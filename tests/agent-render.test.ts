import { describe, expect, it } from "vitest";

import type { ExperienceRecord, TurnPlan } from "../src/lib/coast/contracts";
import { renderCoastMessages } from "../src/lib/coast/render";

const plan: TurnPlan = {
  responseText: "I found two clean moves for you.",
  selectedExternalIds: ["event:1", "place:1"],
  poll: null,
  preferenceUpdates: [],
  provenanceIds: ["claim:1"],
};

const experiences: ExperienceRecord[] = [
  {
    externalId: "event:1",
    entityType: "event",
    title: "Live [Jazz]",
    canonicalUrl: "https://example.com/jazz",
    timingLabel: "Sep 12 · 8 PM",
    observedSummary: "A quartet plays a late set.\nTickets are listed by the venue.",
    provenanceIds: ["claim:1"],
    matchBasis: "observed",
    startAtMs: Date.parse("2026-09-12T20:00:00-07:00"),
    endAtMs: Date.parse("2026-09-12T22:00:00-07:00"),
    lifecycleStatus: "active",
  },
  {
    externalId: "place:1",
    entityType: "place",
    title: "A Great Bar",
    canonicalUrl: "https://example.com/bar",
    timingLabel: "North Beach",
    observedSummary: "The source highlights its amaro list.",
    provenanceIds: ["claim:2"],
    matchBasis: "inferred",
    lifecycleStatus: "active",
  },
];

describe("COAST message rendering", () => {
  it("builds source-backed result presentations without repeated timing", () => {
    const rendered = renderCoastMessages(
      plan,
      experiences,
      Date.parse("2026-09-01T00:00:00-07:00"),
    );
    expect(rendered.response).toBe("I found two clean moves for you.");
    expect(rendered.presentations).toHaveLength(2);
    expect(rendered.presentations[0]).toMatchObject({
      title: "Live [Jazz]",
      canonicalUrl: "https://example.com/jazz",
      calendarFileName: "Sat Sep 12 8:00 PM — Add to Calendar.ics",
    });
    expect(rendered.presentations[0]?.description).toBe(
      "A quartet plays a late set. Tickets are listed by the venue.",
    );
  });

  it("excludes expired events after their occurrence", () => {
    const rendered = renderCoastMessages(
      plan,
      experiences,
      Date.parse("2026-10-01T00:00:00-07:00"),
    );
    expect(rendered.presentations.map((item) => item.title)).not.toContain("Live [Jazz]");
    expect(rendered.presentations.map((item) => item.title)).toContain("A Great Bar");
  });

  it("never accepts a model-authored URL in response text", () => {
    expect(() =>
      renderCoastMessages(
        { ...plan, responseText: "Go to https://malicious.example" },
        experiences,
      )
    ).toThrow(/destination URL/u);
  });
});
