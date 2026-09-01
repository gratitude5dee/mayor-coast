import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import { cancelActiveCheckInsForUser } from "./checkIns";
import {
  cancelActiveLocationRequestsForThread,
  cancelActiveLocationRequestsForUser,
  expediteLocationRequestForThread,
} from "./locationRequests";
import { inboundClaimResult } from "./lib/validators";

const RAW_TEXT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const BURST_DEBOUNCE_MS = 150;
const LOCATION_REQUEST_TTL_MS = 2 * 60 * 1_000;

function detectCommand(
  text: string,
): "none" | "help" | "stop" | "start" | "forget_me" {
  const normalized = text.trim().replace(/\s+/g, " ").toUpperCase();
  if (normalized === "HELP") return "help";
  if (normalized === "STOP") return "stop";
  if (normalized === "START") return "start";
  if (normalized === "FORGET ME") return "forget_me";
  return "none";
}

function replyForCommand(
  command: "none" | "help" | "stop" | "start" | "forget_me",
  isStopped: boolean,
) {
  if (command === "help") {
    return "I’m COAST, an unofficial AI concierge for San Francisco. Tell me your timing, neighborhood, budget, and vibe. Text STOP to pause or FORGET ME to erase saved preferences and message history.";
  }
  if (command === "stop")
    return "COAST is paused. Text START whenever you want SF recommendations again.";
  if (command === "start")
    return "COAST is back on. What kind of move are we making?";
  if (command === "forget_me") {
    return "Got you. I’m erasing your saved preferences and message history; the minimal delivery-safety record stays pseudonymous.";
  }
  if (isStopped)
    return "COAST is paused for this number. Text START to turn recommendations back on.";
  return "";
}

type LocationIntent = {
  purpose: "nearby_search" | "directions";
  entityType: "event" | "place" | "any";
  searchText?: string;
  travelMode: "walking" | "driving" | "transit" | "bicycling";
};

function detectLocationIntent(text: string): LocationIntent | null {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const directions = /\b(?:get|give|show|need|want|send)?.{0,24}\b(?:directions?|route|navigate|map me)\b/u;
  if (directions.test(normalized)) {
    return {
      purpose: "directions",
      entityType: "any",
      travelMode: travelModeForText(normalized),
    };
  }
  const nearby =
    /\b(?:what|anything|something|places?|spots?|events?|food|drinks?).{0,32}\b(?:near me|nearby|around me|close by)\b/u.test(
      normalized,
    ) || /\b(?:near me|nearby|around me|close by)\b/u.test(normalized);
  if (!nearby) return null;
  const searchText = /\b(?:pizza|food|eat|restaurant|dinner|brunch|coffee|drink|bar|cocktail)\b/u.test(
    normalized,
  )
    ? "food drinks"
    : /\b(?:music|concert|comedy|art|gallery|party|nightlife|event)\b/u.test(normalized)
      ? "events nightlife"
      : "nearby";
  return {
    purpose: "nearby_search",
    entityType:
      searchText === "food drinks"
        ? "place"
        : searchText === "events nightlife"
          ? "event"
          : "any",
    searchText,
    travelMode: travelModeForText(normalized),
  };
}

function travelModeForText(text: string): LocationIntent["travelMode"] {
  if (/\b(?:drive|driving|car)\b/u.test(text)) return "driving";
  if (/\b(?:transit|muni|bart|bus|train)\b/u.test(text)) return "transit";
  if (/\b(?:bike|biking|bicycle)\b/u.test(text)) return "bicycling";
  return "walking";
}

function isLocationAcknowledgement(text: string): boolean {
  return /^(?:shared|done|use my location|sent location|location shared)[.!\s]*$/iu.test(
    text.trim(),
  );
}

