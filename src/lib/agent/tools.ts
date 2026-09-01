import { zodResponsesFunction } from "openai/helpers/zod";
import { z } from "zod";

import {
  isExperienceEligible,
  PreferenceUpdateSchema,
  type ExperienceRecord,
  type PreferenceUpdate,
  type SourceBackedRecommendation,
} from "../coast/contracts";
import type { CoastDataSource } from "./data-source";

export const SearchExperiencesToolInputSchema = z
  .object({
    query: z.string().trim().min(1).max(300),
    entityType: z.enum(["any", "event", "place"]),
    neighborhoods: z.array(z.string().trim().min(1).max(80)).max(8),
    primaryTypes: z.array(z.string().trim().min(1).max(80)).max(8),
    priceBands: z.array(z.string().trim().min(1).max(40)).max(5),
    startAtMs: z.number().int().nonnegative().nullable(),
    endAtMs: z.number().int().nonnegative().nullable(),
    limit: z.number().int().min(1).max(30),
  })
  .strict();

export const GetExperienceDetailsToolInputSchema = z
  .object({
    externalIds: z.array(z.string().trim().min(1).max(240)).min(1).max(30),
  })
  .strict();

export const GetRecommendationsToolInputSchema = z
  .object({
    placeExternalIds: z
      .array(z.string().trim().min(1).max(240))
      .min(1)
      .max(5),
    limitPerPlace: z.number().int().min(1).max(10),
  })
  .strict();

export const SavePreferencesToolInputSchema = z
  .object({
    updates: z.array(PreferenceUpdateSchema).min(1).max(10),
  })
  .strict();

export const COAST_RESPONSE_TOOLS = [
  zodResponsesFunction({
    name: "searchExperiences",
    description:
      "Search the bounded SF experience-card index. Search before asking non-blocking preference questions. Observed text is always searched first; the runtime may add clearly labeled inferred matches only when observed retrieval is weak. To resolve a trusted priorSelections reference, search by the supplied source-backed title so the record is reacquired in this turn.",
    parameters: SearchExperiencesToolInputSchema,
  }),
  zodResponsesFunction({
    name: "getExperienceDetails",
    description:
      "Load source-backed details for immutable external IDs already discovered or reacquired by search during this turn. Use it before making factual claims about a prior selection.",
    parameters: GetExperienceDetailsToolInputSchema,
  }),
  zodResponsesFunction({
    name: "getRecommendations",
    description:
      "Load explicit, source-backed dish and drink recommendations for place external IDs. A dish or drink may be named only when this tool returned it.",
    parameters: GetRecommendationsToolInputSchema,
  }),
  zodResponsesFunction({
    name: "savePreferences",
    description:
      "Stage only preferences the user explicitly stated for atomic persistence with the final turn plan. Never infer a preference from a recommendation or click.",
    parameters: SavePreferencesToolInputSchema,
  }),
] as const;

export type CoastToolName =
  | "getExperienceDetails"
  | "getRecommendations"
  | "savePreferences"
  | "searchExperiences";

export interface FunctionCallLike {
  call_id: string;
  name: string;
  arguments: string;
}

export interface FunctionCallOutputLike {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export interface CoastToolLedger {
  availableExternalIds: Set<string>;
  availableProvenanceIds: Set<string>;
  experiences: Map<string, ExperienceRecord>;
  hydratedExternalIds: Set<string>;
  recommendations: Map<string, SourceBackedRecommendation>;
  recommendationsLoadedForPlaceIds: Set<string>;
  stagedPreferenceUpdates: PreferenceUpdate[];
  observedRetrievalWeak: boolean;
  usedInferredFallback: boolean;
}

export function createToolLedger(): CoastToolLedger {
  return {
    availableExternalIds: new Set(),
    availableProvenanceIds: new Set(),
    experiences: new Map(),
    hydratedExternalIds: new Set(),
    recommendations: new Map(),
    recommendationsLoadedForPlaceIds: new Set(),
    stagedPreferenceUpdates: [],
    observedRetrievalWeak: false,
    usedInferredFallback: false,
  };
}

export interface CoastDataCallBudget {
  readonly maxCalls: number;
  readonly usedCalls: number;
  run<T>(operation: () => Promise<T>): Promise<T>;
}

/** A per-turn ceiling over CoastDataSource method invocations. */
export function createCoastDataCallBudget(
  maxCalls = 4,
): CoastDataCallBudget {
  let usedCalls = 0;
  return {
    maxCalls,
    get usedCalls() {
      return usedCalls;
    },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (usedCalls >= maxCalls) {
        throw new Error("Per-turn backend data-call limit reached");
      }
      usedCalls += 1;
      return operation();
    },
  };
}

