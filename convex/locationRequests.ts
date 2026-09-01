import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { internalAction, internalMutation } from "./_generated/server";
import { isServingExperienceEligible } from "./lib/servingEligibility";

const RESOLUTION_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 40_000, 80_000, 120_000];

function activeRequest(request: {
  expiresAtMs: number;
  state: string;
}, nowMs: number): boolean {
  return (
    request.expiresAtMs > nowMs &&
    (request.state === "pending_provider" ||
      request.state === "awaiting_share" ||
      request.state === "resolving")
  );
}

function stageKey(
  turnId: Id<"coastTurns">,
  sequence: number,
  stage: "response" | "experience_card" | "calendar_attachment" | "maps_card",
  itemKey: string,
): string {
  return `${turnId}:${sequence}:${stage}:${itemKey}`;
}

export const claimForResolution = internalMutation({
  args: { requestId: v.id("coastLocationRequests"), nowMs: v.number() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (request === null) return null;
    if (!activeRequest(request, args.nowMs)) {
      if (request.state !== "consumed" && request.state !== "cancelled") {
        await ctx.db.patch(request._id, {
          state: "expired",
          updatedAtMs: args.nowMs,
          lastErrorCode: "LOCATION_REQUEST_EXPIRED",
        });
      }
      return null;
    }
    const thread = await ctx.db.get(request.threadId);
    if (thread === null) return null;
    await ctx.db.patch(request._id, {
      state: "resolving",
      updatedAtMs: args.nowMs,
      lastErrorCode: undefined,
    });
    return {
      requestId: request._id,
      revision: request.revision,
      encryptedThreadRef: thread.encryptedProviderThreadRef,
      purpose: request.purpose,
      entityType: request.entityType,
      searchText: request.searchText ?? null,
      targetExternalId: request.targetExternalId ?? null,
      travelMode: request.travelMode,
      expiresAtMs: request.expiresAtMs,
    };
  },
});

export const releaseResolution = internalMutation({
  args: {
    requestId: v.id("coastLocationRequests"),
    errorCode: v.optional(v.string()),
    nowMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (request === null || request.state !== "resolving") return null;
    if (request.expiresAtMs <= args.nowMs) {
      await ctx.db.patch(request._id, {
        state: "expired",
        updatedAtMs: args.nowMs,
        ...(args.errorCode ? { lastErrorCode: args.errorCode.slice(0, 120) } : {}),
      });
      return null;
    }
    await ctx.db.patch(request._id, {
      state: "awaiting_share",
      updatedAtMs: args.nowMs,
      ...(args.errorCode ? { lastErrorCode: args.errorCode.slice(0, 120) } : {}),
    });
    return null;
  },
});

export const completeNearby = internalMutation({
  args: {
    requestId: v.id("coastLocationRequests"),
    expectedRevision: v.number(),
    selectedExternalIds: v.array(v.string()),
    nowMs: v.number(),
  },
  returns: v.union(v.id("coastTurns"), v.null()),
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (
      request === null ||
      request.state !== "resolving" ||
      request.revision !== args.expectedRevision ||
      request.expiresAtMs <= args.nowMs
    ) {
      return null;
    }
    const cards = [];
    for (const externalId of [...new Set(args.selectedExternalIds)].slice(0, 5)) {
      const card = await ctx.db
        .query("sfExperienceCards")
        .withIndex("by_externalId", (q) => q.eq("externalId", externalId))
        .unique();
      if (card !== null && isServingExperienceEligible(card, args.nowMs)) cards.push(card);
    }
    const responseText = cards.length
      ? "I found a few source-backed moves close to you. Pick one and I’ll map it out."
      : "I’m not seeing a source-backed move close enough right now. Try a neighborhood or a different vibe and I’ll widen the search.";
    const turnId = await ctx.db.insert("coastTurns", {
      userId: request.userId,
      threadId: request.threadId,
      state: "response_planned",
      revision: 1,
      messageIds: [],
      carryForwardTurnIds: [request.sourceTurnId],
      origin: "inbound",
      plan: {
        responseText,
        selectedExternalIds: cards.map((card) => card.externalId),
        poll: null,
        preferenceUpdates: [],
        provenanceIds: cards.flatMap((card) => card.inferred.provenanceIds),
        modelRoute: "luna_low",
        routeReasons: ["privacy_safe_nearby_resolver"],
        modelSteps: 0,
        toolCalls: 0,
        retrievalMode: "observed",
      },
      scheduledForMs: args.nowMs,
      planPersistedAtMs: args.nowMs,
      attemptCount: 0,
      createdAtMs: args.nowMs,
      updatedAtMs: args.nowMs,
    });
    const stages: Array<{
      stage: "response" | "experience_card" | "calendar_attachment";
      itemKey: string;
      payload: Record<string, unknown>;
    }> = [{ stage: "response", itemKey: "response", payload: { text: responseText } }];
    for (const card of cards) {
      stages.push({
        stage: "experience_card",
        itemKey: card.externalId,
        payload: { externalId: card.externalId },
      });
      if (card.inferred.entityType === "event" && card.inferred.startAtUtcMs !== null) {
        stages.push({
          stage: "calendar_attachment",
          itemKey: card.externalId,
          payload: { externalId: card.externalId },
        });
      }
    }
    for (const [sequence, stage] of stages.entries()) {
      await ctx.db.insert("outboundDeliveries", {
        turnId,
        threadId: request.threadId,
        stage: stage.stage,
        sequence,
        itemKey: stage.itemKey,
        idempotencyKey: stageKey(turnId, sequence, stage.stage, stage.itemKey),
        payload: stage.payload,
        status: "pending",
        attemptCount: 0,
        nextAttemptAtMs: args.nowMs,
        createdAtMs: args.nowMs,
        updatedAtMs: args.nowMs,
      });
    }
    await ctx.db.patch(request._id, {
      state: "consumed",
      consumedAtMs: args.nowMs,
      updatedAtMs: args.nowMs,
      lastErrorCode: undefined,
    });
    await ctx.db.patch(request.threadId, { activeTurnId: turnId, updatedAtMs: args.nowMs });
    await ctx.scheduler.runAfter(0, internal.turnQueue.deliverTurn, { turnId });
    return turnId;
  },
});