const NEIGHBORHOOD_REPLIES: ReadonlyArray<readonly [string, string]> = [
  ["south of market", "South of Market"],
  ["soma", "South of Market"],
  ["north beach", "North Beach"],
  ["hayes valley", "Hayes Valley"],
  ["potrero hill", "Potrero Hill"],
  ["mission bay", "Mission Bay"],
  ["mission", "Mission"],
  ["financial district", "Financial District/South Beach"],
  ["fi di", "Financial District/South Beach"],
  ["tenderloin", "Tenderloin"],
  ["russian hill", "Russian Hill"],
  ["nob hill", "Nob Hill"],
  ["castro", "Castro/Upper Market"],
  ["marina", "Marina"],
  ["chinatown", "Chinatown"],
  ["bernal heights", "Bernal Heights"],
  ["outer richmond", "Outer Richmond"],
  ["richmond", "Outer Richmond"],
  ["sunset", "Sunset/Parkside"],
  ["haight", "Haight Ashbury"],
  ["bayview", "Bayview Hunters Point"],
];

function knownNeighborhoodReply(text: string): string | null {
  const normalized = text.toLowerCase().replace(/[^a-z\s]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 100) return null;
  for (const [alias, neighborhoodId] of NEIGHBORHOOD_REPLIES) {
    if (
      normalized === alias ||
      normalized === `in ${alias}` ||
      normalized === `near ${alias}` ||
      normalized === `around ${alias}`
    ) {
      return neighborhoodId;
    }
  }
  return null;
}

async function latestSelectedDestination(
  ctx: MutationCtx,
  threadId: Id<"coastThreads">,
  nowMs: number,
): Promise<string | null> {
  const decisions = await ctx.db
    .query("coastDecisions")
    .withIndex("by_thread_status", (q) =>
      q.eq("threadId", threadId).eq("status", "selected"),
    )
    .take(10);
  const selected = decisions
    .filter((decision) => decision.expiresAtMs > nowMs)
    .sort((a, b) => (b.selectedAtMs ?? b.updatedAtMs) - (a.selectedAtMs ?? a.updatedAtMs))[0];
  return selected?.experienceExternalId ?? null;
}

