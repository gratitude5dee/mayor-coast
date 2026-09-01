import type { Infer } from "convex/values";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import {
  isSamePollText,
  selectPendingPollCandidate,
} from "./lib/pollMatching";
import { inboundClaimResult } from "./lib/validators";

const BURST_DEBOUNCE_MS = 500;
const RAW_TEXT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const NEWER_INBOUND_TOLERANCE_MS = 2_000;

export const claimVote = internalMutation({
  args: {
    webhookId: v.string(),
    providerMessageId: v.string(),
    senderHash: v.string(),
    threadKeyHash: v.string(),
    encryptedThreadRef: v.string(),
    pollTitle: v.string(),
    providerPollId: v.optional(v.string()),
    selectedOption: v.string(),
    receivedAtMs: v.number(),
  },
  returns: inboundClaimResult,
  handler: async (ctx, args): Promise<Infer<typeof inboundClaimResult>> => {
    if (args.senderHash.length < 32 || args.threadKeyHash.length < 32) {
      throw new Error("INVALID_PSEUDONYMOUS_ID");
    }
    const dedupeKey = `${args.webhookId}:${args.providerMessageId}`;
    const duplicateByDedupe = await ctx.db
      .query("inboundDeliveryClaims")
      .withIndex("by_dedupe", (q) => q.eq("dedupeKey", dedupeKey))
      .unique();
    const duplicateByMessage = await ctx.db
      .query("inboundDeliveryClaims")
      .withIndex("by_provider_message", (q) => q.eq("providerMessageId", args.providerMessageId))
      .first();
    const duplicate = duplicateByDedupe ?? duplicateByMessage;
    if (duplicate !== null) {
      return {
        accepted: false,
        duplicate: true,
        shouldAcknowledge: false,
        shouldStartTyping: false,
        command: duplicate.command,
        controlReply: null,
        userId: duplicate.userId,
        threadId: duplicate.threadId,
        messageId: duplicate.messageId,
        turnId: duplicate.turnId,
      };
    }

    const user = await ctx.db
      .query("coastUsers")
      .withIndex("by_sender_hash", (q) => q.eq("senderHash", args.senderHash))
      .unique();
    const thread = await ctx.db
      .query("coastThreads")
      .withIndex("by_provider_thread", (q) =>
        q.eq("provider", "imessage").eq("providerThreadKeyHash", args.threadKeyHash),
      )
      .unique();
    if (user === null || thread === null || thread.userId !== user._id) {
      throw new Error("POLL_THREAD_NOT_FOUND");
    }
    if (user.status !== "active") throw new Error("POLL_USER_NOT_ACTIVE");
    if (
      thread.latestInboundAtMs >
      args.receivedAtMs + NEWER_INBOUND_TOLERANCE_MS
    ) {
      throw new Error("POLL_SELECTION_SUPERSEDED");
    }

    let poll = args.providerPollId === undefined
      ? null
      : await ctx.db
          .query("coastPolls")
          .withIndex("by_provider_poll", (q) =>
            q.eq("providerPollId", args.providerPollId),
          )
          .unique();

    if (
      poll !== null &&
      (poll.threadId !== thread._id ||
        poll.status !== "pending" ||
        !poll.options.some((option) =>
          isSamePollText(option, args.selectedOption),
        ))
    ) {
      poll = null;
    }

    if (poll === null) {
      const pending = await ctx.db
        .query("coastPolls")
        .withIndex("by_thread_status", (q) =>
          q.eq("threadId", thread._id).eq("status", "pending"),
        )
        .order("desc")
        .take(6);
      poll = selectPendingPollCandidate({
        pending,
        pollTitle: args.pollTitle,
        ...(args.providerPollId === undefined
          ? {}
          : { providerPollId: args.providerPollId }),
        selectedOption: args.selectedOption,
      });
    }
    if (poll === null || poll.expiresAtMs <= args.receivedAtMs) {
      throw new Error("POLL_SELECTION_NOT_PENDING");
    }
    const canonicalOption = poll.options.find(
      (option) => isSamePollText(option, args.selectedOption),
    );
    if (canonicalOption === undefined) throw new Error("POLL_OPTION_NOT_FOUND");

    await ctx.db.patch(poll._id, {
      ...(poll.providerPollId === undefined && args.providerPollId !== undefined
        ? { providerPollId: args.providerPollId }
        : {}),
      status: "answered",
      selectedOption: canonicalOption,
      answeredAtMs: args.receivedAtMs,
    });
    await ctx.db.patch(thread._id, {
      encryptedProviderThreadRef: args.encryptedThreadRef,
      latestInboundAtMs: args.receivedAtMs,
      updatedAtMs: args.receivedAtMs,
    });
    await ctx.db.patch(user._id, {
      lastSeenAtMs: args.receivedAtMs,
      updatedAtMs: args.receivedAtMs,
    });

    const messageId = await ctx.db.insert("coastMessages", {
      userId: user._id,
      threadId: thread._id,
      providerMessageId: args.providerMessageId,
      direction: "inbound",
      body: `Poll answer: ${poll.question} — ${canonicalOption}`,
      bodyExpiresAtMs: args.receivedAtMs + RAW_TEXT_RETENTION_MS,
      createdAtMs: args.receivedAtMs,
    });
    const turnId = await ctx.db.insert("coastTurns", {
      userId: user._id,
      threadId: thread._id,
      state: "debouncing",
      revision: 1,
      messageIds: [messageId],
      carryForwardTurnIds: [poll.turnId],
      scheduledForMs: args.receivedAtMs + BURST_DEBOUNCE_MS,
      attemptCount: 0,
      createdAtMs: args.receivedAtMs,
      updatedAtMs: args.receivedAtMs,
    });
    await ctx.db.patch(messageId, { turnId });
    await ctx.db.patch(thread._id, { activeTurnId: turnId });
    await ctx.db.insert("inboundDeliveryClaims", {
      dedupeKey,
      webhookId: args.webhookId,
      providerMessageId: args.providerMessageId,
      userId: user._id,
      threadId: thread._id,
      messageId,
      turnId,
      status: "claimed",
      command: "none" as const,
      createdAtMs: args.receivedAtMs,
    });
    await ctx.scheduler.runAfter(BURST_DEBOUNCE_MS, internal.turnQueue.beginGeneration, {
      turnId,
      expectedRevision: 1,
    });

    return {
      accepted: true,
      duplicate: false,
      shouldAcknowledge: true,
      shouldStartTyping: true,
      command: "none" as const,
      controlReply: null,
      userId: user._id,
      threadId: thread._id,
      messageId,
      turnId,
    };
  },
});
