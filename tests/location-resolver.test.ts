import { describe, expect, it } from "vitest";

import { isValidSharedLocation } from "../src/app/api/internal/location/resolve/route";

const nowMs = Date.parse("2026-09-01T00:30:00.000Z");

describe("Find My location validation", () => {
  it("accepts a fresh, consented legacy snapshot without relaxing safety checks", () => {
    expect(
      isValidSharedLocation(
        {
          accuracy: 75,
          isLocatingInProgress: false,
          latitude: 37.7749,
          locationTimestamp: new Date(nowMs - 30_000),
          locationType: "legacy",
          longitude: -122.4194,
        },
        nowMs,
      ),
    ).toBe(true);
  });

  it("still rejects stale, locating, unknown, and imprecise snapshots", () => {
    const base = {
      accuracy: 75,
      isLocatingInProgress: false,
      latitude: 37.7749,
      locationTimestamp: new Date(nowMs - 30_000),
      locationType: "live",
      longitude: -122.4194,
    } as const;

    expect(
      isValidSharedLocation(
        { ...base, locationTimestamp: new Date(nowMs - 16 * 60_000) },
        nowMs,
      ),
    ).toBe(false);
    expect(
      isValidSharedLocation({ ...base, isLocatingInProgress: true }, nowMs),
    ).toBe(false);
    expect(
      isValidSharedLocation({ ...base, locationType: "unknown" }, nowMs),
    ).toBe(false);
    expect(isValidSharedLocation({ ...base, accuracy: 2_001 }, nowMs)).toBe(
      false,
    );
  });
});
