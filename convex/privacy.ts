import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { cancelActiveCheckInsForUser } from "./checkIns";

const BATCH_SIZE = 100;

export const eraseUserBatch = internalMutation({
  args: { userId: v.id("coastUsers") },
  returns: v.object({ processed: v.number(), complete: v.boolean() }),
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (user === null) return { processed: 0, complete: true };
    const nowMs = Date.now();
    let processed = 0;

    // User status is the primary fail-closed delivery guard. This bounded
    // cancellation is defense in depth while the erasure batches drain.
    await cancelActiveCheckInsForUser(ctx, args.userId, nowMs, "forget_erase");

    const preferences = await ctx.db
      .query("coastPreferences")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(BATCH_SIZE);
    for (const preference of preferences) {
      await ctx.db.delete(preference._id);
      processed += 1;
    }

    const messages = await ctx.db
      .query("coastMessages")
      .withIndex("by_user_privacy_redacted", (q) =>
        q.eq("userId", args.userId).eq("privacyRedactedAtMs", undefined),
      )
      .take(BATCH_SIZE);
    for (const message of messages) {
      await ctx.db.patch(message._id, {
        body: null,
        bodyExpiresAtMs: null,
        deletedAtMs: nowMs,
        privacyRedactedAtMs: nowMs,
      });
      processed += 1;
    }

    const checkIns = await ctx.db
      .query("coastCheckIns")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(BATCH_SIZE);
    for (const checkIn of checkIns) {
      await ctx.db.delete(checkIn._id);
      processed += 1;
    }

    const polls = await ctx.db
      .query("coastPolls")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(BATCH_SIZE);
    for (const poll of polls) {
      await ctx.db.delete(poll._id);
      processed += 1;
    }

    const itineraries = await ctx.db
      .query("coastItineraries")
      .withIndex("by_user_created", (q) => q.eq("userId", args.userId))
      .take(BATCH_SIZE);
    for (const itinerary of itineraries) {
      await ctx.db.delete(itinerary._id);
      processed += 1;
    }

    const remainingCheckIn = await ctx.db
      .query("coastCheckIns")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();
    const decisions =
      remainingCheckIn === null
        ? await ctx.db
            .query("coastDecisions")
            .withIndex("by_user", (q) => q.eq("userId", args.userId))
            .take(BATCH_SIZE)
        : [];
    for (const decision of decisions) {
      await ctx.db.delete(decision._id);
      processed += 1;
    }

    const turns = await ctx.db
      .query("coastTurns")
      .withIndex("by_user_privacy_redacted", (q) =>
        q.eq("userId", args.userId).eq("privacyRedactedAtMs", undefined),
      )
      .take(BATCH_SIZE);
    for (const turn of turns) {
      await ctx.db.patch(turn._id, {
        plan: undefined,
        privacyRedactedAtMs: nowMs,
        updatedAtMs: nowMs,
      });
      processed += 1;
      const deliveries = await ctx.db
        .query("outboundDeliveries")
        .withIndex("by_turn_stage", (q) => q.eq("turnId", turn._id))
        .take(3);
      for (const delivery of deliveries) {
        await ctx.db.patch(delivery._id, {
          payload: { redacted: true },
          status:
            delivery.status === "sent" || delivery.status === "cancelled"
              ? delivery.status
              : "cancelled",
          updatedAtMs: nowMs,
        });
      }
    }

    const incomplete =
      preferences.length === BATCH_SIZE ||
      messages.length === BATCH_SIZE ||
      checkIns.length === BATCH_SIZE ||
      polls.length === BATCH_SIZE ||
      itineraries.length === BATCH_SIZE ||
      remainingCheckIn !== null ||
      decisions.length === BATCH_SIZE ||
      turns.length === BATCH_SIZE;
    if (incomplete) {
      await ctx.scheduler.runAfter(0, internal.privacy.eraseUserBatch, {
        userId: args.userId,
      });
      return { processed, complete: false };
    }
    await ctx.db.patch(args.userId, {
      status: "forgotten",
      forgottenAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    return { processed, complete: true };
  },
});

export const expireRawMessagesBatch = internalMutation({
  args: {},
  returns: v.object({ expired: v.number(), hasMore: v.boolean() }),
  handler: async (ctx) => {
    const nowMs = Date.now();
    const messages = await ctx.db
      .query("coastMessages")
      .withIndex("by_body_expiry", (q) =>
        q.gte("bodyExpiresAtMs", 0).lt("bodyExpiresAtMs", nowMs),
      )
      .take(BATCH_SIZE);
    for (const message of messages) {
      await ctx.db.patch(message._id, {
        body: null,
        bodyExpiresAtMs: null,
        deletedAtMs: nowMs,
        privacyRedactedAtMs: nowMs,
      });
    }
    if (messages.length === BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        0,
        internal.privacy.expireRawMessagesBatch,
        {},
      );
    }
    return {
      expired: messages.length,
      hasMore: messages.length === BATCH_SIZE,
    };
  },
});
