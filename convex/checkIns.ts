import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import { SF_EVENT_WINDOW_END_EXCLUSIVE_UTC_MS } from "./lib/servingEligibility";

const MIN_SCHEDULE_LEAD_MS = 60_000;
const MAX_SCHEDULE_HORIZON_MS = 12 * 60 * 60 * 1_000;
const EVENT_CHECK_IN_GRACE_MS = 2 * 60 * 60 * 1_000;
const ACTIVE_ANCHOR_TTL_MS = 6 * 60 * 60 * 1_000;
const RECORD_RETENTION_MS = 24 * 60 * 60 * 1_000;
const PROPOSAL_TTL_MS = 2 * 60 * 60 * 1_000;
const SNOOZE_MS = 30 * 60 * 1_000;
const MAX_SNOOZES = 2;
const WORK_BATCH = 50;

const runDueReference = makeFunctionReference<
  "mutation",
  { checkInId: Id<"coastCheckIns">; expectedRevision: number },
  boolean
>("checkIns:runDue");
const expireBatchReference = makeFunctionReference<
  "mutation",
  Record<string, never>,
  { deleted: number; expiredPolls: number; hasMore: boolean }
>("checkIns:expireBatch");

const activeCheckInStatuses = [
  "scheduled",
  "due",
  "awaiting_arrival",
  "suggesting",
] as const;
const activeCheckInStatusSet = new Set<string>(activeCheckInStatuses);

type SchedulePolicyInput = {
  entityType: "event" | "place";
  eventStartAtMs: number | null;
  nowMs: number;
  scheduledForMs: number;
};

export function isCheckInScheduleAllowed(input: SchedulePolicyInput): boolean {
  const { entityType, eventStartAtMs, nowMs, scheduledForMs } = input;
  if (!Number.isFinite(nowMs) || !Number.isFinite(scheduledForMs)) return false;
  if (!Number.isInteger(scheduledForMs)) return false;
  if (scheduledForMs < nowMs + MIN_SCHEDULE_LEAD_MS) return false;
  if (scheduledForMs > nowMs + MAX_SCHEDULE_HORIZON_MS) return false;

  if (entityType === "place") return true;
  if (eventStartAtMs === null || !Number.isFinite(eventStartAtMs)) return false;
  return (
    scheduledForMs >= eventStartAtMs &&
    scheduledForMs <= eventStartAtMs + EVENT_CHECK_IN_GRACE_MS &&
    scheduledForMs < SF_EVENT_WINDOW_END_EXCLUSIVE_UTC_MS
  );
}

type DueGuardInput = {
  checkInRevision: number;
  expectedRevision: number;
  nowMs: number;
  scheduledForMs: number;
  anchorExpiresAtMs: number;
  checkInStatus: string;
  decisionStatus: string;
  threadStatus: string;
  userStatus: string;
};

export function isDueCheckInClaimable(input: DueGuardInput): boolean {
  return (
    input.checkInStatus === "scheduled" &&
    input.checkInRevision === input.expectedRevision &&
    input.decisionStatus === "selected" &&
    input.userStatus === "active" &&
    input.threadStatus === "active" &&
    input.scheduledForMs <= input.nowMs &&
    input.anchorExpiresAtMs > input.nowMs
  );
}

function sanitizedReason(reason: string): string {
  return reason.replace(/[^a-z0-9_-]/giu, "_").slice(0, 64) || "cancelled";
}

async function cancelCheckInDocument(
  ctx: MutationCtx,
  checkInId: Id<"coastCheckIns">,
  nowMs: number,
  reason: string,
): Promise<boolean> {
  const checkIn = await ctx.db.get(checkInId);
  if (checkIn === null || !activeCheckInStatusSet.has(checkIn.status)) {
    return false;
  }
  await ctx.db.patch(checkInId, {
    status: "cancelled",
    revision: checkIn.revision + 1,
    cancelledAtMs: nowMs,
    updatedAtMs: nowMs,
    lastErrorCode: sanitizedReason(reason),
  });
  return true;
}