export const completeDirections = internalMutation({
  args: {
    requestId: v.id("coastLocationRequests"),
    expectedRevision: v.number(),
    nowMs: v.number(),
  },
  returns: v.union(v.id("coastTurns"), v.null()),
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (
      request === null ||
      request.state !== "resolving" ||
      request.revision !== args.expectedRevision ||
      request.targetExternalId === undefined ||
      request.expiresAtMs <= args.nowMs
    ) {
      return null;
    }
    const card = await ctx.db
      .query("sfExperienceCards")
      .withIndex("by_externalId", (q) => q.eq("externalId", request.targetExternalId!))
      .unique();
    if (card === null || !isServingExperienceEligible(card, args.nowMs)) {
      await ctx.db.patch(request._id, {
        state: "failed",
        updatedAtMs: args.nowMs,
        lastErrorCode: "DIRECTION_DESTINATION_UNAVAILABLE",
      });
      return null;
    }
    const responseText = `Here’s the ${request.travelMode} route to ${card.observed.title}.`;
    const turnId = await ctx.db.insert("coastTurns", {
      userId: request.userId,
      threadId: request.threadId,
      state: "response_planned",
      revision: 1,
      messageIds: [],
      carryForwardTurnIds: [request.sourceTurnId],
      origin: "inbound",
      plan: {
        responseText,
        selectedExternalIds: [card.externalId],
        poll: null,
        preferenceUpdates: [],
        provenanceIds: card.inferred.provenanceIds,
        modelRoute: "luna_low",
        routeReasons: ["privacy_safe_directions_resolver"],
        modelSteps: 0,
        toolCalls: 0,
        retrievalMode: "observed",
      },
      scheduledForMs: args.nowMs,
      planPersistedAtMs: args.nowMs,
      attemptCount: 0,
      createdAtMs: args.nowMs,
      updatedAtMs: args.nowMs,
    });
    const stages = [
      { stage: "response" as const, itemKey: "response", payload: { text: responseText } },
      {
        stage: "maps_card" as const,
        itemKey: card.externalId,
        payload: { externalId: card.externalId, travelMode: request.travelMode },
      },
    ];
    for (const [sequence, stage] of stages.entries()) {
      await ctx.db.insert("outboundDeliveries", {
        turnId,
        threadId: request.threadId,
        stage: stage.stage,
        sequence,
        itemKey: stage.itemKey,
        idempotencyKey: stageKey(turnId, sequence, stage.stage, stage.itemKey),
        payload: stage.payload,
        status: "pending",
        attemptCount: 0,
        nextAttemptAtMs: args.nowMs,
        createdAtMs: args.nowMs,
        updatedAtMs: args.nowMs,
      });
    }
    await ctx.db.patch(request._id, {
      state: "consumed",
      consumedAtMs: args.nowMs,
      updatedAtMs: args.nowMs,
      lastErrorCode: undefined,
    });
    await ctx.db.patch(request.threadId, { activeTurnId: turnId, updatedAtMs: args.nowMs });
    await ctx.scheduler.runAfter(0, internal.turnQueue.deliverTurn, { turnId });
    return turnId;
  },
});

