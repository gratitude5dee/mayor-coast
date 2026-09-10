import { insertOwnedDelivery } from "./lib/adminOwnership";
import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { serviceSecretFingerprintHex } from "./lib/service_auth";
import { CREATIVE_ACTIVE_STATES, admitCreativeJob, appendCreativeLedger, creativeKind, getCreativeCredits, releaseCreativeFunding, settleCreativeFunding } from "./lib/creative";
import { creativePollDelayMs } from "../src/lib/creative";

const jobCommand = v.union(v.literal("imagine"), v.literal("zap"), v.literal("draw"));
const reservationSource = v.union(v.literal("free"), v.literal("credit"), v.literal("payment"));
const drawMode = v.union(v.literal("fast"), v.literal("detailed"), v.literal("turbo"), v.literal("hq"));

async function nextDrawEventSequence(ctx: MutationCtx, sessionId: Id<"drawSessions">): Promise<number> {
  const session = await ctx.db.get(sessionId);
  if (!session) throw new Error("DRAW_SESSION_MISSING");
  let current = session.eventSequence;
  if (current === undefined) {
    const existing = await ctx.db.query("drawEvents").withIndex("by_session_created", q => q.eq("sessionId", sessionId)).collect();
    current = existing.reduce((maximum, event) => Math.max(maximum, event.sequence), -1);
  }
  const next = current + 1;
  await ctx.db.patch(sessionId, { eventSequence: next });
  return next;
}

export const getCredits = internalQuery({
  args: { userId: v.id("coastUsers"), nowMs: v.number() },
  returns: v.object({ imageFreeRemaining: v.number(), videoFreeRemaining: v.number(), creditCents: v.number(), activeJob: v.boolean(), activeImageJob: v.union(v.id("creativeJobs"), v.null()), activeVideoJob: v.union(v.id("creativeJobs"), v.null()) }),
  handler: (ctx, args) => getCreativeCredits(ctx, args.userId, args.nowMs),
});