async function cancelActiveCheckInsForThread(
  ctx: MutationCtx,
  threadId: Id<"coastThreads">,
  nowMs: number,
  reason: string,
): Promise<number> {
  let cancelled = 0;
  for (const status of activeCheckInStatuses) {
    const checkIns = await ctx.db
      .query("coastCheckIns")
      .withIndex("by_thread_status", (q) =>
        q.eq("threadId", threadId).eq("status", status),
      )
      .take(WORK_BATCH);
    for (const checkIn of checkIns) {
      if (await cancelCheckInDocument(ctx, checkIn._id, nowMs, reason)) {
        cancelled += 1;
      }
    }
  }
  return cancelled;
}

/**
 * Shared by STOP and FORGET ME. User status is still the ultimate fail-closed
 * guard if an account somehow owns more than one bounded cancellation batch.
 */
export async function cancelActiveCheckInsForUser(
  ctx: MutationCtx,
  userId: Id<"coastUsers">,
  nowMs: number,
  reason: string,
): Promise<number> {
  let cancelled = 0;
  for (const status of activeCheckInStatuses) {
    const checkIns = await ctx.db
      .query("coastCheckIns")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", userId).eq("status", status),
      )
      .take(WORK_BATCH);
    for (const checkIn of checkIns) {
      if (await cancelCheckInDocument(ctx, checkIn._id, nowMs, reason)) {
        cancelled += 1;
      }
    }
  }

  for (const status of ["proposed", "selected"] as const) {
    const decisions = await ctx.db
      .query("coastDecisions")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", userId).eq("status", status),
      )
      .take(WORK_BATCH);
    for (const decision of decisions) {
      await ctx.db.patch(decision._id, {
        status: "cancelled",
        revision: decision.revision + 1,
        updatedAtMs: nowMs,
      });
    }
  }
  return cancelled;
}

export const proposeDecision = internalMutation({
  args: {
    userId: v.id("coastUsers"),
    threadId: v.id("coastThreads"),
    sourceTurnId: v.id("coastTurns"),
    sourceMessageIds: v.array(v.id("coastMessages")),
    experienceExternalId: v.string(),
    entityType: v.union(v.literal("event"), v.literal("place")),
    nowMs: v.number(),
  },
  returns: v.object({
    decisionId: v.id("coastDecisions"),
    revision: v.number(),
  }),
  handler: async (ctx, args) => {
    const [user, thread, turn] = await Promise.all([
      ctx.db.get(args.userId),
      ctx.db.get(args.threadId),
      ctx.db.get(args.sourceTurnId),
    ]);
    if (
      user?.status !== "active" ||
      thread?.status !== "active" ||
      thread.userId !== args.userId ||
      turn === null ||
      turn.userId !== args.userId ||
      turn.threadId !== args.threadId ||
      turn.plan === undefined ||
      !turn.plan.selectedExternalIds.includes(args.experienceExternalId)
    ) {
      throw new Error("DECISION_CONTEXT_NOT_ACTIVE");
    }
    if (args.sourceMessageIds.length < 1 || args.sourceMessageIds.length > 20) {
      throw new Error("DECISION_EVIDENCE_COUNT_INVALID");
    }
    for (const messageId of args.sourceMessageIds) {
      const message = await ctx.db.get(messageId);
      if (
        message === null ||
        message.userId !== args.userId ||
        message.threadId !== args.threadId
      ) {
        throw new Error("DECISION_EVIDENCE_INVALID");
      }
    }

    const card = await ctx.db
      .query("sfExperienceCards")
      .withIndex("by_externalId", (q) =>
        q.eq("externalId", args.experienceExternalId),
      )
      .unique();
    if (
      card === null ||
      card.lifecycleStatus !== "active" ||
      card.inferred.activeStatus !== "active" ||
      card.inferred.entityType !== args.entityType
    ) {
      throw new Error("DECISION_EXPERIENCE_NOT_ACTIVE");
    }

    const proposals = await ctx.db
      .query("coastDecisions")
      .withIndex("by_thread_status", (q) =>
        q.eq("threadId", args.threadId).eq("status", "proposed"),
      )
      .take(10);
    for (const proposal of proposals) {
      await ctx.db.patch(proposal._id, {
        status: "cancelled",
        revision: proposal.revision + 1,
        updatedAtMs: args.nowMs,
      });
    }

    const decisionId = await ctx.db.insert("coastDecisions", {
      userId: args.userId,
      threadId: args.threadId,
      sourceTurnId: args.sourceTurnId,
      sourceMessageIds: [...new Set(args.sourceMessageIds)],
      experienceExternalId: args.experienceExternalId,
      entityType: args.entityType,
      status: "proposed",
      revision: 1,
      proposedAtMs: args.nowMs,
      updatedAtMs: args.nowMs,
      expiresAtMs: args.nowMs + PROPOSAL_TTL_MS,
    });
    return { decisionId, revision: 1 };
  },
});

