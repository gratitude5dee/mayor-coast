import { describe, expect, it } from "vitest";

import {
  IMAGE_PRICE_CENTS,
  TOPUP_CREDIT_CENTS,
  VIDEO_DURATION_SECONDS,
  admissionCost,
  availableFreeUsage,
  buildProviderRequest,
  parseCreativeRequest,
  topupMessage,
  validateAttachmentSizes,
} from "../src/lib/creative";
import { creativeRuntimeRequestSchema } from "../src/app/api/internal/creative/route";
import { completedStroke } from "../src/lib/draw/canvas";
import { drawLaunchSecret, drawSessionCookie } from "../src/lib/draw/launch";

describe("creative commands and credits", () => {
  it("parses text and one image edit without leaking attachment fields", () => {
    const result = parseCreativeRequest("/imagine make it cinematic", [
      { id: "image-1", kind: "image", mimeType: "image/jpeg", byteLength: 100 },
    ]);
    expect(result).toMatchObject({ command: "imagine", prompt: "make it cinematic" });
  });

  it("rejects audio-only /zap and over-limit media", () => {
    expect(parseCreativeRequest("/zap add bass", [
      { id: "audio-1", kind: "audio", mimeType: "audio/wav", byteLength: 100 },
    ])).toEqual({ error: "Audio alone is not enough for /zap—send an image or video with it." });
    expect(validateAttachmentSizes([
      { id: "video-1", kind: "video", mimeType: "video/mp4", byteLength: 21 * 1024 * 1024 },
    ])).toContain("too large");
  });

  it("uses free allowance before cents and prices images at 50 cents", () => {
    const now = Date.now();
    expect(availableFreeUsage([], "image", now)).toBe(10);
    expect(admissionCost("imagine", [], [], now)).toEqual({ source: "free", amountCents: 0 });
    const windows = Array.from({ length: 10 }, (_, index) => ({
      kind: "image" as const,
      admittedAtMs: now - index,
      reservationId: String(index),
      settled: true,
    }));
    expect(admissionCost("imagine", windows, [{ amountCents: IMAGE_PRICE_CENTS, kind: "topup", idempotencyKey: "t" }], now))
      .toEqual({ source: "credit", amountCents: IMAGE_PRICE_CENTS });
    expect(TOPUP_CREDIT_CENTS).toBe(1_000);
  });

  it("builds the pinned Fal 15-second text-to-video request", () => {
    const result = buildProviderRequest({ command: "zap", prompt: "a foggy bridge", attachments: [] });
    expect(result).toMatchObject({ provider: "fal", model: "minimax/h3-max-turbo/text-to-video" });
    expect(result.input.duration).toBe(VIDEO_DURATION_SECONDS);
  });

  it("accepts the fenced Convex worker envelope", () => {
    expect(creativeRuntimeRequestSchema.safeParse({
      jobId: "job-1",
      attemptId: "attempt-1",
      fencingToken: 1,
      command: "zap",
      encryptedPayload: "v1." + "x".repeat(40),
    }).success).toBe(true);
    expect(creativeRuntimeRequestSchema.safeParse({
      operation: "poll",
      jobId: "job-1",
      attemptId: "attempt-1",
      fencingToken: 1,
      command: "zap",
      encryptedPayload: "v1." + "x".repeat(40),
    }).success).toBe(false);
  });

  it("reads draw authorization from the URL fragment and scopes its cookie to APIs", () => {
    const secret = "secret-value-that-is-long-enough";
    expect(drawLaunchSecret(`#secret=${encodeURIComponent(secret)}`)).toBe(secret);
    expect(drawLaunchSecret("#unrelated=value")).toBeNull();
    expect(drawSessionCookie("coast_draw_1", "browser-token", 3_600)).toContain("Path=/;");
  });

  it("keeps a single tap as a visible drawing stroke", () => {
    expect(completedStroke([{ x: 12, y: 20 }], "#17231d", 18, false)).toEqual({
      points: [{ x: 12, y: 20 }],
      color: "#17231d",
      width: 18,
      erase: false,
    });
    expect(completedStroke([{ x: Number.NaN, y: 4 }], "#17231d", 18, false)).toBeNull();
  });

  it("gives the user a direct top-up explanation", () => {
    expect(topupMessage("video", null)).toContain("$9.99");
    expect(topupMessage("image", null)).toContain("$0.50");
  });
});
