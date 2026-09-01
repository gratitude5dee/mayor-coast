import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { isServingExperienceEligible } from "./lib/servingEligibility";
import { turnPlan } from "./lib/validators";

const MAX_MODEL_STEPS = 2;
const MAX_TOOL_CALLS = 4;
const MAX_SELECTED_RESULTS = 5;
const MAX_PREFERENCES_PER_TURN = 10;
const MAX_CONTEXT_MESSAGES = 20;
const MAX_CONTEXT_PREFERENCES = 50;
const MAX_GENERATION_ATTEMPTS = 3;
const AGENT_RUNTIME_DEADLINE_MS = 2_600;
const MAX_DELIVERY_ATTEMPTS = 5;
const POLL_TTL_MS = 24 * 60 * 60 * 1_000;
const DECISION_PROPOSAL_TTL_MS = 2 * 60 * 60 * 1_000;
const RAW_TEXT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const LOCATION_RESOLUTION_DELAYS_MS = [
  2_000,
  5_000,
  10_000,
  20_000,
  40_000,
  80_000,
  120_000,
];

type RuntimeTurnPlan = {
  responseText: string;
  selectedExternalIds: string[];
  poll: { question: string; options: string[] } | null;
  preferenceUpdates: Array<{
    namespace: string;
    key: string;
    value: unknown;
    confidence: number;
    source: "explicit" | "inferred";
  }>;
  provenanceIds: string[];
  modelRoute: "luna_high_fast" | "terra_low";
  routeReasons: string[];
  modelSteps: number;
  toolCalls: number;
  retrievalMode: "observed" | "inferred_fallback" | "none";
  generationKind: "model" | "deterministic" | "deadline_fallback";
  elapsedMs: number;
  serviceTier: string | null;
  nextAction?:
    | { type: "none" }
    | {
        type: "request_location";
        purpose: "nearby_search" | "directions";
        targetExternalId?: string;
        travelMode?: "walking" | "driving" | "transit" | "bicycling";
      }
    | {
        type: "create_calendar";
        targetExternalId: string;
        startAtMs: number;
        endAtMs?: number | null;
      };
};

