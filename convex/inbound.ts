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
import { serviceSecretFingerprintHex } from "./lib/service_auth";

const RAW_TEXT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const BURST_DEBOUNCE_MS = 150;
const LOCATION_REQUEST_TTL_MS = 2 * 60 * 1_000;

function detectCommand(
  text: string,
): "none" | "help" | "stop" | "start" | "forget_me" | "credits" | "topup" | "disconnect_link" {
  const normalized = text.trim().replace(/\s+/g, " ").toUpperCase();
  if (normalized === "HELP") return "help";
  if (normalized === "STOP") return "stop";
  if (normalized === "START") return "start";
  if (normalized === "FORGET ME") return "forget_me";
  if (normalized === "CREDITS") return "credits";
  if (normalized === "TOPUP" || normalized === "TOP UP") return "topup";
  if (normalized === "DISCONNECT LINK") return "disconnect_link";
  return "none";
}

function detectCreativeCommand(text: string): "imagine" | "zap" | "draw" | null {
  const match = /^\s*\/(imagine|zap|draw)(?:\s+|$)/iu.exec(text);
  return (match?.[1]?.toLowerCase() as "imagine" | "zap" | "draw" | undefined) ?? null;
}

function replyForCommand(
  command: "none" | "help" | "stop" | "start" | "forget_me" | "credits" | "topup" | "disconnect_link",
  isStopped: boolean,
) {
  if (command === "help") {
    return "I’m COAST, your unofficial mayor of SF. Tell me your timing, neighborhood, budget, and vibe. Text STOP to pause or FORGET ME to erase saved preferences and message history.";
  }
  if (command === "stop")
    return "COAST is paused. Text START whenever you want SF recommendations again.";
  if (command === "start")
    return "COAST is back on. What kind of move are we making?";
  if (command === "forget_me") {
    return "Got you. I’m erasing your saved preferences and message history; the minimal delivery-safety record stays pseudonymous.";
  }
  if (command === "credits") {
    return "Free allowance: 10 images and 10 videos per rolling 24 hours. Purchased credit carries forward and is used after free generations.";
  }
  if (command === "topup") {
    return "Top-ups add $10 of generation credit for $9.99. Free generations are always used first; when an allowance is exhausted, COAST sends a one-tap Checkout link or Link approval request.";
  }
  if (command === "disconnect_link") return "Your Link wallet is disconnected from COAST. Existing purchased credit remains available.";
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
    creativeCommand: v.optional(v.union(v.literal("imagine"), v.literal("zap"), v.literal("draw"))),
    creativeCommandAmbiguous: v.optional(v.boolean()),
    encryptedCreativePayload: v.optional(v.string()),
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
    const creativeRequest = args.unsupportedContent === undefined && !args.locationSignal &&
      (args.creativeCommand !== undefined || args.creativeCommandAmbiguous === true);
    const creativeCommand = args.unsupportedContent || args.locationSignal || args.creativeCommandAmbiguous
      ? null
      : args.creativeCommand ?? detectCreativeCommand(args.text);
    const persistedText = args.locationSignal
      ? "[private location share omitted]"
      : args.unsupportedContent
        ? "[unsupported inbound content omitted]"
        : creativeRequest
          ? "[creative request omitted]"
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

    if (args.creativeCommandAmbiguous) {
      controlReply = {
        command,
        text: "Please send exactly one creative command per request: /imagine, /zap, or /draw.",
      };
    } else if (args.unsupportedContent && creativeCommand === null) {
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
      await cancelCreativeJobsInline(ctx, userId, args.receivedAtMs);
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
      await cancelCreativeJobsInline(ctx, userId, args.receivedAtMs, true);
      controlReply = { command, text: replyForCommand(command, false) };
      await ctx.scheduler.runAfter(30_000, internal.privacy.eraseUserBatch, {
        userId,
      });
    } else if (command === "help") {
      controlReply = { command, text: replyForCommand(command, false) };
    } else if (command === "credits" || command === "topup") {
      controlReply = {
        command,
        text: await creativeCommandReply(ctx, userId, command, args.receivedAtMs),
      };
    } else if (command === "disconnect_link") {
      const connections = await ctx.db
        .query("creativeLinkConnections")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(10);
      for (const connection of connections) {
        await ctx.db.patch(connection._id, { status: "revoked", encryptedAuth: "[revoked]", updatedAtMs: args.receivedAtMs });
      }
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

      if (
        activeTurn?.state === "debouncing" &&
        creativeCommand !== null &&
        activeTurn.creativeCommand !== undefined &&
        activeTurn.creativeCommand !== creativeCommand
      ) {
        turnId = activeTurn._id;
        const responseText = "Please send one creative command at a time: /imagine or /zap.";
        await ctx.db.patch(activeTurn._id, {
          state: "response_planned",
          plan: {
            responseText,
            selectedExternalIds: [],
            poll: null,
            preferenceUpdates: [],
            provenanceIds: [],
            modelRoute: "luna_low",
            routeReasons: ["ambiguous_creative_burst"],
            modelSteps: 0,
            toolCalls: 0,
            retrievalMode: "none",
          },
          updatedAtMs: args.receivedAtMs,
        });
        await ctx.db.insert("outboundDeliveries", {
          turnId,
          threadId,
          stage: "response",
          sequence: 0,
          itemKey: "ambiguous-creative-command",
          idempotencyKey: `${turnId}:ambiguous-creative-command`,
          payload: { text: responseText },
          status: "pending",
          attemptCount: 0,
          nextAttemptAtMs: args.receivedAtMs,
          createdAtMs: args.receivedAtMs,
          updatedAtMs: args.receivedAtMs,
        });
        await ctx.db.patch(messageId, { turnId });
        await ctx.scheduler.runAfter(0, internal.turnQueue.deliverTurn, { turnId });
      } else if (
        activeTurn?.state === "debouncing" &&
        creativeCommand === null &&
        activeTurn.creativeCommand === undefined
      ) {
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
          creativeCommand === null &&
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
          state: creativeCommand === null ? "debouncing" : "response_planned",
          revision: 1,
          messageIds: [...new Set(messageIds)],
          carryForwardTurnIds: [...new Set(carryForwardTurnIds)],
          // A typed free-form message is a fresh discovery request. Poll votes
          // continue their lineage through convex/polls.ts instead.
          clarificationDepth: 0,
          ...(creativeCommand === null ? {} : { creativeCommand }),
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
        if (creativeCommand === null) {
          await ctx.scheduler.runAfter(
            BURST_DEBOUNCE_MS,
            internal.turnQueue.beginGeneration,
            { turnId, expectedRevision: 1 },
          );
        }
      }
    }

    // Admission is atomic with the inbound claim. The actual provider call is
    // performed by a later worker, so retries can poll a known request ID and
    // never submit a duplicate paid render.
    if (
      creativeCommand !== null &&
      args.encryptedCreativePayload !== undefined &&
      controlReply === null &&
      command === "none"
    ) {
      if (creativeCommand === "draw" && process.env.COAST_DRAW_ENABLED !== "true") {
        await ctx.db.insert("outboundDeliveries", {
          turnId,
          threadId,
          stage: "response",
          sequence: 0,
          itemKey: "draw-disabled",
          idempotencyKey: `${turnId}:draw-disabled`,
          payload: { text: "COAST Draw is temporarily paused while we finish the image service. Try /draw again soon." },
          status: "pending",
          attemptCount: 0,
          nextAttemptAtMs: args.receivedAtMs,
          createdAtMs: args.receivedAtMs,
          updatedAtMs: args.receivedAtMs,
        });
        await ctx.scheduler.runAfter(0, internal.turnQueue.deliverTurn, { turnId });
      } else {
      const admitted = await admitCreativeInline(ctx, {
        userId,
        threadId,
        sourceMessageId: messageId,
        turnId,
        requestKey: `${args.webhookId}:${args.providerMessageId}`,
        command: creativeCommand,
        encryptedPayload: args.encryptedCreativePayload,
        nowMs: args.receivedAtMs,
      });
      if (admitted.state === "busy") {
        await ctx.db.insert("outboundDeliveries", {
          turnId,
          threadId,
          stage: "response",
          sequence: 0,
          itemKey: "creative-pending",
          idempotencyKey: `${turnId}:creative-pending`,
          payload: { text: "Your previous creative request is still running. I’ll finish it before accepting another." },
          status: "pending",
          attemptCount: 0,
          nextAttemptAtMs: args.receivedAtMs,
          createdAtMs: args.receivedAtMs,
          updatedAtMs: args.receivedAtMs,
        });
        await ctx.scheduler.runAfter(0, internal.turnQueue.deliverTurn, { turnId });
      } else if (admitted.state === "awaiting_payment") {
        const noun = creativeCommand === "zap" ? "videos" : "images";
        const text = `You’ve used your 10 free ${noun} for now. Add $10 credit for $9.99: images are $0.50 and 15-second videos are $1. Connect Link for future top-ups, or pay directly here.`;
        await ctx.db.insert("outboundDeliveries", {
          turnId,
          threadId,
          stage: "billing",
          sequence: 0,
          itemKey: "topup",
          idempotencyKey: `${turnId}:billing:topup`,
          payload: {
            text,
            ...(admitted.topupOrderId === undefined ? {} : { orderId: admitted.topupOrderId }),
          },
          status: "pending",
          attemptCount: 0,
          nextAttemptAtMs: args.receivedAtMs,
          createdAtMs: args.receivedAtMs,
          updatedAtMs: args.receivedAtMs,
        });
        await ctx.scheduler.runAfter(0, internal.turnQueue.deliverTurn, { turnId });
      } else {
        if (creativeCommand === "draw" && "drawSessionId" in admitted && admitted.drawSessionId && admitted.launchSecret) {
          await ctx.db.insert("outboundDeliveries", {
            turnId,
            threadId,
            stage: "draw_card",
            sequence: 0,
            itemKey: "draw-card",
            idempotencyKey: `${turnId}:draw-card`,
            payload: { sessionId: admitted.drawSessionId, launchSecret: admitted.launchSecret },
            status: "pending",
            attemptCount: 0,
            nextAttemptAtMs: args.receivedAtMs,
            createdAtMs: args.receivedAtMs,
            updatedAtMs: args.receivedAtMs,
          });
        } else {
          await ctx.db.insert("outboundDeliveries", {
            turnId,
            threadId,
            stage: "response",
            sequence: 0,
            itemKey: "creative-accepted",
            idempotencyKey: `${turnId}:creative-accepted`,
            payload: { text: "Got it — I’m creating that now." },
            status: "pending",
            attemptCount: 0,
            nextAttemptAtMs: args.receivedAtMs,
            createdAtMs: args.receivedAtMs,
            updatedAtMs: args.receivedAtMs,
          });
        }
        await ctx.scheduler.runAfter(0, internal.turnQueue.deliverTurn, { turnId });
        const job = await ctx.db
          .query("creativeJobs")
          .withIndex("by_request_key", (q) => q.eq("requestKey", `${args.webhookId}:${args.providerMessageId}`))
          .unique();
        if (job !== null && creativeCommand !== "draw") await ctx.scheduler.runAfter(0, internal.creative.run, { jobId: job._id });
      }
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

async function creativeCommandReply(
  ctx: MutationCtx,
  userId: Id<"coastUsers">,
  command: "credits" | "topup",
  nowMs: number,
): Promise<string> {
  const usage = await ctx.db
    .query("creativeUsage")
    .withIndex("by_user_kind_admitted", (q) => q.eq("userId", userId))
    .take(100);
  const windowStart = nowMs - 24 * 60 * 60 * 1_000;
  const images = usage.filter((item) => item.kind === "image" && item.admittedAtMs > windowStart).length;
  const videos = usage.filter((item) => item.kind === "video" && item.admittedAtMs > windowStart).length;
  const ledger = await ctx.db
    .query("creativeCreditLedger")
    .withIndex("by_user_created", (q) => q.eq("userId", userId))
    .collect();
  const creditCents = ledger.reduce((sum, item) => sum + item.amountCents, 0);
  if (command === "credits") {
    return `Free remaining: ${Math.max(0, 10 - images)} images and ${Math.max(0, 10 - videos)} videos in the rolling 24-hour window. Purchased credit: $${(creditCents / 100).toFixed(2)}.`;
  }
  if (images < 10 || videos < 10) {
    return `You still have free generations available: ${Math.max(0, 10 - images)} images and ${Math.max(0, 10 - videos)} videos. Free generations are used before purchased credit.`;
  }
  return "Add $10 of generation credit for $9.99. COAST will send a one-tap Checkout link, or you can connect Link for future approvals.";
}

async function cancelCreativeJobsInline(
  ctx: MutationCtx,
  userId: Id<"coastUsers">,
  nowMs: number,
  redact = false,
): Promise<void> {
  const jobs = await ctx.db
    .query("creativeJobs")
    .withIndex("by_user_state", (q) => q.eq("userId", userId))
    .take(50);
  for (const job of jobs) {
    if (["delivered", "failed", "refused", "cancelled", "expired"].includes(job.state)) continue;
    if (job.reservationSource === "credit") {
      await ctx.db.insert("creativeCreditLedger", {
        userId,
        jobId: job._id,
        kind: "release",
        amountCents: job.reservedCents,
        idempotencyKey: `${job.reservationId}:cancel-release`,
        createdAtMs: nowMs,
      });
    } else if (job.reservationSource === "free") {
      const usage = await ctx.db
        .query("creativeUsage")
        .withIndex("by_reservation", (q) => q.eq("reservationId", job.reservationId))
        .unique();
      if (usage !== null) await ctx.db.delete(usage._id);
    }
    await ctx.db.patch(job._id, {
      state: "cancelled",
      ...(redact ? { encryptedPayload: "[redacted]" } : {}),
      updatedAtMs: nowMs,
    });
  }
}

async function admitCreativeInline(
  ctx: MutationCtx,
  args: {
    userId: Id<"coastUsers">;
    threadId: Id<"coastThreads">;
    sourceMessageId: Id<"coastMessages">;
    turnId: Id<"coastTurns">;
    requestKey: string;
    command: "imagine" | "zap" | "draw";
    encryptedPayload: string;
    nowMs: number;
  },
) {
  const existing = await ctx.db.query("creativeJobs").withIndex("by_request_key", (q) => q.eq("requestKey", args.requestKey)).unique();
  if (existing !== null) return { state: existing.state };
  const active = await ctx.db
    .query("creativeJobs")
    .withIndex("by_user_state", (q) => q.eq("userId", args.userId))
    .take(20);
  if (active.some((job) => !["delivered", "failed", "refused", "cancelled", "expired", "retryable_failure"].includes(job.state))) {
    return { state: "busy" };
  }
  if (args.command === "draw") {
    const launchSecret = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const sessionId = await ctx.db.insert("drawSessions", {
      userId: args.userId,
      threadId: args.threadId,
      sourceMessageId: args.sourceMessageId,
      turnId: args.turnId,
      launchSecretHash: serviceSecretFingerprintHex(launchSecret),
      encryptedLaunchSecret: serviceSecretFingerprintHex(launchSecret),
      launchExpiresAtMs: args.nowMs + 15 * 60_000,
      encryptedPayload: args.encryptedPayload,
      status: "active",
      createdAtMs: args.nowMs,
      updatedAtMs: args.nowMs,
      expiresAtMs: args.nowMs + 24 * 60 * 60_000,
    });
    return { state: "admitted", drawSessionId: sessionId, launchSecret };
  }
  const kind = args.command === "zap" ? "video" : "image";
  const price = args.command === "zap" ? 100 : 50;
  const usage = await ctx.db.query("creativeUsage").withIndex("by_user_kind_admitted", (q) => q.eq("userId", args.userId).eq("kind", kind)).take(100);
  const free = usage.filter((item) => item.admittedAtMs > args.nowMs - 24 * 60 * 60 * 1_000).length < 10;
  let source: "free" | "credit" | "payment" = free ? "free" : "payment";
  if (!free) {
    const ledger = await ctx.db.query("creativeCreditLedger").withIndex("by_user_created", (q) => q.eq("userId", args.userId)).collect();
    if (ledger.reduce((sum, item) => sum + item.amountCents, 0) >= price) source = "credit";
  }
  const reservationId = `${args.requestKey}:reservation`;
  const jobId = await ctx.db.insert("creativeJobs", {
    userId: args.userId,
    threadId: args.threadId,
    sourceMessageId: args.sourceMessageId,
    turnId: args.turnId,
    requestKey: args.requestKey,
    command: args.command,
    state: source === "payment" ? "awaiting_payment" : "admitted",
    encryptedPayload: args.encryptedPayload,
    reservationSource: source,
    reservedCents: source === "free" ? 0 : price,
    reservationId,
    createdAtMs: args.nowMs,
    updatedAtMs: args.nowMs,
    expiresAtMs: args.nowMs + 24 * 60 * 60 * 1_000,
  });
  if (source === "free") await ctx.db.insert("creativeUsage", { userId: args.userId, kind, jobId, reservationId, admittedAtMs: args.nowMs, settled: false });
  if (source === "credit") await ctx.db.insert("creativeCreditLedger", { userId: args.userId, jobId, kind: "reserve", amountCents: -price, idempotencyKey: reservationId, createdAtMs: args.nowMs });
  let topupOrderId: string | undefined;
  if (source === "payment") {
    topupOrderId = `ct_${args.requestKey.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(-48)}`;
    await ctx.db.insert("creativeTopups", {
      userId: args.userId,
      orderId: topupOrderId,
      paymentPath: "checkout",
      status: "created",
      chargeCents: 999,
      creditCents: 1000,
      savedJobId: jobId,
      createdAtMs: args.nowMs,
      updatedAtMs: args.nowMs,
    });
  }
  return { state: source === "payment" ? "awaiting_payment" : "admitted", topupOrderId };
}

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
