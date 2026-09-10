import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export const CREATIVE_DAY_MS = 86_400_000;
// A slot represents ownership of provider work, never ownership of an already
// generated artifact or its delivery. That distinction lets a user save a Draw
// result while starting an independent video.
export const CREATIVE_ACTIVE_STATES = ["staging", "awaiting_payment", "admitted", "submitting", "submission_unknown", "queued", "running", "retryable_failure"] as const;
export type CreativeCommand = "imagine" | "zap" | "draw";
export function creativeKind(command: CreativeCommand) { return command === "zap" ? "video" as const : "image" as const; }
export function creativePrice(command: CreativeCommand) { return command === "zap" ? 100 : 50; }
export function isCreativeActive(job: Doc<"creativeJobs">) { return (CREATIVE_ACTIVE_STATES as readonly string[]).includes(job.state); }
type CreativeSlot = "image" | "video";
function slotFor(command: CreativeCommand): CreativeSlot { return creativeKind(command); }
function slotField(slot: CreativeSlot) { return slot === "image" ? "activeImageJobId" as const : "activeVideoJobId" as const; }

// Both recent successful jobs and every unresolved reservation occupy a slot.
// Query by the rolling boundary instead of truncating a user's lifetime history.
async function occupiedSlots(ctx: QueryCtx | MutationCtx, userId: Id<"coastUsers">, kind: "image" | "video", nowMs: number) {
  const recent = await ctx.db.query("creativeUsage").withIndex("by_user_kind_admitted", q => q.eq("userId", userId).eq("kind", kind).gt("admittedAtMs", nowMs - CREATIVE_DAY_MS)).collect();
  const unresolved = await ctx.db.query("creativeUsage").withIndex("by_user_kind_settled", q => q.eq("userId", userId).eq("kind", kind).eq("settled", false)).collect();
  return new Set([...recent, ...unresolved].map(item => String(item._id))).size;
}

export async function getCreativeCredits(ctx: QueryCtx | MutationCtx, userId: Id<"coastUsers">, nowMs: number) {
  const [images, videos, account] = await Promise.all([
    occupiedSlots(ctx, userId, "image", nowMs), occupiedSlots(ctx, userId, "video", nowMs),
    ctx.db.query("creativeCreditAccounts").withIndex("by_user", q => q.eq("userId", userId)).unique(),
  ]);
  let creditCents = account?.balanceCents ?? 0;
  if (!account?.reconciledAtMs) {
    const ledger = await ctx.db.query("creativeCreditLedger").withIndex("by_user_created", q => q.eq("userId", userId)).collect();
    creditCents = ledger.reduce((sum, entry) => sum + entry.amountCents, 0);
  }
  const [activeImageJob, activeVideoJob] = await Promise.all([
    findActiveJobForSlot(ctx, userId, account, "image"),
    findActiveJobForSlot(ctx, userId, account, "video"),
  ]);
  return {
    imageFreeRemaining: Math.max(0, 10 - images),
    videoFreeRemaining: Math.max(0, 10 - videos),
    creditCents,
    // Preserve this aggregate for callers released before slots existed.
    activeJob: activeImageJob !== null || activeVideoJob !== null,
    activeImageJob: activeImageJob?._id ?? null,
    activeVideoJob: activeVideoJob?._id ?? null,
  };
}

export async function findActiveJob(ctx: QueryCtx | MutationCtx, userId: Id<"coastUsers">, activeJobId?: Id<"creativeJobs">) {
  if (activeJobId) {
    const job = await ctx.db.get(activeJobId);
    if (job && isCreativeActive(job)) return job;
  }
  // Compatibility for jobs admitted before the account lock was introduced.
  for (const state of CREATIVE_ACTIVE_STATES) {
    const job = await ctx.db.query("creativeJobs").withIndex("by_user_state", q => q.eq("userId", userId).eq("state", state)).first();
    if (job) return job;
  }
  return null;
}

