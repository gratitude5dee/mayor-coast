import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { internalQuery, query } from "./_generated/server";
import { experienceResult, nullableString } from "./lib/validators";
import {
  isServingExperienceEligible,
  SF_EVENT_WINDOW_END_EXCLUSIVE_UTC_MS,
  SF_EVENT_WINDOW_START_UTC_MS,
} from "./lib/servingEligibility";

const DEFAULT_LIMIT = 8;
const MAX_CANDIDATE_READ = 30;

const servingEntityType = v.union(v.literal("event"), v.literal("place"));

const searchFilters = {
  entityType: v.optional(servingEntityType),
  neighborhoodId: v.optional(v.string()),
  primaryType: v.optional(v.string()),
  priceBand: v.optional(v.string()),
};

const recommendationResult = v.object({
  externalId: v.string(),
  placeExternalId: v.string(),
  recommendationType: nullableString,
  recommendationLabel: nullableString,
  subject: nullableString,
  rationale: nullableString,
  sourceUrl: nullableString,
  provenanceIds: v.array(v.string()),
});

type ExperienceCard = Doc<"sfExperienceCards">;

function boundedLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_CANDIDATE_READ, Math.floor(requested)));
}

function isEligible(card: ExperienceCard, nowMs: number): boolean {
  return isServingExperienceEligible(card, nowMs);
}

type DiscoveryFallback = {
  entityType: "event" | "place";
  primaryType?: string;
};

/**
 * Full-text search should stay literal for named venues, cuisines, and artists.
 * These intentionally broad words are the exception: people naturally ask for
 * "dinner" or "a drink," while a source card normally says "restaurant" or
 * "bar." The fallback remains an indexed, source-backed browse and never
 * fabricates an attribute the source did not provide.
 */
function discoveryFallback(
  searchText: string,
  requestedEntityType: "event" | "place" | undefined,
): DiscoveryFallback | null {
  const normalized = searchText.trim().toLowerCase();
  if (
    /\b(?:food|eat|meal|dinner|lunch|brunch|restaurant)\b/u.test(normalized) &&
    (requestedEntityType === undefined || requestedEntityType === "place")
  ) {
    return { entityType: "place", primaryType: "restaurant" };
  }
  if (
    /\b(?:drink|drinks|bar|cocktail|wine|beer|brewery|happy hour|mocktail)\b/u.test(
      normalized,
    ) &&
    (requestedEntityType === undefined || requestedEntityType === "place")
  ) {
    return { entityType: "place", primaryType: "bar" };
  }
  if (
    /\b(?:event|events|concert|show|party|music|comedy|dance|nightlife)\b/u.test(
      normalized,
    ) &&
    (requestedEntityType === undefined || requestedEntityType === "event")
  ) {
    return { entityType: "event" };
  }
  return null;
}

function compactCard(
  card: ExperienceCard,
  matchSource: "observed" | "inferred",
) {
  return {
    externalId: card.externalId,
    contentHash: card.contentHash,
    entityExternalId: card.inferred.entityExternalId,
    title: card.observed.title,
    canonicalUrl: card.observed.canonicalUrl,
    observedSummary: card.observed.observedSummary ?? "",
    sourceUrls: card.observed.sourceUrls,
    entityType: card.inferred.entityType,
    activeStatus: card.inferred.activeStatus,
    neighborhoodId: card.inferred.neighborhoodId,
    primaryType: card.inferred.primaryType,
    priceBand: card.inferred.priceBand,
    startAtUtcMs: card.inferred.startAtUtcMs,
    endAtUtcMs: endAtUtcMs(card.observed.experienceFields),
    startDateKey: card.inferred.startDateKey,
    h3R6: card.inferred.h3R6,
    h3R8: card.inferred.h3R8,
    provenanceIds: card.inferred.provenanceIds,
    experienceFields: card.observed.experienceFields,
    matchSource,
  } as const;
}

