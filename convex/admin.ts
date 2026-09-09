import { mutation, query } from "./_generated/server";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { assertVercelServiceSecret } from "./lib/service_auth";

const ADMIN_LOGIN_WINDOW_MS = 15 * 60_000;
const ADMIN_LOGIN_LIMIT = 5;

export const login = query({
  args: { serviceSecret: v.string(), passwordHash: v.string() },
  returns: v.boolean(),
  handler: async (_ctx, args) => {
    assertVercelServiceSecret(args.serviceSecret);
    const expected = process.env.COAST_ADMIN_PASSWORD_HASH;
    let matches = Boolean(expected && expected.length === args.passwordHash.length);
    let diff = 0;
    if (expected && matches) {
      for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ args.passwordHash.charCodeAt(i);
      matches = diff === 0;
    }
    return matches;
  },
});

export const loginRateLimited = mutation({
  args: {
    serviceSecret: v.string(),
    passwordHash: v.string(),
    clientHash: v.string(),
    nowMs: v.number(),
  },
  returns: v.object({ allowed: v.boolean(), retryAfterMs: v.number() }),
  handler: async (ctx, args) => {
    assertVercelServiceSecret(args.serviceSecret);
    const attempt = await ctx.db
      .query("adminLoginAttempts")
      .withIndex("by_client", (q) => q.eq("clientHash", args.clientHash))
      .unique();
    if (attempt?.lockedUntilMs !== undefined && attempt.lockedUntilMs > args.nowMs) {
      return { allowed: false, retryAfterMs: attempt.lockedUntilMs - args.nowMs };
    }
    const expected = process.env.COAST_ADMIN_PASSWORD_HASH;
    let matches = Boolean(expected && expected.length === args.passwordHash.length);
    let diff = 0;
    if (expected && matches) {
      for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ args.passwordHash.charCodeAt(i);
      matches = diff === 0;
    }
    if (matches) {
      if (attempt) await ctx.db.delete(attempt._id);
      return { allowed: true, retryAfterMs: 0 };
    }

    if (!attempt || args.nowMs - attempt.windowStartedAtMs >= ADMIN_LOGIN_WINDOW_MS) {
      if (attempt) {
        await ctx.db.patch(attempt._id, {
          attemptCount: 1,
          windowStartedAtMs: args.nowMs,
          lastAttemptAtMs: args.nowMs,
          lockedUntilMs: undefined,
        });
      } else {
        await ctx.db.insert("adminLoginAttempts", {
          clientHash: args.clientHash,
          attemptCount: 1,
          windowStartedAtMs: args.nowMs,
          lastAttemptAtMs: args.nowMs,
        });
      }
      return { allowed: false, retryAfterMs: 0 };
    }

    const attemptCount = attempt.attemptCount + 1;
    const lockedUntilMs = attemptCount >= ADMIN_LOGIN_LIMIT
      ? args.nowMs + ADMIN_LOGIN_WINDOW_MS
      : undefined;
    await ctx.db.patch(attempt._id, {
      attemptCount,
      lastAttemptAtMs: args.nowMs,
      lockedUntilMs,
    });
    return {
      allowed: false,
      retryAfterMs: lockedUntilMs === undefined ? 0 : ADMIN_LOGIN_WINDOW_MS,
    };
  },
});

export const users = query({
  args: { serviceSecret: v.string() },
  returns: v.array(v.object({
    userId: v.id("coastUsers"),
    status: v.string(),
    createdAtMs: v.number(),
    lastSeenAtMs: v.number(),
    balanceCents: v.number(),
    activeJobId: v.union(v.id("creativeJobs"), v.null()),
    threadId: v.union(v.id("coastThreads"), v.null()),
    encryptedThreadRef: v.union(v.string(), v.null()),
  })),
  handler: async (ctx, args) => {
    assertVercelServiceSecret(args.serviceSecret);
    const people = await ctx.db.query("coastUsers").order("desc").take(100);
    return await Promise.all(people.map(async (user) => {
      const [thread, account] = await Promise.all([
        ctx.db.query("coastThreads").withIndex("by_user_updated", (q) => q.eq("userId", user._id)).order("desc").first(),
        ctx.db.query("creativeCreditAccounts").withIndex("by_user", (q) => q.eq("userId", user._id)).unique(),
      ]);
      return {
        userId: user._id,
        status: user.status,
        createdAtMs: user.createdAtMs,
        lastSeenAtMs: user.lastSeenAtMs,
        balanceCents: account?.balanceCents ?? 0,
        activeJobId: account?.activeJobId ?? null,
        threadId: thread?._id ?? null,
        encryptedThreadRef: thread?.encryptedProviderThreadRef ?? null,
      };
    }));
  },
});