async function findActiveJobForSlot(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"coastUsers">,
  account: Doc<"creativeCreditAccounts"> | null,
  slot: CreativeSlot,
) {
  const candidates = [account?.[slotField(slot)], account?.activeJobId].filter(
    (id): id is Id<"creativeJobs"> => id !== undefined,
  );
  for (const id of candidates) {
    const job = await ctx.db.get(id);
    if (job && creativeKind(job.command) === slot && isCreativeActive(job)) return job;
  }
  // Compatibility for legacy accounts and interrupted backfills. This scans
  // indexed states rather than truncating a user's complete job history.
  for (const state of CREATIVE_ACTIVE_STATES) {
    const jobs = await ctx.db.query("creativeJobs")
      .withIndex("by_user_state", q => q.eq("userId", userId).eq("state", state))
      .collect();
    const job = jobs.find(item => creativeKind(item.command) === slot);
    if (job) return job;
  }
  return null;
}

export async function reconcileCreativeAccount(ctx: MutationCtx, userId: Id<"coastUsers">, nowMs: number) {
  let account = await ctx.db.query("creativeCreditAccounts").withIndex("by_user", q => q.eq("userId", userId)).unique();
  if (!account?.reconciledAtMs) {
    const ledger = await ctx.db.query("creativeCreditLedger").withIndex("by_user_created", q => q.eq("userId", userId)).collect();
    const balanceCents = ledger.reduce((sum, entry) => sum + entry.amountCents, 0);
    if (account) await ctx.db.patch(account._id, { balanceCents, reconciledAtMs: nowMs, updatedAtMs: nowMs });
    else {
      const id = await ctx.db.insert("creativeCreditAccounts", { userId, balanceCents, reconciledAtMs: nowMs, updatedAtMs: nowMs });
      account = await ctx.db.get(id);
    }
    if (account) account = { ...account, balanceCents, reconciledAtMs: nowMs };
  }
  if (!account) throw new Error("CREATIVE_ACCOUNT_UNAVAILABLE");
  return account;
}

export async function appendCreativeLedger(ctx: MutationCtx, args: { userId: Id<"coastUsers">; jobId?: Id<"creativeJobs">; topupOrderId?: string; kind: "topup" | "reserve" | "release" | "settle" | "refund"; amountCents: number; idempotencyKey: string; createdAtMs: number }) {
  const existing = await ctx.db.query("creativeCreditLedger").withIndex("by_idempotency", q => q.eq("idempotencyKey", args.idempotencyKey)).unique();
  if (existing) return false;
  const account = await reconcileCreativeAccount(ctx, args.userId, args.createdAtMs);
  await ctx.db.insert("creativeCreditLedger", args);
  await ctx.db.patch(account._id, { balanceCents: account.balanceCents + args.amountCents, updatedAtMs: args.createdAtMs });
  return true;
}

