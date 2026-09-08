import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { serviceSecretFingerprintHex } from "./lib/service_auth";
import { admitCreativeJob, releaseCreativeFunding } from "./lib/creative";

const DAY_MS = 24 * 60 * 60 * 1_000;
const IMAGE_FREE_LIMIT = 10;
const VIDEO_FREE_LIMIT = 10;

const jobCommand = v.union(v.literal("imagine"), v.literal("zap"), v.literal("draw"));
const reservationSource = v.union(v.literal("free"), v.literal("credit"), v.literal("payment"));

export const getCredits = internalQuery({
  args: { userId: v.id("coastUsers"), nowMs: v.number() },
  returns: v.object({ imageFreeRemaining: v.number(), videoFreeRemaining: v.number(), creditCents: v.number(), activeJob: v.boolean() }),
  handler: async (ctx, args) => {
    const usage = await ctx.db.query("creativeUsage").withIndex("by_user_kind_admitted", (q) => q.eq("userId", args.userId)).take(100);
    const activeJobs = await ctx.db.query("creativeJobs").withIndex("by_user_state", (q) => q.eq("userId", args.userId)).take(20);
    const imageCount = usage.filter((item) => item.kind === "image" && item.admittedAtMs > args.nowMs - DAY_MS).length;
    const videoCount = usage.filter((item) => item.kind === "video" && item.admittedAtMs > args.nowMs - DAY_MS).length;
    const ledger = await ctx.db.query("creativeCreditLedger").withIndex("by_user_created", (q) => q.eq("userId", args.userId)).collect();
    const creditCents = ledger.reduce((sum, item) => sum + item.amountCents, 0);
    const activeJob = activeJobs.some((job) => !["delivered", "failed", "refused", "cancelled", "expired"].includes(job.state));
    return {
      imageFreeRemaining: Math.max(0, IMAGE_FREE_LIMIT - imageCount),
      videoFreeRemaining: Math.max(0, VIDEO_FREE_LIMIT - videoCount),
      creditCents,
      activeJob,
    };
  },
});

export const admit = internalMutation({
  args: {
    userId: v.id("coastUsers"),
    threadId: v.id("coastThreads"),
    sourceMessageId: v.id("coastMessages"),
    turnId: v.id("coastTurns"),
    requestKey: v.string(),
    command: jobCommand,
    encryptedPayload: v.string(),
    nowMs: v.number(),
  },
  returns: v.object({ jobId: v.id("creativeJobs"), state: v.string(), source: reservationSource, amountCents: v.number() }),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("creativeJobs").withIndex("by_request_key", (q) => q.eq("requestKey", args.requestKey)).unique();
    if (existing !== null) return { jobId: existing._id, state: existing.state, source: existing.reservationSource, amountCents: existing.reservedCents };
    const activeJobs = await ctx.db.query("creativeJobs").withIndex("by_user_state", (q) => q.eq("userId", args.userId)).take(20);
    if (activeJobs.some((job) => !["delivered", "failed", "refused", "cancelled", "expired"].includes(job.state))) {
      throw new Error("CREATIVE_JOB_ALREADY_ACTIVE");
    }
    const kind = args.command === "imagine" ? "image" : "video";
    const price = args.command === "imagine" ? 50 : 100;
    const usage = await ctx.db.query("creativeUsage").withIndex("by_user_kind_admitted", (q) => q.eq("userId", args.userId).eq("kind", kind)).take(100);
    const freeLimit = kind === "image" ? IMAGE_FREE_LIMIT : VIDEO_FREE_LIMIT;
    const freeAvailable = usage.filter((item) => item.admittedAtMs > args.nowMs - DAY_MS).length < freeLimit;
    let source: "free" | "credit" | "payment" = freeAvailable ? "free" : "payment";
    if (!freeAvailable) {
      const ledger = await ctx.db.query("creativeCreditLedger").withIndex("by_user_created", (q) => q.eq("userId", args.userId)).collect();
      const balance = ledger.reduce((sum, item) => sum + item.amountCents, 0);
      if (balance >= price) source = "credit";
    }
    const reservationId = `${args.requestKey}:reservation`;
    const state = source === "payment" ? "awaiting_payment" : "admitted";
    const jobId = await ctx.db.insert("creativeJobs", {
      userId: args.userId,
      threadId: args.threadId,
      sourceMessageId: args.sourceMessageId,
      turnId: args.turnId,
      requestKey: args.requestKey,
      command: args.command,
      state,
      encryptedPayload: args.encryptedPayload,
      reservationSource: source,
      reservedCents: source === "free" ? 0 : price,
      reservationId,
      createdAtMs: args.nowMs,
      updatedAtMs: args.nowMs,
      expiresAtMs: args.nowMs + DAY_MS,
    });
    if (source === "free") {
      await ctx.db.insert("creativeUsage", { userId: args.userId, kind, jobId, reservationId, admittedAtMs: args.nowMs, settled: false });
    } else if (source === "credit") {
      await ctx.db.insert("creativeCreditLedger", { userId: args.userId, jobId, kind: "reserve", amountCents: -price, idempotencyKey: reservationId, createdAtMs: args.nowMs });
    }
    return { jobId, state, source, amountCents: source === "free" ? 0 : price };
  },
});