// Additive migration for accounts created before image/video slots existed.
// The scheduled cursor keeps each transaction bounded and relies only on
// verified live jobs, so it cannot alter settled balances or reservations.
export const backfillActiveSlots = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({ cursor: v.string(), isDone: v.boolean(), scanned: v.number(), updated: v.number() }),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("creativeCreditAccounts").paginate({ numItems: 50, cursor: args.cursor });
    let updated = 0;
    for (const account of page.page) {
      const liveByState = await Promise.all(
        CREATIVE_ACTIVE_STATES.map((state) => ctx.db.query("creativeJobs")
          .withIndex("by_user_state", (q) => q.eq("userId", account.userId).eq("state", state))
          .collect()),
      );
      const live = liveByState.flat().sort((left, right) => right.createdAtMs - left.createdAtMs);
      const image = live.find((job) => creativeKind(job.command) === "image");
      const video = live.find((job) => creativeKind(job.command) === "video");
      const patch = {
        activeImageJobId: image?._id,
        activeVideoJobId: video?._id,
        // Legacy readers receive the newest live work while all new admission
        // checks use the two specific slots above.
        activeJobId: live[0]?._id,
        updatedAtMs: Date.now(),
      };
      if (
        account.activeImageJobId !== patch.activeImageJobId ||
        account.activeVideoJobId !== patch.activeVideoJobId ||
        account.activeJobId !== patch.activeJobId
      ) {
        await ctx.db.patch(account._id, patch);
        updated += 1;
      }
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.creative.backfillActiveSlots, { cursor: page.continueCursor });
    return { cursor: page.continueCursor, isDone: page.isDone, scanned: page.page.length, updated };
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
  handler: (ctx, args) => admitCreativeJob(ctx, args),
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
    await ctx.db.insert("creativePaymentEvents", { userId: order.userId, eventId: args.eventId, paymentIdentity: args.paymentIdentity, orderId: args.orderId, createdAtMs: args.nowMs });
    await appendCreativeLedger(ctx, {
      userId: order.userId,
      topupOrderId: args.orderId,
      kind: "topup",
      amountCents: 1_000,
      idempotencyKey: `topup:${args.orderId}`,
      createdAtMs: args.nowMs,
    });
    await ctx.db.patch(order._id, { status: "succeeded", updatedAtMs: args.nowMs });
    if (order.savedJobId !== undefined) {
      const job = await ctx.db.get(order.savedJobId);
      if (job?.state === "awaiting_payment") {
        // Payment resumption uses the same transaction as every other
        // creative request. This rechecks status, rolling allowance, balance,
        // cancellation, expiry, and the command's image/video slot.
        const resumed = await admitCreativeJob(ctx, {
          userId: job.userId,
          threadId: job.threadId,
          sourceMessageId: job.sourceMessageId,
          turnId: job.turnId,
          requestKey: job.requestKey,
          command: job.command,
          encryptedPayload: job.encryptedPayload,
          nowMs: args.nowMs,
          resumeJobId: job._id,
          ...(job.drawSessionId ? { drawSessionId: job.drawSessionId } : {}),
          ...(job.drawMode ? { drawMode: job.drawMode } : {}),
          ...(job.revisionKey ? { revisionKey: job.revisionKey } : {}),
          ...(job.inputMediaId ? { inputMediaId: job.inputMediaId } : {}),
          ...(job.inputCategory ? { inputCategory: job.inputCategory } : {}),
        });
        if (resumed.state === "admitted") {
          await ctx.scheduler.runAfter(0, internal.creative.run, { jobId: resumed.jobId });
        }
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
    await ctx.db.insert("creativePaymentEvents", { userId: order.userId, eventId: args.eventId, paymentIdentity: args.paymentIdentity, orderId: args.orderId, createdAtMs: args.nowMs });
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

// A revision opened from `/edit` lives in a new Draw session but may display
// an ancestor artifact from the same user/thread/root. The root comparison is
// the ownership proof; arbitrary same-user media is never sufficient.
export const getAuthorizedDrawMedia = internalQuery({
  args: { sessionId: v.id("drawSessions"), browserTokenHash: v.string(), mediaId: v.id("creativeMedia"), nowMs: v.number() },
  returns: v.union(v.object({ sourceUrl: v.string(), mimeType: v.string(), filename: v.string(), expiresAtMs: v.number() }), v.null()),
  handler: async (ctx, args) => {
    const [session, media] = await Promise.all([ctx.db.get(args.sessionId), ctx.db.get(args.mediaId)]);
    if (!session || !media || session.status !== "active" || session.browserTokenHash !== args.browserTokenHash || session.expiresAtMs <= args.nowMs || media.deletedAtMs !== undefined || media.expiresAtMs <= args.nowMs || media.userId !== session.userId || media.threadId !== session.threadId) return null;
    if (media.drawSessionId === session._id) return { sourceUrl: media.sourceUrl, mimeType: media.mimeType, filename: media.filename, expiresAtMs: media.expiresAtMs };
    if (!media.jobId || !session.latestJobId) return null;
    const [mediaJob, latestJob] = await Promise.all([ctx.db.get(media.jobId), ctx.db.get(session.latestJobId)]);
    const mediaRoot = mediaJob?.rootJobId ?? mediaJob?._id;
    const latestRoot = latestJob?.rootJobId ?? latestJob?._id;
    if (!mediaRoot || !latestRoot || mediaRoot !== latestRoot) return null;
    return { sourceUrl: media.sourceUrl, mimeType: media.mimeType, filename: media.filename, expiresAtMs: media.expiresAtMs };
  },
});

// This is deliberately narrower than browser media access: Fal receives a
// short-lived signed URL that can read only the input attached to its current
// Draw job. The route still verifies cancellation, job identity, and expiry.
export const getCreativeProviderInput = internalQuery({
  args: { jobId: v.id("creativeJobs"), mediaId: v.id("creativeMedia"), nowMs: v.number() },
  returns: v.union(v.object({ sourceUrl: v.string(), mimeType: v.string() }), v.null()),
  handler: async (ctx, args) => {
    const [job, media] = await Promise.all([ctx.db.get(args.jobId), ctx.db.get(args.mediaId)]);
    if (!job || !media || job.inputMediaId !== media._id || media.deletedAtMs !== undefined || media.expiresAtMs <= args.nowMs || ["cancelled", "failed", "refused", "expired"].includes(job.state)) return null;
    return { sourceUrl: media.sourceUrl, mimeType: media.mimeType };
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
    return await ctx.db.insert("creativeMedia", { drawSessionId: session._id, userId: session.userId, threadId: session.threadId, role: "input", sourceUrl: args.sourceUrl, mimeType: args.mimeType, filename: args.filename, byteLength: args.byteLength, width: args.width, height: args.height, createdAtMs: args.nowMs, expiresAtMs: Math.min(session.expiresAtMs, args.nowMs + 24 * 60 * 60_000), deletionState: "pending" });
  },
});

export const admitDrawGeneration = internalMutation({
  // Prompt text is encrypted at Vercel. Convex only receives opaque payloads
  // and relationship metadata needed for transactional admission.
  args: { sessionId: v.id("drawSessions"), browserTokenHash: v.string(), requestKey: v.string(), requestFingerprint: v.string(), encryptedPayload: v.string(), mode: drawMode, inputMediaId: v.optional(v.id("creativeMedia")), inputCategory: v.optional(v.union(v.literal("prompt"), v.literal("sketch"), v.literal("photo"), v.literal("result"))), parentJobId: v.optional(v.id("creativeJobs")), resetContext: v.optional(v.boolean()), nowMs: v.number() },
  returns: v.object({ jobId: v.id("creativeJobs"), state: v.string(), source: v.string(), amountCents: v.number() }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status !== "active" || session.browserTokenHash !== args.browserTokenHash || session.expiresAtMs < args.nowMs) throw new Error("DRAW_SESSION_INVALID");
    const parent = args.parentJobId ? await ctx.db.get(args.parentJobId) : null;
    if (args.parentJobId && (!parent || parent.command !== "draw" || parent.userId !== session.userId || parent.threadId !== session.threadId || !parent.outputMediaId || !["ready_for_save", "ready_for_delivery", "delivered"].includes(parent.state))) {
      throw new Error("DRAW_PARENT_UNAVAILABLE");
    }
    const parentMedia = parent?.outputMediaId ? await ctx.db.get(parent.outputMediaId) : null;
    if (parent && (!parentMedia || parentMedia.deletedAtMs !== undefined || parentMedia.expiresAtMs <= args.nowMs)) throw new Error("DRAW_PARENT_EXPIRED");
    const inheritedInput = args.inputMediaId ?? parent?.outputMediaId;
    const rootJobId = parent ? (parent.rootJobId ?? parent._id) : undefined;
    const revisionNumber = parent ? (parent.revisionNumber ?? 1) + 1 : 1;
    const drawApiMode = args.mode === "turbo" ? "turbo" as const : parent && process.env.COAST_DRAW_MULTITURN_ENABLED === "true" ? "responses" as const : "images" as const;
    const result = await admitCreativeJob(ctx, {
      userId: session.userId, threadId: session.threadId, sourceMessageId: session.sourceMessageId, turnId: session.turnId,
      requestKey: args.requestKey, requestFingerprint: args.requestFingerprint, command: "draw", encryptedPayload: args.encryptedPayload,
      nowMs: args.nowMs, drawSessionId: session._id, drawMode: args.mode, revisionKey: args.requestKey, drawApiMode,
      ...(inheritedInput ? { inputMediaId: inheritedInput } : {}),
      ...(args.inputCategory ? { inputCategory: args.inputCategory } : parent ? { inputCategory: "result" as const } : {}),
      ...(parent ? { parentJobId: parent._id, ...(rootJobId ? { rootJobId } : {}), revisionNumber, ...(args.resetContext ? { contextReset: true } : {}) } : { revisionNumber }),
    });
    const sequence = await nextDrawEventSequence(ctx, session._id);
    await ctx.db.patch(session._id, { activeJobId: result.jobId, latestJobId: result.jobId, updatedAtMs: args.nowMs });
    await ctx.db.insert("drawEvents", { sessionId: session._id, jobId: result.jobId, sequence, kind: "state", state: result.state, createdAtMs: args.nowMs });
    if (result.state === "admitted") await ctx.scheduler.runAfter(0, internal.creative.run, { jobId: result.jobId });
    return result;
  },
});

export const animateDrawJob = internalMutation({
  args: { sessionId: v.id("drawSessions"), browserTokenHash: v.string(), jobId: v.id("creativeJobs"), requestKey: v.string(), encryptedPayload: v.string(), nowMs: v.number() },
  returns: v.object({ jobId: v.id("creativeJobs"), state: v.string(), source: v.string(), amountCents: v.number() }),
  handler: async (ctx, args) => {
    const [session, drawJob] = await Promise.all([ctx.db.get(args.sessionId), ctx.db.get(args.jobId)]);
    if (!session || !drawJob || session.status !== "active" || session.browserTokenHash !== args.browserTokenHash || session.expiresAtMs < args.nowMs || drawJob.drawSessionId !== session._id || !["ready_for_save", "ready_for_delivery", "delivered"].includes(drawJob.state) || !drawJob.outputMediaId) throw new Error("DRAW_RESULT_UNAVAILABLE");
    const output = await ctx.db.get(drawJob.outputMediaId);
    if (!output || output.deletedAtMs !== undefined || output.expiresAtMs <= args.nowMs) throw new Error("DRAW_RESULT_UNAVAILABLE");
    const result = await admitCreativeJob(ctx, {
      userId: session.userId,
      threadId: session.threadId,
      sourceMessageId: session.sourceMessageId,
      turnId: session.turnId,
      requestKey: args.requestKey,
      command: "zap",
      encryptedPayload: args.encryptedPayload,
      inputMediaId: output._id,
      inputCategory: "result",
      nowMs: args.nowMs,
    });
    if (result.state === "admitted") await ctx.scheduler.runAfter(0, internal.creative.run, { jobId: result.jobId });
    return result;
  },
});

export const listDrawEvents = internalQuery({
  args: { sessionId: v.id("drawSessions"), browserTokenHash: v.string(), afterSequence: v.optional(v.number()), nowMs: v.number() },
  returns: v.union(v.object({ events: v.array(v.object({ jobId: v.id("creativeJobs"), sequence: v.number(), kind: v.string(), state: v.string(), mediaId: v.union(v.id("creativeMedia"), v.null()), previewIndex: v.union(v.number(), v.null()), errorCode: v.union(v.string(), v.null()) })), latest: v.union(v.number(), v.null()), activeJobId: v.union(v.id("creativeJobs"), v.null()), latestJobId: v.union(v.id("creativeJobs"), v.null()), initialMediaId: v.union(v.id("creativeMedia"), v.null()), currentJob: v.union(v.object({ jobId: v.id("creativeJobs"), state: v.string(), previewMediaId: v.union(v.id("creativeMedia"), v.null()), outputMediaId: v.union(v.id("creativeMedia"), v.null()), errorCode: v.union(v.string(), v.null()) }), v.null()) }), v.null()),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status !== "active" || session.browserTokenHash !== args.browserTokenHash || session.expiresAtMs < args.nowMs) return null;
    const events = await ctx.db.query("drawEvents").withIndex("by_session_created", q => q.eq("sessionId", args.sessionId)).collect();
    const filtered = await ctx.db.query("drawEvents").withIndex("by_session_sequence", q => q.eq("sessionId", args.sessionId).gt("sequence", args.afterSequence ?? -1)).take(50);
    const latestJob = session.latestJobId ? await ctx.db.get(session.latestJobId) : null;
    const latestPreview = latestJob
      ? events.filter(item => item.jobId === latestJob._id && item.kind === "preview" && item.mediaId).sort((a, b) => b.sequence - a.sequence)[0]
      : undefined;
    return {
      events: filtered.map(item => ({ jobId: item.jobId, sequence: item.sequence, kind: item.kind, state: item.state, mediaId: item.mediaId ?? null, previewIndex: item.previewIndex ?? null, errorCode: item.errorCode ?? null })),
      latest: session.eventSequence ?? (events.length ? Math.max(...events.map(item => item.sequence)) : null),
      activeJobId: session.activeJobId ?? null,
      latestJobId: session.latestJobId ?? null,
      initialMediaId: session.initialMediaId ?? null,
      currentJob: latestJob ? {
        jobId: latestJob._id,
        state: latestJob.state,
        previewMediaId: latestPreview?.mediaId ?? null,
        outputMediaId: latestJob.outputMediaId ?? null,
        errorCode: latestJob.lastErrorCode ?? null,
      } : null,
    };
  },
});

