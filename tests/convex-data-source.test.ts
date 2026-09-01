import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";

import {
  canonicalNeighborhood,
  ConvexCoastDataSource,
} from "../src/lib/convex/data-source";

describe("ConvexCoastDataSource", () => {
  it("uses the snapshot's event entity type and maps it into the agent contract", async () => {
    const query = vi.fn().mockResolvedValue({
      retrievalMode: "observed",
      results: [
        {
          externalId: "experienceCard:event-1",
          entityExternalId: "eventOccurrence:event-1",
          title: "A September Show",
          canonicalUrl: "https://example.com/show",
          observedSummary: "A source-backed event summary.",
          entityType: "event",
          activeStatus: "active",
          neighborhoodId: "Mission",
          primaryType: null,
          priceBand: "unknown",
          startAtUtcMs: Date.parse("2026-09-15T03:00:00Z"),
          provenanceIds: ["sourceClaim:event-1"],
          experienceFields: {},
          matchSource: "observed",
        },
      ],
    });
    const dataSource = new ConvexCoastDataSource(
      { query } as unknown as ConvexHttpClient,
      Date.parse("2026-09-01T07:00:00Z"),
    );

    const result = await dataSource.searchExperiences({
      query: "live music",
      entityType: "event",
      neighborhoods: [],
      primaryTypes: [],
      priceBands: [],
      startAtMs: null,
      endAtMs: null,
      limit: 5,
      matchMode: "observed",
    });

    expect(query).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entityType: "event" }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.entityType).toBe("event");
  });

  it("normalizes local neighborhood shorthand before issuing a bounded query", async () => {
    const query = vi.fn().mockResolvedValue({ retrievalMode: "observed", results: [] });
    const dataSource = new ConvexCoastDataSource(
      { query } as unknown as ConvexHttpClient,
      Date.parse("2026-09-01T07:00:00Z"),
    );

    await dataSource.searchExperiences({
      query: "dinner",
      entityType: "place",
      neighborhoods: ["SoMa"],
      primaryTypes: [],
      priceBands: [],
      startAtMs: null,
      endAtMs: null,
      limit: 5,
      matchMode: "observed",
    });

    expect(query).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ neighborhoodId: "South of Market" }),
    );
    expect(canonicalNeighborhood("Downtown")).toBe("Financial District/South Beach");
  });

  it("forwards a bounded event time range to the indexed Convex query", async () => {
    const query = vi.fn().mockResolvedValue({ retrievalMode: "observed", results: [] });
    const dataSource = new ConvexCoastDataSource(
      { query } as unknown as ConvexHttpClient,
      Date.parse("2026-09-01T07:00:00Z"),
    );
    const startAtMs = Date.parse("2026-09-01T07:00:00Z");
    const endAtMs = Date.parse("2026-09-02T07:00:00Z");

    await dataSource.searchExperiences({
      query: "events",
      entityType: "event",
      neighborhoods: [],
      primaryTypes: [],
      priceBands: [],
      startAtMs,
      endAtMs,
      limit: 5,
      matchMode: "observed",
    });

    expect(query).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ startAtMs, endAtMs, entityType: "event" }),
    );
  });
});