function parseRuntimePlan(value: unknown): RuntimeTurnPlan {
  if (typeof value !== "object" || value === null) throw new Error("INVALID_PLAN_OBJECT");
  const plan = value as Record<string, unknown>;
  const responseText = plan.responseText;
  const selectedExternalIds = plan.selectedExternalIds;
  const poll = plan.poll;
  const preferenceUpdates = plan.preferenceUpdates;
  const provenanceIds = plan.provenanceIds;
  const modelRoute = plan.modelRoute;
  const routeReasons = plan.routeReasons;
  const modelSteps = plan.modelSteps;
  const toolCalls = plan.toolCalls;
  const retrievalMode = plan.retrievalMode;
  const nextAction = plan.nextAction;

  if (typeof responseText !== "string" || responseText.length < 1 || responseText.length > 2_000) {
    throw new Error("INVALID_PLAN_RESPONSE_TEXT");
  }
  if (
    !Array.isArray(selectedExternalIds) ||
    selectedExternalIds.length > MAX_SELECTED_RESULTS ||
    !selectedExternalIds.every((id) => typeof id === "string")
  ) {
    throw new Error("INVALID_PLAN_SELECTIONS");
  }

  let normalizedNextAction: RuntimeTurnPlan["nextAction"];
  if (nextAction !== undefined) {
    if (typeof nextAction !== "object" || nextAction === null) {
      throw new Error("INVALID_PLAN_NEXT_ACTION");
    }
    const action = nextAction as Record<string, unknown>;
    if (action.type === "none") {
      normalizedNextAction = { type: "none" };
    } else if (
      action.type === "request_location" &&
      (action.purpose === "nearby_search" || action.purpose === "directions") &&
      (action.targetExternalId === undefined || typeof action.targetExternalId === "string") &&
      (action.travelMode === undefined ||
        action.travelMode === "walking" ||
        action.travelMode === "driving" ||
        action.travelMode === "transit" ||
        action.travelMode === "bicycling")
    ) {
      normalizedNextAction = {
        type: "request_location",
        purpose: action.purpose,
        ...(typeof action.targetExternalId === "string"
          ? { targetExternalId: action.targetExternalId.slice(0, 240) }
          : {}),
        ...(typeof action.travelMode === "string"
          ? { travelMode: action.travelMode }
          : {}),
      };
    } else if (
      action.type === "create_calendar" &&
      typeof action.targetExternalId === "string" &&
      typeof action.startAtMs === "number" &&
      Number.isFinite(action.startAtMs) &&
      (action.endAtMs === undefined || action.endAtMs === null ||
        (typeof action.endAtMs === "number" && Number.isFinite(action.endAtMs)))
    ) {
      normalizedNextAction = {
        type: "create_calendar",
        targetExternalId: action.targetExternalId.slice(0, 240),
        startAtMs: Math.floor(action.startAtMs),
        ...(action.endAtMs === undefined
          ? {}
          : { endAtMs: action.endAtMs === null ? null : Math.floor(action.endAtMs as number) }),
      };
    } else {
      throw new Error("INVALID_PLAN_NEXT_ACTION");
    }
  }
  if (
    !Array.isArray(provenanceIds) ||
    !provenanceIds.every((id) => typeof id === "string")
  ) {
    throw new Error("INVALID_PLAN_PROVENANCE");
  }
  if (!Array.isArray(routeReasons) || !routeReasons.every((reason) => typeof reason === "string")) {
    throw new Error("INVALID_PLAN_ROUTE_REASONS");
  }
  if (modelRoute !== "luna_high_fast" && modelRoute !== "terra_low") {
    throw new Error("INVALID_PLAN_MODEL_ROUTE");
  }
  if (
    retrievalMode !== "observed" &&
    retrievalMode !== "inferred_fallback" &&
    retrievalMode !== "none"
  ) {
    throw new Error("INVALID_PLAN_RETRIEVAL_MODE");
  }
  if (
    typeof modelSteps !== "number" ||
    !Number.isInteger(modelSteps) ||
    modelSteps < 0 ||
    modelSteps > MAX_MODEL_STEPS ||
    typeof toolCalls !== "number" ||
    !Number.isInteger(toolCalls) ||
    toolCalls < 0 ||
    toolCalls > MAX_TOOL_CALLS
  ) {
    throw new Error("INVALID_PLAN_BUDGET");
  }
  const generationKind = plan.generationKind;
  const elapsedMs = plan.elapsedMs;
  const serviceTier = plan.serviceTier;
  if (
    (generationKind !== "model" &&
      generationKind !== "deterministic" &&
      generationKind !== "deadline_fallback") ||
    typeof elapsedMs !== "number" ||
    !Number.isInteger(elapsedMs) ||
    elapsedMs < 0 ||
    elapsedMs > 10_000 ||
    (serviceTier !== null && typeof serviceTier !== "string")
  ) {
    throw new Error("INVALID_PLAN_LATENCY_METADATA");
  }

  let normalizedPoll: RuntimeTurnPlan["poll"] = null;
  if (poll !== null) {
    if (typeof poll !== "object") throw new Error("INVALID_PLAN_POLL");
    const pollRecord = poll as Record<string, unknown>;
    if (
      typeof pollRecord.question !== "string" ||
      !Array.isArray(pollRecord.options) ||
      pollRecord.options.length < 2 ||
      pollRecord.options.length > 6 ||
      !pollRecord.options.every((option) => typeof option === "string")
    ) {
      throw new Error("INVALID_PLAN_POLL");
    }
    normalizedPoll = {
      question: pollRecord.question.slice(0, 120),
      options: [...new Set(pollRecord.options.map((option) => option.slice(0, 80)))],
    };
    if (normalizedPoll.options.length < 2) throw new Error("INVALID_PLAN_POLL_OPTIONS");
  }

  if (!Array.isArray(preferenceUpdates) || preferenceUpdates.length > MAX_PREFERENCES_PER_TURN) {
    throw new Error("INVALID_PLAN_PREFERENCES");
  }
  const normalizedPreferences: RuntimeTurnPlan["preferenceUpdates"] = [];
  for (const update of preferenceUpdates) {
    if (typeof update !== "object" || update === null) throw new Error("INVALID_PREFERENCE");
    const record = update as Record<string, unknown>;
    if (
      typeof record.namespace !== "string" ||
      typeof record.key !== "string" ||
      typeof record.confidence !== "number" ||
      (record.source !== "explicit" && record.source !== "inferred")
    ) {
      throw new Error("INVALID_PREFERENCE");
    }
    normalizedPreferences.push({
      namespace: record.namespace.slice(0, 64),
      key: record.key.slice(0, 64),
      value: record.value,
      confidence: Math.max(0, Math.min(1, record.confidence)),
      source: record.source,
    });
  }

  return {
    responseText,
    selectedExternalIds: [...new Set(selectedExternalIds)].slice(0, MAX_SELECTED_RESULTS),
    poll: normalizedPoll,
    preferenceUpdates: normalizedPreferences,
    provenanceIds: [...new Set(provenanceIds)].slice(0, 100),
    modelRoute,
    routeReasons: routeReasons.slice(0, 8).map((reason) => reason.slice(0, 120)),
    modelSteps,
    toolCalls,
    retrievalMode,
    generationKind,
    elapsedMs,
    serviceTier: serviceTier === null ? null : serviceTier.slice(0, 80),
    ...(normalizedNextAction === undefined ? {} : { nextAction: normalizedNextAction }),
  };
}

