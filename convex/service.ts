import type { Infer } from "convex/values";
import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import {
  experienceResult,
  inboundClaimResult,
  pollClaimResult,
} from "./lib/validators";
import { assertVercelServiceSecret as assertServiceSecret } from "./lib/service_auth";

type InboundClaim = Infer<typeof inboundClaimResult>;
const locationResolutionClaim = v.union(
  v.object({
    requestId: v.id("coastLocationRequests"),
    revision: v.number(),
    encryptedThreadRef: v.string(),
    purpose: v.union(v.literal("nearby_search"), v.literal("directions")),
    entityType: v.union(v.literal("event"), v.literal("place"), v.literal("any")),
    searchText: v.union(v.string(), v.null()),
    targetExternalId: v.union(v.string(), v.null()),
    travelMode: v.union(
      v.literal("walking"),
      v.literal("driving"),
      v.literal("transit"),
      v.literal("bicycling"),
    ),
    expiresAtMs: v.number(),
  }),
  v.null(),
);
type LocationResolutionClaim = Infer<typeof locationResolutionClaim>;
type TurnStatus = {
  state:
    | "debouncing"
    | "ready_generation"
    | "generating"
    | "response_planned"
    | "sending"
    | "sent"
    | "superseded"
    | "failed"
    | "cancelled";
  revision: number;
  attemptCount: number;
  lastErrorCode: string | null;
} | null;

const commonClaimFields = {
  webhookId: v.string(),
  providerMessageId: v.string(),
  senderHash: v.string(),
  threadKeyHash: v.string(),
  encryptedThreadRef: v.string(),
  receivedAtMs: v.number(),
};

