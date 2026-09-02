import type {
  ExperienceEntityType,
  ExperienceRecord,
  PreferenceUpdate,
  SourceBackedRecommendation,
} from "../coast/contracts";

export type SearchMatchMode = "inferred" | "observed";

export interface SearchExperiencesInput {
  query: string;
  entityType: ExperienceEntityType | "any";
  neighborhoods: readonly string[];
  primaryTypes: readonly string[];
  priceBands: readonly string[];
  startAtMs: number | null;
  endAtMs: number | null;
  limit: number;
  matchMode: SearchMatchMode;
}

export interface SearchExperiencesResult {
  items: readonly ExperienceRecord[];
  weak: boolean;
  reason?: string;
}

export interface SavePreferencesResult {
  applied: number;
}

/**
 * Convex implements this boundary. Keeping it application-owned lets a later
 * Pi adapter reuse the same deterministic retrieval and safety contract.
 */
export interface CoastDataSource {
  /** Indexed deterministic agenda browse; only used for current-day events. */
  listActiveEvents?(input: {
    startAtMs: number;
    endAtMs: number;
    limit: number;
  }): Promise<readonly ExperienceRecord[]>;
  searchExperiences(
    input: SearchExperiencesInput,
  ): Promise<SearchExperiencesResult>;
  getExperienceDetails(externalIds: readonly string[]): Promise<readonly ExperienceRecord[]>;
  getRecommendations(
    placeExternalIds: readonly string[],
    limitPerPlace: number,
  ): Promise<readonly SourceBackedRecommendation[]>;
  /**
   * @deprecated The Responses runtime never calls this method. Preference
   * writes are staged into TurnPlan and must be committed by the durable,
   * revision-checked Convex plan mutation.
   */
  savePreferences?(
    pseudonymousUserId: string,
    updates: readonly PreferenceUpdate[],
  ): Promise<SavePreferencesResult>;
}

/** Name used by the Convex action layer for the injected tool boundary. */
export type CoastDataTools = CoastDataSource;
