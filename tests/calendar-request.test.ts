import { describe, expect, it } from "vitest";

import { resolveCalendarRequest } from "../src/lib/agent/calendar-request";
import {
  buildCalendarIcs,
  buildExperiencePresentation,
} from "../src/lib/coast/presentation";

const NOW_MS = Date.parse("2026-09-01T12:00:00-07:00");
const selections = [{
  items: [
    { externalId: "place:kin-khao", title: "Kin Khao" },
    { externalId: "place:maillards", title: "Maillards" },
  ],
}];

describe("deterministic calendar requests", () => {
  it("turns a prior result, date, and time into an authoritative calendar action", () => {
    expect(resolveCalendarRequest({
      latestMessage: "Send me a calendar link for Kin Khao at 5 PM today",
      recentInboundMessages: [],
      priorSelections: selections,
      nowMs: NOW_MS,
    })).toMatchObject({
      kind: "create",
      externalId: "place:kin-khao",
      startAtMs: Date.parse("2026-09-01T17:00:00-07:00"),
    });
  });

  it("uses one native date poll when the date is missing", () => {
    const result = resolveCalendarRequest({
      latestMessage: "Calendar link for 5 PM at Kin Khao",
      recentInboundMessages: [],
      priorSelections: selections,
      nowMs: NOW_MS,
    });
    expect(result).toMatchObject({
      kind: "clarify",
      poll: { question: "What date?" },
    });
  });

  it("keeps a specifically named place deterministic when prior cards are no longer in context", () => {
    expect(resolveCalendarRequest({
      latestMessage: "Send me a calendar invite for 5 PM today at Kin Khao",
      recentInboundMessages: [],
      priorSelections: [],
      nowMs: NOW_MS,
    })).toMatchObject({
      kind: "lookup",
      title: "Kin Khao",
      startAtMs: Date.parse("2026-09-01T17:00:00-07:00"),
    });
  });

  it("resumes from the settled poll answer without losing the original time", () => {
    const result = resolveCalendarRequest({
      latestMessage: "Poll answer: What date? — Today, Sep 1",
      recentInboundMessages: ["Calendar link for 5 PM at Kin Khao"],
      priorSelections: selections,
      nowMs: NOW_MS,
    });
    expect(result).toMatchObject({
      kind: "create",
      externalId: "place:kin-khao",
      startAtMs: Date.parse("2026-09-01T17:00:00-07:00"),
    });
  });

  it("does not replay a calendar hold for an unrelated follow-up poll", () => {
    expect(resolveCalendarRequest({
      latestMessage: "Poll answer: Want COAST to check in after? — No thanks",
      recentInboundMessages: ["Calendar link for 5 PM at Kin Khao today"],
      priorSelections: selections,
      nowMs: NOW_MS,
    })).toBeNull();
  });

  it("does not treat a fresh today-events request as a date reply for an older calendar hold", () => {
    expect(resolveCalendarRequest({
      latestMessage: "Any events going on today?",
      recentInboundMessages: ["Calendar link for 5 PM at Kin Khao"],
      priorSelections: selections,
      nowMs: NOW_MS,
    })).toBeNull();
  });
});

describe("Apple Calendar attachment", () => {
  it("creates a place hold with a deterministic 15-minute reminder", () => {
    const presentation = buildExperiencePresentation({
      canonicalUrl: "https://example.com/kin-khao",
      entityType: "place",
      externalId: "place:kin-khao",
      observedSummary: "Thai restaurant in Union Square.",
      title: "Kin Khao",
      venueAddress: "55 Cyril Magnin St, San Francisco, CA",
      venueName: "Kin Khao",
    });
    expect(presentation).not.toBeNull();
    const ics = buildCalendarIcs(presentation!, {
      startAtMs: Date.parse("2026-09-01T17:00:00-07:00"),
      endAtMs: Date.parse("2026-09-01T19:00:00-07:00"),
    });
    expect(ics).toContain("DTSTART:20260902T000000Z");
    expect(ics).toContain("BEGIN:VALARM\r\nTRIGGER:-PT15M\r\nACTION:DISPLAY");
    expect(ics).toContain("SUMMARY:Kin Khao");
    expect(ics.endsWith("\r\n")).toBe(true);
  });
});
