import { describe, expect, it } from "vitest";

import {
  IMAGE_PRICE_CENTS,
  TOPUP_CREDIT_CENTS,
  VIDEO_DURATION_SECONDS,
  admissionCost,
  availableFreeUsage,
  buildProviderRequest,
  creativeLatencyReward,
  creativePollDelayMs,
  parseCreativeRequest,
  topupMessage,
  validateAttachmentSizes,
} from "../src/lib/creative";
import {
  creativeRuntimeRequestSchema,
  falQueueUrl,
  falRequestId,
  falRequestUrl,
} from "../src/app/api/internal/creative/route";
import { completedStroke } from "../src/lib/draw/canvas";
import { DEFAULT_DRAW_MODEL, SUNBURST_DRAW_MODEL, drawImageSettings, drawStreamEvent, turboDrawInput } from "../src/lib/draw/provider";
import { drawLaunchSecret, drawSessionCookie } from "../src/lib/draw/launch";
import { resolveMiniApp } from "@photon-ai/chat-adapter-imessage";

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

  it("accepts Fal queue IDs from current, compatibility, and header responses", () => {
    expect(falRequestId({ request_id: "current-id" })).toBe("current-id");
    expect(falRequestId({ requestId: "compat-id" })).toBe("compat-id");
    expect(falRequestId({}, "header-id")).toBe("header-id");
    expect(falRequestId({})).toBeNull();
  });

  it("uses Fal operation routes for submission and canonical model routes for requests", () => {
    expect(falQueueUrl("minimax/h3-max-turbo/text-to-video")).toBe(
      "https://queue.fal.run/minimax/h3-max-turbo/text-to-video",
    );
    expect(falRequestUrl("minimax/h3-max-turbo/text-to-video", "request_123", "/status")).toBe(
      "https://queue.fal.run/minimax/h3-max-turbo/requests/request_123/status",
    );
    expect(falRequestUrl("minimax/h3-max/reference-to-video", "request_456")).toBe(
      "https://queue.fal.run/minimax/h3-max/requests/request_456",
    );
  });

  it("polls images aggressively and scores their delivery target", () => {
    expect(creativePollDelayMs("imagine", 0)).toBe(1_000);
    expect(creativePollDelayMs("draw", 19_999)).toBe(1_000);
    expect(creativePollDelayMs("zap", 0)).toBe(3_000);
    expect(creativeLatencyReward("imagine", 9_000)).toBe(1);
    expect(creativeLatencyReward("imagine", 15_000)).toBe(0.5);
    expect(creativeLatencyReward("imagine", 21_000)).toBe(0);
  });

  it("centralizes Draw modes and durable stream event handling", () => {
    expect(DEFAULT_DRAW_MODEL).toBe("gpt-image-2.5-flare");
    expect(drawImageSettings("fast")).toMatchObject({ quality: "low", outputFormat: "jpeg", outputCompression: 85, partialImages: 2 });
    expect(drawImageSettings("detailed")).toMatchObject({ quality: "medium", outputFormat: "jpeg", outputCompression: 92, partialImages: 2 });
    expect(drawImageSettings("hq")).toMatchObject({ model: SUNBURST_DRAW_MODEL, quality: "high", outputFormat: "jpeg", outputCompression: 92, partialImages: 2 });
    expect(turboDrawInput("finish this sketch", "https://coast.example/sketch.jpg", "sketch")).toMatchObject({ image_size: "square_hd", num_inference_steps: 4, num_images: 1, enable_safety_checker: true, output_format: "jpeg", strength: 0.9 });
    expect(turboDrawInput("refine this photo", "https://coast.example/photo.jpg", "photo")).toMatchObject({ strength: 0.6 });
    expect(drawStreamEvent({ type: "image_edit.partial_image", b64_json: "preview", partial_image_index: 1 })).toMatchObject({ kind: "preview", index: 1 });
    expect(drawStreamEvent({ type: "image_generation.completed", b64_json: "final" })).toEqual({ kind: "completed", base64: "final" });
    expect(drawStreamEvent({ type: "image_generation.partial_image", b64_json: "preview" })).not.toMatchObject({ kind: "completed" });
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
    expect(creativeRuntimeRequestSchema.safeParse({ operation: "canary" }).success).toBe(true);
    expect(creativeRuntimeRequestSchema.safeParse({ operation: "canary", command: "zap" }).success).toBe(false);
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

  it("preserves the live Messages layout for the installed draw extension", async () => {
    await expect(resolveMiniApp({
      appName: "COAST Draw",
      teamId: "TEAM123",
      extensionBundleId: "com.fivedeestudios.coastdraw.MessagesExtension",
      live: true,
      url: "https://mayor-blue.vercel.app/draw/session#secret=redacted",
    })).resolves.toMatchObject({ live: true });
  });

  it("gives the user a direct top-up explanation", () => {
    expect(topupMessage("video", null)).toContain("$9.99");
    expect(topupMessage("image", null)).toContain("$0.50");
  });
});