export const claimDelivery = internalMutation({
  args: {
    webhookId: v.string(),
    providerMessageId: v.string(),
    senderHash: v.string(),
    threadKeyHash: v.string(),
    encryptedThreadRef: v.string(),
    text: v.string(),
    locationSignal: v.optional(v.boolean()),
    unsupportedContent: v.optional(
      v.union(v.literal("attachment"), v.literal("private_location")),
    ),
    receivedAtMs: v.number(),
  },
  returns: inboundClaimResult,
  handler: async (ctx, args) => {
    if (args.senderHash.length < 32 || args.threadKeyHash.length < 32) {
      throw new Error("INVALID_PSEUDONYMOUS_ID");
    }
    if (
      args.encryptedThreadRef.length < 24 ||
      args.encryptedThreadRef.length > 4_096
    ) {
      throw new Error("INVALID_ENCRYPTED_THREAD_REF");
    }
    if (args.unsupportedContent === undefined && args.text.length > 12_000) {
      throw new Error("MESSAGE_TOO_LARGE");
    }

    const dedupeKey = `${args.webhookId}:${args.providerMessageId}`;
    const existingByDedupe = await ctx.db
      .query("inboundDeliveryClaims")
      .withIndex("by_dedupe", (q) => q.eq("dedupeKey", dedupeKey))
      .unique();
    const existingByMessage = await ctx.db
      .query("inboundDeliveryClaims")
      .withIndex("by_provider_message", (q) =>
        q.eq("providerMessageId", args.providerMessageId),
      )
      .first();
    const existing = existingByDedupe ?? existingByMessage;
    if (existing !== null) {
      return {
        accepted: false,
        duplicate: true,
        shouldAcknowledge: false,
        shouldStartTyping: false,
        command: existing.command,
        controlReply: null,
        userId: existing.userId,
        threadId: existing.threadId,
        messageId: existing.messageId,
        turnId: existing.turnId,
      };
    }

    let user = await ctx.db
      .query("coastUsers")
      .withIndex("by_sender_hash", (q) => q.eq("senderHash", args.senderHash))
      .unique();
    let userId: Id<"coastUsers">;
    if (user === null) {
      userId = await ctx.db.insert("coastUsers", {
        senderHash: args.senderHash,
        status: "active",
        createdAtMs: args.receivedAtMs,
        updatedAtMs: args.receivedAtMs,
        lastSeenAtMs: args.receivedAtMs,
      });
      user = await ctx.db.get(userId);
      if (user === null) throw new Error("USER_INSERT_FAILED");
    } else {
      userId = user._id;
      await ctx.db.patch(userId, {
        updatedAtMs: args.receivedAtMs,
        lastSeenAtMs: args.receivedAtMs,
      });
    }

    let thread = await ctx.db
      .query("coastThreads")
      .withIndex("by_provider_thread", (q) =>
        q
          .eq("provider", "imessage")
          .eq("providerThreadKeyHash", args.threadKeyHash),
      )
      .unique();
    let threadId: Id<"coastThreads">;
    if (thread === null) {
      threadId = await ctx.db.insert("coastThreads", {
        userId,
        provider: "imessage",
        providerThreadKeyHash: args.threadKeyHash,
        encryptedProviderThreadRef: args.encryptedThreadRef,
        status: "active",
        latestInboundAtMs: args.receivedAtMs,
        createdAtMs: args.receivedAtMs,
        updatedAtMs: args.receivedAtMs,
      });
      thread = await ctx.db.get(threadId);
      if (thread === null) throw new Error("THREAD_INSERT_FAILED");
    } else {
      threadId = thread._id;
      await ctx.db.patch(threadId, {
        userId,
        status: "active",
        encryptedProviderThreadRef: args.encryptedThreadRef,
        latestInboundAtMs: args.receivedAtMs,
        updatedAtMs: args.receivedAtMs,
      });
    }

    // Defense in depth: even an authenticated caller cannot persist content
    // that it has classified as an attachment or private location share.
    const persistedText = args.locationSignal
      ? "[private location share omitted]"
      : args.unsupportedContent
        ? "[unsupported inbound content omitted]"
        : args.text;
    const command = args.unsupportedContent || args.locationSignal ? "none" : detectCommand(args.text);
    const messageId = await ctx.db.insert("coastMessages", {
      userId,
      threadId,
      providerMessageId: args.providerMessageId,
      direction: "inbound",
      body: persistedText,
      bodyExpiresAtMs: args.receivedAtMs + RAW_TEXT_RETENTION_MS,
      createdAtMs: args.receivedAtMs,
    });

    let turnId: Id<"coastTurns">;
    let shouldStartTyping = true;
    let controlReply: { command: typeof command; text: string } | null = null;
    const coarseNeighborhoodId =
      !args.unsupportedContent && !args.locationSignal
        ? knownNeighborhoodReply(args.text)
        : null;
    const resumeLocationRequestId =
      !args.unsupportedContent &&
      (args.locationSignal || isLocationAcknowledgement(args.text) || coarseNeighborhoodId !== null)
        ? await expediteLocationRequestForThread(
            ctx,
            threadId,
            args.receivedAtMs,
            coarseNeighborhoodId ?? undefined,
          )
        : null;
    const detectedLocationIntent =
      !args.unsupportedContent && !args.locationSignal && command === "none"
        ? detectLocationIntent(args.text)
        : null;
    const directionTarget =
      detectedLocationIntent?.purpose === "directions"
        ? await latestSelectedDestination(ctx, threadId, args.receivedAtMs)
        : null;

    if (
      detectedLocationIntent?.purpose === "directions" &&
      directionTarget === null &&
      resumeLocationRequestId === null
    ) {
      controlReply = {
        command,
        text: "Which spot should I map you to? Pick one result first, then say “get me directions.”",
      };
    }

    if (args.unsupportedContent) {
      controlReply = {
        command,
        text:
          args.unsupportedContent === "private_location"
            ? "I can’t process live or private location shares. Send a neighborhood or public venue name instead."
            : "I can’t read attachments yet. Send the details as text and I’ll help from there.",
      };
    } else if (command === "stop") {
      await ctx.db.patch(userId, {
        status: "stopped",
        updatedAtMs: args.receivedAtMs,
      });
      await cancelActiveCheckInsForUser(
        ctx,
        userId,
        args.receivedAtMs,
        "user_stopped",
      );
      await cancelActiveLocationRequestsForUser(
        ctx,
        userId,
        args.receivedAtMs,
        "user_stopped",
      );
      controlReply = { command, text: replyForCommand(command, false) };
    } else if (command === "start") {
      await ctx.db.patch(userId, {
        status: "active",
        updatedAtMs: args.receivedAtMs,
        forgetRequestedAtMs: undefined,
      });
      controlReply = { command, text: replyForCommand(command, false) };
    } else if (command === "forget_me") {
      await ctx.db.patch(userId, {
        status: "forgetting",
        forgetRequestedAtMs: args.receivedAtMs,
        updatedAtMs: args.receivedAtMs,
      });
      await cancelActiveCheckInsForUser(
        ctx,
        userId,
        args.receivedAtMs,
        "forget_requested",
      );
      await cancelActiveLocationRequestsForUser(
        ctx,
        userId,
        args.receivedAtMs,
        "forget_requested",
      );
      controlReply = { command, text: replyForCommand(command, false) };
      await ctx.scheduler.runAfter(30_000, internal.privacy.eraseUserBatch, {
        userId,
      });
    } else if (command === "help") {
      controlReply = { command, text: replyForCommand(command, false) };
    } else if (user.status === "stopped") {
      controlReply = { command, text: replyForCommand(command, true) };
    }

    if (args.locationSignal && resumeLocationRequestId === null && controlReply === null) {
      controlReply = {
        command,
        text: "Ask me what’s near you or say “get me directions,” then tap Find My so I can use the share for that one request.",
      };
    }

    if (resumeLocationRequestId !== null && controlReply === null) {
      // A Find My share or its acknowledgement is not conversational content.
      // Claim it for dedupe/audit, schedule the resolver, and never send the
      // private payload to the model or back to the user.
      shouldStartTyping = false;
      turnId = await ctx.db.insert("coastTurns", {
        userId,
        threadId,
        state: "sent",
        revision: 1,
        messageIds: [messageId],
        carryForwardTurnIds: [],
        plan: {
          responseText: "[location share consumed privately]",
          selectedExternalIds: [],
          poll: null,
          preferenceUpdates: [],
          provenanceIds: [],
          modelRoute: "luna_low",
          routeReasons: ["location_share_resolver"],
          modelSteps: 0,
          toolCalls: 0,
          retrievalMode: "none",
        },
        scheduledForMs: args.receivedAtMs,
        planPersistedAtMs: args.receivedAtMs,
        completedAtMs: args.receivedAtMs,
        attemptCount: 0,
        createdAtMs: args.receivedAtMs,
        updatedAtMs: args.receivedAtMs,
      });
      await ctx.db.patch(messageId, { turnId });
      await ctx.db.patch(threadId, { activeTurnId: turnId, updatedAtMs: args.receivedAtMs });
    } else if (controlReply !== null) {
      shouldStartTyping = false;
      const activeTurn =
        thread.activeTurnId === undefined
          ? null
          : await ctx.db.get(thread.activeTurnId);
      if (
        activeTurn !== null &&
        activeTurn.state !== "sent" &&
        activeTurn.state !== "failed" &&
        activeTurn.state !== "cancelled" &&
        activeTurn.state !== "superseded"
      ) {
        await ctx.db.patch(activeTurn._id, {
          state: "superseded",
          supersededAtMs: args.receivedAtMs,
          updatedAtMs: args.receivedAtMs,
        });
        const pendingOutbound = await ctx.db
          .query("outboundDeliveries")
          .withIndex("by_turn_stage", (q) => q.eq("turnId", activeTurn._id))
          .take(3);
        for (const delivery of pendingOutbound) {
          if (delivery.status !== "sent") {
            await ctx.db.patch(delivery._id, {
              status: "cancelled",
              updatedAtMs: args.receivedAtMs,
            });
          }
        }
      }

      const plan = {
        responseText: controlReply.text,
        selectedExternalIds: [],
        poll: null,
        preferenceUpdates: [],
        provenanceIds: [],
        modelRoute: "luna_low" as const,
        routeReasons: [
          args.unsupportedContent
            ? "unsupported_inbound_no_model"
            : "control_command_no_model",
        ],
        modelSteps: 0,
        toolCalls: 0,
        retrievalMode: "none" as const,
      };
      turnId = await ctx.db.insert("coastTurns", {
        userId,
        threadId,
        state: "response_planned",
        revision: 1,
        messageIds: [messageId],
        carryForwardTurnIds: activeTurn === null ? [] : [activeTurn._id],
        plan,
        scheduledForMs: args.receivedAtMs,
        planPersistedAtMs: args.receivedAtMs,
        attemptCount: 0,
        createdAtMs: args.receivedAtMs,
        updatedAtMs: args.receivedAtMs,
      });
      await ctx.db.insert("outboundDeliveries", {
        turnId,
        threadId,
        stage: "response",
        sequence: 0,
        itemKey: "response",
        idempotencyKey: `${turnId}:0:response:response`,
        payload: { text: controlReply.text },
        status: "pending",
        attemptCount: 0,
        nextAttemptAtMs: args.receivedAtMs,
        createdAtMs: args.receivedAtMs,
        updatedAtMs: args.receivedAtMs,
      });
      await ctx.db.patch(messageId, { turnId });
      await ctx.db.patch(threadId, {
        activeTurnId: turnId,
        updatedAtMs: args.receivedAtMs,
      });
      await ctx.scheduler.runAfter(0, internal.turnQueue.deliverTurn, {
        turnId,
      });
    } else if (detectedLocationIntent !== null) {
      await cancelActiveLocationRequestsForThread(
        ctx,
        threadId,
        args.receivedAtMs,
        "superseded_location_request",
      );
      const activeTurn =
        thread.activeTurnId === undefined ? null : await ctx.db.get(thread.activeTurnId);
      if (
        activeTurn !== null &&
        activeTurn.state !== "sent" &&
        activeTurn.state !== "failed" &&
        activeTurn.state !== "cancelled" &&
        activeTurn.state !== "superseded"
      ) {
        await ctx.db.patch(activeTurn._id, {
          state: "superseded",
          supersededAtMs: args.receivedAtMs,
          updatedAtMs: args.receivedAtMs,
        });
        const pendingOutbound = await ctx.db
          .query("outboundDeliveries")
          .withIndex("by_turn_stage", (q) => q.eq("turnId", activeTurn._id))
          .take(24);
        for (const delivery of pendingOutbound) {
          if (delivery.status !== "sent") {
            await ctx.db.patch(delivery._id, {
              status: "cancelled",
              updatedAtMs: args.receivedAtMs,
            });
          }
        }
      }
      const responseText =
        "Tap Find My below and share once—I’ll use it for this request and won’t save your exact location.";
      turnId = await ctx.db.insert("coastTurns", {
        userId,
        threadId,
        state: "response_planned",
        revision: 1,
        messageIds: [messageId],
        carryForwardTurnIds: activeTurn === null ? [] : [activeTurn._id],
        plan: {
          responseText,
          selectedExternalIds: [],
          poll: null,
          preferenceUpdates: [],
          provenanceIds: [],
          modelRoute: "luna_low",
          routeReasons: ["deterministic_location_intent"],
          modelSteps: 0,
          toolCalls: 0,
          retrievalMode: "none",
          nextAction: {
            type: "request_location",
            purpose: detectedLocationIntent.purpose,
            ...(directionTarget === null ? {} : { targetExternalId: directionTarget }),
            travelMode: detectedLocationIntent.travelMode,
          },
        },
        scheduledForMs: args.receivedAtMs,
        planPersistedAtMs: args.receivedAtMs,
        attemptCount: 0,
        createdAtMs: args.receivedAtMs,
        updatedAtMs: args.receivedAtMs,
      });
      const requestId = await ctx.db.insert("coastLocationRequests", {
        userId,
        threadId,
        sourceTurnId: turnId,
        requestKey: `${threadId}:${turnId}:location`,
        purpose: detectedLocationIntent.purpose,
        state: "pending_provider",
        revision: 1,
        entityType: detectedLocationIntent.entityType,
        ...(detectedLocationIntent.searchText
          ? { searchText: detectedLocationIntent.searchText }
          : {}),
        ...(directionTarget === null ? {} : { targetExternalId: directionTarget }),
        travelMode: detectedLocationIntent.travelMode,
        createdAtMs: args.receivedAtMs,
        updatedAtMs: args.receivedAtMs,
        expiresAtMs: args.receivedAtMs + LOCATION_REQUEST_TTL_MS,
      });
      const stages = [
        { stage: "response" as const, itemKey: "response", payload: { text: responseText } },
        {
          stage: "location_request" as const,
          itemKey: requestId,
          payload: { locationRequestId: requestId },
        },
      ];
      for (const [sequence, stage] of stages.entries()) {
        await ctx.db.insert("outboundDeliveries", {
          turnId,
          threadId,
          stage: stage.stage,
          sequence,
          itemKey: stage.itemKey,
          idempotencyKey: `${turnId}:${sequence}:${stage.stage}:${stage.itemKey}`,
          payload: stage.payload,
          status: "pending",
          attemptCount: 0,
          nextAttemptAtMs: args.receivedAtMs,
          createdAtMs: args.receivedAtMs,
          updatedAtMs: args.receivedAtMs,
        });
      }
      await ctx.db.patch(messageId, { turnId });
      await ctx.db.patch(threadId, { activeTurnId: turnId, updatedAtMs: args.receivedAtMs });
      await ctx.scheduler.runAfter(0, internal.turnQueue.deliverTurn, { turnId });
    } else {
      const activeTurn =
        thread.activeTurnId === undefined
          ? null
          : await ctx.db.get(thread.activeTurnId);
      const scheduledForMs = args.receivedAtMs + BURST_DEBOUNCE_MS;

      if (activeTurn?.state === "debouncing") {
        turnId = activeTurn._id;
        const revision = activeTurn.revision + 1;
        await ctx.db.patch(turnId, {
          revision,
          messageIds: [...activeTurn.messageIds, messageId],
          scheduledForMs,
          updatedAtMs: args.receivedAtMs,
        });
        await ctx.db.patch(messageId, { turnId });
        await ctx.scheduler.runAfter(
          BURST_DEBOUNCE_MS,
          internal.turnQueue.beginGeneration,
          {
            turnId,
            expectedRevision: revision,
          },
        );
      } else {
        const carryForwardTurnIds: Id<"coastTurns">[] = [];
        const messageIds: Id<"coastMessages">[] = [messageId];
        if (
          activeTurn !== null &&
          activeTurn.state !== "sent" &&
          activeTurn.state !== "failed" &&
          activeTurn.state !== "cancelled" &&
          activeTurn.state !== "superseded"
        ) {
          carryForwardTurnIds.push(
            activeTurn._id,
            ...activeTurn.carryForwardTurnIds,
          );
          messageIds.unshift(...activeTurn.messageIds);
          await ctx.db.patch(activeTurn._id, {
            state: "superseded",
            supersededAtMs: args.receivedAtMs,
            updatedAtMs: args.receivedAtMs,
          });
          const pendingOutbound = await ctx.db
            .query("outboundDeliveries")
            .withIndex("by_turn_stage", (q) => q.eq("turnId", activeTurn._id))
            .take(3);
          for (const delivery of pendingOutbound) {
            if (delivery.status !== "sent") {
              await ctx.db.patch(delivery._id, {
                status: "cancelled",
                updatedAtMs: args.receivedAtMs,
              });
            }
          }
        }

        turnId = await ctx.db.insert("coastTurns", {
          userId,
          threadId,
          state: "debouncing",
          revision: 1,
          messageIds: [...new Set(messageIds)],
          carryForwardTurnIds: [...new Set(carryForwardTurnIds)],
          // A typed free-form message is a fresh discovery request. Poll votes
          // continue their lineage through convex/polls.ts instead.
          clarificationDepth: 0,
          scheduledForMs,
          attemptCount: 0,
          createdAtMs: args.receivedAtMs,
          updatedAtMs: args.receivedAtMs,
        });
        await ctx.db.patch(messageId, { turnId });
        await ctx.db.patch(threadId, {
          activeTurnId: turnId,
          updatedAtMs: args.receivedAtMs,
        });
        await ctx.scheduler.runAfter(
          BURST_DEBOUNCE_MS,
          internal.turnQueue.beginGeneration,
          {
            turnId,
            expectedRevision: 1,
          },
        );
      }
    }

    await ctx.db.insert("inboundDeliveryClaims", {
      dedupeKey,
      webhookId: args.webhookId,
      providerMessageId: args.providerMessageId,
      userId,
      threadId,
      messageId,
      turnId,
      status: "claimed",
      command,
      createdAtMs: args.receivedAtMs,
    });

    return {
      accepted: true,
      duplicate: false,
      shouldAcknowledge: true,
      shouldStartTyping,
      command,
      controlReply,
      userId,
      threadId,
      messageId,
      turnId,
    };
  },
});