export const addTopupCredit = internalMutation({
  args: { orderId: v.string(), eventId: v.string(), paymentIdentity: v.string(), nowMs: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const order = await ctx.db.query("creativeTopups").withIndex("by_order", (q) => q.eq("orderId", args.orderId)).unique();
    if (order === null || order.chargeCents !== 999 || order.creditCents !== 1000 || order.status === "succeeded") return false;
    const existing = await ctx.db.query("creativePaymentEvents").withIndex("by_payment", (q) => q.eq("paymentIdentity", args.paymentIdentity)).first();
    const existingEvent = await ctx.db.query("creativePaymentEvents").withIndex("by_event", (q) => q.eq("eventId", args.eventId)).first();
    if (existing !== null || existingEvent !== null) return false;
    await ctx.db.insert("creativePaymentEvents", { eventId: args.eventId, paymentIdentity: args.paymentIdentity, orderId: args.orderId, createdAtMs: args.nowMs });
    await ctx.db.insert("creativeCreditLedger", { userId: order.userId, topupOrderId: args.orderId, kind: "topup", amountCents: 1_000, idempotencyKey: `topup:${args.orderId}`, createdAtMs: args.nowMs });
    const account = await ctx.db.query("creativeCreditAccounts").withIndex("by_user", (q) => q.eq("userId", order.userId)).unique();
    if (account === null) await ctx.db.insert("creativeCreditAccounts", { userId: order.userId, balanceCents: 1_000, updatedAtMs: args.nowMs });
    else await ctx.db.patch(account._id, { balanceCents: account.balanceCents + 1_000, updatedAtMs: args.nowMs });
    await ctx.db.patch(order._id, { status: "succeeded", updatedAtMs: args.nowMs });
    if (order.savedJobId !== undefined) {
      const job = await ctx.db.get(order.savedJobId);
      if (job?.state === "awaiting_payment") {
        await ctx.db.patch(job._id, { state: "admitted", reservationSource: "credit", reservedCents: job.command === "imagine" ? 50 : 100, updatedAtMs: args.nowMs });
        await ctx.db.insert("creativeCreditLedger", { userId: order.userId, jobId: job._id, kind: "reserve", amountCents: job.command === "imagine" ? -50 : -100, idempotencyKey: `${job.reservationId}:payment`, createdAtMs: args.nowMs });
        await ctx.scheduler.runAfter(0, internal.creative.run, { jobId: job._id });
      }
    }
    return true;
  },
});