function stageRank(
  stage:
    | "response"
    | "results"
    | "experience_card"
    | "calendar_attachment"
    | "reservation_action"
    | "location_request"
    | "maps_card"
    | "poll",
): number {
  if (stage === "response") return 0;
  if (stage === "results" || stage === "experience_card") return 1;
  if (stage === "calendar_attachment") return 2;
  if (stage === "reservation_action") return 3;
  if (stage === "location_request" || stage === "maps_card") return 4;
  return 4;
}

function compactError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 120).replace(/https?:\/\/\S+/g, "[url]");
  return "UNKNOWN_FAILURE";
}

function retryDelayMs(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

export const claimGeneration = internalMutation({
  args: {
    turnId: v.id("coastTurns"),
    expectedRevision: v.number(),
    nowMs: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const turn = await ctx.db.get(args.turnId);
    if (
      turn === null ||
      turn.state !== "debouncing" ||
      turn.revision !== args.expectedRevision ||
      turn.scheduledForMs > args.nowMs
    ) {
      return false;
    }
    await ctx.db.patch(args.turnId, {
      state: "generating",
      generationStartedAtMs: args.nowMs,
      attemptCount: turn.attemptCount + 1,
      updatedAtMs: args.nowMs,
      lastErrorCode: undefined,
    });
    return true;
  },
});

export const getGenerationContext = internalQuery({
  args: { turnId: v.id("coastTurns") },
  returns: v.union(
    v.object({
      turnId: v.id("coastTurns"),
      threadId: v.id("coastThreads"),
      encryptedThreadRef: v.string(),
      messages: v.array(
        v.object({
          direction: v.union(v.literal("inbound"), v.literal("outbound")),
          body: v.string(),
          createdAtMs: v.number(),
        }),
      ),
      preferences: v.array(
        v.object({
          namespace: v.string(),
          key: v.string(),
          value: v.any(),
          confidence: v.number(),
          source: v.union(v.literal("explicit"), v.literal("inferred")),
        }),
      ),
      carryForwardTurnIds: v.array(v.id("coastTurns")),
      clarificationDepth: v.number(),
      priorSelections: v.array(
        v.object({
          items: v.array(
            v.object({ externalId: v.string(), title: v.string() }),
          ),
        }),
      ),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const turn = await ctx.db.get(args.turnId);
    if (turn === null || turn.state !== "generating") return null;
    const thread = await ctx.db.get(turn.threadId);
    if (thread === null) return null;

    const messages = await ctx.db
      .query("coastMessages")
      .withIndex("by_thread_created", (q) => q.eq("threadId", turn.threadId))
      .order("desc")
      .take(MAX_CONTEXT_MESSAGES);
    const preferences = await ctx.db
      .query("coastPreferences")
      .withIndex("by_user", (q) => q.eq("userId", turn.userId))
      .take(MAX_CONTEXT_PREFERENCES);
    const priorTurns = await ctx.db
      .query("coastTurns")
      .withIndex("by_thread_state_updated", (q) =>
        q.eq("threadId", turn.threadId).eq("state", "sent"),
      )
      .order("desc")
      .take(3);
    const priorSelections: Array<{
      items: Array<{ externalId: string; title: string }>;
    }> = [];
    for (const priorTurn of priorTurns.reverse()) {
      const externalIds = priorTurn.plan?.selectedExternalIds.slice(0, 5) ?? [];
      const items: Array<{ externalId: string; title: string }> = [];
      for (const externalId of externalIds) {
        const card = await ctx.db
          .query("sfExperienceCards")
          .withIndex("by_externalId", (q) => q.eq("externalId", externalId))
          .unique();
        if (card !== null) {
          items.push({ externalId: card.externalId, title: card.observed.title });
        }
      }
      if (items.length > 0) priorSelections.push({ items });
    }

    return {
      turnId: turn._id,
      threadId: thread._id,
      encryptedThreadRef: thread.encryptedProviderThreadRef,
      messages: messages
        .filter((message) => message.body !== null)
        .reverse()
        .map((message) => ({
          direction: message.direction,
          body: message.body as string,
          createdAtMs: message.createdAtMs,
        })),
      preferences: preferences.map((preference) => ({
        namespace: preference.namespace,
        key: preference.key,
        value: preference.value,
        confidence: preference.confidence,
        source: preference.source,
      })),
      carryForwardTurnIds: turn.carryForwardTurnIds,
      clarificationDepth: Math.max(0, Math.min(2, turn.clarificationDepth ?? 0)),
      priorSelections,
    };
  },
});

export const beginGeneration = internalAction({
  args: {
    turnId: v.id("coastTurns"),
    expectedRevision: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const nowMs = Date.now();
    const claimed = await ctx.runMutation(internal.turnQueue.claimGeneration, {
      ...args,
      nowMs,
    });
    if (!claimed) return null;

    const context = await ctx.runQuery(internal.turnQueue.getGenerationContext, {
      turnId: args.turnId,
    });
    if (context === null) return null;

    const runtimeUrl = process.env.COAST_AGENT_RUNTIME_URL;
    const serviceSecret = process.env.COAST_CONVEX_SERVICE_SECRET;
    if (!runtimeUrl || !serviceSecret) {
      await ctx.runMutation(internal.turnQueue.recordGenerationFailure, {
        turnId: args.turnId,
        expectedRevision: args.expectedRevision,
        errorCode: "AGENT_RUNTIME_NOT_CONFIGURED",
        nowMs: Date.now(),
      });
      return null;
    }

    try {
      const response = await fetch(runtimeUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          turnId: context.turnId,
          threadId: context.threadId,
          messages: context.messages,
          preferences: context.preferences,
          clarificationDepth: context.clarificationDepth,
          priorSelections: context.priorSelections,
          limits: { modelSteps: MAX_MODEL_STEPS, toolCalls: MAX_TOOL_CALLS },
        }),
        signal: AbortSignal.timeout(AGENT_RUNTIME_DEADLINE_MS),
      });
      if (!response.ok) throw new Error(`AGENT_RUNTIME_HTTP_${response.status}`);
      const plan = parseRuntimePlan(await response.json());
      await ctx.runMutation(internal.turnQueue.persistPlan, {
        turnId: args.turnId,
        expectedRevision: args.expectedRevision,
        plan,
        nowMs: Date.now(),
      });
    } catch (error) {
      await ctx.runMutation(internal.turnQueue.recordGenerationFailure, {
        turnId: args.turnId,
        expectedRevision: args.expectedRevision,
        errorCode: compactError(error),
        nowMs: Date.now(),
      });
    }
    return null;
  },
});