export const recordAcknowledgement = internalMutation({
  args: {
    webhookId: v.string(),
    providerMessageId: v.string(),
    reactionSent: v.boolean(),
    readSent: v.boolean(),
    typingStarted: v.boolean(),
    recordedAtMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const claim = await ctx.db
      .query("inboundDeliveryClaims")
      .withIndex("by_dedupe", (q) =>
        q.eq("dedupeKey", `${args.webhookId}:${args.providerMessageId}`),
      )
      .unique();
    if (claim === null) return null;
    await ctx.db.patch(claim._id, {
      reactionClaimedAtMs: args.reactionSent
        ? args.recordedAtMs
        : claim.reactionClaimedAtMs,
      readClaimedAtMs: args.readSent
        ? args.recordedAtMs
        : claim.readClaimedAtMs,
      typingClaimedAtMs: args.typingStarted
        ? args.recordedAtMs
        : claim.typingClaimedAtMs,
      status: "handled",
      handledAtMs: args.recordedAtMs,
    });
    return null;
  },
});

export const getThreadByHash = internalQuery({
  args: { threadKeyHash: v.string() },
  returns: v.union(
    v.object({
      threadId: v.id("coastThreads"),
      userId: v.id("coastUsers"),
      status: v.union(v.literal("active"), v.literal("closed")),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const thread = await ctx.db
      .query("coastThreads")
      .withIndex("by_provider_thread", (q) =>
        q
          .eq("provider", "imessage")
          .eq("providerThreadKeyHash", args.threadKeyHash),
      )
      .unique();
    if (thread === null) return null;
    return {
      threadId: thread._id,
      userId: thread.userId,
      status: thread.status,
    };
  },
});