async function validateAnsweredSemanticPoll(
  ctx: MutationCtx,
  pollId: Id<"coastPolls">,
  decisionId: Id<"coastDecisions">,
  expectedAction:
    "confirm_without_checkin" | "schedule_checkin" | "reject_decision",
) {
  const poll = await ctx.db.get(pollId);
  if (
    poll === null ||
    poll.status !== "answered" ||
    poll.purpose !== "decision_confirm_checkin" ||
    poll.decisionId !== decisionId ||
    poll.selectedOption === undefined ||
    poll.optionActions === undefined
  ) {
    throw new Error("DECISION_CONSENT_POLL_INVALID");
  }
  const selectedAction = poll.optionActions.find(
    (option) => option.option === poll.selectedOption,
  );
  if (selectedAction?.action !== expectedAction) {
    throw new Error("DECISION_CONSENT_ACTION_INVALID");
  }
  return { poll, selectedAction };
}

async function supersedePriorDecision(
  ctx: MutationCtx,
  decisionId: Id<"coastDecisions">,
  threadId: Id<"coastThreads">,
  nowMs: number,
): Promise<void> {
  const selected = await ctx.db
    .query("coastDecisions")
    .withIndex("by_thread_status", (q) =>
      q.eq("threadId", threadId).eq("status", "selected"),
    )
    .take(10);
  for (const prior of selected) {
    if (prior._id === decisionId) continue;
    await ctx.db.patch(prior._id, {
      status: "superseded",
      revision: prior.revision + 1,
      supersededByDecisionId: decisionId,
      updatedAtMs: nowMs,
    });
  }
  await cancelActiveCheckInsForThread(
    ctx,
    threadId,
    nowMs,
    "decision_superseded",
  );
}

export const confirmWithoutCheckIn = internalMutation({
  args: {
    decisionId: v.id("coastDecisions"),
    expectedRevision: v.number(),
    confirmationPollId: v.id("coastPolls"),
    explicitChoice: v.literal(true),
    nowMs: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const decision = await ctx.db.get(args.decisionId);
    if (
      decision === null ||
      decision.status !== "proposed" ||
      decision.revision !== args.expectedRevision ||
      decision.expiresAtMs <= args.nowMs
    ) {
      return false;
    }
    const user = await ctx.db.get(decision.userId);
    if (user?.status !== "active") return false;
    await validateAnsweredSemanticPoll(
      ctx,
      args.confirmationPollId,
      decision._id,
      "confirm_without_checkin",
    );
    await supersedePriorDecision(
      ctx,
      decision._id,
      decision.threadId,
      args.nowMs,
    );
    await ctx.db.patch(decision._id, {
      status: "selected",
      revision: decision.revision + 1,
      selectedAtMs: args.nowMs,
      updatedAtMs: args.nowMs,
      expiresAtMs: args.nowMs + RECORD_RETENTION_MS,
    });
    return true;
  },
});