export const listDrawRevisions = internalQuery({
  args: { sessionId: v.id("drawSessions"), browserTokenHash: v.string(), cursor: v.optional(v.number()), nowMs: v.number() },
  returns: v.union(v.object({ revisions: v.array(v.object({ jobId: v.id("creativeJobs"), parentJobId: v.union(v.id("creativeJobs"), v.null()), rootJobId: v.union(v.id("creativeJobs"), v.null()), revisionNumber: v.number(), mode: v.union(drawMode, v.null()), model: v.union(v.string(), v.null()), state: v.string(), outputMediaId: v.union(v.id("creativeMedia"), v.null()), previewMediaId: v.union(v.id("creativeMedia"), v.null()), createdAtMs: v.number() })), nextCursor: v.union(v.number(), v.null()) }), v.null()),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status !== "active" || session.browserTokenHash !== args.browserTokenHash || session.expiresAtMs < args.nowMs) return null;
    const newest = session.latestJobId ? await ctx.db.get(session.latestJobId) : null;
    const root = newest?.rootJobId ?? newest?._id;
    if (!root) return { revisions: [], nextCursor: null };
    const all = await ctx.db.query("creativeJobs").withIndex("by_root_revision", q => q.eq("rootJobId", root)).collect();
    const ordered = all.sort((left, right) => (left.revisionNumber ?? 1) - (right.revisionNumber ?? 1));
    const cursor = Math.max(0, args.cursor ?? 0);
    const page = ordered.slice(cursor, cursor + 50);
    const revisions = await Promise.all(page.map(async (job) => {
      const previews = await ctx.db.query("drawEvents").withIndex("by_job_sequence", q => q.eq("jobId", job._id)).collect();
      const preview = previews.filter(event => event.kind === "preview" && event.mediaId).sort((a, b) => b.sequence - a.sequence)[0];
      return { jobId: job._id, parentJobId: job.parentJobId ?? null, rootJobId: job.rootJobId ?? null, revisionNumber: job.revisionNumber ?? 1, mode: job.drawMode ?? null, model: job.providerModel ?? null, state: job.state, outputMediaId: job.outputMediaId ?? null, previewMediaId: preview?.mediaId ?? job.currentPreviewMediaId ?? null, createdAtMs: job.createdAtMs };
    }));
    return { revisions, nextCursor: cursor + page.length < ordered.length ? cursor + page.length : null };
  },
});

