import { z } from "zod";

export const COAST_EVENT_WINDOW_START_MS = Date.parse(
  "2026-09-01T00:00:00-07:00",
);

export const COAST_EVENT_WINDOW_END_MS = Date.parse(
  "2026-10-01T00:00:00-07:00",
);

export const PreferenceKeySchema = z.enum([
  "accessibility",
  "beverageFocus",
  "cuisines",
  "dietaryNeeds",
  "eventFormats",
  "neighborhoods",
  "occasionTags",
  "placeTypes",
  "priceBands",
  "vibeTags",
]);

export const PreferenceUpdateSchema = z
  .object({
    key: PreferenceKeySchema,
    operation: z.enum(["add", "remove", "set"]),
    values: z.array(z.string().trim().min(1).max(80)).min(1).max(12),
  })
  .strict();

export const CoastPollSchema = z
  .object({
    question: z.string().trim().min(1).max(180),
    options: z.array(z.string().trim().min(1).max(80)).min(2).max(6),
    multiple: z.literal(false),
  })
  .strict();

/**
 * The model returns identifiers only. URLs and display facts are resolved from
 * Convex after validation, so a model-generated destination can never be sent.
 */
export const TurnPlanSchema = z
  .object({
    responseText: z.string().trim().min(1).max(480),
    selectedExternalIds: z
      .array(z.string().trim().min(1).max(240))
      .max(5),
    poll: CoastPollSchema.nullable(),
    preferenceUpdates: z.array(PreferenceUpdateSchema).max(10),
    provenanceIds: z
      .array(z.string().trim().min(1).max(240))
      .max(30),
  })
  .strict();

export type TurnPlan = z.infer<typeof TurnPlanSchema>;
export type CoastPoll = z.infer<typeof CoastPollSchema>;
export type PreferenceUpdate = z.infer<typeof PreferenceUpdateSchema>;

export type ExperienceEntityType = "event" | "place";
export type RetrievalMatchBasis = "inferred" | "observed";

export interface ExperienceRecord {
  externalId: string;
  entityType: ExperienceEntityType;
  title: string;
  canonicalUrl: string;
  timingLabel: string;
  observedSummary: string;
  provenanceIds: readonly string[];
  matchBasis: RetrievalMatchBasis;
  startAtMs?: number | null;
  endAtMs?: number | null;
  lifecycleStatus?: string | null;
}

export interface SourceBackedRecommendation {
  externalId: string;
  placeExternalId: string;
  kind: "dish" | "drink" | "other";
  itemName: string;
  description?: string | null;
  provenanceIds: readonly string[];
}

export function emptyTurnPlan(responseText: string): TurnPlan {
  return {
    responseText,
    selectedExternalIds: [],
    poll: null,
    preferenceUpdates: [],
    provenanceIds: [],
  };
}

export function containsDestinationUrl(value: string): boolean {
  return /(?:https?:\/\/|www\.|\[[^\]]*\]\([^)]*\)|\b(?:data|javascript|mailto|tel):)/iu.test(
    value,
  );
}

export function isExperienceEligible(
  experience: ExperienceRecord,
  nowMs: number,
): boolean {
  const status = experience.lifecycleStatus?.toLowerCase();
  if (status !== "active" && status !== "publishable") {
    return false;
  }

  if (experience.entityType === "place") {
    return true;
  }

  if (
    nowMs >= COAST_EVENT_WINDOW_END_MS ||
    experience.startAtMs == null ||
    experience.startAtMs < COAST_EVENT_WINDOW_START_MS ||
    experience.startAtMs >= COAST_EVENT_WINDOW_END_MS
  ) {
    return false;
  }

  const expiresAtMs = experience.endAtMs ?? experience.startAtMs;
  return expiresAtMs >= nowMs;
}
