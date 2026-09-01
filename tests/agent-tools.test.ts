import { describe, expect, it, vi } from "vitest";

import type { CoastDataSource } from "../src/lib/agent/data-source";
import {
  createToolLedger,
  executeCoastTool,
} from "../src/lib/agent/tools";
import type { ExperienceRecord } from "../src/lib/coast/contracts";

function experience(
  externalId: string,
  matchBasis: "inferred" | "observed" = "observed",
): ExperienceRecord {
  return {
    externalId,
    entityType: "place",
    title: externalId,
    canonicalUrl: `https://example.com/${externalId}`,
    timingLabel: "Mission",
    observedSummary: "A source-backed summary.",
    provenanceIds: [`claim:${externalId}`],
    matchBasis,
    lifecycleStatus: "active",
  };
}

describe("COAST tool execution", () => {
  it("searches observed text first and labels inferred fallback", async () => {
    const searchExperiences = vi
      .fn<CoastDataSource["searchExperiences"]>()
      .mockResolvedValueOnce({ items: [experience("observed")], weak: true })
      .mockResolvedValueOnce({ items: [experience("inferred")], weak: false });
    const dataSource: CoastDataSource = {
      searchExperiences,
      getExperienceDetails: vi.fn(async () => []),
      getRecommendations: vi.fn(async () => []),
      savePreferences: vi.fn(async () => ({ applied: 0 })),
    };
    const ledger = createToolLedger();
    const output = await executeCoastTool({
      call: {
        call_id: "call_1",
        name: "searchExperiences",
        arguments: JSON.stringify({
          query: "romantic dinner",
          entityType: "place",
          neighborhoods: [],
          primaryTypes: ["restaurant"],
          priceBands: [],
          startAtMs: null,
          endAtMs: null,
          limit: 10,
        }),
      },
      dataSource,
      ledger,
      nowMs: Date.parse("2026-09-01T00:00:00-07:00"),
      pseudonymousUserId: "user_hash",
    });

    expect(searchExperiences).toHaveBeenCalledTimes(2);
    expect(searchExperiences.mock.calls[0]?.[0].matchMode).toBe("observed");
    expect(searchExperiences.mock.calls[1]?.[0].matchMode).toBe("inferred");
    expect(ledger.usedInferredFallback).toBe(true);
    expect(output.output).not.toContain("https://");
    expect(JSON.parse(output.output).items[1].matchBasis).toBe("inferred");
  });

  it("does not load details for IDs the model did not discover", async () => {
    const getExperienceDetails = vi.fn(async () => [experience("invented")]);
    const dataSource: CoastDataSource = {
      searchExperiences: vi.fn(async () => ({ items: [], weak: true })),
      getExperienceDetails,
      getRecommendations: vi.fn(async () => []),
      savePreferences: vi.fn(async () => ({ applied: 0 })),
    };
    await executeCoastTool({
      call: {
        call_id: "call_2",
        name: "getExperienceDetails",
        arguments: JSON.stringify({ externalIds: ["invented"] }),
      },
      dataSource,
      ledger: createToolLedger(),
      nowMs: Date.parse("2026-09-01T00:00:00-07:00"),
      pseudonymousUserId: "user_hash",
    });
    expect(getExperienceDetails).not.toHaveBeenCalled();
  });
});
