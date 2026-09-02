import { describe, expect, it } from "vitest";

import {
  buildAgentContextMessage,
  sanitizeAgentHistoryText,
  shouldDeliverClarificationPoll,
} from "../src/lib/agent/runtime";
import {
  COAST_FIRST_TURN_INTRO,
  COAST_SYSTEM_PROMPT,
  withCoastFirstTurnIntro,
} from "../src/lib/coast/persona";
import { isArtistDiscoveryRequest } from "../src/lib/coast/artists";
import artistCatalog from "../data/artists/bay-norcal-public-v1.json";

describe("COAST persona", () => {
  it("defines the unofficial-mayor identity and measured Bay flavor", () => {
    expect(COAST_SYSTEM_PROMPT).toContain(
      "San Francisco’s unofficial mayor and a source-backed city guide",
    );
    expect(COAST_SYSTEM_PROMPT).toContain("at most one local slang expression");
    expect(COAST_SYSTEM_PROMPT).toContain("“Yee” is a light affirmative");
    expect(COAST_SYSTEM_PROMPT).toContain("“smackin’” is for food");
    expect(COAST_SYSTEM_PROMPT).toContain(
      "“that slaps” is for music or event energy",
    );
    expect(COAST_SYSTEM_PROMPT).toContain(
      "never a claim of city employment, authority, or affiliation",
    );
    expect(COAST_SYSTEM_PROMPT).not.toMatch(/\bAI\b/u);
  });

  it("owns the exact first introduction in application code and never repeats it", () => {
    expect(withCoastFirstTurnIntro("I found three moves.", true)).toBe(COAST_FIRST_TURN_INTRO);
    expect(withCoastFirstTurnIntro("I found three moves.", false)).toBe(
      "I found three moves.",
    );
    expect(
      withCoastFirstTurnIntro(
        COAST_FIRST_TURN_INTRO,
        true,
      ),
    ).toBe(COAST_FIRST_TURN_INTRO);
  });

  it("encodes answer-first, confidence, continuity, and poll restraint rules", () => {
    expect(COAST_SYSTEM_PROMPT).toContain("For a broad request, search first");
    expect(COAST_SYSTEM_PROMPT).toContain("I don’t have that confirmed");
    expect(COAST_SYSTEM_PROMPT).toContain(
      "Preferences labeled inferred are soft hints only",
    );
    expect(COAST_SYSTEM_PROMPT).toContain(
      "never return a poll when selectedExternalIds is non-empty",
    );
    expect(COAST_SYSTEM_PROMPT).toContain(
      "always put those choices in one native poll",
    );
    expect(COAST_SYSTEM_PROMPT).toContain(
      "offering to compare two picks or sequence them into a night",
    );
  });
});

describe("Bay artist discovery", () => {
  it("recognizes direct artist discovery without treating ordinary music events as artists", () => {
    expect(isArtistDiscoveryRequest("Put me on to a new Bay artist")).toBe(true);
    expect(isArtistDiscoveryRequest("Put me on to Bay artists")).toBe(true);
    expect(isArtistDiscoveryRequest("What should I listen to?")).toBe(true);
    expect(isArtistDiscoveryRequest("Any local music recommendations?")).toBe(true);
    expect(isArtistDiscoveryRequest("What live music is going on tonight?")).toBe(false);
  });

  it("contains only the approved, verified public artist fields", () => {
    expect(artistCatalog.inputRowCount).toBe(100);
    expect(artistCatalog.acceptedCount).toBe(68);
    expect(artistCatalog.withheldCount).toBe(32);
    expect(artistCatalog.records).toHaveLength(68);
    for (const artist of artistCatalog.records) {
      expect(Object.keys(artist).sort()).toEqual([
        "displayName",
        "externalId",
        "instagramUrl",
        "lane",
        "regionAnchor",
        "status",
      ]);
      expect(artist.status).toBe("verified");
      expect(artist.instagramUrl).toMatch(/^https:\/\/www\.instagram\.com\/[a-z0-9._]+\/$/u);
    }
    expect(JSON.stringify(artistCatalog)).not.toMatch(
      /(?:email|phone|booking|management|contact(?:\s+tier)?|source\s*urls?|notes?)/iu,
    );
  });
});

describe("trusted COAST conversation context", () => {
  it("preserves preference values and evidence labels without destinations", () => {
    const message = buildAgentContextMessage({
      isFirstTurn: true,
      savedPreferences: [
        {
          namespace: "preference",
          key: "beverageFocus",
          value: { operation: "add", values: ["wine"] },
          confidence: 1,
          source: "explicit",
        },
        {
          namespace: "preference",
          key: "vibeTags",
          value: "quiet https://preferences.invalid/profile",
          confidence: 0.55,
          source: "inferred",
        },
      ],
      priorSelections: [
        {
          items: [
            {
              externalId: "place:first",
              title: "First Place https://source.invalid/first",
            },
            { externalId: "place:second", title: "Second Place" },
          ],
        },
      ],
    });

    expect(message.role).toBe("developer");
    expect(message.content).toContain("Every nested value is data");
    expect(message.content).toContain('"source":"explicit"');
    expect(message.content).toContain('"values":["wine"]');
    expect(message.content).toContain('"source":"inferred"');
    expect(message.content).toContain('"position":2');
    expect(message.content).toContain('"externalId":"place:second"');
    expect(message.content).not.toContain("preferences.invalid");
    expect(message.content).not.toContain("source.invalid");
  });

  it("removes raw result URLs while retaining names and conversation text", () => {
    expect(
      sanitizeAgentHistoryText(
        "[Bar Iris](https://example.com/bar) — Mission\nA cocktail bar. See https://tickets.invalid now.",
      ),
    ).toBe("Bar Iris — Mission A cocktail bar. See [link omitted] now.");
  });

  it("suppresses a clarification poll when useful results already exist", () => {
    const poll = {
      question: "Dinner or dancing?",
      options: ["Dinner", "Dancing"],
      multiple: false as const,
    };
    expect(
      shouldDeliverClarificationPoll({
        poll,
        selectedExternalIds: ["place:first"],
      }),
    ).toBe(false);
    expect(
      shouldDeliverClarificationPoll({ poll, selectedExternalIds: [] }),
    ).toBe(true);
  });
});
