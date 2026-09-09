import { internalMutation, mutation, query } from "./_generated/server";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertVercelServiceSecret } from "./lib/service_auth";

import type { GenericTableInfo, OrderedQuery } from "convex/server";
import type { QueryCtx } from "./_generated/server";
import { CREATIVE_ACTIVE_STATES, findActiveJob, getCreativeCredits } from "./lib/creative";
import { deliveryOwner } from "./lib/adminOwnership";
import { userStatus } from "./lib/validators";

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
  jobs: ["_id", "userId", "threadId", "turnId", "lastErrorCode", "command", "state", "provider", "providerModel", "drawMode", "reservationSource", "reservedCents", "fundingStatus", "createdAtMs", "submittedAtMs", "firstPreviewAtMs", "completedAtMs", "deliveredAtMs"],
  interactions: ["_id", "userId", "threadId", "state", "origin", "creativeCommand", "generationElapsedMs", "lastErrorCode", "createdAtMs", "updatedAtMs"],
  messages: ["_id", "userId", "threadId", "turnId", "direction", "createdAtMs", "deletedAtMs", "privacyRedactedAtMs"],
  usage: ["_id", "userId", "kind", "jobId", "admittedAtMs", "settled"],
  payments: ["_id", "userId", "orderId", "paymentPath", "status", "chargeCents", "creditCents", "stripePaymentId", "createdAtMs", "updatedAtMs"],
  paymentEvents: ["_id", "userId", "eventId", "paymentIdentity", "orderId", "createdAtMs"],
  balances: ["_id", "userId", "balanceCents", "activeJobId", "updatedAtMs"],
  ledger: ["_id", "userId", "jobId", "topupOrderId", "kind", "amountCents", "createdAtMs"],
  link: ["_id", "userId", "status", "createdAtMs", "updatedAtMs"],
  deliveries: ["_id", "userId", "threadId", "turnId", "stage", "status", "attemptCount", "lastErrorCode", "createdAtMs", "updatedAtMs", "sentAtMs"],
} as const;

const adminValue = v.union(v.string(), v.number(), v.boolean(), v.null());

type Section = keyof typeof tables;
const recordValidator = v.record(v.string(), adminValue);
const personValidator = v.object({
  userId: v.id("coastUsers"), status: v.string(), createdAtMs: v.number(), lastSeenAtMs: v.number(),
  encryptedThreadRef: v.union(v.string(), v.null()),
});
async function person(ctx: QueryCtx, user: Doc<"coastUsers">) {
  const thread = user.status === "forgotten" ? null : await ctx.db.query("coastThreads")
    .withIndex("by_user_updated", q => q.eq("userId", user._id)).order("desc").first();
  return { userId: user._id, status: user.status, createdAtMs: user.createdAtMs,
    lastSeenAtMs: user.lastSeenAtMs, encryptedThreadRef: thread?.encryptedProviderThreadRef ?? null };
}
function project(section: Section, source: Record<string, unknown>) {
  return Object.fromEntries(fields[section].map(key => {
    let value = source[key];
    if (key === "lastErrorCode" && typeof value === "string" && !/^[A-Z][A-Z0-9_:-]{0,95}$/.test(value)) value = "DETAIL_UNAVAILABLE";
    return [key, typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null];
  }));
}
const pageOptions = (options: { numItems: number; cursor: string | null }) => ({ ...options, numItems: Math.min(50, Math.max(1, options.numItems)), maximumRowsRead: 2000 });