export const section = v.union(
  v.literal("jobs"),
  v.literal("interactions"),
  v.literal("messages"),
  v.literal("usage"),
  v.literal("payments"),
  v.literal("paymentEvents"),
  v.literal("balances"),
  v.literal("ledger"),
  v.literal("link"),
  v.literal("deliveries"),
);
const tables = {
  jobs: "creativeJobs",
  interactions: "coastTurns",
  messages: "coastMessages",
  usage: "creativeUsage",
  payments: "creativeTopups",
  paymentEvents: "creativePaymentEvents",
  balances: "creativeCreditAccounts",
  ledger: "creativeCreditLedger",
  link: "creativeLinkConnections",
  deliveries: "outboundDeliveries",
} as const;
// Explicit projection: never send prompts, message bodies, addresses, auth,
// private media URLs, payment URLs, or encrypted payloads to the dashboard.
export const fields = {
  jobs: ["_id", "userId", "command", "state", "provider", "providerModel", "drawMode", "reservationSource", "reservedCents", "fundingStatus", "createdAtMs", "submittedAtMs", "firstPreviewAtMs", "completedAtMs", "deliveredAtMs"],
  interactions: ["_id", "userId", "state", "origin", "creativeCommand", "generationElapsedMs", "lastErrorCode", "createdAtMs", "updatedAtMs"],
  messages: ["_id", "userId", "threadId", "turnId", "direction", "createdAtMs", "deletedAtMs", "privacyRedactedAtMs"],
  usage: ["_id", "userId", "kind", "jobId", "admittedAtMs", "settled"],
  payments: ["_id", "userId", "orderId", "paymentPath", "status", "chargeCents", "creditCents", "stripePaymentId", "createdAtMs", "updatedAtMs"],
  paymentEvents: ["_id", "userId", "eventId", "paymentIdentity", "orderId", "createdAtMs"],
  balances: ["_id", "userId", "balanceCents", "activeJobId", "updatedAtMs"],
  ledger: ["_id", "userId", "jobId", "topupOrderId", "kind", "amountCents", "createdAtMs"],
  link: ["_id", "userId", "status", "createdAtMs", "updatedAtMs"],
  deliveries: ["_id", "userId", "threadId", "stage", "status", "attemptCount", "lastErrorCode", "createdAtMs", "updatedAtMs", "sentAtMs"],
} as const;

const adminValue = v.union(v.string(), v.number(), v.boolean(), v.null());

export const records = query({
  args: {
    serviceSecret: v.string(),
    section,
    userId: v.optional(v.id("coastUsers")),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(v.record(v.string(), adminValue)),
  handler: async (ctx, args) => {
    assertVercelServiceSecret(args.serviceSecret);
    const paginationOpts = {
      ...args.paginationOpts,
      numItems: Math.min(50, Math.max(1, args.paginationOpts.numItems)),
    };
    const result = args.userId === undefined
      ? await ctx.db.query(tables[args.section]).order("desc").paginate(paginationOpts)
      : await (async () => {
          switch (args.section) {
            case "jobs": return await ctx.db.query("creativeJobs").withIndex("by_user_created", (q) => q.eq("userId", args.userId!)).order("desc").paginate(paginationOpts);
            case "interactions": return await ctx.db.query("coastTurns").withIndex("by_user_updated", (q) => q.eq("userId", args.userId!)).order("desc").paginate(paginationOpts);
            case "messages": return await ctx.db.query("coastMessages").withIndex("by_user_created", (q) => q.eq("userId", args.userId!)).order("desc").paginate(paginationOpts);
            case "usage": return await ctx.db.query("creativeUsage").withIndex("by_user_admitted", (q) => q.eq("userId", args.userId!)).order("desc").paginate(paginationOpts);
            case "payments": return await ctx.db.query("creativeTopups").withIndex("by_user_created", (q) => q.eq("userId", args.userId!)).order("desc").paginate(paginationOpts);
            case "balances": return await ctx.db.query("creativeCreditAccounts").withIndex("by_user", (q) => q.eq("userId", args.userId!)).paginate(paginationOpts);
            case "ledger": return await ctx.db.query("creativeCreditLedger").withIndex("by_user_created", (q) => q.eq("userId", args.userId!)).order("desc").paginate(paginationOpts);
            case "link": return await ctx.db.query("creativeLinkConnections").withIndex("by_user", (q) => q.eq("userId", args.userId!)).paginate(paginationOpts);
            case "paymentEvents": return await ctx.db.query("creativePaymentEvents").order("desc").paginate(paginationOpts);
            case "deliveries": return await ctx.db.query("outboundDeliveries").order("desc").paginate(paginationOpts);
          }
        })();
    const projected = await Promise.all(result.page.map(async (row) => {
      const source = row as unknown as Record<string, unknown>;
      let ownerId = typeof source.userId === "string" ? source.userId : null;
      if (ownerId === null && args.section === "deliveries" && typeof source.turnId === "string") {
        ownerId = (await ctx.db.get(source.turnId as Id<"coastTurns">))?.userId ?? null;
      }
      if (ownerId === null && args.section === "paymentEvents" && typeof source.orderId === "string") {
        ownerId = (await ctx.db.query("creativeTopups").withIndex("by_order", (q) => q.eq("orderId", source.orderId as string)).unique())?.userId ?? null;
      }
      const view: Record<string, unknown> = { ...source, userId: ownerId };
      return {
        ownerId,
        record: Object.fromEntries(fields[args.section].map((key) => {
          const value = view[key];
          return [key, typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null];
        })),
      };
    }));
    return {
      ...result,
      page: projected
        .filter(({ ownerId }) => args.userId === undefined || ownerId === args.userId)
        .map(({ record }) => record),
    };
  },
});