type AdmissionArgs = { userId: Id<"coastUsers">; threadId: Id<"coastThreads">; sourceMessageId: Id<"coastMessages">; turnId: Id<"coastTurns">; requestKey: string; command: CreativeCommand; encryptedPayload: string; nowMs: number; drawSessionId?: Id<"drawSessions">; drawMode?: "fast" | "detailed" | "turbo" | "hq"; revisionKey?: string; inputMediaId?: Id<"creativeMedia">; inputCategory?: "prompt" | "sketch" | "photo" | "result"; parentJobId?: Id<"creativeJobs">; rootJobId?: Id<"creativeJobs">; revisionNumber?: number; contextReset?: boolean; drawApiMode?: "images" | "responses" | "turbo"; requestFingerprint?: string; resumeJobId?: Id<"creativeJobs"> };
export type AdmissionResult = { jobId: Id<"creativeJobs">; state: string; source: "free" | "credit" | "payment"; amountCents: number };
export async function admitCreativeJob(ctx: MutationCtx, args: AdmissionArgs): Promise<AdmissionResult> {
  const user = await ctx.db.get(args.userId);
  if (!user || user.status !== "active") throw new Error("CREATIVE_USER_INACTIVE");
  const existing = await ctx.db.query("creativeJobs").withIndex("by_request_key", q => q.eq("requestKey", args.requestKey)).unique();
  if (existing && existing._id !== args.resumeJobId) {
    if (args.requestFingerprint && existing.requestFingerprint && existing.requestFingerprint !== args.requestFingerprint) {
      throw new Error("CREATIVE_REQUEST_KEY_CONFLICT");
    }
    return { jobId: existing._id, state: existing.state, source: existing.reservationSource, amountCents: existing.reservedCents };
  }
  if (args.resumeJobId && (!existing || existing.state !== "awaiting_payment" || existing.expiresAtMs <= args.nowMs)) throw new Error("CREATIVE_RESUME_INVALID");
  const account = await reconcileCreativeAccount(ctx, args.userId, args.nowMs);
  const active = await findActiveJobForSlot(ctx, args.userId, account, slotFor(args.command));
  if (active && active._id !== args.resumeJobId) throw new Error("CREATIVE_JOB_ALREADY_ACTIVE");
  const free = await occupiedSlots(ctx, args.userId, creativeKind(args.command), args.nowMs) < 10;
  const price = creativePrice(args.command);
  const source = free ? "free" as const : account.balanceCents >= price ? "credit" as const : "payment" as const;
  const state = source === "payment" ? "awaiting_payment" as const : "admitted" as const;
  const fields = {
    reservationSource: source, reservedCents: source === "free" ? 0 : price, state,
    fundingStatus: source === "payment" ? "awaiting_payment" as const : "reserved" as const, updatedAtMs: args.nowMs,
  };
  const reservationId = existing?.reservationId ?? `${args.requestKey}:reservation`;
  const jobId = existing?._id ?? await ctx.db.insert("creativeJobs", {
    userId: args.userId, threadId: args.threadId, sourceMessageId: args.sourceMessageId, turnId: args.turnId,
    requestKey: args.requestKey, command: args.command, encryptedPayload: args.encryptedPayload, reservationId,
    ...fields, ...(args.command === "draw" ? { provider: args.drawMode === "turbo" ? "fal" as const : "openai" as const } : {}),
    ...(args.drawSessionId ? { drawSessionId: args.drawSessionId } : {}), ...(args.revisionKey ? { revisionKey: args.revisionKey } : {}),
    ...(args.drawMode ? { drawMode: args.drawMode } : {}),
    ...(args.inputMediaId ? { inputMediaId: args.inputMediaId } : {}),
    ...(args.inputCategory ? { inputCategory: args.inputCategory } : {}),
    ...(args.parentJobId ? { parentJobId: args.parentJobId } : {}),
    ...(args.rootJobId ? { rootJobId: args.rootJobId } : {}),
    ...(args.revisionNumber ? { revisionNumber: args.revisionNumber } : {}),
    ...(args.contextReset ? { contextReset: true } : {}),
    ...(args.drawApiMode ? { drawApiMode: args.drawApiMode } : {}),
    ...(args.requestFingerprint ? { requestFingerprint: args.requestFingerprint } : {}),
    admittedAtMs: args.nowMs,
    createdAtMs: args.nowMs, expiresAtMs: args.nowMs + CREATIVE_DAY_MS,
  });
  if (existing) await ctx.db.patch(jobId, fields);
  // A root job can only learn its id after insertion. Persisting it gives
  // revisions an indexed, stable branch without inferring ancestry for older
  // records.
  if (!existing && args.command === "draw" && !args.rootJobId) {
    await ctx.db.patch(jobId, { rootJobId: jobId, revisionNumber: args.revisionNumber ?? 1 });
  }
  // A request waiting for payment is deliberately not a generation lock. It
  // may coexist with independently-funded work in either media slot.
  if (state === "admitted") {
    await ctx.db.patch(account._id, {
      activeJobId: jobId,
      [slotField(slotFor(args.command))]: jobId,
      updatedAtMs: args.nowMs,
    });
  }
  if (source === "free") {
    const usage = await ctx.db.query("creativeUsage").withIndex("by_reservation", q => q.eq("reservationId", reservationId)).unique();
    if (!usage) await ctx.db.insert("creativeUsage", { userId: args.userId, kind: creativeKind(args.command), jobId, reservationId, admittedAtMs: args.nowMs, settled: false });
  } else if (source === "credit") await appendCreativeLedger(ctx, { userId: args.userId, jobId, kind: "reserve", amountCents: -price, idempotencyKey: reservationId, createdAtMs: args.nowMs });
  return { jobId, state, source, amountCents: fields.reservedCents };
}