export const reverseTopupCredit = internalMutation({
  args: { orderId: v.string(), eventId: v.string(), paymentIdentity: v.string(), nowMs: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const order = await ctx.db.query("creativeTopups").withIndex("by_order", (q) => q.eq("orderId", args.orderId)).unique();
    if (order === null || order.status === "refunded") return false;
    const existingEvent = await ctx.db.query("creativePaymentEvents").withIndex("by_event", (q) => q.eq("eventId", args.eventId)).first();
    if (existingEvent !== null) return false;
    await ctx.db.insert("creativePaymentEvents", { eventId: args.eventId, paymentIdentity: args.paymentIdentity, orderId: args.orderId, createdAtMs: args.nowMs });
    await ctx.db.insert("creativeCreditLedger", { userId: order.userId, topupOrderId: args.orderId, kind: "refund", amountCents: -1_000, idempotencyKey: `refund:${args.orderId}`, createdAtMs: args.nowMs });
    const account = await ctx.db.query("creativeCreditAccounts").withIndex("by_user", (q) => q.eq("userId", order.userId)).unique();
    if (account !== null) await ctx.db.patch(account._id, { balanceCents: account.balanceCents - 1_000, updatedAtMs: args.nowMs });
    await ctx.db.patch(order._id, { status: "refunded", updatedAtMs: args.nowMs });
    return true;
  },
});

export const getTopup = internalQuery({
  args: { orderId: v.string() },
  returns: v.union(
    v.object({ userId: v.id("coastUsers"), orderId: v.string(), status: v.string(), chargeCents: v.number(), creditCents: v.number() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const order = await ctx.db.query("creativeTopups").withIndex("by_order", (q) => q.eq("orderId", args.orderId)).unique();
    return order === null ? null : { userId: order.userId, orderId: order.orderId, status: order.status, chargeCents: order.chargeCents, creditCents: order.creditCents };
  },
});

export const getMedia = internalQuery({
  args: { mediaId: v.id("creativeMedia"), nowMs: v.number() },
  returns: v.union(
    v.object({ sourceUrl: v.string(), mimeType: v.string(), filename: v.string(), expiresAtMs: v.number() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const media = await ctx.db.get(args.mediaId);
    if (media === null || media.deletedAtMs !== undefined || media.expiresAtMs <= args.nowMs) return null;
    return { sourceUrl: media.sourceUrl, mimeType: media.mimeType, filename: media.filename, expiresAtMs: media.expiresAtMs };
  },
});

export const getDrawMediaIdentity = internalQuery({
  args: { mediaId: v.id("creativeMedia") },
  returns: v.union(v.object({ drawSessionId: v.union(v.id("drawSessions"), v.null()) }), v.null()),
  handler: async (ctx, args) => {
    const media = await ctx.db.get(args.mediaId);
    return media ? { drawSessionId: media.drawSessionId ?? null } : null;
  },
});

export const exchangeDrawSession = internalMutation({
  args: { sessionId: v.id("drawSessions"), launchSecret: v.string(), nowMs: v.number() },
  returns: v.union(v.object({ browserToken: v.string(), expiresAtMs: v.number() }), v.null()),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status !== "active" || session.launchConsumedAtMs !== undefined || session.launchExpiresAtMs < args.nowMs || session.expiresAtMs < args.nowMs) return null;
    if (serviceSecretFingerprintHex(args.launchSecret) !== session.launchSecretHash) return null;
    const browserToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    await ctx.db.patch(session._id, { launchConsumedAtMs: args.nowMs, browserTokenHash: serviceSecretFingerprintHex(browserToken), updatedAtMs: args.nowMs });
    return { browserToken, expiresAtMs: session.expiresAtMs };
  },
});

export const getDrawSession = internalQuery({
  args: { sessionId: v.id("drawSessions"), browserTokenHash: v.string(), nowMs: v.number() },
  returns: v.union(v.object({ sessionId: v.id("drawSessions"), userId: v.id("coastUsers"), threadId: v.id("coastThreads"), expiresAtMs: v.number(), activeJobId: v.union(v.id("creativeJobs"), v.null()), latestJobId: v.union(v.id("creativeJobs"), v.null()), status: v.string() }), v.null()),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.browserTokenHash !== args.browserTokenHash || session.expiresAtMs < args.nowMs || session.status !== "active") return null;
    return { sessionId: session._id, userId: session.userId, threadId: session.threadId, expiresAtMs: session.expiresAtMs, activeJobId: session.activeJobId ?? null, latestJobId: session.latestJobId ?? null, status: session.status };
  },
});