function endAtUtcMs(fields: Record<string, unknown>): number | null {
  const timing = fields.timing;
  if (typeof timing !== "object" || timing === null || Array.isArray(timing)) return null;
  const value = (timing as Record<string, unknown>).endAtUtc;
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The only full-text recommendation surface. It reads at most 30 observed
 * candidates and, only if those are weak, at most 30 clearly labeled inferred
 * candidates. Source claims are deliberately absent from this serving path.
 */
export const searchExperiences = query({
  args: {
    searchText: v.string(),
    ...searchFilters,
    nowMs: v.number(),
    limit: v.optional(v.number()),
    minimumObservedResults: v.optional(v.number()),
    allowInferredFallback: v.optional(v.boolean()),
  },
  returns: v.object({
    retrievalMode: v.union(v.literal("observed"), v.literal("inferred_fallback")),
    results: v.array(experienceResult),
  }),
  handler: async (ctx, args) => {
    const searchText = args.searchText.trim().slice(0, 256);
    if (!searchText) return { retrievalMode: "observed" as const, results: [] };

    const limit = boundedLimit(args.limit);
    const minimumObserved = Math.max(
      1,
      Math.min(limit, Math.floor(args.minimumObservedResults ?? Math.min(3, limit))),
    );

    const observedCandidates = await ctx.db
      .query("sfExperienceCards")
      .withSearchIndex("search_experiences", (search) => {
        let filter = search
          .search("observed.retrievalTextObserved", searchText)
          .eq("inferred.activeStatus", "active");
        if (args.entityType !== undefined) {
          filter = filter.eq("inferred.entityType", args.entityType);
        }
        if (args.neighborhoodId !== undefined) {
          filter = filter.eq("inferred.neighborhoodId", args.neighborhoodId);
        }
        if (args.primaryType !== undefined) {
          filter = filter.eq("inferred.primaryType", args.primaryType);
        }
        if (args.priceBand !== undefined) {
          filter = filter.eq("inferred.priceBand", args.priceBand);
        }
        return filter;
      })
      .take(MAX_CANDIDATE_READ);

    const observed = observedCandidates
      .filter((card) => isEligible(card, args.nowMs))
      .slice(0, limit)
      .map((card) => compactCard(card, "observed"));

    if (observed.length >= minimumObserved || observed.length >= limit) {
      return { retrievalMode: "observed" as const, results: observed };
    }

    const fallback = discoveryFallback(searchText, args.entityType);
    const appendDiscoveryFallback = async (
      existing: ReturnType<typeof compactCard>[],
    ) => {
      if (fallback === null || existing.length >= limit) return existing;

      const neighborhoodId = args.neighborhoodId;
      const candidates = neighborhoodId === undefined
        ? await ctx.db
            .query("sfExperienceCards")
            .withIndex("by_kind_start", (q) =>
              q
                .eq("inferred.entityType", fallback.entityType)
                .eq("inferred.activeStatus", "active"),
            )
            .take(MAX_CANDIDATE_READ)
        : await ctx.db
            .query("sfExperienceCards")
            .withIndex("by_neighborhood_start", (q) =>
              q
                .eq("inferred.neighborhoodId", neighborhoodId)
                .eq("inferred.activeStatus", "active"),
            )
            .take(MAX_CANDIDATE_READ);

      const seen = new Set(existing.map((card) => card.externalId));
      const primaryType = args.primaryType ?? fallback.primaryType;
      const priceBand = args.priceBand;
      const additions = candidates
        .filter(
          (card) =>
            !seen.has(card.externalId) &&
            card.inferred.entityType === fallback.entityType &&
            (primaryType === undefined || card.inferred.primaryType === primaryType) &&
            (priceBand === undefined || card.inferred.priceBand === priceBand) &&
            card.observed.canonicalUrl.trim().length > 0 &&
            isEligible(card, args.nowMs),
        )
        .slice(0, limit - existing.length)
        .map((card) => compactCard(card, "observed"));
      return [...existing, ...additions];
    };

    if (args.allowInferredFallback === false) {
      return {
        retrievalMode: "observed" as const,
        results: await appendDiscoveryFallback(observed),
      };
    }

    const inferredCandidates = await ctx.db
      .query("sfExperienceCards")
      .withSearchIndex("search_experiences_inferred", (search) => {
        let filter = search
          .search("inferred.retrievalTextInferred", searchText)
          .eq("inferred.activeStatus", "active");
        if (args.entityType !== undefined) {
          filter = filter.eq("inferred.entityType", args.entityType);
        }
        if (args.neighborhoodId !== undefined) {
          filter = filter.eq("inferred.neighborhoodId", args.neighborhoodId);
        }
        if (args.primaryType !== undefined) {
          filter = filter.eq("inferred.primaryType", args.primaryType);
        }
        if (args.priceBand !== undefined) {
          filter = filter.eq("inferred.priceBand", args.priceBand);
        }
        return filter;
      })
      .take(MAX_CANDIDATE_READ);

    const seen = new Set(observed.map((card) => card.externalId));
    const inferred = inferredCandidates
      .filter((card) => isEligible(card, args.nowMs) && !seen.has(card.externalId))
      .slice(0, limit - observed.length)
      .map((card) => compactCard(card, "inferred"));

    const combined = [...observed, ...inferred];
    const results = await appendDiscoveryFallback(combined);
    return {
      retrievalMode:
        inferred.length > 0 ? ("inferred_fallback" as const) : ("observed" as const),
      results,
    };
  },
});

export const getExperienceDetails = query({
  args: {
    externalId: v.string(),
    nowMs: v.number(),
  },
  returns: v.union(experienceResult, v.null()),
  handler: async (ctx, args) => {
    const card = await ctx.db
      .query("sfExperienceCards")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .unique();
    if (card === null || !isEligible(card, args.nowMs)) return null;
    return compactCard(card, "observed");
  },
});

export const getExperienceDetailsBatch = query({
  args: {
    externalIds: v.array(v.string()),
    nowMs: v.number(),
  },
  returns: v.array(experienceResult),
  handler: async (ctx, args) => {
    const externalIds = [...new Set(args.externalIds)].slice(0, MAX_CANDIDATE_READ);
    const results = [];
    for (const externalId of externalIds) {
      const card = await ctx.db
        .query("sfExperienceCards")
        .withIndex("by_externalId", (q) => q.eq("externalId", externalId))
        .unique();
      if (card !== null && isEligible(card, args.nowMs)) {
        results.push(compactCard(card, "observed"));
      }
    }
    return results;
  },
});

/**
 * Location requests send only transient H3 cells into Convex. The precise
 * Find My coordinate never crosses this function boundary or enters a record.
 */
export const searchNearbyCells = internalQuery({
  args: {
    cells: v.array(v.string()),
    entityType: v.union(v.literal("event"), v.literal("place"), v.literal("any")),
    nowMs: v.number(),
  },
  returns: v.array(experienceResult),
  handler: async (ctx, args) => {
    const cells = [...new Set(args.cells)].slice(0, 19);
    const types: Array<"event" | "place"> =
      args.entityType === "any" ? ["event", "place"] : [args.entityType];
    const seen = new Set<string>();
    const results = [];
    for (const cell of cells) {
      for (const entityType of types) {
        const candidates = await ctx.db
          .query("sfExperienceCards")
          .withIndex("by_h3R8_kind_status_start", (q) => {
            const indexed = q
              .eq("inferred.h3R8", cell)
              .eq("inferred.entityType", entityType)
              .eq("inferred.activeStatus", "active");
            return entityType === "event"
              ? indexed.gte("inferred.startAtUtcMs", args.nowMs)
              : indexed;
          })
          .take(10);
        for (const card of candidates) {
          if (
            results.length < MAX_CANDIDATE_READ &&
            !seen.has(card.externalId) &&
            isEligible(card, args.nowMs)
          ) {
            seen.add(card.externalId);
            results.push(compactCard(card, "observed"));
          }
        }
      }
    }
    return results;
  },
});

/** A typed neighborhood is a privacy-preserving fallback when Find My is unavailable. */
export const searchNeighborhoodCandidates = internalQuery({
  args: {
    neighborhoodId: v.string(),
    entityType: v.union(v.literal("event"), v.literal("place"), v.literal("any")),
    nowMs: v.number(),
  },
  returns: v.array(experienceResult),
  handler: async (ctx, args) => {
    const candidates = await ctx.db
      .query("sfExperienceCards")
      .withIndex("by_neighborhood_start", (q) =>
        q
          .eq("inferred.neighborhoodId", args.neighborhoodId)
          .eq("inferred.activeStatus", "active"),
      )
      .take(MAX_CANDIDATE_READ);
    return candidates
      .filter(
        (card) =>
          (args.entityType === "any" || card.inferred.entityType === args.entityType) &&
          isEligible(card, args.nowMs),
      )
      .slice(0, 5)
      .map((card) => compactCard(card, "observed"));
  },
});

export const getRecommendations = query({
  args: {
    placeExternalId: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(recommendationResult),
  handler: async (ctx, args) => {
    const limit = Math.min(20, boundedLimit(args.limit));
    const documents = await ctx.db
      .query("sfRecommendations")
      .withIndex("by_place", (q) => q.eq("inferred.placeExternalId", args.placeExternalId))
      .take(limit);

    return documents.map((document) => {
      const observed = document.observed;
      return {
        externalId: document.externalId,
        placeExternalId: document.inferred.placeExternalId,
        recommendationType:
          typeof observed.recommendation_type === "string" ? observed.recommendation_type : null,
        recommendationLabel:
          typeof observed.recommendation_label === "string" ? observed.recommendation_label : null,
        subject:
          typeof observed.claimed_subject_text === "string" ? observed.claimed_subject_text : null,
        rationale:
          typeof observed.rationale_summary === "string" ? observed.rationale_summary : null,
        sourceUrl: typeof observed.source_url === "string" ? observed.source_url : null,
        provenanceIds: document.sourceRefs,
      };
    });
  },
});

export const getRecommendationsBatch = query({
  args: {
    placeExternalIds: v.array(v.string()),
    limitPerPlace: v.optional(v.number()),
  },
  returns: v.array(recommendationResult),
  handler: async (ctx, args) => {
    const placeExternalIds = [...new Set(args.placeExternalIds)].slice(0, 5);
    const limit = Math.min(10, boundedLimit(args.limitPerPlace));
    const results = [];
    for (const placeExternalId of placeExternalIds) {
      const documents = await ctx.db
        .query("sfRecommendations")
        .withIndex("by_place", (q) =>
          q.eq("inferred.placeExternalId", placeExternalId),
        )
        .take(limit);
      for (const document of documents) {
        const observed = document.observed;
        results.push({
          externalId: document.externalId,
          placeExternalId: document.inferred.placeExternalId,
          recommendationType:
            typeof observed.recommendation_type === "string"
              ? observed.recommendation_type
              : null,
          recommendationLabel:
            typeof observed.recommendation_label === "string"
              ? observed.recommendation_label
              : null,
          subject:
            typeof observed.claimed_subject_text === "string"
              ? observed.claimed_subject_text
              : null,
          rationale:
            typeof observed.rationale_summary === "string"
              ? observed.rationale_summary
              : null,
          sourceUrl:
            typeof observed.source_url === "string" ? observed.source_url : null,
          provenanceIds: document.sourceRefs,
        });
      }
    }
    return results;
  },
});

export const listUpcoming = query({
  args: {
    startAtMs: v.number(),
    endBeforeMs: v.number(),
    entityType: v.optional(servingEntityType),
    limit: v.optional(v.number()),
  },
  returns: v.array(experienceResult),
  handler: async (ctx, args) => {
    const limit = boundedLimit(args.limit);
    const startAtMs = Math.max(args.startAtMs, SF_EVENT_WINDOW_START_UTC_MS);
    const endBeforeMs = Math.min(
      args.endBeforeMs,
      SF_EVENT_WINDOW_END_EXCLUSIVE_UTC_MS,
    );
    if (startAtMs >= endBeforeMs) return [];
    const entityType = args.entityType ?? "event";
    const candidates = await ctx.db
      .query("sfExperienceCards")
      .withIndex("by_kind_start", (q) =>
        q
          .eq("inferred.entityType", entityType)
          .eq("inferred.activeStatus", "active")
          .gte("inferred.startAtUtcMs", startAtMs)
          .lt("inferred.startAtUtcMs", endBeforeMs),
      )
      .take(Math.min(limit, MAX_CANDIDATE_READ));
    return candidates.map((card) => compactCard(card, "observed"));
  },
});

export const getDatasetState = query({
  args: {},
  returns: v.union(
    v.object({
      activeSnapshotId: v.string(),
      manifestSha256: v.string(),
      dqStatus: v.literal("passed"),
      collectionCounts: v.record(v.string(), v.number()),
      totalDocuments: v.number(),
      eventWindowStart: v.string(),
      eventWindowEndInclusive: v.string(),
      editorialWindowStart: v.string(),
      editorialWindowEndInclusive: v.string(),
      verifiedAtMs: v.number(),
      advancedAtMs: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx) => {
    const state = await ctx.db
      .query("sfDatasetState")
      .withIndex("by_singleton", (q) => q.eq("singletonKey", "current"))
      .unique();
    if (state === null) return null;
    return {
      activeSnapshotId: state.activeSnapshotId,
      manifestSha256: state.manifestSha256,
      dqStatus: state.dqStatus,
      collectionCounts: state.collectionCounts,
      totalDocuments: state.totalDocuments,
      eventWindowStart: state.eventWindowStart,
      eventWindowEndInclusive: state.eventWindowEndInclusive,
      editorialWindowStart: state.editorialWindowStart,
      editorialWindowEndInclusive: state.editorialWindowEndInclusive,
      verifiedAtMs: state.verifiedAtMs,
      advancedAtMs: state.advancedAtMs,
    };
  },
});