export const persistPlan = internalMutation({
  args: {
    turnId: v.id("coastTurns"),
    expectedRevision: v.number(),
    plan: turnPlan,
    nowMs: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const turn = await ctx.db.get(args.turnId);
    if (
      turn === null ||
      turn.state !== "generating" ||
      turn.revision !== args.expectedRevision ||
      args.plan.modelSteps > MAX_MODEL_STEPS ||
      args.plan.toolCalls > MAX_TOOL_CALLS ||
      args.plan.selectedExternalIds.length > MAX_SELECTED_RESULTS ||
      args.plan.preferenceUpdates.length > MAX_PREFERENCES_PER_TURN
    ) {
      return false;
    }
    if (args.plan.poll !== null && (turn.clarificationDepth ?? 0) >= 2) {
      throw new Error("CLARIFICATION_DEPTH_EXHAUSTED");
    }
    if (
      args.plan.poll !== null &&
      (args.plan.poll.options.length < 2 || args.plan.poll.options.length > 6)
    ) {
      throw new Error("INVALID_POLL_OPTION_COUNT");
    }

    const cards: Doc<"sfExperienceCards">[] = [];
    for (const externalId of [...new Set(args.plan.selectedExternalIds)]) {
      const card = await ctx.db
        .query("sfExperienceCards")
        .withIndex("by_externalId", (q) => q.eq("externalId", externalId))
        .unique();
      if (card === null || !isServingExperienceEligible(card, args.nowMs)) {
        continue;
      }
      cards.push(card);
    }

    let calendarCard: Doc<"sfExperienceCards"> | null = null;
    if (args.plan.nextAction?.type === "create_calendar") {
      const calendarAction = args.plan.nextAction;
      calendarCard = await ctx.db
        .query("sfExperienceCards")
        .withIndex("by_externalId", (q) =>
          q.eq("externalId", calendarAction.targetExternalId),
        )
        .unique();
      if (
        calendarCard === null ||
        !isServingExperienceEligible(calendarCard, args.nowMs) ||
        calendarAction.startAtMs < args.nowMs - 5 * 60_000 ||
        calendarAction.startAtMs > args.nowMs + 365 * 24 * 60 * 60_000
      ) {
        throw new Error("CALENDAR_TARGET_INVALID");
      }
    }

    const authoritativeProvenance = new Set(cards.flatMap((card) => card.inferred.provenanceIds));
    const safePlan = {
      ...args.plan,
      selectedExternalIds: cards.map((card) => card.externalId),
      provenanceIds: args.plan.provenanceIds.filter((id) => authoritativeProvenance.has(id)),
    };

    for (const update of safePlan.preferenceUpdates) {
      const existing = await ctx.db
        .query("coastPreferences")
        .withIndex("by_user_key", (q) =>
          q
            .eq("userId", turn.userId)
            .eq("namespace", update.namespace)
            .eq("key", update.key),
        )
        .unique();
      if (existing === null) {
        await ctx.db.insert("coastPreferences", {
          userId: turn.userId,
          ...update,
          createdAtMs: args.nowMs,
          updatedAtMs: args.nowMs,
        });
      } else {
        await ctx.db.patch(existing._id, {
          value: update.value,
          confidence: update.confidence,
          source: update.source,
          updatedAtMs: args.nowMs,
        });
      }
    }

    // Delivery is deliberately itemized.  A retry can therefore resume at an
    // individual card or calendar attachment without repeating the whole
    // recommendation set in a single noisy Markdown bubble.
    const stages: Array<{
      stage:
        | "response"
        | "experience_card"
        | "calendar_attachment"
        | "reservation_action"
        | "poll";
      itemKey: string;
      payload: Record<string, unknown>;
      sequence: number;
    }> = [
      {
        stage: "response",
        itemKey: "response",
        payload: { text: safePlan.responseText },
        sequence: 0,
      },
    ];

    for (const card of cards) {
      const cardSequence = stages.length;
      stages.push({
        stage: "experience_card",
        itemKey: card.externalId,
        payload: { externalId: card.externalId },
        sequence: cardSequence,
      });
      if (card.inferred.entityType === "event" && card.inferred.startAtUtcMs !== null) {
        stages.push({
          stage: "calendar_attachment",
          itemKey: card.externalId,
          payload: { externalId: card.externalId },
          sequence: stages.length,
        });
      }
    }
    if (calendarCard !== null && safePlan.nextAction?.type === "create_calendar") {
      stages.push({
        stage: "calendar_attachment",
        itemKey: `hold:${calendarCard.externalId}:${safePlan.nextAction.startAtMs}`,
        payload: {
          externalId: calendarCard.externalId,
          startAtMs: safePlan.nextAction.startAtMs,
          endAtMs: safePlan.nextAction.endAtMs ?? null,
        },
        sequence: stages.length,
      });
      stages.push({
        stage: "reservation_action",
        itemKey: calendarCard.externalId,
        payload: { externalId: calendarCard.externalId },
        sequence: stages.length,
      });
      const checkInAtMs = calendarCard.inferred.entityType === "event"
        ? Math.min(
            safePlan.nextAction.endAtMs ?? safePlan.nextAction.startAtMs + 90 * 60_000,
            safePlan.nextAction.startAtMs + 2 * 60 * 60_000,
          )
        : safePlan.nextAction.startAtMs + 90 * 60_000;
      if (
        checkInAtMs >= args.nowMs + 60_000 &&
        checkInAtMs <= args.nowMs + 12 * 60 * 60_000
      ) {
        const decisionId = await ctx.db.insert("coastDecisions", {
          userId: turn.userId,
          threadId: turn.threadId,
          sourceTurnId: turn._id,
          sourceMessageIds: turn.messageIds,
          experienceExternalId: calendarCard.externalId,
          entityType: calendarCard.inferred.entityType,
          status: "proposed",
          revision: 1,
          proposedAtMs: args.nowMs,
          updatedAtMs: args.nowMs,
          expiresAtMs: args.nowMs + DECISION_PROPOSAL_TTL_MS,
        });
        const question = "Want COAST to check in after?";
        const options = ["Yes—check in", "No thanks"];
        stages.push({
          stage: "poll",
          itemKey: `check-in:${calendarCard.externalId}`,
          payload: { question, options },
          sequence: stages.length,
        });
        await ctx.db.insert("coastPolls", {
          userId: turn.userId,
          threadId: turn.threadId,
          turnId: turn._id,
          question,
          options,
          purpose: "decision_confirm_checkin",
          decisionId,
          optionActions: [
            { option: options[0]!, action: "schedule_checkin", scheduledForMs: checkInAtMs },
            { option: options[1]!, action: "confirm_without_checkin" },
          ],
          status: "pending",
          createdAtMs: args.nowMs,
          expiresAtMs: args.nowMs + DECISION_PROPOSAL_TTL_MS,
        });
      }
    }
    if (safePlan.poll !== null) {
      stages.push({
        stage: "poll",
        itemKey: "poll",
        payload: { question: safePlan.poll.question, options: safePlan.poll.options },
        sequence: stages.length,
      });
      await ctx.db.insert("coastPolls", {
        userId: turn.userId,
        threadId: turn.threadId,
        turnId: turn._id,
        question: safePlan.poll.question,
        options: safePlan.poll.options,
        status: "pending",
        createdAtMs: args.nowMs,
        expiresAtMs: args.nowMs + POLL_TTL_MS,
      });
    }

    for (const stage of stages) {
      const idempotencyKey = `${turn._id}:${stage.sequence}:${stage.stage}:${stage.itemKey}`;
      const existing = await ctx.db
        .query("outboundDeliveries")
        .withIndex("by_idempotency", (q) => q.eq("idempotencyKey", idempotencyKey))
        .unique();
      if (existing === null) {
        await ctx.db.insert("outboundDeliveries", {
          turnId: turn._id,
          threadId: turn.threadId,
          stage: stage.stage,
          sequence: stage.sequence,
          itemKey: stage.itemKey,
          idempotencyKey,
          payload: stage.payload,
          status: "pending",
          attemptCount: 0,
          nextAttemptAtMs: args.nowMs,
          createdAtMs: args.nowMs,
          updatedAtMs: args.nowMs,
        });
      }
    }

    await ctx.db.patch(turn._id, {
      plan: safePlan,
      state: "response_planned",
      planPersistedAtMs: args.nowMs,
      updatedAtMs: args.nowMs,
      lastErrorCode: undefined,
      generationElapsedMs: args.plan.elapsedMs ?? 0,
      generationKind: args.plan.generationKind ?? "deterministic",
      ...(args.plan.serviceTier === undefined || args.plan.serviceTier === null
        ? {}
        : { actualServiceTier: args.plan.serviceTier }),
      ...(args.plan.generationKind === "deadline_fallback"
        ? { deadlineFallbackReason: "planning_deadline_or_fast_unavailable" }
        : {}),
    });
    await ctx.scheduler.runAfter(0, internal.turnQueue.deliverTurn, { turnId: turn._id });
    return true;
  },
});

