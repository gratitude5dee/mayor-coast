import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api";
import type {
  CoastDataSource,
  SearchExperiencesInput,
  SearchExperiencesResult,
} from "../agent/data-source";
import type {
  ExperienceRecord,
  SourceBackedRecommendation,
} from "../coast/contracts";
import { endAtMsFromExperienceFields } from "../coast/experience-details";

type ConvexExperience = {
  externalId: string;
  entityExternalId: string;
  title: string;
  canonicalUrl: string;
  contentHash?: string;
  endAtUtcMs?: number | null;
  observedSummary: string;
  entityType: "event" | "place";
  activeStatus: string;
  neighborhoodId: string;
  startAtUtcMs: number | null;
  provenanceIds: string[];
  experienceFields: Record<string, unknown>;
  matchSource: "inferred" | "observed";
};

export class ConvexCoastDataSource implements CoastDataSource {
  private readonly entityExternalIds = new Map<string, string>();

  constructor(
    private readonly client: ConvexHttpClient,
    private readonly nowMs: number,
  ) {}

  async searchExperiences(
    input: SearchExperiencesInput,
  ): Promise<SearchExperiencesResult> {
    const neighborhoods = input.neighborhoods.map(canonicalNeighborhood);
    const response = await this.client.query(api.dataset.searchExperiences, {
      searchText: input.query,
      nowMs: this.nowMs,
      limit: Math.min(30, input.limit),
      minimumObservedResults: Math.min(3, input.limit),
      allowInferredFallback: input.matchMode === "inferred",
      ...(input.entityType === "any"
        ? {}
        : { entityType: input.entityType }),
      ...(neighborhoods.length === 1
        ? { neighborhoodId: neighborhoods[0] }
        : {}),
      ...(input.primaryTypes.length === 1
        ? { primaryType: input.primaryTypes[0] }
        : {}),
      ...(input.priceBands.length === 1
        ? { priceBand: input.priceBands[0] }
        : {}),
    });

    const items = response.results
      .filter((item) =>
        input.matchMode === "observed"
          ? item.matchSource === "observed"
          : item.matchSource === "inferred",
      )
      .filter((item) => matchesArray(neighborhoods, item.neighborhoodId))
      .filter((item) => matchesArray(input.primaryTypes, item.primaryType))
      .filter((item) => matchesArray(input.priceBands, item.priceBand))
      .filter((item) =>
        input.startAtMs === null ||
        item.startAtUtcMs === null ||
        item.startAtUtcMs >= input.startAtMs,
      )
      .filter((item) =>
        input.endAtMs === null ||
        item.startAtUtcMs === null ||
        item.startAtUtcMs < input.endAtMs,
      )
      .slice(0, input.limit)
      .map((item) => this.mapExperience(item));

    return {
      items,
      weak: items.length < Math.min(3, input.limit),
      ...(items.length === 0
        ? { reason: `${input.matchMode}_search_returned_no_eligible_results` }
        : {}),
    };
  }

  async getExperienceDetails(
    externalIds: readonly string[],
  ): Promise<readonly ExperienceRecord[]> {
    const results = await this.client.query(api.dataset.getExperienceDetailsBatch, {
      externalIds: [...new Set(externalIds)].slice(0, 30),
      nowMs: this.nowMs,
    });
    return results.map((item) => this.mapExperience(item));
  }

  async getRecommendations(
    placeExternalIds: readonly string[],
    limitPerPlace: number,
  ): Promise<readonly SourceBackedRecommendation[]> {
    const requested = [...new Set(placeExternalIds)].slice(0, 5);
    const canonicalIds = requested.map(
      (externalId) => this.entityExternalIds.get(externalId) ?? externalId,
    );
    const cardIdForEntity = new Map(
      requested.map((externalId) => [
        this.entityExternalIds.get(externalId) ?? externalId,
        externalId,
      ]),
    );
    const results = await this.client.query(api.dataset.getRecommendationsBatch, {
      placeExternalIds: canonicalIds,
      limitPerPlace: Math.min(10, Math.max(1, limitPerPlace)),
    });
    return results.map((item) => ({
      externalId: item.externalId,
      placeExternalId: cardIdForEntity.get(item.placeExternalId) ?? item.placeExternalId,
      kind: recommendationKind(item.recommendationType),
      itemName:
        item.recommendationLabel ?? item.subject ?? "Source recommendation",
      description: item.rationale,
      provenanceIds: item.provenanceIds,
    }));
  }

  private mapExperience(item: ConvexExperience): ExperienceRecord {
    this.entityExternalIds.set(item.externalId, item.entityExternalId);
    return {
      externalId: item.externalId,
      entityType: item.entityType,
      title: item.title,
      canonicalUrl: item.canonicalUrl,
      timingLabel: timingLabel(item.startAtUtcMs, item.neighborhoodId),
      observedSummary: item.observedSummary,
      provenanceIds: item.provenanceIds,
      matchBasis: item.matchSource,
      startAtMs: item.startAtUtcMs,
      endAtMs: numericExperienceField(item.experienceFields, [
        "endAtUtcMs",
        "end_at_utc_ms",
        "endAtMs",
      ]) ?? item.endAtUtcMs ?? endAtMsFromExperienceFields(item.experienceFields),
      lifecycleStatus: item.activeStatus,
    };
  }
}

function matchesArray(
  requested: readonly string[],
  actual: string | null,
): boolean {
  if (requested.length === 0) return true;
  if (actual === null) return false;
  const normalized = actual.trim().toLowerCase();
  return requested.some((value) => value.trim().toLowerCase() === normalized);
}

/** The scraper's canonical neighborhood labels stay stable while COAST accepts local shorthand. */
export function canonicalNeighborhood(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim().toLowerCase();
  const aliases: Record<string, string> = {
    downtown: "Financial District/South Beach",
    "financial district": "Financial District/South Beach",
    "financial district/south beach": "Financial District/South Beach",
    "japan town": "Japantown",
    soma: "South of Market",
    "south of market": "South of Market",
  };
  return aliases[normalized] ?? value.replace(/\s+/gu, " ").trim();
}

function timingLabel(startAtMs: number | null, neighborhood: string): string {
  if (startAtMs === null) return neighborhood;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(startAtMs));
}

function numericExperienceField(
  fields: Record<string, unknown>,
  names: readonly string[],
): number | null {
  for (const name of names) {
    const value = fields[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function recommendationKind(
  value: string | null,
): "dish" | "drink" | "other" {
  const normalized = value?.toLowerCase() ?? "";
  if (/drink|cocktail|wine|beer|beverage/.test(normalized)) return "drink";
  if (/dish|food|menu|eat/.test(normalized)) return "dish";
  return "other";
}