export const getDrawRevisionInstruction = internalQuery({
  args: { sessionId: v.id("drawSessions"), browserTokenHash: v.string(), jobId: v.id("creativeJobs"), nowMs: v.number() },
  returns: v.union(v.object({ encryptedPayload: v.string() }), v.null()),
  handler: async (ctx, args) => {
    const [session, job] = await Promise.all([ctx.db.get(args.sessionId), ctx.db.get(args.jobId)]);
    if (!session || !job || session.status !== "active" || session.browserTokenHash !== args.browserTokenHash || session.expiresAtMs < args.nowMs || job.userId !== session.userId || job.threadId !== session.threadId || job.command !== "draw") return null;
    return { encryptedPayload: job.encryptedPayload };
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
      if (media.deletedAtMs !== undefined || media.deletionState === "deleted") continue;
      if (media.deletionState === "deleting" && (media.deletionLeaseUntilMs ?? 0) > args.nowMs) continue;
      await ctx.db.patch(media._id, {
        deletionState: "deleting",
        deletionLeaseUntilMs: args.nowMs + 5 * 60_000,
        deletionAttempts: (media.deletionAttempts ?? 0) + 1,
      });
      result.push({ mediaId: media._id, sourceUrl: media.sourceUrl });
    }
    return result;
  },
});

export const acknowledgeMediaDeletion = internalMutation({
  args: { mediaIds: v.array(v.id("creativeMedia")), success: v.boolean(), nowMs: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const mediaId of args.mediaIds) {
      const media = await ctx.db.get(mediaId);
      if (!media || media.deletionState !== "deleting") continue;
      await ctx.db.patch(mediaId, args.success
        ? { deletionState: "deleted", deletedAtMs: args.nowMs, deletionLeaseUntilMs: undefined }
        : { deletionState: "pending", deletionLeaseUntilMs: undefined });
    }
    return null;
  },
});

export const cleanupExpiredMedia = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cleanupUrl = process.env.COAST_CREATIVE_CLEANUP_URL;
    const secret = process.env.COAST_CONVEX_SERVICE_SECRET;
    if (!cleanupUrl || !secret) return null;
    const expired = await ctx.runMutation(internal.creative.claimExpiredMedia, { nowMs: Date.now() });
    if (expired.length === 0) return null;
    try {
      const response = await fetch(cleanupUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ urls: expired.map((item) => item.sourceUrl) }),
        signal: AbortSignal.timeout(10_000),
      });
      await ctx.runMutation(internal.creative.acknowledgeMediaDeletion, { mediaIds: expired.map(item => item.mediaId), success: response.ok, nowMs: Date.now() });
    } catch {
      await ctx.runMutation(internal.creative.acknowledgeMediaDeletion, { mediaIds: expired.map(item => item.mediaId), success: false, nowMs: Date.now() });
    }
    return null;
  },
});

export const cancelUserJobs = internalMutation({
  args: { userId: v.id("coastUsers"), nowMs: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const jobs = await ctx.db.query("creativeJobs").withIndex("by_user_state", (q) => q.eq("userId", args.userId)).take(50);
    for (const job of jobs) {
      if (!["delivered", "failed", "refused", "cancelled", "expired"].includes(job.state)) {
        await ctx.db.patch(job._id, { state: "cancelled", updatedAtMs: args.nowMs });
        await releaseCreativeFunding(ctx, job, args.nowMs);
      }
    }
    return null;
  },
});

export const claimForProcessing = internalMutation({
  args: { jobId: v.id("creativeJobs"), nowMs: v.number() },
  returns: v.union(v.object({ jobId: v.id("creativeJobs"), command: jobCommand, encryptedPayload: v.string(), encryptedThreadRef: v.string(), attemptId: v.string(), fencingToken: v.number(), inputMediaId: v.union(v.id("creativeMedia"), v.null()) }), v.null()),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null || job.state !== "admitted") return null;
    const thread = await ctx.db.get(job.threadId);
    if (thread === null) return null;
    const attemptId = `${job._id}:${args.nowMs}`;
    const fencingToken = (job.fencingToken ?? 0) + 1;
    await ctx.db.patch(job._id, { state: "submitting", leaseToken: attemptId, attemptId, fencingToken, leaseExpiresAtMs: args.nowMs + 60_000, updatedAtMs: args.nowMs });
    return { jobId: job._id, command: job.command, encryptedPayload: job.encryptedPayload, encryptedThreadRef: thread.encryptedProviderThreadRef, attemptId, fencingToken, inputMediaId: job.inputMediaId ?? null };
  },
});

export const getDrawProviderContext = internalQuery({
  args: { jobId: v.id("creativeJobs") },
  returns: v.union(v.object({ drawApiMode: v.union(v.literal("images"), v.literal("responses"), v.literal("turbo")), drawMode, encryptedPayloads: v.array(v.string()) }), v.null()),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.command !== "draw") return null;
    const payloads: string[] = [];
    let cursor: typeof job | null = job;
    // Bounded ancestry prevents a malformed cycle from pinning a worker. The
    // worker applies the separate 32k instruction limit after decryption.
    for (let depth = 0; cursor && depth < 64; depth += 1) {
      payloads.push(cursor.encryptedPayload);
      if (cursor.contextReset || !cursor.parentJobId) break;
      cursor = await ctx.db.get(cursor.parentJobId);
    }
    return { drawApiMode: job.drawApiMode ?? (job.drawMode === "turbo" ? "turbo" : "images"), drawMode: job.drawMode ?? "fast", encryptedPayloads: payloads.reverse() };
  },
});