export const directory = query({
  args: { serviceSecret: v.string(), status: v.optional(userStatus), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(personValidator),
  handler: async (ctx, args) => {
    assertVercelServiceSecret(args.serviceSecret);
    const base = args.status ? ctx.db.query("coastUsers").withIndex("by_status_last_seen", q => q.eq("status", args.status!))
      : ctx.db.query("coastUsers").withIndex("by_last_seen");
    const result = await base.order("desc").paginate(pageOptions(args.paginationOpts));
    return { ...result, page: await Promise.all(result.page.map(user => person(ctx, user))) };
  },
});
export const searchUser = query({
  args: { serviceSecret: v.string(), senderHash: v.optional(v.string()), userId: v.optional(v.string()) },
  returns: v.union(personValidator, v.null()),
  handler: async (ctx, args) => {
    assertVercelServiceSecret(args.serviceSecret);
    const id = args.userId ? ctx.db.normalizeId("coastUsers", args.userId) : null;
    const user = args.senderHash ? await ctx.db.query("coastUsers").withIndex("by_sender_hash", q => q.eq("senderHash", args.senderHash!)).unique()
      : id ? await ctx.db.get(id) : null;
    // Forgotten identities are not recoverable through address search.
    return user && !(args.senderHash && user.status === "forgotten") ? person(ctx, user) : null;
  },
});
export const summary = query({
  args: { serviceSecret: v.string(), userId: v.id("coastUsers"), nowMs: v.number() },
  returns: v.union(v.object({
    user: personValidator,
    imageFreeRemaining: v.number(), videoFreeRemaining: v.number(), creditCents: v.number(),
    reservedImageCount: v.number(), reservedVideoCount: v.number(), reservedCreditCents: v.number(),
    activeJob: v.union(recordValidator, v.null()), linkStatus: v.union(v.string(), v.null()),
  }), v.null()),
  handler: async (ctx, args) => {
    assertVercelServiceSecret(args.serviceSecret);
    const user = await ctx.db.get(args.userId);
    if (!user) return null;
    const [credits, activeJob, imageReservations, videoReservations, link, reservedJobs] = await Promise.all([
      getCreativeCredits(ctx, user._id, args.nowMs), findActiveJob(ctx, user._id),
      ctx.db.query("creativeUsage").withIndex("by_user_kind_settled", q => q.eq("userId", user._id).eq("kind", "image").eq("settled", false)).collect(),
      ctx.db.query("creativeUsage").withIndex("by_user_kind_settled", q => q.eq("userId", user._id).eq("kind", "video").eq("settled", false)).collect(),
      ctx.db.query("creativeLinkConnections").withIndex("by_user", q => q.eq("userId", user._id)).first(),
      Promise.all(CREATIVE_ACTIVE_STATES.map(state => ctx.db.query("creativeJobs").withIndex("by_user_state", q => q.eq("userId", user._id).eq("state", state)).collect())),
    ]);
    return { user: await person(ctx, user), imageFreeRemaining: credits.imageFreeRemaining, videoFreeRemaining: credits.videoFreeRemaining,
      creditCents: credits.creditCents, reservedImageCount: imageReservations.length, reservedVideoCount: videoReservations.length,
      reservedCreditCents: reservedJobs.flat().filter(job => job.reservationSource === "credit" && job.fundingStatus === "reserved").reduce((sum, job) => sum + job.reservedCents, 0),
      activeJob: activeJob ? project("jobs", activeJob) : null, linkStatus: link?.status ?? null };
  },
});
export const threads = query({
  args: { serviceSecret: v.string(), userId: v.id("coastUsers"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object({ threadId: v.id("coastThreads"), status: v.string(), latestInboundAtMs: v.number(), encryptedThreadRef: v.union(v.string(), v.null()) })),
  handler: async (ctx, args) => {
    assertVercelServiceSecret(args.serviceSecret);
    const user = await ctx.db.get(args.userId);
    const result = await ctx.db.query("coastThreads").withIndex("by_user_updated", q => q.eq("userId", args.userId)).order("desc").paginate(pageOptions(args.paginationOpts));
    return { ...result, page: result.page.map(thread => ({ threadId: thread._id, status: thread.status, latestInboundAtMs: thread.latestInboundAtMs,
      encryptedThreadRef: user?.status === "forgotten" ? null : thread.encryptedProviderThreadRef })) };
  },
});

function scopedRecords(ctx: QueryCtx, section: Section, userId?: Id<"coastUsers">): OrderedQuery<GenericTableInfo> {
  if (!userId) return ctx.db.query(tables[section]).order("desc");
  switch (section) {
    case "jobs": return ctx.db.query("creativeJobs").withIndex("by_user_created", q => q.eq("userId", userId)).order("desc");
    case "interactions": return ctx.db.query("coastTurns").withIndex("by_user_created", q => q.eq("userId", userId)).order("desc");
    case "messages": return ctx.db.query("coastMessages").withIndex("by_user_created", q => q.eq("userId", userId)).order("desc");
    case "usage": return ctx.db.query("creativeUsage").withIndex("by_user_admitted", q => q.eq("userId", userId)).order("desc");
    case "payments": return ctx.db.query("creativeTopups").withIndex("by_user_created", q => q.eq("userId", userId)).order("desc");
    case "paymentEvents": return ctx.db.query("creativePaymentEvents").withIndex("by_user_created", q => q.eq("userId", userId)).order("desc");
    case "balances": return ctx.db.query("creativeCreditAccounts").withIndex("by_user", q => q.eq("userId", userId));
    case "ledger": return ctx.db.query("creativeCreditLedger").withIndex("by_user_created", q => q.eq("userId", userId)).order("desc");
    case "link": return ctx.db.query("creativeLinkConnections").withIndex("by_user", q => q.eq("userId", userId));
    case "deliveries": return ctx.db.query("outboundDeliveries").withIndex("by_user_created", q => q.eq("userId", userId)).order("desc");
  }
}
export const records = query({
  args: { serviceSecret: v.string(), section, userId: v.optional(v.id("coastUsers")), threadId: v.optional(v.id("coastThreads")),
    fromMs: v.optional(v.number()), toMs: v.optional(v.number()), status: v.optional(v.string()), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(recordValidator),
  handler: async (ctx, args) => {
    assertVercelServiceSecret(args.serviceSecret);
    if (args.threadId) {
      const thread = await ctx.db.get(args.threadId);
      if (!args.userId || thread?.userId !== args.userId) throw new Error("ADMIN_RECORD_UNAVAILABLE");
      if (!["interactions", "jobs", "messages", "deliveries"].includes(args.section)) throw new Error("ADMIN_FILTER_INVALID");
    }
    if (args.fromMs !== undefined && args.toMs !== undefined && args.fromMs > args.toMs) throw new Error("ADMIN_FILTER_INVALID");
    let base = scopedRecords(ctx, args.section, args.userId);
    if (args.threadId) base = base.filter(q => q.eq(q.field("threadId"), args.threadId));
    const timeField = args.section === "usage" ? "admittedAtMs" : "createdAtMs";
    if (args.fromMs !== undefined) base = base.filter(q => q.gte(q.field(timeField), args.fromMs!));
    if (args.toMs !== undefined) base = base.filter(q => q.lt(q.field(timeField), args.toMs!));
    if (args.status) {
      const field = ["jobs", "interactions"].includes(args.section) ? "state" : args.section === "ledger" ? "kind" : "status";
      base = base.filter(q => q.eq(q.field(field), args.status));
    }
    const result = await base.paginate(pageOptions(args.paginationOpts));
    return { ...result, page: result.page.map(row => project(args.section, row)) };
  },
});

const parentSection = v.union(v.literal("interactions"), v.literal("jobs"), v.literal("payments"));
export const related = query({
  args: { serviceSecret: v.string(), userId: v.id("coastUsers"), section: parentSection, recordId: v.string(),
    relation: v.union(v.literal("messages"), v.literal("deliveries"), v.literal("ledger"), v.literal("paymentEvents")), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(recordValidator),
  handler: async (ctx, args) => {
    assertVercelServiceSecret(args.serviceSecret);
    const id = ctx.db.normalizeId(tables[args.section], args.recordId);
    const parent = id ? await ctx.db.get(id) : null;
    if (!parent || parent.userId !== args.userId) throw new Error("ADMIN_RECORD_UNAVAILABLE");
    let base: OrderedQuery<GenericTableInfo>;
    if (args.section === "interactions" && args.relation === "messages") {
      const turn = parent as Doc<"coastTurns">;
      base = ctx.db.query("coastMessages").withIndex("by_thread_created", q => q.eq("threadId", turn.threadId)).order("desc").filter(q => q.eq(q.field("turnId"), turn._id));
    } else if ((args.section === "interactions" || args.section === "jobs") && args.relation === "deliveries") {
      const turnId = args.section === "interactions" ? parent._id as Id<"coastTurns"> : (parent as Doc<"creativeJobs">).turnId;
      base = ctx.db.query("outboundDeliveries").withIndex("by_turn_created", q => q.eq("turnId", turnId)).order("desc");
    } else if (args.section === "jobs" && args.relation === "ledger") {
      base = ctx.db.query("creativeCreditLedger").withIndex("by_job_created", q => q.eq("jobId", parent._id as Id<"creativeJobs">)).order("desc");
    } else if (args.section === "payments" && args.relation === "ledger") {
      base = ctx.db.query("creativeCreditLedger").withIndex("by_order_created", q => q.eq("topupOrderId", (parent as Doc<"creativeTopups">).orderId)).order("desc");
    } else if (args.section === "payments" && args.relation === "paymentEvents") {
      base = ctx.db.query("creativePaymentEvents").withIndex("by_order_created", q => q.eq("orderId", (parent as Doc<"creativeTopups">).orderId)).order("desc");
    } else throw new Error("ADMIN_FILTER_INVALID");
    const result = await base.filter(q => q.eq(q.field("userId"), args.userId)).paginate(pageOptions(args.paginationOpts));
    return { ...result, page: result.page.map(row => project(args.relation, row)) };
  },
});

/** Reentrant bounded migration. The caller persists the returned cursor between batches. */
export const backfillOwners = internalMutation({
  args: { table: v.union(v.literal("outboundDeliveries"), v.literal("creativePaymentEvents")), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ cursor: v.string(), isDone: v.boolean(), scanned: v.number(), updated: v.number(), unavailable: v.number() }),
  handler: async (ctx, args) => {
    const result = await ctx.db.query(args.table).paginate({ numItems: 100, cursor: args.cursor });
    let updated = 0, unavailable = 0;
    for (const row of result.page) {
      const owner = args.table === "outboundDeliveries"
        ? await deliveryOwner(ctx, (row as Doc<"outboundDeliveries">).turnId, (row as Doc<"outboundDeliveries">).threadId)
        : (await ctx.db.query("creativeTopups").withIndex("by_order", q => q.eq("orderId", (row as Doc<"creativePaymentEvents">).orderId)).unique())?.userId;
      if (!owner) unavailable++;
      if (owner !== row.userId) { await ctx.db.patch(row._id, { userId: owner }); updated++; }
    }
    return { cursor: result.continueCursor, isDone: result.isDone, scanned: result.page.length, updated, unavailable };
  },
});