export const claimInbound = action({
  args: {
    serviceSecret: v.string(),
    ...commonClaimFields,
    text: v.string(),
    locationSignal: v.optional(v.boolean()),
    unsupportedContent: v.optional(
      v.union(v.literal("attachment"), v.literal("private_location")),
    ),
    creativeCommand: v.optional(v.union(v.literal("imagine"), v.literal("zap"), v.literal("draw"))),
    creativeCommandAmbiguous: v.optional(v.boolean()),
    encryptedCreativePayload: v.optional(v.string()),
  },
  returns: inboundClaimResult,
  handler: async (ctx, args): Promise<InboundClaim> => {
    assertServiceSecret(args.serviceSecret);
    return await ctx.runMutation(internal.inbound.claimDelivery, {
      webhookId: args.webhookId,
      providerMessageId: args.providerMessageId,
      senderHash: args.senderHash,
      threadKeyHash: args.threadKeyHash,
      encryptedThreadRef: args.encryptedThreadRef,
      text: args.text,
      ...(args.locationSignal ? { locationSignal: true } : {}),
      ...(args.unsupportedContent
        ? { unsupportedContent: args.unsupportedContent }
        : {}),
      ...(args.creativeCommand && args.encryptedCreativePayload
        ? {
            creativeCommand: args.creativeCommand,
            encryptedCreativePayload: args.encryptedCreativePayload,
          }
        : {}),
      ...(args.creativeCommand && args.creativeCommandAmbiguous
        ? { creativeCommandAmbiguous: true }
        : {}),
      receivedAtMs: args.receivedAtMs,
    });
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const exchangeDrawSession: any = action({
  args: { serviceSecret: v.string(), sessionId: v.id("drawSessions"), launchSecret: v.string(), nowMs: v.number() },
  returns: v.union(v.object({ browserToken: v.string(), expiresAtMs: v.number() }), v.null()),
  handler: async (ctx, args) => { assertServiceSecret(args.serviceSecret); return await ctx.runMutation(internal.creative.exchangeDrawSession, { sessionId: args.sessionId, launchSecret: args.launchSecret, nowMs: args.nowMs }); },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const getDrawSession: any = action({
  args: { serviceSecret: v.string(), sessionId: v.id("drawSessions"), browserTokenHash: v.string(), nowMs: v.number() },
  returns: v.union(v.object({ sessionId: v.id("drawSessions"), userId: v.id("coastUsers"), threadId: v.id("coastThreads"), expiresAtMs: v.number(), activeJobId: v.union(v.id("creativeJobs"), v.null()), latestJobId: v.union(v.id("creativeJobs"), v.null()), status: v.string() }), v.null()),
  handler: async (ctx, args) => { assertServiceSecret(args.serviceSecret); return await ctx.runQuery(internal.creative.getDrawSession, { sessionId: args.sessionId, browserTokenHash: args.browserTokenHash, nowMs: args.nowMs }); },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const admitDrawGeneration: any = action({
  args: { serviceSecret: v.string(), sessionId: v.id("drawSessions"), browserTokenHash: v.string(), requestKey: v.string(), encryptedPayload: v.string(), prompt: v.string(), mode: v.union(v.literal("fast"), v.literal("detailed"), v.literal("turbo")), inputMediaId: v.optional(v.id("creativeMedia")), nowMs: v.number() },
  returns: v.object({ jobId: v.id("creativeJobs"), state: v.string(), source: v.string(), amountCents: v.number() }),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    return await ctx.runMutation(internal.creative.admitDrawGeneration, {
      sessionId: args.sessionId,
      browserTokenHash: args.browserTokenHash,
      requestKey: args.requestKey,
      encryptedPayload: args.encryptedPayload,
      prompt: args.prompt,
      mode: args.mode,
      ...(args.inputMediaId ? { inputMediaId: args.inputMediaId } : {}),
      nowMs: args.nowMs,
    });
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const listDrawEvents: any = action({
  args: { serviceSecret: v.string(), sessionId: v.id("drawSessions"), browserTokenHash: v.string(), afterSequence: v.optional(v.number()), nowMs: v.number() },
  returns: v.union(v.object({ events: v.array(v.object({ jobId: v.id("creativeJobs"), sequence: v.number(), kind: v.string(), state: v.string(), mediaId: v.union(v.id("creativeMedia"), v.null()), previewIndex: v.union(v.number(), v.null()), errorCode: v.union(v.string(), v.null()) })), latest: v.union(v.number(), v.null()), activeJobId: v.union(v.id("creativeJobs"), v.null()), latestJobId: v.union(v.id("creativeJobs"), v.null()), initialMediaId: v.union(v.id("creativeMedia"), v.null()) }), v.null()),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    return await ctx.runQuery(internal.creative.listDrawEvents, {
      sessionId: args.sessionId,
      browserTokenHash: args.browserTokenHash,
      ...(args.afterSequence === undefined ? {} : { afterSequence: args.afterSequence }),
      nowMs: args.nowMs,
    });
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const recordDrawSubmission: any = action({
  args: { serviceSecret: v.string(), jobId: v.id("creativeJobs"), attemptId: v.string(), fencingToken: v.number(), providerRequestId: v.string(), providerModel: v.string(), nowMs: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    return await ctx.runMutation(internal.creative.recordDrawSubmission, { jobId: args.jobId, attemptId: args.attemptId, fencingToken: args.fencingToken, providerRequestId: args.providerRequestId, providerModel: args.providerModel, nowMs: args.nowMs });
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const recordDrawPreview: any = action({
  args: { serviceSecret: v.string(), jobId: v.id("creativeJobs"), attemptId: v.string(), fencingToken: v.number(), sourceUrl: v.string(), mimeType: v.string(), filename: v.string(), byteLength: v.number(), previewIndex: v.number(), nowMs: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    return await ctx.runMutation(internal.creative.recordDrawPreview, { jobId: args.jobId, attemptId: args.attemptId, fencingToken: args.fencingToken, sourceUrl: args.sourceUrl, mimeType: args.mimeType, filename: args.filename, byteLength: args.byteLength, previewIndex: args.previewIndex, nowMs: args.nowMs });
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const cancelDrawJob: any = action({
  args: { serviceSecret: v.string(), sessionId: v.id("drawSessions"), browserTokenHash: v.string(), jobId: v.id("creativeJobs"), nowMs: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    return await ctx.runMutation(internal.creative.cancelDrawJob, { sessionId: args.sessionId, browserTokenHash: args.browserTokenHash, jobId: args.jobId, nowMs: args.nowMs });
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const saveDrawJob: any = action({
  args: { serviceSecret: v.string(), sessionId: v.id("drawSessions"), browserTokenHash: v.string(), jobId: v.id("creativeJobs"), nowMs: v.number() },
  returns: v.object({ saved: v.boolean(), state: v.string() }),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    return await ctx.runMutation(internal.creative.saveDrawJob, { sessionId: args.sessionId, browserTokenHash: args.browserTokenHash, jobId: args.jobId, nowMs: args.nowMs });
  },
});

// Service-authenticated deployment canary. It exercises the same Flare stream
// used by Draw without creating a customer job or touching customer balances.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const drawProviderCanary: any = action({
  args: { serviceSecret: v.string(), kind: v.union(v.literal("generate"), v.literal("edit")) },
  returns: v.object({ status: v.string(), model: v.string(), partials: v.number(), hasRequestId: v.boolean(), errorCode: v.string() }),
  handler: async (_ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    const runtimeUrl = process.env.COAST_DRAW_RUNTIME_URL;
    const secret = process.env.COAST_CONVEX_SERVICE_SECRET;
    if (!runtimeUrl || !secret) return { status: "runtime_not_configured", model: "", partials: 0, hasRequestId: false, errorCode: "" };
    const response = await fetch(runtimeUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "canary", kind: args.kind }),
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
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const createDrawMedia: any = action({
  args: { serviceSecret: v.string(), sessionId: v.id("drawSessions"), browserTokenHash: v.string(), sourceUrl: v.string(), mimeType: v.string(), filename: v.string(), byteLength: v.number(), width: v.number(), height: v.number(), nowMs: v.number() },
  returns: v.union(v.id("creativeMedia"), v.null()),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    return await ctx.runMutation(internal.creative.createDrawMedia, {
      sessionId: args.sessionId,
      browserTokenHash: args.browserTokenHash,
      sourceUrl: args.sourceUrl,
      mimeType: args.mimeType,
      filename: args.filename,
      byteLength: args.byteLength,
      width: args.width,
      height: args.height,
      nowMs: args.nowMs,
    });
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const getAuthorizedDrawMedia: any = action({
  args: { serviceSecret: v.string(), sessionId: v.id("drawSessions"), browserTokenHash: v.string(), mediaId: v.id("creativeMedia"), nowMs: v.number() },
  returns: v.union(v.object({ sourceUrl: v.string(), mimeType: v.string(), filename: v.string(), expiresAtMs: v.number() }), v.null()),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    const session = await ctx.runQuery(internal.creative.getDrawSession, { sessionId: args.sessionId, browserTokenHash: args.browserTokenHash, nowMs: args.nowMs });
    if (!session) return null;
    const media = await ctx.runQuery(internal.creative.getMedia, { mediaId: args.mediaId, nowMs: args.nowMs });
    if (!media) return null;
    const manifest = await ctx.runQuery(internal.creative.getDrawMediaIdentity, { mediaId: args.mediaId });
    return manifest?.drawSessionId === args.sessionId ? media : null;
  },
});

export const getCreativeTopup = action({
  args: { serviceSecret: v.string(), orderId: v.string() },
  returns: v.union(
    v.object({ userId: v.id("coastUsers"), orderId: v.string(), status: v.string(), chargeCents: v.number(), creditCents: v.number() }),
    v.null(),
  ),
  handler: async (ctx, args): Promise<{ userId: Id<"coastUsers">; orderId: string; status: string; chargeCents: number; creditCents: number } | null> => {
    assertServiceSecret(args.serviceSecret);
    return await ctx.runQuery(internal.creative.getTopup, { orderId: args.orderId });
  },
});

export const settleCreativeTopup = action({
  args: { serviceSecret: v.string(), orderId: v.string(), eventId: v.string(), paymentIdentity: v.string(), nowMs: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    assertServiceSecret(args.serviceSecret);
    return await ctx.runMutation(internal.creative.addTopupCredit, {
      orderId: args.orderId,
      eventId: args.eventId,
      paymentIdentity: args.paymentIdentity,
      nowMs: args.nowMs,
    });
  },
});

export const getCreativeMedia = action({
  args: { serviceSecret: v.string(), mediaId: v.id("creativeMedia"), nowMs: v.number() },
  returns: v.union(
    v.object({ sourceUrl: v.string(), mimeType: v.string(), filename: v.string(), expiresAtMs: v.number() }),
    v.null(),
  ),
  handler: async (ctx, args): Promise<{ sourceUrl: string; mimeType: string; filename: string; expiresAtMs: number } | null> => {
    assertServiceSecret(args.serviceSecret);
    return await ctx.runQuery(internal.creative.getMedia, { mediaId: args.mediaId, nowMs: args.nowMs });
  },
});

export const reverseCreativeTopup = action({
  args: { serviceSecret: v.string(), orderId: v.string(), eventId: v.string(), paymentIdentity: v.string(), nowMs: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    assertServiceSecret(args.serviceSecret);
    return await ctx.runMutation(internal.creative.reverseTopupCredit, {
      orderId: args.orderId,
      eventId: args.eventId,
      paymentIdentity: args.paymentIdentity,
      nowMs: args.nowMs,
    });
  },
});

export const claimLocationResolution = action({
  args: {
    serviceSecret: v.string(),
    requestId: v.id("coastLocationRequests"),
    nowMs: v.number(),
  },
  returns: locationResolutionClaim,
  handler: async (ctx, args): Promise<LocationResolutionClaim> => {
    assertServiceSecret(args.serviceSecret);
    return await ctx.runMutation(internal.locationRequests.claimForResolution, {
      requestId: args.requestId,
      nowMs: args.nowMs,
    });
  },
});

export const releaseLocationResolution = action({
  args: {
    serviceSecret: v.string(),
    requestId: v.id("coastLocationRequests"),
    errorCode: v.optional(v.string()),
    nowMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertServiceSecret(args.serviceSecret);
    await ctx.runMutation(internal.locationRequests.releaseResolution, {
      requestId: args.requestId,
      ...(args.errorCode ? { errorCode: args.errorCode } : {}),
      nowMs: args.nowMs,
    });
    return null;
  },
});

export const searchNearbyCandidates = action({
  args: {
    serviceSecret: v.string(),
    cells: v.array(v.string()),
    entityType: v.union(v.literal("event"), v.literal("place"), v.literal("any")),
    nowMs: v.number(),
  },
  returns: v.array(experienceResult),
  handler: async (ctx, args): Promise<Infer<typeof experienceResult>[]> => {
    assertServiceSecret(args.serviceSecret);
    return await ctx.runQuery(internal.dataset.searchNearbyCells, {
      cells: args.cells,
      entityType: args.entityType,
      nowMs: args.nowMs,
    });
  },
});

export const searchNeighborhoodCandidates = action({
  args: {
    serviceSecret: v.string(),
    neighborhoodId: v.string(),
    entityType: v.union(v.literal("event"), v.literal("place"), v.literal("any")),
    nowMs: v.number(),
  },
  returns: v.array(experienceResult),
  handler: async (ctx, args): Promise<Infer<typeof experienceResult>[]> => {
    assertServiceSecret(args.serviceSecret);
    return await ctx.runQuery(internal.dataset.searchNeighborhoodCandidates, {
      neighborhoodId: args.neighborhoodId,
      entityType: args.entityType,
      nowMs: args.nowMs,
    });
  },
});

export const completeNearbyLocation = action({
  args: {
    serviceSecret: v.string(),
    requestId: v.id("coastLocationRequests"),
    expectedRevision: v.number(),
    selectedExternalIds: v.array(v.string()),
    nowMs: v.number(),
  },
  returns: v.union(v.id("coastTurns"), v.null()),
  handler: async (ctx, args): Promise<Id<"coastTurns"> | null> => {
    assertServiceSecret(args.serviceSecret);
    return await ctx.runMutation(internal.locationRequests.completeNearby, {
      requestId: args.requestId,
      expectedRevision: args.expectedRevision,
      selectedExternalIds: args.selectedExternalIds,
      nowMs: args.nowMs,
    });
  },
});

export const completeDirectionsLocation = action({
  args: {
    serviceSecret: v.string(),
    requestId: v.id("coastLocationRequests"),
    expectedRevision: v.number(),
    nowMs: v.number(),
  },
  returns: v.union(v.id("coastTurns"), v.null()),
  handler: async (ctx, args): Promise<Id<"coastTurns"> | null> => {
    assertServiceSecret(args.serviceSecret);
    return await ctx.runMutation(internal.locationRequests.completeDirections, {
      requestId: args.requestId,
      expectedRevision: args.expectedRevision,
      nowMs: args.nowMs,
    });
  },
});

export const claimPollVote = action({
  args: {
    serviceSecret: v.string(),
    ...commonClaimFields,
    pollTitle: v.string(),
    providerPollId: v.optional(v.string()),
    selectedOption: v.string(),
  },
  returns: pollClaimResult,
  handler: async (ctx, args): Promise<Infer<typeof pollClaimResult>> => {
    assertServiceSecret(args.serviceSecret);
    try {
      return await ctx.runMutation(internal.polls.claimVote, {
        webhookId: args.webhookId,
        providerMessageId: args.providerMessageId,
        senderHash: args.senderHash,
        threadKeyHash: args.threadKeyHash,
        encryptedThreadRef: args.encryptedThreadRef,
        pollTitle: args.pollTitle,
        ...(args.providerPollId === undefined
          ? {}
          : { providerPollId: args.providerPollId }),
        selectedOption: args.selectedOption,
        receivedAtMs: args.receivedAtMs,
      });
    } catch (error) {
      if (isTerminalPollClaimError(error)) return { terminal: true };
      throw error;
    }
  },
});

function isTerminalPollClaimError(error: unknown): boolean {
  const message = collectErrorText(error);
  return /POLL_(?:OPTION_NOT_FOUND|SELECTION_NOT_PENDING|SELECTION_NOT_CHANGEABLE|SELECTION_SUPERSEDED|THREAD_NOT_FOUND|USER_NOT_ACTIVE)/.test(
    message,
  );
}

function collectErrorText(value: unknown, seen = new Set<unknown>()): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || seen.has(value)) return "";
  seen.add(value);

  const fields: unknown[] = [];
  if (value instanceof Error) fields.push(value.message, value.cause);
  for (const nested of Object.values(value)) fields.push(nested);
  const record = value as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(value)) fields.push(record[key]);
  return [...fields.map((field) => collectErrorText(field, seen)), String(value)].join(" ");
}

export const getTurnStatus = action({
  args: { serviceSecret: v.string(), turnId: v.id("coastTurns") },
  returns: v.union(
    v.object({
      state: v.union(
        v.literal("debouncing"),
        v.literal("ready_generation"),
        v.literal("generating"),
        v.literal("response_planned"),
        v.literal("sending"),
        v.literal("sent"),
        v.literal("superseded"),
        v.literal("failed"),
        v.literal("cancelled"),
      ),
      revision: v.number(),
      attemptCount: v.number(),
      lastErrorCode: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, args): Promise<TurnStatus> => {
    assertServiceSecret(args.serviceSecret);
    return await ctx.runQuery(internal.turnQueue.getTurnStatus, { turnId: args.turnId });
  },
});