async function unlock(ctx: MutationCtx, job: Doc<"creativeJobs">, nowMs: number) {
  const account = await reconcileCreativeAccount(ctx, job.userId, nowMs);
  const field = slotField(slotFor(job.command));
  if (account.activeJobId === job._id || account[field] === job._id) {
    await ctx.db.patch(account._id, {
      ...(account.activeJobId === job._id ? { activeJobId: undefined } : {}),
      ...(account[field] === job._id ? { [field]: undefined } : {}),
      updatedAtMs: nowMs,
    });
  }
  if (job.drawSessionId) {
    const session = await ctx.db.get(job.drawSessionId);
    if (session?.activeJobId === job._id) await ctx.db.patch(session._id, { activeJobId: undefined, updatedAtMs: nowMs });
  }
}

export async function releaseCreativeFunding(ctx: MutationCtx, original: Doc<"creativeJobs">, nowMs: number) {
  const job = await ctx.db.get(original._id);
  if (!job || job.fundingStatus === "released" || job.fundingStatus === "settled") return false;
  if (job.reservationSource === "free") {
    const usage = await ctx.db.query("creativeUsage").withIndex("by_reservation", q => q.eq("reservationId", job.reservationId)).unique();
    if (usage?.settled) { await ctx.db.patch(job._id, { fundingStatus: "settled" }); return false; }
    if (usage) await ctx.db.delete(usage._id);
  } else if (job.reservationSource === "credit") {
    // Old releases used several keys; accounting migrations must not mint a second refund.
    const oldEntries = await ctx.db.query("creativeCreditLedger").withIndex("by_user_created", q => q.eq("userId", job.userId)).filter(q => q.eq(q.field("jobId"), job._id)).collect();
    if (!oldEntries.some(item => item.kind === "release")) await appendCreativeLedger(ctx, { userId: job.userId, jobId: job._id, kind: "release", amountCents: job.reservedCents, idempotencyKey: `${job.reservationId}:release`, createdAtMs: nowMs });
  }
  await ctx.db.patch(job._id, { fundingStatus: "released", updatedAtMs: nowMs });
  await unlock(ctx, job, nowMs);
  return true;
}

export async function settleCreativeFunding(ctx: MutationCtx, original: Doc<"creativeJobs">, nowMs: number) {
  const job = await ctx.db.get(original._id);
  if (!job || job.fundingStatus === "settled" || job.fundingStatus === "released") return false;
  if (job.reservationSource === "free") {
    const usage = await ctx.db.query("creativeUsage").withIndex("by_reservation", q => q.eq("reservationId", job.reservationId)).unique();
    if (usage) await ctx.db.patch(usage._id, { settled: true });
  } else if (job.reservationSource === "credit") await appendCreativeLedger(ctx, { userId: job.userId, jobId: job._id, kind: "settle", amountCents: 0, idempotencyKey: `${job.reservationId}:settle`, createdAtMs: nowMs });
  await ctx.db.patch(job._id, { fundingStatus: "settled", updatedAtMs: nowMs });
  await unlock(ctx, job, nowMs);
  return true;
}