function rememberExperience(
  ledger: CoastToolLedger,
  item: ExperienceRecord,
): void {
  ledger.availableExternalIds.add(item.externalId);
  ledger.experiences.set(item.externalId, item);
  for (const provenanceId of item.provenanceIds) {
    ledger.availableProvenanceIds.add(provenanceId);
  }
}

function toModelExperience(item: ExperienceRecord) {
  return {
    externalId: item.externalId,
    entityType: item.entityType,
    title: item.title,
    timingLabel: item.timingLabel,
    observedSummary: item.observedSummary,
    provenanceIds: item.provenanceIds,
    matchBasis: item.matchBasis,
    startAtMs: item.startAtMs ?? null,
    endAtMs: item.endAtMs ?? null,
  };
}

function rememberRecommendation(
  ledger: CoastToolLedger,
  recommendation: SourceBackedRecommendation,
): void {
  ledger.recommendations.set(recommendation.externalId, recommendation);
  for (const provenanceId of recommendation.provenanceIds) {
    ledger.availableProvenanceIds.add(provenanceId);
  }
}

function preferenceUpdateIdentity(update: PreferenceUpdate): string {
  return JSON.stringify([update.key, update.operation, update.values]);
}

function stagePreferenceUpdates(
  ledger: CoastToolLedger,
  updates: readonly PreferenceUpdate[],
): number {
  const identities = new Set(
    ledger.stagedPreferenceUpdates.map(preferenceUpdateIdentity),
  );
  let staged = 0;
  for (const update of updates) {
    const identity = preferenceUpdateIdentity(update);
    if (identities.has(identity)) {
      continue;
    }
    identities.add(identity);
    ledger.stagedPreferenceUpdates.push({
      ...update,
      values: [...update.values],
    });
    staged += 1;
  }
  return staged;
}

function uniqueEligible(
  items: readonly ExperienceRecord[],
  nowMs: number,
  matchBasis?: "inferred" | "observed",
): ExperienceRecord[] {
  const unique = new Map<string, ExperienceRecord>();
  for (const item of items) {
    const normalized = matchBasis ? { ...item, matchBasis } : item;
    if (isExperienceEligible(normalized, nowMs)) {
      unique.set(normalized.externalId, normalized);
    }
  }
  return [...unique.values()];
}

export async function executeCoastTool(input: {
  call: FunctionCallLike;
  dataSource: CoastDataSource;
  ledger: CoastToolLedger;
  nowMs: number;
  pseudonymousUserId: string;
  dataCallBudget?: CoastDataCallBudget;
}): Promise<FunctionCallOutputLike> {
  const {
    call,
    dataSource,
    ledger,
    nowMs,
    pseudonymousUserId,
    dataCallBudget = createCoastDataCallBudget(),
  } = input;
  void pseudonymousUserId;

  try {
    switch (call.name as CoastToolName) {
      case "searchExperiences": {
        const args = SearchExperiencesToolInputSchema.parse(
          JSON.parse(call.arguments),
        );
        const observed = await dataCallBudget.run(() =>
          dataSource.searchExperiences({
            ...args,
            matchMode: "observed",
          }),
        );
        const observedItems = uniqueEligible(observed.items, nowMs, "observed");
        const observedWeak = observed.weak || observedItems.length < 3;
        ledger.observedRetrievalWeak ||= observedWeak;

        let inferredItems: ExperienceRecord[] = [];
        if (observedWeak) {
          const inferred = await dataCallBudget.run(() =>
            dataSource.searchExperiences({
              ...args,
              matchMode: "inferred",
            }),
          );
          const observedIds = new Set(observedItems.map((item) => item.externalId));
          inferredItems = uniqueEligible(inferred.items, nowMs, "inferred")
            .filter((item) => !observedIds.has(item.externalId));
          ledger.usedInferredFallback ||= inferredItems.length > 0;
        }

        const items = [...observedItems, ...inferredItems].slice(0, args.limit);
        for (const item of items) {
          rememberExperience(ledger, item);
        }

        return {
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify({
            items: items.map(toModelExperience),
            observedRetrievalWeak: observedWeak,
            inferredFallbackUsed: inferredItems.length > 0,
            reason: observed.reason ?? null,
          }),
        };
      }
      case "getExperienceDetails": {
        const args = GetExperienceDetailsToolInputSchema.parse(
          JSON.parse(call.arguments),
        );
        const discoveredIds = args.externalIds.filter((externalId) =>
          ledger.availableExternalIds.has(externalId)
        );
        const missingIds = discoveredIds.filter(
          (externalId) => !ledger.hydratedExternalIds.has(externalId),
        );
        const details = missingIds.length > 0
          ? await dataCallBudget.run(() =>
              dataSource.getExperienceDetails(missingIds),
            )
          : [];
        for (const externalId of missingIds) {
          ledger.hydratedExternalIds.add(externalId);
        }
        const hydratedItems = uniqueEligible(details, nowMs).map((item) => ({
          ...item,
          matchBasis:
            ledger.experiences.get(item.externalId)?.matchBasis ?? item.matchBasis,
        }));
        for (const item of hydratedItems) {
          rememberExperience(ledger, item);
        }
        const items = discoveredIds
          .map((externalId) => ledger.experiences.get(externalId))
          .filter((item): item is ExperienceRecord => Boolean(item));
        return {
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify({ items: items.map(toModelExperience) }),
        };
      }
      case "getRecommendations": {
        const args = GetRecommendationsToolInputSchema.parse(
          JSON.parse(call.arguments),
        );
        const placeExternalIds = args.placeExternalIds.filter((externalId) =>
          ledger.availableExternalIds.has(externalId)
        );
        const unloadedPlaceIds = placeExternalIds.filter(
          (externalId) =>
            !ledger.recommendationsLoadedForPlaceIds.has(externalId),
        );
        const loadedRecommendations = unloadedPlaceIds.length > 0
          ? await dataCallBudget.run(() =>
              dataSource.getRecommendations(
                unloadedPlaceIds,
                args.limitPerPlace,
              ),
            )
          : [];
        for (const externalId of unloadedPlaceIds) {
          ledger.recommendationsLoadedForPlaceIds.add(externalId);
        }
        for (const recommendation of loadedRecommendations) {
          rememberRecommendation(ledger, recommendation);
        }
        const recommendations = [...ledger.recommendations.values()].filter(
          (recommendation) =>
            placeExternalIds.includes(recommendation.placeExternalId),
        );
        return {
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify({ recommendations }),
        };
      }
      case "savePreferences": {
        const args = SavePreferencesToolInputSchema.parse(
          JSON.parse(call.arguments),
        );
        const staged = stagePreferenceUpdates(
          ledger,
          args.updates as PreferenceUpdate[],
        );
        return {
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify({
            staged,
            persistence: "deferred_until_revision_checked_plan",
          }),
        };
      }
      default:
        throw new Error("Tool is not in the COAST allowlist");
    }
  } catch (error) {
    return {
      type: "function_call_output",
      call_id: call.call_id,
      output: JSON.stringify({
        error: error instanceof Error ? error.message : "Tool execution failed",
      }),
    };
  }
}