export const createDrawMedia = internalMutation({
  args: { sessionId: v.id("drawSessions"), browserTokenHash: v.string(), sourceUrl: v.string(), mimeType: v.string(), filename: v.string(), byteLength: v.number(), width: v.number(), height: v.number(), nowMs: v.number() },
  returns: v.union(v.id("creativeMedia"), v.null()),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status !== "active" || session.browserTokenHash !== args.browserTokenHash || session.expiresAtMs < args.nowMs) return null;
    return await ctx.db.insert("creativeMedia", { drawSessionId: session._id, userId: session.userId, threadId: session.threadId, role: "input", sourceUrl: args.sourceUrl, mimeType: args.mimeType, filename: args.filename, byteLength: args.byteLength, width: args.width, height: args.height, createdAtMs: args.nowMs, expiresAtMs: Math.min(session.expiresAtMs, args.nowMs + 24 * 60 * 60_000) });
  },
});

export const admitDrawGeneration = internalMutation({
  args: { sessionId: v.id("drawSessions"), browserTokenHash: v.string(), requestKey: v.string(), encryptedPayload: v.string(), prompt: v.string(), inputMediaId: v.optional(v.id("creativeMedia")), nowMs: v.number() },
  returns: v.object({ jobId: v.id("creativeJobs"), state: v.string(), source: v.string(), amountCents: v.number() }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status !== "active" || session.browserTokenHash !== args.browserTokenHash || session.expiresAtMs < args.nowMs) throw new Error("DRAW_SESSION_INVALID");
    const result = await admitCreativeJob(ctx, { userId: session.userId, threadId: session.threadId, sourceMessageId: session.sourceMessageId, turnId: session.turnId, requestKey: args.requestKey, command: "draw", encryptedPayload: args.encryptedPayload, nowMs: args.nowMs, drawSessionId: session._id, ...(args.inputMediaId ? { inputMediaId: args.inputMediaId } : {}), revisionKey: args.requestKey });
    await ctx.db.patch(session._id, { activeJobId: result.jobId, latestJobId: result.jobId, updatedAtMs: args.nowMs });
    await ctx.db.insert("drawEvents", { sessionId: session._id, jobId: result.jobId, sequence: 0, kind: "state", state: result.state, createdAtMs: args.nowMs });
    if (result.state === "admitted") await ctx.scheduler.runAfter(0, internal.creative.run, { jobId: result.jobId });
    return result;
  },
});

export const listDrawEvents = internalQuery({
  args: { sessionId: v.id("drawSessions"), browserTokenHash: v.string(), afterSequence: v.optional(v.number()), nowMs: v.number() },
  returns: v.union(v.object({ events: v.array(v.object({ sequence: v.number(), kind: v.string(), state: v.string(), mediaId: v.union(v.id("creativeMedia"), v.null()), previewIndex: v.union(v.number(), v.null()) })), latest: v.union(v.number(), v.null()) }), v.null()),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status !== "active" || session.browserTokenHash !== args.browserTokenHash || session.expiresAtMs < args.nowMs) return null;
    const events = await ctx.db.query("drawEvents").withIndex("by_session_created", q => q.eq("sessionId", args.sessionId)).collect();
    const filtered = events.filter(item => item.sequence > (args.afterSequence ?? -1)).sort((a,b) => a.sequence-b.sequence).slice(0, 50);
    return { events: filtered.map(item => ({ sequence: item.sequence, kind: item.kind, state: item.state, mediaId: item.mediaId ?? null, previewIndex: item.previewIndex ?? null })), latest: events.length ? Math.max(...events.map(item => item.sequence)) : null };
  },
});