export const markRequestDelivered = internalMutation({
  args: {
    requestId: v.id("coastLocationRequests"),
    providerRequestMessageId: v.optional(v.string()),
    nowMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (request === null || request.state !== "pending_provider") return null;
    if (request.expiresAtMs <= args.nowMs) {
      await ctx.db.patch(request._id, { state: "expired", updatedAtMs: args.nowMs });
      return null;
    }
    await ctx.db.patch(request._id, {
      state: "awaiting_share",
      ...(args.providerRequestMessageId
        ? { providerRequestMessageId: args.providerRequestMessageId }
        : {}),
      updatedAtMs: args.nowMs,
    });
    for (const delayMs of RESOLUTION_DELAYS_MS) {
      await ctx.scheduler.runAfter(delayMs, internal.locationRequests.resolve, {
        requestId: request._id,
      });
    }
    return null;
  },
});

export const resolve = internalAction({
  args: { requestId: v.id("coastLocationRequests") },
  returns: v.null(),
  handler: async (_ctx, args) => {
    const deliveryUrl = process.env.COAST_DELIVERY_URL;
    const serviceSecret = process.env.COAST_CONVEX_SERVICE_SECRET;
    if (!deliveryUrl || !serviceSecret) return null;
    const resolverUrl = new URL("/api/internal/location/resolve", deliveryUrl).toString();
    try {
      await fetch(resolverUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ requestId: args.requestId }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // Scheduled bounded retries remain authoritative; do not retain errors
      // that could accidentally reveal provider location state.
    }
    return null;
  },
});

export async function expediteLocationRequestForThread(
  ctx: MutationCtx,
  threadId: Id<"coastThreads">,
  nowMs: number,
  coarseNeighborhoodId?: string,
): Promise<Id<"coastLocationRequests"> | null> {
  const candidates = [];
  for (const state of ["pending_provider", "awaiting_share", "resolving"] as const) {
    candidates.push(
      ...(await ctx.db
        .query("coastLocationRequests")
        .withIndex("by_thread_state", (q) => q.eq("threadId", threadId).eq("state", state))
        .take(5)),
    );
  }
  const request = candidates
    .filter((candidate) => activeRequest(candidate, nowMs))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
  if (request === undefined) return null;
  if (coarseNeighborhoodId && request.purpose === "nearby_search") {
    await ctx.db.patch(request._id, {
      searchText: `neighborhood:${coarseNeighborhoodId}`,
      revision: request.revision + 1,
      updatedAtMs: nowMs,
      lastErrorCode: undefined,
    });
  }
  await ctx.scheduler.runAfter(0, internal.locationRequests.resolve, {
    requestId: request._id,
  });
  return request._id;
}

export const expediteThreadRequest = internalMutation({
  args: { threadId: v.id("coastThreads"), nowMs: v.number() },
  returns: v.union(v.id("coastLocationRequests"), v.null()),
  handler: async (ctx, args) =>
    await expediteLocationRequestForThread(ctx, args.threadId, args.nowMs),
});

export async function cancelActiveLocationRequestsForUser(
  ctx: MutationCtx,
  userId: Id<"coastUsers">,
  nowMs: number,
  reason: string,
): Promise<void> {
  const requests = await ctx.db
    .query("coastLocationRequests")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(50);
  for (const request of requests) {
    if (activeRequest(request, nowMs)) {
      await ctx.db.patch(request._id, {
        state: "cancelled",
        cancelledAtMs: nowMs,
        updatedAtMs: nowMs,
        lastErrorCode: reason.slice(0, 120),
      });
    }
  }
}

export async function cancelActiveLocationRequestsForThread(
  ctx: MutationCtx,
  threadId: Id<"coastThreads">,
  nowMs: number,
  reason: string,
): Promise<void> {
  for (const state of ["pending_provider", "awaiting_share", "resolving"] as const) {
    const requests = await ctx.db
      .query("coastLocationRequests")
      .withIndex("by_thread_state", (q) => q.eq("threadId", threadId).eq("state", state))
      .take(20);
    for (const request of requests) {
      if (activeRequest(request, nowMs)) {
        await ctx.db.patch(request._id, {
          state: "cancelled",
          cancelledAtMs: nowMs,
          updatedAtMs: nowMs,
          lastErrorCode: reason.slice(0, 120),
        });
      }
    }
  }
}