export interface CoastSearchHydration {
  details: readonly ReturnType<typeof toModelExperience>[];
  explicitRecommendations: readonly SourceBackedRecommendation[];
}

/**
 * Deterministically enrich first-step search results before the second model
 * call. Details and recommendations are batched and share the turn budget.
 */
export async function hydrateDiscoveredExperiences(input: {
  dataSource: CoastDataSource;
  ledger: CoastToolLedger;
  nowMs: number;
  dataCallBudget: CoastDataCallBudget;
  maxCandidates?: number;
  maxRecommendationPlaces?: number;
  limitPerPlace?: number;
}): Promise<CoastSearchHydration> {
  const {
    dataSource,
    ledger,
    nowMs,
    dataCallBudget,
    maxCandidates = 30,
    maxRecommendationPlaces = 5,
    limitPerPlace = 10,
  } = input;
  const candidateIds = [...ledger.experiences.keys()].slice(0, maxCandidates);
  if (candidateIds.length === 0) {
    return { details: [], explicitRecommendations: [] };
  }

  const rawDetails = await dataCallBudget.run(() =>
    dataSource.getExperienceDetails(candidateIds),
  );
  for (const externalId of candidateIds) {
    ledger.hydratedExternalIds.add(externalId);
  }
  const details = uniqueEligible(rawDetails, nowMs).map((item) => ({
    ...item,
    matchBasis:
      ledger.experiences.get(item.externalId)?.matchBasis ?? item.matchBasis,
  }));
  for (const item of details) {
    rememberExperience(ledger, item);
  }

  const placeExternalIds = candidateIds
    .filter((externalId) => {
      const item = ledger.experiences.get(externalId);
      return item?.entityType === "place";
    })
    .slice(0, maxRecommendationPlaces);
  const recommendations = placeExternalIds.length > 0
    ? await dataCallBudget.run(() =>
        dataSource.getRecommendations(placeExternalIds, limitPerPlace),
      )
    : [];
  for (const externalId of placeExternalIds) {
    ledger.recommendationsLoadedForPlaceIds.add(externalId);
  }
  for (const recommendation of recommendations) {
    if (placeExternalIds.includes(recommendation.placeExternalId)) {
      rememberRecommendation(ledger, recommendation);
    }
  }

  return {
    details: details.map(toModelExperience),
    explicitRecommendations: recommendations.filter((recommendation) =>
      placeExternalIds.includes(recommendation.placeExternalId),
    ),
  };
}
