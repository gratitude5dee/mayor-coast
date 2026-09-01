export const SF_EVENT_WINDOW_START_UTC_MS = Date.UTC(2026, 8, 1, 7);
export const SF_EVENT_WINDOW_END_EXCLUSIVE_UTC_MS = Date.UTC(2026, 9, 1, 7);

export type ServingEntityType = "event" | "place";

type ServingExperienceCard = {
  lifecycleStatus: string;
  inferred: {
    activeStatus: string;
    entityType: string;
    startAtUtcMs: number | null;
  };
};

/**
 * Fail-closed eligibility for the fixed September 2026 serving snapshot.
 *
 * Snapshot experience cards intentionally use `event`, while the normalized
 * entity table is named `sfEventOccurrences`. Treating an unknown card kind as
 * a place would let a stale `event_occurrence` value bypass all date checks.
 */
export function isServingExperienceEligible(
  card: ServingExperienceCard,
  nowMs: number,
): boolean {
  if (
    card.lifecycleStatus !== "active" ||
    card.inferred.activeStatus !== "active"
  ) {
    return false;
  }

  if (card.inferred.entityType === "place") return true;
  if (card.inferred.entityType !== "event") return false;

  const startAtMs = card.inferred.startAtUtcMs;
  return (
    nowMs < SF_EVENT_WINDOW_END_EXCLUSIVE_UTC_MS &&
    startAtMs !== null &&
    startAtMs >= SF_EVENT_WINDOW_START_UTC_MS &&
    startAtMs >= nowMs &&
    startAtMs < SF_EVENT_WINDOW_END_EXCLUSIVE_UTC_MS
  );
}
