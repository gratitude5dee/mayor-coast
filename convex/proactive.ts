import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { isServingExperienceEligible } from "./lib/servingEligibility";

const SIX_HOURS_MS = 6 * 60 * 60_000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;
const POLL_TTL_MS = 24 * 60 * 60_000;
const MAX_THREADS_PER_RUN = 10;
const MAX_CARDS = 3;

export function isProactiveNudgeEligible(input: {
  latestInboundAtMs: number;
  lastProactiveAtMs?: number;
  nowMs: number;
  localHour: number;
  hasTasteSignal: boolean;
}): boolean {
  return input.hasTasteSignal &&
    input.localHour >= 10 &&
    input.localHour < 22 &&
    input.latestInboundAtMs <= input.nowMs - SIX_HOURS_MS &&
    input.latestInboundAtMs >= input.nowMs - THIRTY_DAYS_MS &&
    (input.lastProactiveAtMs === undefined ||
      input.lastProactiveAtMs <= input.nowMs - SIX_HOURS_MS);
}

export const scanIdle = internalMutation({
  args: {},
  handler: async (ctx) => {
    const nowMs = Date.now();
    const hour = Number(new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      hourCycle: "h23",
    }).format(new Date(nowMs)));
    if (hour < 10 || hour >= 22) return { scheduled: 0 };

    const { startAtMs, endAtMs } = sanFranciscoDayRange(nowMs);
    const eventCards = (await ctx.db
      .query("sfExperienceCards")
      .withIndex("by_kind_start", (q) =>
        q
          .eq("inferred.entityType", "event")
          .eq("inferred.activeStatus", "active")
          .gte("inferred.startAtUtcMs", startAtMs)
          .lt("inferred.startAtUtcMs", endAtMs),
      )
      .take(20))
      .filter((card) => isServingExperienceEligible(card, nowMs));
    if (eventCards.length === 0) return { scheduled: 0 };

    const threads = await ctx.db
      .query("coastThreads")
      .withIndex("by_status_inbound", (q) =>
        q.eq("status", "active").lte("latestInboundAtMs", nowMs - SIX_HOURS_MS),
      )
      .order("asc")
      .take(MAX_THREADS_PER_RUN * 2);
    let scheduled = 0;

    for (const thread of threads) {
      if (scheduled >= MAX_THREADS_PER_RUN) break;
      const user = await ctx.db.get(thread.userId);
      if (user?.status !== "active") continue;
      const [preferences, decisions] = await Promise.all([
        ctx.db.query("coastPreferences").withIndex("by_user", (q) => q.eq("userId", user._id)).take(20),
        ctx.db.query("coastDecisions").withIndex("by_user_status", (q) => q.eq("userId", user._id).eq("status", "selected")).take(10),
      ]);
      if (!isProactiveNudgeEligible({
        latestInboundAtMs: thread.latestInboundAtMs,
        ...(thread.lastProactiveAtMs === undefined ? {} : { lastProactiveAtMs: thread.lastProactiveAtMs }),
        nowMs,
        localHour: hour,
        hasTasteSignal: preferences.length > 0 || decisions.length > 0,
      })) continue;
      if (thread.activeTurnId !== undefined) {
        const active = await ctx.db.get(thread.activeTurnId);
        if (active !== null && !["sent", "cancelled", "failed", "superseded"].includes(active.state)) continue;
      }

      const tasteText = JSON.stringify(preferences.map((preference) => preference.value)).toLowerCase();
      const priorCards: Doc<"sfExperienceCards">[] = [];
      for (const decision of decisions.slice(0, 5)) {
        const card = await ctx.db.query("sfExperienceCards").withIndex("by_externalId", (q) => q.eq("externalId", decision.experienceExternalId)).unique();
        if (card !== null) priorCards.push(card);
      }
      const neighborhoods = new Set(priorCards.map((card) => card.inferred.neighborhoodId));
      const primaryTypes = new Set(priorCards.map((card) => card.inferred.primaryType).filter(Boolean));
      const ranked = [...eventCards]
        .map((card) => ({
          card,
          score:
            (neighborhoods.has(card.inferred.neighborhoodId) ? 4 : 0) +
            (primaryTypes.has(card.inferred.primaryType) ? 3 : 0) +
            (tasteText && tasteText.split(/[^a-z]+/u).some((token) => token.length > 3 && card.observed.retrievalTextObserved.toLowerCase().includes(token)) ? 2 : 0),
        }))
        .sort((left, right) => right.score - left.score ||
          (left.card.inferred.startAtUtcMs ?? 0) - (right.card.inferred.startAtUtcMs ?? 0) ||
          left.card.externalId.localeCompare(right.card.externalId))
        .slice(0, MAX_CARDS)
        .map(({ card }) => card);
      if (ranked.length === 0) continue;

      const turnId = await ctx.db.insert("coastTurns", {
        userId: user._id,
        threadId: thread._id,
        state: "response_planned",
        revision: 1,
        messageIds: [],
        carryForwardTurnIds: [],
        clarificationDepth: 0,
        origin: "proactive",
        plan: {
          responseText: "Quick COAST tap-in: a few things today line up with your past picks. Want me to narrow the lane?",
          selectedExternalIds: ranked.map((card) => card.externalId),
          poll: { question: "What sounds right?", options: ["Live music", "Nightlife", "Food & drinks", "Surprise me"] },
          preferenceUpdates: [],
          provenanceIds: [...new Set(ranked.flatMap((card) => card.inferred.provenanceIds))],
          modelRoute: "luna_high_fast",
          routeReasons: ["idle_six_hour_personalized_nudge"],
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
      const responseText = "Quick COAST tap-in: a few things today line up with your past picks. Want me to narrow the lane?";
      const stages: Array<{ stage: "response" | "experience_card" | "poll"; itemKey: string; payload: Record<string, unknown> }> = [
        { stage: "response", itemKey: "response", payload: { text: responseText } },
        ...ranked.map((card) => ({ stage: "experience_card" as const, itemKey: card.externalId, payload: { externalId: card.externalId } })),
        { stage: "poll", itemKey: "poll", payload: { question: "What sounds right?", options: ["Live music", "Nightlife", "Food & drinks", "Surprise me"] } },
      ];
      for (const [sequence, stage] of stages.entries()) {
        await ctx.db.insert("outboundDeliveries", {
          turnId, threadId: thread._id, stage: stage.stage, sequence, itemKey: stage.itemKey,
          idempotencyKey: `${turnId}:${sequence}:${stage.stage}:${stage.itemKey}`,
          payload: stage.payload, status: "pending", attemptCount: 0,
          nextAttemptAtMs: nowMs, createdAtMs: nowMs, updatedAtMs: nowMs,
        });
      }
      await ctx.db.insert("coastPolls", {
        userId: user._id, threadId: thread._id, turnId,
        question: "What sounds right?", options: ["Live music", "Nightlife", "Food & drinks", "Surprise me"],
        purpose: "clarification", status: "pending", createdAtMs: nowMs,
        expiresAtMs: nowMs + POLL_TTL_MS,
      });
      await ctx.db.patch(thread._id, { activeTurnId: turnId, lastProactiveAtMs: nowMs, updatedAtMs: nowMs });
      await ctx.scheduler.runAfter(0, internal.turnQueue.deliverTurn, { turnId });
      scheduled += 1;
    }
    return { scheduled };
  },
});

function sanFranciscoDayRange(nowMs: number): { startAtMs: number; endAtMs: number } {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(nowMs));
  const startAtMs = Date.parse(`${date}T00:00:00-07:00`);
  return { startAtMs, endAtMs: startAtMs + 24 * 60 * 60_000 };
}