export const claimExpiredMedia = internalMutation({
  args: { nowMs: v.number() },
  returns: v.array(v.object({ mediaId: v.id("creativeMedia"), sourceUrl: v.string() })),
  handler: async (ctx, args) => {
    const expired = await ctx.db
      .query("creativeMedia")
      .withIndex("by_expiry", (q) => q.lt("expiresAtMs", args.nowMs))
      .take(20);
    const result = [] as Array<{ mediaId: Id<"creativeMedia">; sourceUrl: string }>;
    for (const media of expired) {
      if (media.deletedAtMs !== undefined) continue;
      await ctx.db.patch(media._id, { deletedAtMs: args.nowMs });
      result.push({ mediaId: media._id, sourceUrl: media.sourceUrl });
    }
    return result;
  },
});

export const cleanupExpiredMedia = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const expired = await ctx.runMutation(internal.creative.claimExpiredMedia, { nowMs: Date.now() });
    const cleanupUrl = process.env.COAST_CREATIVE_CLEANUP_URL;
    const secret = process.env.COAST_CONVEX_SERVICE_SECRET;
    if (!cleanupUrl || !secret || expired.length === 0) return null;
    await fetch(cleanupUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ urls: expired.map((item) => item.sourceUrl) }),
      signal: AbortSignal.timeout(10_000),
    });
    return null;
  },
});

export const cancelUserJobs = internalMutation({
  args: { userId: v.id("coastUsers"), nowMs: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const jobs = await ctx.db.query("creativeJobs").withIndex("by_user_state", (q) => q.eq("userId", args.userId)).take(50);
    for (const job of jobs) {
      if (!["delivered", "failed", "refused", "cancelled", "expired"].includes(job.state)) await ctx.db.patch(job._id, { state: "cancelled", updatedAtMs: args.nowMs });
    }
    return null;
  },
});

export const claimForProcessing = internalMutation({
  args: { jobId: v.id("creativeJobs"), nowMs: v.number() },
  returns: v.union(v.object({ jobId: v.id("creativeJobs"), command: jobCommand, encryptedPayload: v.string(), encryptedThreadRef: v.string(), attemptId: v.string(), fencingToken: v.number() }), v.null()),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null || job.state !== "admitted") return null;
    const thread = await ctx.db.get(job.threadId);
    if (thread === null) return null;
    const attemptId = `${job._id}:${args.nowMs}`;
    const fencingToken = (job.fencingToken ?? 0) + 1;
    await ctx.db.patch(job._id, { state: "submitting", leaseToken: attemptId, attemptId, fencingToken, leaseExpiresAtMs: args.nowMs + 60_000, updatedAtMs: args.nowMs });
    return { jobId: job._id, command: job.command, encryptedPayload: job.encryptedPayload, encryptedThreadRef: thread.encryptedProviderThreadRef, attemptId, fencingToken };
  },
});

const processingOwnership = {
  jobId: v.id("creativeJobs"),
  attemptId: v.string(),
  fencingToken: v.number(),
};

export const recordProviderSubmission = internalMutation({
  args: { ...processingOwnership, providerRequestId: v.string(), state: v.union(v.literal("queued"), v.literal("running")), nowMs: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.state !== "submitting" || job.attemptId !== args.attemptId || job.fencingToken !== args.fencingToken) return false;
    await ctx.db.patch(job._id, {
      providerRequestId: args.providerRequestId,
      provider: job.command === "zap" ? "fal" : job.provider,
      submittedAtMs: args.nowMs,
      heartbeatAtMs: args.nowMs,
      state: args.state,
      lastErrorCode: undefined,
      updatedAtMs: args.nowMs,
    });
    await ctx.scheduler.runAfter(5_000, internal.creative.poll, { jobId: job._id });
    return true;
  },
});

