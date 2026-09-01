import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

const RECOVERY_BATCH = 20;
const CHAT_TTL_BATCH = 50;

export const recoverStalled = internalMutation({
  args: {},
  returns: v.object({ recovered: v.number(), expiredState: v.number() }),
  handler: async (ctx) => {
    const nowMs = Date.now();
    const staleBeforeMs = nowMs - 60_000;
    const runId = `recovery:${nowMs}`;
    const logId = await ctx.db.insert("cronRunLogs", {
      jobName: "recover_stalled",
      runId,
      state: "running",
      processedCount: 0,
      deletedCount: 0,
      recoveredCount: 0,
      startedAtMs: nowMs,
    });
    let recovered = 0;

    const debouncing = await ctx.db
      .query("coastTurns")
      .withIndex("by_state_updated", (q) => q.eq("state", "debouncing").lt("updatedAtMs", nowMs))
      .take(RECOVERY_BATCH);
    for (const turn of debouncing) {
      if (turn.scheduledForMs <= nowMs) {
        await ctx.scheduler.runAfter(0, internal.turnQueue.beginGeneration, {
          turnId: turn._id,
          expectedRevision: turn.revision,
        });
        recovered += 1;
      }
    }

    const generating = await ctx.db
      .query("coastTurns")
      .withIndex("by_state_updated", (q) =>
        q.eq("state", "generating").lt("updatedAtMs", staleBeforeMs),
      )
      .take(RECOVERY_BATCH);
    for (const turn of generating) {
      await ctx.db.patch(turn._id, {
        state: "debouncing",
        scheduledForMs: nowMs,
        updatedAtMs: nowMs,
        lastErrorCode: "RECOVERED_STALE_GENERATION",
      });
      await ctx.scheduler.runAfter(0, internal.turnQueue.beginGeneration, {
        turnId: turn._id,
        expectedRevision: turn.revision,
      });
      recovered += 1;
    }

    for (const state of ["response_planned", "sending"] as const) {
      const turns = await ctx.db
        .query("coastTurns")
        .withIndex("by_state_updated", (q) => q.eq("state", state).lt("updatedAtMs", staleBeforeMs))
        .take(RECOVERY_BATCH);
      for (const turn of turns) {
        await ctx.scheduler.runAfter(0, internal.turnQueue.deliverTurn, { turnId: turn._id });
        recovered += 1;
      }
    }

    const retryableDeliveries = await ctx.db
      .query("outboundDeliveries")
      .withIndex("by_status_next_attempt", (q) =>
        q.eq("status", "failed").lte("nextAttemptAtMs", nowMs),
      )
      .take(RECOVERY_BATCH);
    for (const delivery of retryableDeliveries) {
      await ctx.scheduler.runAfter(0, internal.turnQueue.deliverTurn, { turnId: delivery.turnId });
      recovered += 1;
    }

    let expiredState = 0;
    const expiringTables = [
      "chatStateKv",
      "chatStateListItems",
      "chatStateLocks",
      "chatStateQueueItems",
      "chatStateSubscriptions",
    ] as const;
    for (const table of expiringTables) {
      const expired = await ctx.db
        .query(table)
        .withIndex("by_expiry", (q) => q.lt("expiresAtMs", nowMs))
        .take(CHAT_TTL_BATCH);
      for (const document of expired) {
        await ctx.db.delete(document._id);
        expiredState += 1;
      }
    }

    await ctx.db.patch(logId, {
      state: "completed",
      processedCount:
        debouncing.length + generating.length + retryableDeliveries.length + expiredState,
      deletedCount: expiredState,
      recoveredCount: recovered,
      finishedAtMs: Date.now(),
    });
    return { recovered, expiredState };
  },
});