const processingOwnership = {
  jobId: v.id("creativeJobs"),
  attemptId: v.string(),
  fencingToken: v.number(),
};

export const recordDrawSubmission = internalMutation({
  args: { ...processingOwnership, providerRequestId: v.string(), providerModel: v.string(), state: v.optional(v.union(v.literal("queued"), v.literal("running"))), nowMs: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.command !== "draw" || job.state !== "submitting" || job.attemptId !== args.attemptId || job.fencingToken !== args.fencingToken) return false;
    const sequence = job.drawSessionId ? await nextDrawEventSequence(ctx, job.drawSessionId) : (job.eventSequence ?? 0) + 1;
    await ctx.db.patch(job._id, {
      state: args.state ?? "running",
      providerRequestId: args.providerRequestId,
      providerModel: args.providerModel,
      submittedAtMs: args.nowMs,
      firstStateAtMs: job.firstStateAtMs ?? args.nowMs,
      heartbeatAtMs: args.nowMs,
      eventSequence: sequence,
      updatedAtMs: args.nowMs,
    });
    if (job.drawSessionId) await ctx.db.insert("drawEvents", { sessionId: job.drawSessionId, jobId: job._id, sequence, kind: "state", state: args.state ?? "running", createdAtMs: args.nowMs });
    if ((args.state ?? "running") === "queued") await ctx.scheduler.runAfter(0, internal.creative.poll, { jobId: job._id });
    return true;
  },
});

export const recordDrawPreview = internalMutation({
  args: { ...processingOwnership, sourceUrl: v.string(), mimeType: v.string(), filename: v.string(), byteLength: v.number(), previewIndex: v.number(), nowMs: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.command !== "draw" || job.state !== "running" || !job.drawSessionId || job.attemptId !== args.attemptId || job.fencingToken !== args.fencingToken) return false;
    const priorEvents = await ctx.db.query("drawEvents").withIndex("by_job_sequence", q => q.eq("jobId", job._id)).collect();
    const priorPreviewIndexes = priorEvents.filter(event => event.kind === "preview" && event.previewIndex !== undefined).map(event => event.previewIndex as number);
    // A provider can replay a partial after reconnecting. It must not replace
    // a newer preview or leak another private object.
    if (priorPreviewIndexes.includes(args.previewIndex)) return true;
    if (priorPreviewIndexes.some(index => index > args.previewIndex)) return false;
    const retireAtMs = args.nowMs + 15 * 60_000;
    for (const event of priorEvents) {
      if (event.kind !== "preview" || !event.mediaId) continue;
      const media = await ctx.db.get(event.mediaId);
      if (media && media.expiresAtMs > retireAtMs) await ctx.db.patch(media._id, { expiresAtMs: retireAtMs });
    }
    const mediaId = await ctx.db.insert("creativeMedia", {
      jobId: job._id,
      drawSessionId: job.drawSessionId,
      userId: job.userId,
      threadId: job.threadId,
      role: "preview",
      sourceUrl: args.sourceUrl,
      mimeType: args.mimeType,
      filename: args.filename,
      byteLength: args.byteLength,
      createdAtMs: args.nowMs,
      expiresAtMs: Math.min(job.expiresAtMs, retireAtMs),
      deletionState: "pending",
    });
    const sequence = await nextDrawEventSequence(ctx, job.drawSessionId);
    await ctx.db.insert("drawEvents", { sessionId: job.drawSessionId, jobId: job._id, sequence, kind: "preview", state: "running", mediaId, previewIndex: args.previewIndex, createdAtMs: args.nowMs });
    await ctx.db.patch(job._id, { currentPreviewMediaId: mediaId, eventSequence: sequence, heartbeatAtMs: args.nowMs, firstPreviewAtMs: job.firstPreviewAtMs ?? args.nowMs, updatedAtMs: args.nowMs });
    return true;
  },
});

export const cancelDrawJob = internalMutation({
  args: { sessionId: v.id("drawSessions"), browserTokenHash: v.string(), jobId: v.id("creativeJobs"), nowMs: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    const job = await ctx.db.get(args.jobId);
    if (!session || !job || session.browserTokenHash !== args.browserTokenHash || session.status !== "active" || job.drawSessionId !== session._id || ["delivered", "failed", "refused", "cancelled", "expired"].includes(job.state)) return false;
    const sequence = await nextDrawEventSequence(ctx, session._id);
    await ctx.db.patch(job._id, { state: "cancelled", eventSequence: sequence, lastErrorCode: "DRAW_CANCELLED", updatedAtMs: args.nowMs });
    await ctx.db.insert("drawEvents", { sessionId: session._id, jobId: job._id, sequence, kind: "state", state: "cancelled", createdAtMs: args.nowMs });
    await releaseCreativeFunding(ctx, job, args.nowMs);
    return true;
  },
});