export const recordGenerationFailure = internalMutation({
  args: {
    turnId: v.id("coastTurns"),
    expectedRevision: v.number(),
    errorCode: v.string(),
    nowMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const turn = await ctx.db.get(args.turnId);
    if (turn === null || turn.revision !== args.expectedRevision || turn.state !== "generating") {
      return null;
    }
    const terminal = turn.attemptCount >= MAX_GENERATION_ATTEMPTS;
    await ctx.db.patch(turn._id, {
      state: terminal ? "failed" : "debouncing",
      scheduledForMs: args.nowMs + retryDelayMs(turn.attemptCount),
      lastErrorCode: args.errorCode,
      updatedAtMs: args.nowMs,
    });
    await ctx.db.insert("failureAudit", {
      correlationId: `turn:${turn._id}:generation:${turn.attemptCount}`,
      component: "generation",
      code: args.errorCode.slice(0, 120),
      redactedMessage: "Agent runtime generation failed; message content omitted.",
      retryable: !terminal,
      userId: turn.userId,
      threadId: turn.threadId,
      turnId: turn._id,
      ...(turn.generationStartedAtMs === undefined
        ? {}
        : { elapsedMs: Math.max(0, args.nowMs - turn.generationStartedAtMs) }),
      createdAtMs: args.nowMs,
    });
    if (!terminal) {
      await ctx.scheduler.runAfter(
        retryDelayMs(turn.attemptCount),
        internal.turnQueue.beginGeneration,
        { turnId: turn._id, expectedRevision: turn.revision },
      );
    }
    return null;
  },
});