export const confirmAndSchedule = internalMutation({
  args: {
    decisionId: v.id("coastDecisions"),
    expectedRevision: v.number(),
    consentPollId: v.id("coastPolls"),
    explicitConsent: v.literal(true),
    nowMs: v.number(),
  },
  returns: v.union(
    v.object({ checkInId: v.id("coastCheckIns"), revision: v.number() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const decision = await ctx.db.get(args.decisionId);
    if (
      decision === null ||
      decision.status !== "proposed" ||
      decision.revision !== args.expectedRevision ||
      decision.expiresAtMs <= args.nowMs
    ) {
      return null;
    }
    const [user, thread] = await Promise.all([
      ctx.db.get(decision.userId),
      ctx.db.get(decision.threadId),
    ]);
    if (user?.status !== "active" || thread?.status !== "active") return null;

    const { selectedAction } = await validateAnsweredSemanticPoll(
      ctx,
      args.consentPollId,
      decision._id,
      "schedule_checkin",
    );
    const scheduledForMs = selectedAction.scheduledForMs;
    if (scheduledForMs === undefined) {
      throw new Error("CHECK_IN_SCHEDULE_MISSING");
    }

    const card = await ctx.db
      .query("sfExperienceCards")
      .withIndex("by_externalId", (q) =>
        q.eq("externalId", decision.experienceExternalId),
      )
      .unique();
    if (
      card === null ||
      card.lifecycleStatus !== "active" ||
      card.inferred.activeStatus !== "active" ||
      card.inferred.entityType !== decision.entityType ||
      card.lastVerifiedAtMs === null ||
      !card.inferred.h3R6 ||
      !card.inferred.h3R8 ||
      !isCheckInScheduleAllowed({
        entityType: decision.entityType,
        eventStartAtMs: card.inferred.startAtUtcMs,
        nowMs: args.nowMs,
        scheduledForMs,
      })
    ) {
      throw new Error("CHECK_IN_ANCHOR_OR_SCHEDULE_INVALID");
    }

    await supersedePriorDecision(
      ctx,
      decision._id,
      decision.threadId,
      args.nowMs,
    );
    const decisionRevision = decision.revision + 1;
    await ctx.db.patch(decision._id, {
      status: "selected",
      revision: decisionRevision,
      selectedAtMs: args.nowMs,
      updatedAtMs: args.nowMs,
      expiresAtMs: scheduledForMs + RECORD_RETENTION_MS,
    });

    const checkInId = await ctx.db.insert("coastCheckIns", {
      userId: decision.userId,
      threadId: decision.threadId,
      decisionId: decision._id,
      decisionRevision,
      consentPollId: args.consentPollId,
      status: "scheduled",
      revision: 1,
      snoozeCount: 0,
      scheduledForMs,
      consentedAtMs: args.nowMs,
      anchorExternalId: card.externalId,
      anchorEntityType: card.inferred.entityType,
      anchorTitle: card.observed.title.slice(0, 200),
      anchorH3R6: card.inferred.h3R6,
      anchorH3R8: card.inferred.h3R8,
      anchorContentHash: card.contentHash,
      anchorVerifiedAtMs: card.lastVerifiedAtMs,
      anchorExpiresAtMs: scheduledForMs + ACTIVE_ANCHOR_TTL_MS,
      createdAtMs: args.nowMs,
      updatedAtMs: args.nowMs,
      expiresAtMs: scheduledForMs + RECORD_RETENTION_MS,
    });
    await ctx.scheduler.runAt(scheduledForMs, runDueReference, {
      checkInId,
      expectedRevision: 1,
    });
    return { checkInId, revision: 1 };
  },
});

export const rejectDecision = internalMutation({
  args: {
    decisionId: v.id("coastDecisions"),
    expectedRevision: v.number(),
    confirmationPollId: v.id("coastPolls"),
    nowMs: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const decision = await ctx.db.get(args.decisionId);
    if (
      decision === null ||
      decision.status !== "proposed" ||
      decision.revision !== args.expectedRevision
    ) {
      return false;
    }
    await validateAnsweredSemanticPoll(
      ctx,
      args.confirmationPollId,
      decision._id,
      "reject_decision",
    );
    await ctx.db.patch(decision._id, {
      status: "cancelled",
      revision: decision.revision + 1,
      updatedAtMs: args.nowMs,
    });
    return true;
  },
});

export const runDue = internalMutation({
  args: {
    checkInId: v.id("coastCheckIns"),
    expectedRevision: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const checkIn = await ctx.db.get(args.checkInId);
    if (checkIn === null) return false;
    const nowMs = Date.now();
    if (
      checkIn.status !== "scheduled" ||
      checkIn.revision !== args.expectedRevision
    ) {
      return false;
    }
    if (checkIn.scheduledForMs > nowMs) {
      await ctx.scheduler.runAt(checkIn.scheduledForMs, runDueReference, args);
      return false;
    }
    const [decision, user, thread, card] = await Promise.all([
      ctx.db.get(checkIn.decisionId),
      ctx.db.get(checkIn.userId),
      ctx.db.get(checkIn.threadId),
      ctx.db
        .query("sfExperienceCards")
        .withIndex("by_externalId", (q) =>
          q.eq("externalId", checkIn.anchorExternalId),
        )
        .unique(),
    ]);
    if (
      decision === null ||
      user === null ||
      thread === null ||
      !isDueCheckInClaimable({
        checkInRevision: checkIn.revision,
        expectedRevision: args.expectedRevision,
        nowMs,
        scheduledForMs: checkIn.scheduledForMs,
        anchorExpiresAtMs: checkIn.anchorExpiresAtMs,
        checkInStatus: checkIn.status,
        decisionStatus: decision.status,
        threadStatus: thread.status,
        userStatus: user.status,
      }) ||
      checkIn.decisionRevision !== decision.revision ||
      card === null ||
      card.lifecycleStatus !== "active" ||
      card.inferred.activeStatus !== "active" ||
      card.inferred.entityType !== checkIn.anchorEntityType ||
      card.lastVerifiedAtMs === null ||
      !card.inferred.h3R6 ||
      !card.inferred.h3R8
    ) {
      await cancelCheckInDocument(ctx, checkIn._id, nowMs, "due_guard_failed");
      return false;
    }

    const proactiveTurnId = await ctx.db.insert("coastTurns", {
      userId: checkIn.userId,
      threadId: checkIn.threadId,
      state: "response_planned",
      revision: 1,
      messageIds: [],
      carryForwardTurnIds: [],
      clarificationDepth: 0,
      origin: "proactive",
      checkInId: checkIn._id,
      plan: {
        responseText: `How did ${card.observed.title.slice(0, 120)} land? I can line up the next move while you’re out.`,
        selectedExternalIds: [],
        poll: {
          question: "What’s the next move?",
          options: ["Drinks nearby", "Food nearby", "Something else", "I’m good"],
        },
        preferenceUpdates: [],
        provenanceIds: card.inferred.provenanceIds,
        modelRoute: "luna_high_fast",
        routeReasons: ["opt_in_post_recommendation_check_in"],
        modelSteps: 0,
        toolCalls: 0,
        retrievalMode: "observed",
        generationKind: "deterministic",
        elapsedMs: 0,
        serviceTier: null,
      },
      scheduledForMs: nowMs,
      generationElapsedMs: 0,
      generationKind: "deterministic",
      planPersistedAtMs: nowMs,
      attemptCount: 0,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    const arrivalPollId = await ctx.db.insert("coastPolls", {
      userId: checkIn.userId,
      threadId: checkIn.threadId,
      turnId: proactiveTurnId,
      question: "What’s the next move?",
      options: ["Drinks nearby", "Food nearby", "Something else", "I’m good"],
      purpose: "arrival_status",
      checkInId: checkIn._id,
      optionActions: [
        { option: "Drinks nearby", action: "arrived" },
        { option: "Food nearby", action: "arrived" },
        { option: "Something else", action: "arrived" },
        { option: "I’m good", action: "cancel_checkin" },
      ],
      status: "pending",
      createdAtMs: nowMs,
      expiresAtMs: checkIn.anchorExpiresAtMs,
    });
    const responseText = `How did ${card.observed.title.slice(0, 120)} land? I can line up the next move while you’re out.`;
    const deliveries = [
      { stage: "response" as const, itemKey: "response", payload: { text: responseText } },
      {
        stage: "poll" as const,
        itemKey: "next-move",
        payload: {
          question: "What’s the next move?",
          options: ["Drinks nearby", "Food nearby", "Something else", "I’m good"],
        },
      },
    ];
    for (const [sequence, delivery] of deliveries.entries()) {
      await ctx.db.insert("outboundDeliveries", {
        turnId: proactiveTurnId,
        threadId: checkIn.threadId,
        stage: delivery.stage,
        sequence,
        itemKey: delivery.itemKey,
        idempotencyKey: `${proactiveTurnId}:${sequence}:${delivery.stage}:${delivery.itemKey}`,
        payload: delivery.payload,
        status: "pending",
        attemptCount: 0,
        nextAttemptAtMs: nowMs,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
    }
    await ctx.db.patch(checkIn._id, {
      status: "awaiting_arrival",
      revision: checkIn.revision + 1,
      dueAtMs: nowMs,
      updatedAtMs: nowMs,
      anchorTitle: card.observed.title.slice(0, 200),
      anchorH3R6: card.inferred.h3R6,
      anchorH3R8: card.inferred.h3R8,
      anchorContentHash: card.contentHash,
      anchorVerifiedAtMs: card.lastVerifiedAtMs,
      arrivalPollId,
      proactiveTurnId,
    });
    await ctx.db.patch(thread._id, {
      activeTurnId: proactiveTurnId,
      lastProactiveAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    await ctx.scheduler.runAfter(0, internal.turnQueue.deliverTurn, {
      turnId: proactiveTurnId,
    });
    return true;
  },
});

/**
 * Future delivery integration must call this before creating a proactive turn.
 * Merely reaching the scheduled timestamp never sends a message.
 */
export const claimDue = internalMutation({
  args: { checkInId: v.id("coastCheckIns"), expectedRevision: v.number() },
  returns: v.union(
    v.object({
      checkInId: v.id("coastCheckIns"),
      revision: v.number(),
      userId: v.id("coastUsers"),
      threadId: v.id("coastThreads"),
      decisionId: v.id("coastDecisions"),
      anchorExternalId: v.string(),
      anchorTitle: v.string(),
      anchorH3R6: v.string(),
      anchorH3R8: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const checkIn = await ctx.db.get(args.checkInId);
    if (
      checkIn === null ||
      checkIn.status !== "due" ||
      checkIn.revision !== args.expectedRevision ||
      checkIn.anchorExpiresAtMs <= Date.now()
    ) {
      return null;
    }
    const [decision, user, thread] = await Promise.all([
      ctx.db.get(checkIn.decisionId),
      ctx.db.get(checkIn.userId),
      ctx.db.get(checkIn.threadId),
    ]);
    if (
      decision?.status !== "selected" ||
      decision.revision !== checkIn.decisionRevision ||
      user?.status !== "active" ||
      thread?.status !== "active"
    ) {
      await cancelCheckInDocument(
        ctx,
        checkIn._id,
        Date.now(),
        "claim_guard_failed",
      );
      return null;
    }
    const revision = checkIn.revision + 1;
    await ctx.db.patch(checkIn._id, {
      status: "awaiting_arrival",
      revision,
      updatedAtMs: Date.now(),
    });
    return {
      checkInId: checkIn._id,
      revision,
      userId: checkIn.userId,
      threadId: checkIn.threadId,
      decisionId: checkIn.decisionId,
      anchorExternalId: checkIn.anchorExternalId,
      anchorTitle: checkIn.anchorTitle,
      anchorH3R6: checkIn.anchorH3R6,
      anchorH3R8: checkIn.anchorH3R8,
    };
  },
});

export const applyArrivalPoll = internalMutation({
  args: {
    checkInId: v.id("coastCheckIns"),
    expectedRevision: v.number(),
    arrivalPollId: v.id("coastPolls"),
    nowMs: v.number(),
  },
  returns: v.union(
    v.literal("suggesting"),
    v.literal("scheduled"),
    v.literal("cancelled"),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const checkIn = await ctx.db.get(args.checkInId);
    const poll = await ctx.db.get(args.arrivalPollId);
    if (
      checkIn === null ||
      checkIn.status !== "awaiting_arrival" ||
      checkIn.revision !== args.expectedRevision ||
      poll === null ||
      poll.status !== "answered" ||
      poll.purpose !== "arrival_status" ||
      poll.checkInId !== checkIn._id ||
      poll.selectedOption === undefined ||
      poll.optionActions === undefined
    ) {
      return null;
    }
    const action = poll.optionActions.find(
      (option) => option.option === poll.selectedOption,
    )?.action;
    if (action === "arrived") {
      await ctx.db.patch(checkIn._id, {
        status: "suggesting",
        revision: checkIn.revision + 1,
        arrivalPollId: poll._id,
        updatedAtMs: args.nowMs,
      });
      return "suggesting";
    }
    if (action === "cancel_checkin") {
      await cancelCheckInDocument(
        ctx,
        checkIn._id,
        args.nowMs,
        "user_cancelled",
      );
      return "cancelled";
    }
    if (action === "snooze_30m") {
      const scheduledForMs = args.nowMs + SNOOZE_MS;
      if (
        checkIn.snoozeCount >= MAX_SNOOZES ||
        scheduledForMs >= checkIn.anchorExpiresAtMs
      ) {
        await cancelCheckInDocument(
          ctx,
          checkIn._id,
          args.nowMs,
          "snooze_limit",
        );
        return "cancelled";
      }
      const revision = checkIn.revision + 1;
      await ctx.db.patch(checkIn._id, {
        status: "scheduled",
        revision,
        snoozeCount: checkIn.snoozeCount + 1,
        scheduledForMs,
        arrivalPollId: poll._id,
        dueAtMs: undefined,
        updatedAtMs: args.nowMs,
      });
      await ctx.scheduler.runAt(scheduledForMs, runDueReference, {
        checkInId: checkIn._id,
        expectedRevision: revision,
      });
      return "scheduled";
    }
    return null;
  },
});

/** Apply only the last poll selection after the two-second change window. */
export const applySettledSemanticPoll = internalMutation({
  args: {
    pollId: v.id("coastPolls"),
    answerTurnId: v.id("coastTurns"),
    expectedTurnRevision: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const [poll, answerTurn] = await Promise.all([
      ctx.db.get(args.pollId),
      ctx.db.get(args.answerTurnId),
    ]);
    if (
      poll === null ||
      poll.status !== "answered" ||
      poll.answerTurnId !== args.answerTurnId ||
      answerTurn === null ||
      answerTurn.revision !== args.expectedTurnRevision ||
      !["debouncing", "generating"].includes(answerTurn.state) ||
      poll.selectedOption === undefined ||
      poll.optionActions === undefined
    ) return false;
    const selected = poll.optionActions.find((option) => option.option === poll.selectedOption);
    if (selected === undefined) return false;

    if (poll.purpose === "decision_confirm_checkin" && poll.decisionId !== undefined) {
      const decision = await ctx.db.get(poll.decisionId);
      if (decision === null || decision.status !== "proposed") return false;
      if (selected.action === "schedule_checkin") {
        await ctx.scheduler.runAfter(0, internal.checkIns.confirmAndSchedule, {
          decisionId: decision._id,
          expectedRevision: decision.revision,
          consentPollId: poll._id,
          explicitConsent: true,
          nowMs: Date.now(),
        });
      } else if (selected.action === "confirm_without_checkin") {
        await ctx.scheduler.runAfter(0, internal.checkIns.confirmWithoutCheckIn, {
          decisionId: decision._id,
          expectedRevision: decision.revision,
          confirmationPollId: poll._id,
          explicitChoice: true,
          nowMs: Date.now(),
        });
      } else if (selected.action === "reject_decision") {
        await ctx.scheduler.runAfter(0, internal.checkIns.rejectDecision, {
          decisionId: decision._id,
          expectedRevision: decision.revision,
          confirmationPollId: poll._id,
          nowMs: Date.now(),
        });
      }
      return true;
    }
    if (poll.purpose === "arrival_status" && poll.checkInId !== undefined) {
      const checkIn = await ctx.db.get(poll.checkInId);
      if (checkIn === null) return false;
      await ctx.scheduler.runAfter(0, internal.checkIns.applyArrivalPoll, {
        checkInId: checkIn._id,
        expectedRevision: checkIn.revision,
        arrivalPollId: poll._id,
        nowMs: Date.now(),
      });
      return true;
    }
    return false;
  },
});

export const markCompleted = internalMutation({
  args: {
    checkInId: v.id("coastCheckIns"),
    expectedRevision: v.number(),
    nowMs: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const checkIn = await ctx.db.get(args.checkInId);
    if (
      checkIn === null ||
      checkIn.status !== "suggesting" ||
      checkIn.revision !== args.expectedRevision
    ) {
      return false;
    }
    await ctx.db.patch(checkIn._id, {
      status: "completed",
      revision: checkIn.revision + 1,
      completedAtMs: args.nowMs,
      updatedAtMs: args.nowMs,
    });
    return true;
  },
});

export const cancel = internalMutation({
  args: {
    checkInId: v.id("coastCheckIns"),
    expectedRevision: v.number(),
    reason: v.string(),
    nowMs: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const checkIn = await ctx.db.get(args.checkInId);
    if (checkIn === null || checkIn.revision !== args.expectedRevision)
      return false;
    return await cancelCheckInDocument(
      ctx,
      checkIn._id,
      args.nowMs,
      args.reason,
    );
  },
});

export const recoverDue = internalMutation({
  args: {},
  returns: v.object({ scheduled: v.number() }),
  handler: async (ctx) => {
    const nowMs = Date.now();
    const checkIns = await ctx.db
      .query("coastCheckIns")
      .withIndex("by_status_schedule", (q) =>
        q.eq("status", "scheduled").lte("scheduledForMs", nowMs),
      )
      .take(WORK_BATCH);
    for (const checkIn of checkIns) {
      await ctx.scheduler.runAfter(0, runDueReference, {
        checkInId: checkIn._id,
        expectedRevision: checkIn.revision,
      });
    }
    return { scheduled: checkIns.length };
  },
});

export const expireBatch = internalMutation({
  args: {},
  returns: v.object({
    deleted: v.number(),
    expiredPolls: v.number(),
    hasMore: v.boolean(),
  }),
  handler: async (ctx) => {
    const nowMs = Date.now();
    let deleted = 0;

    const pendingPolls = await ctx.db
      .query("coastPolls")
      .withIndex("by_expiry", (q) =>
        q.eq("status", "pending").lt("expiresAtMs", nowMs),
      )
      .take(WORK_BATCH);
    for (const poll of pendingPolls) {
      await ctx.db.patch(poll._id, { status: "expired" });
    }

    const checkIns = await ctx.db
      .query("coastCheckIns")
      .withIndex("by_expiry", (q) => q.lt("expiresAtMs", nowMs))
      .take(WORK_BATCH);
    for (const checkIn of checkIns) {
      await ctx.db.delete(checkIn._id);
      deleted += 1;
    }

    const decisions = await ctx.db
      .query("coastDecisions")
      .withIndex("by_expiry", (q) => q.lt("expiresAtMs", nowMs))
      .take(WORK_BATCH);
    for (const decision of decisions) {
      const linkedCheckIn = await ctx.db
        .query("coastCheckIns")
        .withIndex("by_decision", (q) => q.eq("decisionId", decision._id))
        .first();
      if (linkedCheckIn === null) {
        await ctx.db.delete(decision._id);
        deleted += 1;
      }
    }

    const itineraries = await ctx.db
      .query("coastItineraries")
      .withIndex("by_expiry", (q) => q.lt("expiresAtMs", nowMs))
      .take(WORK_BATCH);
    for (const itinerary of itineraries) {
      await ctx.db.delete(itinerary._id);
      deleted += 1;
    }

    const hasMore =
      pendingPolls.length === WORK_BATCH ||
      checkIns.length === WORK_BATCH ||
      decisions.length === WORK_BATCH ||
      itineraries.length === WORK_BATCH;
    if (hasMore) {
      await ctx.scheduler.runAfter(0, expireBatchReference, {});
    }
    return { deleted, expiredPolls: pendingPolls.length, hasMore };
  },
});
