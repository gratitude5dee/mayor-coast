import { query } from "./_generated/server";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { assertVercelServiceSecret } from "./lib/service_auth";

export const login = query({
  args: { serviceSecret: v.string(), passwordHash: v.string() },
  returns: v.boolean(),
  handler: (_ctx, args) => {
    assertVercelServiceSecret(args.serviceSecret);
    const expected = process.env.COAST_ADMIN_PASSWORD_HASH;
    if (!expected || expected.length !== args.passwordHash.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ args.passwordHash.charCodeAt(i);
    return diff === 0;
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
  paymentEvents: ["_id", "eventId", "paymentIdentity", "orderId", "createdAtMs"],
  balances: ["_id", "userId", "balanceCents", "activeJobId", "updatedAtMs"],
  ledger: ["_id", "userId", "jobId", "topupOrderId", "kind", "amountCents", "createdAtMs"],
  link: ["_id", "userId", "status", "createdAtMs", "updatedAtMs"],
  deliveries: ["_id", "threadId", "stage", "status", "attemptCount", "lastErrorCode", "createdAtMs", "updatedAtMs", "sentAtMs"],
} as const;

const adminValue = v.union(v.string(), v.number(), v.boolean(), v.null());

export const records = query({
  args: { serviceSecret: v.string(), section, paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.record(v.string(), adminValue)),
  handler: async (ctx, args) => {
    assertVercelServiceSecret(args.serviceSecret);
    const result = await ctx.db.query(tables[args.section]).order("desc").paginate({ ...args.paginationOpts, numItems: Math.min(50, Math.max(1, args.paginationOpts.numItems)) });
    return { ...result, page: result.page.map((row) => {
      const source = row as unknown as Record<string, unknown>;
      return Object.fromEntries(fields[args.section].map((key) => {
        const value = source[key];
        return [key, typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null];
      }));
    }) };
  },
});