export const claimForPolling = internalMutation({
  args: { jobId: v.id("creativeJobs"), nowMs: v.number() },
  returns: v.union(v.object({ jobId: v.id("creativeJobs"), command: jobCommand, encryptedPayload: v.string(), attemptId: v.string(), fencingToken: v.number(), providerRequestId: v.string() }), v.null()),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || !["queued", "running", "retryable_failure"].includes(job.state) || !job.providerRequestId || !job.attemptId || !job.fencingToken || job.expiresAtMs <= args.nowMs) return null;
    await ctx.db.patch(job._id, { heartbeatAtMs: args.nowMs, leaseExpiresAtMs: args.nowMs + 60_000, updatedAtMs: args.nowMs });
    return { jobId: job._id, command: job.command, encryptedPayload: job.encryptedPayload, attemptId: job.attemptId, fencingToken: job.fencingToken, providerRequestId: job.providerRequestId };
  },
});

export const recordProviderProgress = internalMutation({
  args: { ...processingOwnership, state: v.union(v.literal("queued"), v.literal("running")), nowMs: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || !["queued", "running", "retryable_failure"].includes(job.state) || job.attemptId !== args.attemptId || job.fencingToken !== args.fencingToken || !job.providerRequestId) return false;
    await ctx.db.patch(job._id, { state: args.state, heartbeatAtMs: args.nowMs, lastErrorCode: undefined, updatedAtMs: args.nowMs });
    await ctx.scheduler.runAfter(5_000, internal.creative.poll, { jobId: job._id });
    return true;
  },
});

export const completeProcessing = internalMutation({
  args: { ...processingOwnership, url: v.string(), mimeType: v.string(), filename: v.string(), caption: v.string(), nowMs: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null || !["submitting", "queued", "running", "retryable_failure"].includes(job.state) || job.attemptId !== args.attemptId || job.fencingToken !== args.fencingToken) return null;
    const mediaId = await ctx.db.insert("creativeMedia", {
      jobId: job._id,
      ...(job.drawSessionId ? { drawSessionId: job.drawSessionId, userId: job.userId, role: "output" as const } : {}),
      threadId: job.threadId,
      sourceUrl: args.url,
      mimeType: args.mimeType,
      filename: args.filename,
      createdAtMs: args.nowMs,
      expiresAtMs: args.nowMs + 24 * 60 * 60 * 1_000,
    });
    const delivery = await ctx.db.insert("outboundDeliveries", {
      turnId: job.turnId,
      threadId: job.threadId,
      stage: "creative_attachment",
      sequence: 1,
      itemKey: String(job._id),
      idempotencyKey: `${job._id}:creative_attachment`,
      payload: { mediaId, mimeType: args.mimeType, filename: args.filename, caption: args.caption },
      status: "pending",
      attemptCount: 0,
      nextAttemptAtMs: args.nowMs,
      createdAtMs: args.nowMs,
      updatedAtMs: args.nowMs,
    });
    await ctx.db.insert("outboundDeliveries", {
      turnId: job.turnId,
      threadId: job.threadId,
      stage: "creative_caption",
      sequence: 2,
      itemKey: `${String(job._id)}:caption`,
      idempotencyKey: `${job._id}:creative_caption`,
      payload: { text: args.caption },
      status: "pending",
      attemptCount: 0,
      nextAttemptAtMs: args.nowMs,
      createdAtMs: args.nowMs,
      updatedAtMs: args.nowMs,
    });
    await ctx.db.patch(job._id, { state: "ready_for_delivery", deliveryId: delivery, outputMediaId: mediaId, updatedAtMs: args.nowMs });
    if (job.drawSessionId) {
      const prior = await ctx.db.query("drawEvents").withIndex("by_job_sequence", q => q.eq("jobId", job._id)).collect();
      await ctx.db.insert("drawEvents", { sessionId: job.drawSessionId, jobId: job._id, sequence: (prior.length ? Math.max(...prior.map(item => item.sequence)) : 0) + 1, kind: "completed", state: "ready_for_delivery", mediaId, createdAtMs: args.nowMs });
      await ctx.db.patch(job.drawSessionId, { latestJobId: job._id, updatedAtMs: args.nowMs });
    }
    await ctx.scheduler.runAfter(0, internal.turnQueue.deliverTurn, { turnId: job.turnId });
    return null;
  },
});