export const saveDrawJob = internalMutation({
  args: { sessionId: v.id("drawSessions"), browserTokenHash: v.string(), jobId: v.id("creativeJobs"), nowMs: v.number() },
  returns: v.object({ saved: v.boolean(), state: v.string() }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    const job = await ctx.db.get(args.jobId);
    if (!session || !job || session.browserTokenHash !== args.browserTokenHash || session.status !== "active" || session.expiresAtMs <= args.nowMs || job.drawSessionId !== session._id) {
      return { saved: false, state: "unauthorized" };
    }
    if (job.state === "delivered") return { saved: true, state: "delivered" };
    if (job.state === "ready_for_delivery") {
      await ctx.scheduler.runAfter(0, internal.turnQueue.deliverTurn, { turnId: job.turnId });
      return { saved: true, state: "ready_for_delivery" };
    }
    if (job.state !== "ready_for_save" || !job.outputMediaId) return { saved: false, state: job.state };
    const [turn, media] = await Promise.all([ctx.db.get(job.turnId), ctx.db.get(job.outputMediaId)]);
    if (!turn || !media || media.deletedAtMs !== undefined || media.expiresAtMs <= args.nowMs || ["superseded", "cancelled", "failed"].includes(turn.state)) {
      return { saved: false, state: "unavailable" };
    }
    const attachmentKey = `${job._id}:creative_attachment`;
    const captionKey = `${job._id}:creative_caption`;
    let attachment = await ctx.db.query("outboundDeliveries").withIndex("by_idempotency", q => q.eq("idempotencyKey", attachmentKey)).unique();
    if (!attachment) {
      const deliveryId = await insertOwnedDelivery(ctx, {
        turnId: job.turnId,
        threadId: job.threadId,
        stage: "creative_attachment",
        sequence: 1,
        itemKey: String(job._id),
        idempotencyKey: attachmentKey,
        payload: { mediaId: job.outputMediaId, mimeType: media.mimeType, filename: media.filename, caption: "Here’s your finished drawing." },
        status: "pending",
        attemptCount: 0,
        nextAttemptAtMs: args.nowMs,
        createdAtMs: args.nowMs,
        updatedAtMs: args.nowMs,
      });
      attachment = await ctx.db.get(deliveryId);
    }
    const caption = await ctx.db.query("outboundDeliveries").withIndex("by_idempotency", q => q.eq("idempotencyKey", captionKey)).unique();
    if (!caption) {
      await insertOwnedDelivery(ctx, {
        turnId: job.turnId,
        threadId: job.threadId,
        stage: "creative_caption",
        sequence: 2,
        itemKey: `${String(job._id)}:caption`,
        idempotencyKey: captionKey,
        payload: { text: "Here’s your finished drawing." },
        status: "pending",
        attemptCount: 0,
        nextAttemptAtMs: args.nowMs,
        createdAtMs: args.nowMs,
        updatedAtMs: args.nowMs,
      });
    }
    if (!attachment) return { saved: false, state: "unavailable" };
    const sequence = await nextDrawEventSequence(ctx, session._id);
    await ctx.db.patch(job._id, { state: "ready_for_delivery", deliveryId: attachment._id, eventSequence: sequence, updatedAtMs: args.nowMs });
    await ctx.db.insert("drawEvents", { sessionId: session._id, jobId: job._id, sequence, kind: "state", state: "ready_for_delivery", mediaId: job.outputMediaId, createdAtMs: args.nowMs });
    await ctx.db.patch(turn._id, { state: "response_planned", completedAtMs: undefined, updatedAtMs: args.nowMs });
    await ctx.scheduler.runAfter(0, internal.turnQueue.deliverTurn, { turnId: job.turnId });
    return { saved: true, state: "ready_for_delivery" };
  },
});

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
    await ctx.scheduler.runAfter(creativePollDelayMs(job.command, 0), internal.creative.poll, { jobId: job._id });
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
    let eventSequence = job.eventSequence;
    if (job.command === "draw" && job.drawSessionId) {
      eventSequence = await nextDrawEventSequence(ctx, job.drawSessionId);
      await ctx.db.insert("drawEvents", { sessionId: job.drawSessionId, jobId: job._id, sequence: eventSequence, kind: "state", state: args.state, createdAtMs: args.nowMs });
    }
    await ctx.db.patch(job._id, {
      state: args.state,
      ...(eventSequence === undefined ? {} : { eventSequence }),
      firstStateAtMs: job.firstStateAtMs ?? args.nowMs,
      heartbeatAtMs: args.nowMs,
      lastErrorCode: undefined,
      updatedAtMs: args.nowMs,
    });
    const elapsedMs = Math.max(0, args.nowMs - (job.submittedAtMs ?? job.createdAtMs));
    await ctx.scheduler.runAfter(creativePollDelayMs(job.command, elapsedMs), internal.creative.poll, { jobId: job._id });
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
      deletionState: "pending",
    });
    if (job.command === "draw") {
      if (!job.drawSessionId) throw new Error("DRAW_SESSION_MISSING");
      const prior = await ctx.db.query("drawEvents").withIndex("by_job_sequence", q => q.eq("jobId", job._id)).collect();
      const retireAtMs = args.nowMs + 15 * 60_000;
      for (const event of prior) {
        if (event.kind !== "preview" || !event.mediaId) continue;
        const preview = await ctx.db.get(event.mediaId);
        if (preview && preview.expiresAtMs > retireAtMs) await ctx.db.patch(preview._id, { expiresAtMs: retireAtMs });
      }
      const finalizingSequence = await nextDrawEventSequence(ctx, job.drawSessionId);
      await ctx.db.insert("drawEvents", { sessionId: job.drawSessionId, jobId: job._id, sequence: finalizingSequence, kind: "state", state: "finalizing", createdAtMs: args.nowMs });
      const sequence = await nextDrawEventSequence(ctx, job.drawSessionId);
      await ctx.db.patch(job._id, { state: "ready_for_save", outputMediaId: mediaId, currentPreviewMediaId: undefined, completedAtMs: args.nowMs, eventSequence: sequence, updatedAtMs: args.nowMs });
      await ctx.db.insert("drawEvents", { sessionId: job.drawSessionId, jobId: job._id, sequence, kind: "completed", state: "ready_for_save", mediaId, createdAtMs: args.nowMs });
      await ctx.db.patch(job.drawSessionId, { latestJobId: job._id, updatedAtMs: args.nowMs });
      // The customer consumes one image only when the private final artifact
      // is safely available in Draw. Save merely delivers that same artifact.
      await settleCreativeFunding(ctx, job, args.nowMs);
      return null;
    }
    const delivery = await insertOwnedDelivery(ctx, {
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
    await insertOwnedDelivery(ctx, {
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
    await ctx.db.patch(job._id, { state: "ready_for_delivery", deliveryId: delivery, outputMediaId: mediaId, completedAtMs: args.nowMs, updatedAtMs: args.nowMs });
    await ctx.scheduler.runAfter(0, internal.turnQueue.deliverTurn, { turnId: job.turnId });
    return null;
  },
});

export const repairLegacyDrawSaveGate = internalMutation({
  args: { jobId: v.id("creativeJobs"), nowMs: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.command !== "draw" || job.state !== "ready_for_delivery" || !job.drawSessionId || !job.outputMediaId || job.deliveredAtMs !== undefined) return false;
    const deliveries = await ctx.db.query("outboundDeliveries").withIndex("by_turn_stage", q => q.eq("turnId", job.turnId)).collect();
    const generated = deliveries.filter(delivery => delivery.idempotencyKey === `${job._id}:creative_attachment` || delivery.idempotencyKey === `${job._id}:creative_caption`);
    if (generated.some(delivery => delivery.status === "sending" || delivery.status === "sent")) return false;
    for (const delivery of generated) await ctx.db.delete(delivery._id);
    const sequence = await nextDrawEventSequence(ctx, job.drawSessionId);
    await ctx.db.patch(job._id, { state: "ready_for_save", deliveryId: undefined, eventSequence: sequence, updatedAtMs: args.nowMs });
    await ctx.db.insert("drawEvents", { sessionId: job.drawSessionId, jobId: job._id, sequence, kind: "completed", state: "ready_for_save", mediaId: job.outputMediaId, createdAtMs: args.nowMs });
    await ctx.db.patch(job.drawSessionId, { eventSequence: sequence, latestJobId: job._id, updatedAtMs: args.nowMs });
    return true;
  },
});

