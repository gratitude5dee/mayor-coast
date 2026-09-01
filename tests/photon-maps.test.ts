import { describe, expect, it } from "vitest";

import {
  buildGoogleMapsDirectionsUrl,
} from "../src/lib/photon/maps";

const destination = { latitude: 37.783657, longitude: -122.433057 };

describe("Google Maps iMessage directions", () => {
  it("lets Maps use the recipient device location when sharing is unavailable", () => {
    const url = new URL(buildGoogleMapsDirectionsUrl({ destination }));

    expect(url.origin).toBe("https://www.google.com");
    expect(url.searchParams.get("destination")).toBe("37.783657,-122.433057");
    expect(url.searchParams.get("origin")).toBeNull();
    expect(url.searchParams.get("travelmode")).toBe("walking");
  });

  it("never includes a consented origin in an outbound Maps URL", () => {
    const url = new URL(
      buildGoogleMapsDirectionsUrl({
        destination,
      }),
    );

    expect(url.searchParams.get("origin")).toBeNull();
  });

  it("rejects a non-SF destination", () => {
    expect(() =>
      buildGoogleMapsDirectionsUrl({
        destination: { latitude: 34.05, longitude: -118.24 },
      }),
    ).toThrow("MAP_DESTINATION_OUTSIDE_SF");
  });
});
