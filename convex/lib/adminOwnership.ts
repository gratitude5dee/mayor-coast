import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export async function deliveryOwner(ctx: QueryCtx | MutationCtx, turnId: Id<"coastTurns">, threadId: Id<"coastThreads">) {
  const turn = await ctx.db.get(turnId);
  const thread = await ctx.db.get(threadId);
  if (!turn || !thread || turn.threadId !== thread._id || turn.userId !== thread.userId) return undefined;
  return turn.userId;
}

/** Preserve delivery behavior while recording only verified ownership. */
export async function insertOwnedDelivery(ctx: MutationCtx, value: Omit<WithoutSystemFields<Doc<"outboundDeliveries">>, "userId">) {
  const userId = await deliveryOwner(ctx, value.turnId, value.threadId);
  return ctx.db.insert("outboundDeliveries", { ...value, ...(userId ? { userId } : {}) });
}