export const failProcessing = internalMutation({
  args: { ...processingOwnership, errorCode: v.string(), outcome: v.union(v.literal("definitive"), v.literal("unknown"), v.literal("retryable")), nowMs: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || !["submitting", "queued", "running", "retryable_failure"].includes(job.state) || job.attemptId !== args.attemptId || job.fencingToken !== args.fencingToken) return null;
    if (args.outcome === "definitive") {
      const sequence = job.drawSessionId ? await nextDrawEventSequence(ctx, job.drawSessionId) : (job.eventSequence ?? 0) + 1;
      await ctx.db.patch(job._id, { state: "failed", eventSequence: sequence, lastErrorCode: args.errorCode, updatedAtMs: args.nowMs });
      if (job.drawSessionId) await ctx.db.insert("drawEvents", { sessionId: job.drawSessionId, jobId: job._id, sequence, kind: "state", state: "failed", errorCode: args.errorCode, createdAtMs: args.nowMs });
      await releaseCreativeFunding(ctx, job, args.nowMs);
    } else {
      const state = args.outcome === "unknown" ? "submission_unknown" : "retryable_failure";
      const sequence = job.drawSessionId ? await nextDrawEventSequence(ctx, job.drawSessionId) : (job.eventSequence ?? 0) + 1;
      await ctx.db.patch(job._id, { state, eventSequence: sequence, lastErrorCode: args.errorCode, updatedAtMs: args.nowMs });
      if (job.drawSessionId) await ctx.db.insert("drawEvents", { sessionId: job.drawSessionId, jobId: job._id, sequence, kind: "state", state, errorCode: args.errorCode, createdAtMs: args.nowMs });
      if (args.outcome === "retryable" && job.providerRequestId) await ctx.scheduler.runAfter(15_000, internal.creative.poll, { jobId: job._id });
    }
    return null;
  },
});

export const releaseStuckDraw = internalMutation({
  args: { jobId: v.id("creativeJobs"), expectedErrorCode: v.string(), nowMs: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.command !== "draw" || job.state !== "submission_unknown" || job.providerRequestId || job.outputMediaId || job.lastErrorCode !== args.expectedErrorCode || !job.drawSessionId) return false;
    const events = await ctx.db.query("drawEvents").withIndex("by_job_sequence", q => q.eq("jobId", job._id)).collect();
    if (events.some(event => event.kind === "preview" || event.kind === "completed")) return false;
    const sequence = await nextDrawEventSequence(ctx, job.drawSessionId);
    await ctx.db.patch(job._id, { state: "failed", eventSequence: sequence, lastErrorCode: "DRAW_PROVIDER_PRECHECK_FAILED", updatedAtMs: args.nowMs });
    await ctx.db.insert("drawEvents", { sessionId: job.drawSessionId, jobId: job._id, sequence, kind: "state", state: "failed", errorCode: "DRAW_PROVIDER_PRECHECK_FAILED", createdAtMs: args.nowMs });
    await releaseCreativeFunding(ctx, job, args.nowMs);
    return true;
  },
});

export const releaseLegacyUnknown = internalMutation({
  args: { jobId: v.id("creativeJobs"), expectedErrorCode: v.string(), nowMs: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (
      !job ||
      job.state !== "submission_unknown" ||
      job.providerRequestId !== undefined ||
      job.lastErrorCode !== args.expectedErrorCode
    ) return false;
    await ctx.db.patch(job._id, {
      state: "failed",
      lastErrorCode: "LEGACY_PROVIDER_SUBMISSION_UNRECOVERABLE",
      updatedAtMs: args.nowMs,
    });
    await releaseCreativeFunding(ctx, job, args.nowMs);
    const existing = await ctx.db
      .query("outboundDeliveries")
      .withIndex("by_idempotency", (q) => q.eq("idempotencyKey", `${job._id}:legacy_unknown_status`))
      .unique();
    if (!existing) {
      await insertOwnedDelivery(ctx, {
        turnId: job.turnId,
        threadId: job.threadId,
        stage: "creative_status",
        sequence: 3,
        itemKey: `${String(job._id)}:legacy-status`,
        idempotencyKey: `${job._id}:legacy_unknown_status`,
        payload: { text: "That render never produced a trackable job, so I cleared it. Please send /zap again." },
        status: "pending",
        attemptCount: 0,
        nextAttemptAtMs: args.nowMs,
        createdAtMs: args.nowMs,
        updatedAtMs: args.nowMs,
      });
      await ctx.scheduler.runAfter(0, internal.turnQueue.deliverTurn, { turnId: job.turnId });
    }
    return true;
  },
});

