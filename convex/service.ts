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
      receivedAtMs: args.receivedAtMs,
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