export const failProcessing = internalMutation({
  args: { ...processingOwnership, errorCode: v.string(), outcome: v.union(v.literal("definitive"), v.literal("unknown"), v.literal("retryable")), nowMs: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || !["submitting", "queued", "running", "retryable_failure"].includes(job.state) || job.attemptId !== args.attemptId || job.fencingToken !== args.fencingToken) return null;
    if (args.outcome === "definitive") {
      await ctx.db.patch(job._id, { state: "failed", lastErrorCode: args.errorCode, updatedAtMs: args.nowMs });
      await releaseCreativeFunding(ctx, job, args.nowMs);
    } else {
      await ctx.db.patch(job._id, { state: args.outcome === "unknown" ? "submission_unknown" : "retryable_failure", lastErrorCode: args.errorCode, updatedAtMs: args.nowMs });
      if (args.outcome === "retryable" && job.providerRequestId) await ctx.scheduler.runAfter(15_000, internal.creative.poll, { jobId: job._id });
    }
    return null;
  },
});

async function runtimeErrorCode(response: Response): Promise<string> {
  const header = response.headers.get("x-coast-error-code");
  if (header && /^[A-Z0-9_]{3,120}$/iu.test(header)) return header.slice(0, 120);
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string" && /^[A-Z0-9_]{3,120}$/iu.test(body.error)) return body.error.slice(0, 120);
  } catch {
    // The HTTP status remains sufficient and contains no user content.
  }
  return `CREATIVE_RUNTIME_HTTP_${response.status}`;
}

function failureOutcome(status: number, hasProviderRequestId: boolean): "definitive" | "unknown" | "retryable" {
  if (status >= 400 && status < 500) return "definitive";
  return hasProviderRequestId ? "retryable" : "unknown";
}

export const run = internalAction({
  args: { jobId: v.id("creativeJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const claim = await ctx.runMutation(internal.creative.claimForProcessing, { jobId: args.jobId, nowMs: Date.now() });
    if (claim === null) return null;
    const runtimeUrl = claim.command === "draw" ? process.env.COAST_DRAW_RUNTIME_URL : process.env.COAST_CREATIVE_RUNTIME_URL;
    const secret = process.env.COAST_CONVEX_SERVICE_SECRET;
    if (!runtimeUrl || !secret) {
      await ctx.runMutation(internal.creative.failProcessing, { jobId: args.jobId, attemptId: claim.attemptId, fencingToken: claim.fencingToken, errorCode: "CREATIVE_RUNTIME_NOT_CONFIGURED", outcome: "retryable", nowMs: Date.now() });
      return null;
    }
    try {
      const requestBody = { jobId: claim.jobId, attemptId: claim.attemptId, fencingToken: claim.fencingToken, command: claim.command, encryptedPayload: claim.encryptedPayload, ...(claim.command === "draw" ? {} : { operation: "submit" as const }) };
      const response = await fetch(runtimeUrl, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(requestBody), signal: AbortSignal.timeout(claim.command === "draw" ? 270_000 : 30_000) });
      if (!response.ok) {
        await ctx.runMutation(internal.creative.failProcessing, { jobId: args.jobId, attemptId: claim.attemptId, fencingToken: claim.fencingToken, errorCode: await runtimeErrorCode(response), outcome: failureOutcome(response.status, false), nowMs: Date.now() });
        return null;
      }
      const result = (await response.json()) as { status?: unknown; providerRequestId?: unknown; url?: unknown; mimeType?: unknown; filename?: unknown; caption?: unknown };
      if ((result.status === "queued" || result.status === "running") && typeof result.providerRequestId === "string") {
        await ctx.runMutation(internal.creative.recordProviderSubmission, { jobId: args.jobId, attemptId: claim.attemptId, fencingToken: claim.fencingToken, providerRequestId: result.providerRequestId, state: result.status, nowMs: Date.now() });
      } else if ((result.status === "completed" || claim.command === "draw") && typeof result.url === "string" && typeof result.mimeType === "string" && typeof result.filename === "string") {
        await ctx.runMutation(internal.creative.completeProcessing, { jobId: args.jobId, attemptId: claim.attemptId, fencingToken: claim.fencingToken, url: result.url, mimeType: result.mimeType, filename: result.filename, caption: typeof result.caption === "string" ? result.caption : "Here’s your creation.", nowMs: Date.now() });
      } else {
        await ctx.runMutation(internal.creative.failProcessing, { jobId: args.jobId, attemptId: claim.attemptId, fencingToken: claim.fencingToken, errorCode: "CREATIVE_RUNTIME_INVALID_RESULT", outcome: "unknown", nowMs: Date.now() });
      }
    } catch {
      await ctx.runMutation(internal.creative.failProcessing, { jobId: args.jobId, attemptId: claim.attemptId, fencingToken: claim.fencingToken, errorCode: "CREATIVE_SUBMISSION_UNKNOWN", outcome: "unknown", nowMs: Date.now() });
    }
    return null;
  },
});

