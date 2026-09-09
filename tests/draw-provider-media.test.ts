import { expect, it } from "vitest";

import {
  drawCanarySketchUrl,
  drawProviderMediaSignature,
  drawProviderMediaUrl,
  verifyDrawCanarySketchSignature,
  verifyDrawProviderMediaSignature,
} from "../src/lib/draw/provider-media";

it("scopes provider URLs to one job, media manifest, and short expiry", () => {
  const secret = "draw-provider-test-secret";
  const expiresAtMs = 1_700_000_900_000;
  const signature = drawProviderMediaSignature(secret, "job-a", "media-a", expiresAtMs);
  expect(verifyDrawProviderMediaSignature(secret, "job-a", "media-a", expiresAtMs, signature)).toBe(true);
  expect(verifyDrawProviderMediaSignature(secret, "job-b", "media-a", expiresAtMs, signature)).toBe(false);
  const url = new URL(drawProviderMediaUrl("https://mayor-blue.vercel.app", secret, "job-a", "media-a", 1_700_000_000_000));
  expect(url.pathname).toBe("/api/internal/draw/provider-media");
  expect(url.searchParams.get("job")).toBe("job-a");
  expect(url.searchParams.get("media")).toBe("media-a");
});

it("uses a signed, non-customer sketch fixture for Turbo image-to-image canaries", () => {
  const secret = "draw-provider-test-secret";
  const url = new URL(drawCanarySketchUrl("https://mayor-blue.vercel.app", secret, 1_700_000_000_000));
  const expires = Number(url.searchParams.get("expires"));
  expect(verifyDrawCanarySketchSignature(secret, expires, url.searchParams.get("sig")!)).toBe(true);
  expect(verifyDrawCanarySketchSignature(secret, expires + 1, url.searchParams.get("sig")!)).toBe(false);
});
