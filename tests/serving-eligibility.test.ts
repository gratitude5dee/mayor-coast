import { describe, expect, it } from "vitest";

import {
  isServingExperienceEligible,
  SF_EVENT_WINDOW_END_EXCLUSIVE_UTC_MS,
  SF_EVENT_WINDOW_START_UTC_MS,
} from "../convex/lib/servingEligibility";
import {
  isExperienceEligible,
  type ExperienceRecord,
} from "../src/lib/coast/contracts";

const BEFORE_WINDOW_MS = Date.parse("2026-08-31T23:59:59.999-07:00");
const SEPTEMBER_1_MS = Date.parse("2026-09-01T00:00:00-07:00");
const SEPTEMBER_30_LAST_MS = Date.parse("2026-09-30T23:59:59.999-07:00");
const OCTOBER_1_MS = Date.parse("2026-10-01T00:00:00-07:00");

function backendCard(entityType: string, startAtUtcMs: number | null) {
  return {
    lifecycleStatus: "active",
    inferred: {
      activeStatus: "active",
      entityType,
      startAtUtcMs,
    },
  };
}

function agentEvent(startAtMs: number): ExperienceRecord {
  return {
    externalId: `event:${startAtMs}`,
    entityType: "event",
    title: "Boundary event",
    canonicalUrl: "https://example.com/event",
    timingLabel: "Boundary time",
    observedSummary: "A source-backed event.",
    provenanceIds: ["claim:event"],
    matchBasis: "observed",
    startAtMs,
    endAtMs: startAtMs,
    lifecycleStatus: "active",
  };
}

describe("fixed September event serving window", () => {
  it("uses San Francisco midnight as the exact inclusive/exclusive bounds", () => {
    expect(SF_EVENT_WINDOW_START_UTC_MS).toBe(SEPTEMBER_1_MS);
    expect(SF_EVENT_WINDOW_END_EXCLUSIVE_UTC_MS).toBe(OCTOBER_1_MS);
  });

  it("includes September 1 and the end of September 30", () => {
    expect(
      isServingExperienceEligible(
        backendCard("event", SEPTEMBER_1_MS),
        BEFORE_WINDOW_MS,
      ),
    ).toBe(true);
    expect(
      isServingExperienceEligible(
        backendCard("event", SEPTEMBER_30_LAST_MS),
        BEFORE_WINDOW_MS,
      ),
    ).toBe(true);

    expect(isExperienceEligible(agentEvent(SEPTEMBER_1_MS), BEFORE_WINDOW_MS)).toBe(
      true,
    );
    expect(
      isExperienceEligible(agentEvent(SEPTEMBER_30_LAST_MS), BEFORE_WINDOW_MS),
    ).toBe(true);
  });

  it("excludes August 31 and October 1 events", () => {
    expect(
      isServingExperienceEligible(
        backendCard("event", BEFORE_WINDOW_MS),
        BEFORE_WINDOW_MS - 1,
      ),
    ).toBe(false);
    expect(
      isServingExperienceEligible(
        backendCard("event", OCTOBER_1_MS),
        BEFORE_WINDOW_MS,
      ),
    ).toBe(false);

    expect(
      isExperienceEligible(agentEvent(BEFORE_WINDOW_MS), BEFORE_WINDOW_MS - 1),
    ).toBe(false);
    expect(isExperienceEligible(agentEvent(OCTOBER_1_MS), BEFORE_WINDOW_MS)).toBe(
      false,
    );
  });

  it("fails closed for the normalized-table name event_occurrence", () => {
    expect(
      isServingExperienceEligible(
        backendCard("event_occurrence", SEPTEMBER_1_MS),
        BEFORE_WINDOW_MS,
      ),
    ).toBe(false);
  });
});