export const claimNextDelivery = internalMutation({
  args: { turnId: v.id("coastTurns"), nowMs: v.number() },
  returns: v.union(
    v.object({
      deliveryId: v.id("outboundDeliveries"),
      idempotencyKey: v.string(),
      stage: v.union(
        v.literal("response"),
        v.literal("results"),
        v.literal("experience_card"),
        v.literal("calendar_attachment"),
        v.literal("reservation_action"),
        v.literal("location_request"),
        v.literal("maps_card"),
        v.literal("poll"),
      ),
      payload: v.record(v.string(), v.any()),
      encryptedThreadRef: v.string(),
      attempt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const turn = await ctx.db.get(args.turnId);
    if (
      turn === null ||
      turn.state === "superseded" ||
      turn.state === "cancelled" ||
      turn.state === "failed" ||
      turn.state === "sent"
    ) {
      return null;
    }
    const thread = await ctx.db.get(turn.threadId);
    if (thread === null) return null;
    const deliveries = await ctx.db
      .query("outboundDeliveries")
      .withIndex("by_turn_stage", (q) => q.eq("turnId", turn._id))
      .take(24);
    const ordered = deliveries.sort(
      (a, b) =>
        (a.sequence ?? stageRank(a.stage)) - (b.sequence ?? stageRank(b.stage)) ||
        a._id.localeCompare(b._id),
    );
    const nextIndex = ordered.findIndex(
      (delivery) =>
        (delivery.status === "pending" || delivery.status === "failed") &&
        delivery.nextAttemptAtMs <= args.nowMs,
    );
    if (nextIndex < 0) {
      if (ordered.length > 0 && ordered.every((delivery) => delivery.status === "sent")) {
        await ctx.db.patch(turn._id, {
          state: "sent",
          completedAtMs: args.nowMs,
          updatedAtMs: args.nowMs,
        });
      }
      return null;
    }
    const next = ordered[nextIndex];
    if (next === undefined) return null;
    const previous = ordered.slice(0, nextIndex);
    if (!previous.every((delivery) => delivery.status === "sent")) return null;

    const attempt = next.attemptCount + 1;
    await ctx.db.patch(next._id, {
      status: "sending",
      attemptCount: attempt,
      updatedAtMs: args.nowMs,
    });
    await ctx.db.patch(turn._id, {
      state: "sending",
      sendStartedAtMs: turn.sendStartedAtMs ?? args.nowMs,
      updatedAtMs: args.nowMs,
    });
    return {
      deliveryId: next._id,
      idempotencyKey: next.idempotencyKey,
      stage: next.stage,
      payload: next.payload,
      encryptedThreadRef: thread.encryptedProviderThreadRef,
      attempt,
    };
  },
});

export const deliverTurn = internalAction({
  args: { turnId: v.id("coastTurns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const delivery = await ctx.runMutation(internal.turnQueue.claimNextDelivery, {
      turnId: args.turnId,
      nowMs: Date.now(),
    });
    if (delivery === null) return null;

    const deliveryUrl = process.env.COAST_DELIVERY_URL;
    const serviceSecret = process.env.COAST_CONVEX_SERVICE_SECRET;
    if (!deliveryUrl || !serviceSecret) {
      await ctx.runMutation(internal.turnQueue.recordDeliveryFailure, {
        deliveryId: delivery.deliveryId,
        errorCode: "DELIVERY_RUNTIME_NOT_CONFIGURED",
        nowMs: Date.now(),
      });
      return null;
    }

    try {
      const response = await fetch(deliveryUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceSecret}`,
          "content-type": "application/json",
          "idempotency-key": delivery.idempotencyKey,
        },
        body: JSON.stringify({
          turnId: args.turnId,
          idempotencyKey: delivery.idempotencyKey,
          encryptedThreadRef: delivery.encryptedThreadRef,
          stage: delivery.stage,
          payload: delivery.payload,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`DELIVERY_HTTP_${response.status}`);
      const body = (await response.json()) as { providerMessageId?: unknown };
      const providerMessageId =
        typeof body.providerMessageId === "string" ? body.providerMessageId : undefined;
      await ctx.runMutation(internal.turnQueue.recordDeliverySuccess, {
        deliveryId: delivery.deliveryId,
        ...(providerMessageId === undefined ? {} : { providerMessageId }),
        nowMs: Date.now(),
      });
    } catch (error) {
      await ctx.runMutation(internal.turnQueue.recordDeliveryFailure, {
        deliveryId: delivery.deliveryId,
        errorCode: compactError(error),
        nowMs: Date.now(),
      });
    }
    return null;
  },
});

export const recordDeliverySuccess = internalMutation({
  args: {
    deliveryId: v.id("outboundDeliveries"),
    providerMessageId: v.optional(v.string()),
    nowMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (delivery === null || delivery.status === "sent" || delivery.status === "cancelled") {
      return null;
    }
    const turn = await ctx.db.get(delivery.turnId);
    if (turn === null || turn.state === "superseded") {
      await ctx.db.patch(delivery._id, { status: "cancelled", updatedAtMs: args.nowMs });
      return null;
    }
    await ctx.db.patch(delivery._id, {
      status: "sent",
      providerMessageId: args.providerMessageId,
      sentAtMs: args.nowMs,
      updatedAtMs: args.nowMs,
      lastErrorCode: undefined,
    });
    if (delivery.stage === "poll" && args.providerMessageId !== undefined) {
      const poll = await ctx.db
        .query("coastPolls")
        .withIndex("by_turn", (q) => q.eq("turnId", turn._id))
        .unique();
      if (poll !== null && poll.providerPollId === undefined) {
        await ctx.db.patch(poll._id, { providerPollId: args.providerMessageId });
      }
    }
    if (delivery.stage === "location_request") {
      const locationRequestId = delivery.payload.locationRequestId;
      if (typeof locationRequestId === "string") {
        const locationRequest = await ctx.db.get(
          locationRequestId as Id<"coastLocationRequests">,
        );
        if (locationRequest !== null && locationRequest.state === "pending_provider") {
          if (locationRequest.expiresAtMs <= args.nowMs) {
            await ctx.db.patch(locationRequest._id, {
              state: "expired",
              updatedAtMs: args.nowMs,
            });
          } else {
            await ctx.db.patch(locationRequest._id, {
              state: "awaiting_share",
              ...(args.providerMessageId
                ? { providerRequestMessageId: args.providerMessageId }
                : {}),
              updatedAtMs: args.nowMs,
            });
            for (const delayMs of LOCATION_RESOLUTION_DELAYS_MS) {
              await ctx.scheduler.runAfter(delayMs, internal.locationRequests.resolve, {
                requestId: locationRequest._id,
              });
            }
          }
        }
      }
    }
    const body =
      typeof delivery.payload.text === "string"
        ? delivery.payload.text
        : typeof delivery.payload.markdown === "string"
          ? delivery.payload.markdown
          : null;
    if (body !== null) {
      await ctx.db.insert("coastMessages", {
        userId: turn.userId,
        threadId: turn.threadId,
        turnId: turn._id,
        ...(args.providerMessageId === undefined
          ? {}
          : { providerMessageId: args.providerMessageId }),
        direction: "outbound",
        body,
        bodyExpiresAtMs: args.nowMs + RAW_TEXT_RETENTION_MS,
        createdAtMs: args.nowMs,
      });
    }
    await ctx.scheduler.runAfter(0, internal.turnQueue.deliverTurn, { turnId: turn._id });
    return null;
  },
});

export const recordDeliveryFailure = internalMutation({
  args: {
    deliveryId: v.id("outboundDeliveries"),
    errorCode: v.string(),
    nowMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (delivery === null || delivery.status === "sent" || delivery.status === "cancelled") {
      return null;
    }
    const turn = await ctx.db.get(delivery.turnId);
    if (turn === null) return null;
    const terminal = delivery.attemptCount >= MAX_DELIVERY_ATTEMPTS;
    const delayMs = retryDelayMs(delivery.attemptCount);
    await ctx.db.patch(delivery._id, {
      status: "failed",
      nextAttemptAtMs: args.nowMs + delayMs,
      lastErrorCode: args.errorCode,
      updatedAtMs: args.nowMs,
    });
    await ctx.db.insert("failureAudit", {
      correlationId: `delivery:${delivery._id}:${delivery.attemptCount}`,
      component: "delivery",
      code: args.errorCode.slice(0, 120),
      redactedMessage: "Photon delivery failed; payload omitted.",
      retryable: !terminal,
      userId: turn.userId,
      threadId: turn.threadId,
      turnId: turn._id,
      createdAtMs: args.nowMs,
    });
    if (terminal) {
      await ctx.db.patch(turn._id, {
        state: "failed",
        lastErrorCode: args.errorCode,
        updatedAtMs: args.nowMs,
      });
    } else {
      await ctx.scheduler.runAfter(delayMs, internal.turnQueue.deliverTurn, {
        turnId: turn._id,
      });
    }
    return null;
  },
});

export const getTurnStatus = internalQuery({
  args: { turnId: v.id("coastTurns") },
  returns: v.union(
    v.object({
      state: v.union(
        v.literal("debouncing"),
        v.literal("ready_generation"),
        v.literal("generating"),
        v.literal("response_planned"),
        v.literal("sending"),
        v.literal("sent"),
        v.literal("superseded"),
        v.literal("failed"),
        v.literal("cancelled"),
      ),
      revision: v.number(),
      attemptCount: v.number(),
      lastErrorCode: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const turn = await ctx.db.get(args.turnId);
    if (turn === null) return null;
    return {
      state: turn.state,
      revision: turn.revision,
      attemptCount: turn.attemptCount,
      lastErrorCode: turn.lastErrorCode ?? null,
    };
  },
});