export const poll = internalAction({
  args: { jobId: v.id("creativeJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const claim = await ctx.runMutation(internal.creative.claimForPolling, { jobId: args.jobId, nowMs: Date.now() });
    if (!claim) return null;
    const runtimeUrl = claim.command === "draw" ? process.env.COAST_DRAW_RUNTIME_URL : process.env.COAST_CREATIVE_RUNTIME_URL;
    const secret = process.env.COAST_CONVEX_SERVICE_SECRET;
    if (!runtimeUrl || !secret || claim.command === "draw") return null;
    try {
      const response = await fetch(runtimeUrl, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ operation: "poll", jobId: claim.jobId, attemptId: claim.attemptId, fencingToken: claim.fencingToken, command: claim.command, encryptedPayload: claim.encryptedPayload, providerRequestId: claim.providerRequestId }), signal: AbortSignal.timeout(90_000) });
      if (!response.ok) {
        await ctx.runMutation(internal.creative.failProcessing, { jobId: args.jobId, attemptId: claim.attemptId, fencingToken: claim.fencingToken, errorCode: await runtimeErrorCode(response), outcome: failureOutcome(response.status, true), nowMs: Date.now() });
        return null;
      }
      const result = (await response.json()) as { status?: unknown; url?: unknown; mimeType?: unknown; filename?: unknown; caption?: unknown };
      if (result.status === "queued" || result.status === "running") {
        await ctx.runMutation(internal.creative.recordProviderProgress, { jobId: args.jobId, attemptId: claim.attemptId, fencingToken: claim.fencingToken, state: result.status, nowMs: Date.now() });
      } else if (result.status === "completed" && typeof result.url === "string" && typeof result.mimeType === "string" && typeof result.filename === "string") {
        await ctx.runMutation(internal.creative.completeProcessing, { jobId: args.jobId, attemptId: claim.attemptId, fencingToken: claim.fencingToken, url: result.url, mimeType: result.mimeType, filename: result.filename, caption: typeof result.caption === "string" ? result.caption : "Here’s your creation.", nowMs: Date.now() });
      } else {
        await ctx.runMutation(internal.creative.failProcessing, { jobId: args.jobId, attemptId: claim.attemptId, fencingToken: claim.fencingToken, errorCode: "CREATIVE_RUNTIME_INVALID_RESULT", outcome: "retryable", nowMs: Date.now() });
      }
    } catch {
      await ctx.runMutation(internal.creative.failProcessing, { jobId: args.jobId, attemptId: claim.attemptId, fencingToken: claim.fencingToken, errorCode: "CREATIVE_POLL_FAILED", outcome: "retryable", nowMs: Date.now() });
    }
    return null;
  },
});

export type CreativeJobId = Id<"creativeJobs">;