export const recoverUnknownWithProviderId = internalMutation({
  args: {
    jobId: v.id("creativeJobs"),
    expectedErrorCode: v.string(),
    providerRequestId: v.string(),
    nowMs: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (
      !job ||
      job.command !== "zap" ||
      job.state !== "submission_unknown" ||
      job.providerRequestId !== undefined ||
      job.lastErrorCode !== args.expectedErrorCode ||
      args.providerRequestId.trim().length === 0
    ) return false;
    await ctx.db.patch(job._id, {
      state: "queued",
      provider: "fal",
      providerRequestId: args.providerRequestId.trim(),
      submittedAtMs: args.nowMs,
      heartbeatAtMs: args.nowMs,
      lastErrorCode: undefined,
      updatedAtMs: args.nowMs,
    });
    await ctx.scheduler.runAfter(0, internal.creative.poll, { jobId: job._id });
    return true;
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

async function runtimeFailure(response: Response, hasProviderRequestId: boolean): Promise<{
  code: string;
  outcome: "definitive" | "unknown" | "retryable";
}> {
  const headerCode = response.headers.get("x-coast-error-code");
  const headerOutcome = response.headers.get("x-coast-outcome");
  let body: { error?: unknown; code?: unknown; outcome?: unknown } | undefined;
  try {
    body = await response.json() as typeof body;
  } catch {
    // HTTP metadata remains sufficient and contains no user content.
  }
  const candidateCode = headerCode ?? body?.code ?? body?.error;
  const code = typeof candidateCode === "string" && /^[A-Z0-9_]{3,120}$/iu.test(candidateCode)
    ? candidateCode.slice(0, 120)
    : `CREATIVE_RUNTIME_HTTP_${response.status}`;
  const candidateOutcome = headerOutcome ?? body?.outcome;
  const outcome = candidateOutcome === "definitive" || candidateOutcome === "unknown" || candidateOutcome === "retryable"
    ? candidateOutcome
    : failureOutcome(response.status, hasProviderRequestId);
  return { code, outcome };
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
      const requestBody = {
        jobId: claim.jobId,
        attemptId: claim.attemptId,
        fencingToken: claim.fencingToken,
        command: claim.command,
        encryptedPayload: claim.encryptedPayload,
        ...(claim.command === "draw" ? {} : { operation: "submit" as const, ...(claim.inputMediaId ? { inputMediaId: claim.inputMediaId } : {}) }),
      };
      const response = await fetch(runtimeUrl, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(requestBody), signal: AbortSignal.timeout(claim.command === "draw" ? 270_000 : 30_000) });
      if (!response.ok) {
        const failure = await runtimeFailure(response, false);
        await ctx.runMutation(internal.creative.failProcessing, { jobId: args.jobId, attemptId: claim.attemptId, fencingToken: claim.fencingToken, errorCode: failure.code, outcome: failure.outcome, nowMs: Date.now() });
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
    if (!runtimeUrl || !secret) return null;
    try {
      const response = await fetch(runtimeUrl, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ operation: "poll", jobId: claim.jobId, attemptId: claim.attemptId, fencingToken: claim.fencingToken, command: claim.command, encryptedPayload: claim.encryptedPayload, providerRequestId: claim.providerRequestId }), signal: AbortSignal.timeout(90_000) });
      if (!response.ok) {
        const failure = await runtimeFailure(response, true);
        await ctx.runMutation(internal.creative.failProcessing, { jobId: args.jobId, attemptId: claim.attemptId, fencingToken: claim.fencingToken, errorCode: failure.code, outcome: failure.outcome, nowMs: Date.now() });
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

export const providerCanary = internalAction({
  args: {},
  returns: v.object({ ok: v.boolean(), cancelled: v.boolean(), code: v.string() }),
  handler: async () => {
    const runtimeUrl = process.env.COAST_CREATIVE_RUNTIME_URL;
    const secret = process.env.COAST_CONVEX_SERVICE_SECRET;
    if (!runtimeUrl || !secret) return { ok: false, cancelled: false, code: "CREATIVE_RUNTIME_NOT_CONFIGURED" };
    try {
      const response = await fetch(runtimeUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ operation: "canary" }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return { ok: false, cancelled: false, code: await runtimeErrorCode(response) };
      const body = await response.json() as { status?: unknown; cancelled?: unknown };
      return {
        ok: body.status === "ok",
        cancelled: body.cancelled === true,
        code: body.status === "ok" ? "FAL_CANARY_OK" : "FAL_CANARY_INVALID_RESULT",
      };
    } catch {
      return { ok: false, cancelled: false, code: "FAL_CANARY_REQUEST_FAILED" };
    }
  },
});

export const drawProviderCanary = internalAction({
  args: { kind: v.union(v.literal("generate"), v.literal("edit")), mode: v.optional(drawMode) },
  returns: v.object({ status: v.string(), model: v.string(), partials: v.number(), hasRequestId: v.boolean(), errorCode: v.string() }),
  handler: async (_ctx, args) => {
    const runtimeUrl = process.env.COAST_DRAW_RUNTIME_URL;
    const secret = process.env.COAST_CONVEX_SERVICE_SECRET;
    if (!runtimeUrl || !secret) return { status: "runtime_not_configured", model: "", partials: 0, hasRequestId: false, errorCode: "" };
    try {
      const response = await fetch(runtimeUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ operation: "canary", kind: args.kind, ...(args.mode ? { mode: args.mode } : {}) }),
        signal: AbortSignal.timeout(270_000),
      });
      const body = await response.json() as { status?: unknown; model?: unknown; partials?: unknown; hasRequestId?: unknown; error?: unknown; code?: unknown; details?: unknown };
      return {
        status: typeof body.status === "string" ? body.status : `HTTP_${response.status}`,
        model: typeof body.model === "string" ? body.model : "",
        partials: typeof body.partials === "number" ? body.partials : 0,
        hasRequestId: body.hasRequestId === true,
        errorCode: typeof body.details === "string" ? body.details : typeof body.code === "string" ? body.code : typeof body.error === "string" ? body.error : "",
      };
    } catch {
      return { status: "request_failed", model: "", partials: 0, hasRequestId: false, errorCode: "REQUEST_FAILED" };
    }
  },
});

export type CreativeJobId = Id<"creativeJobs">;
