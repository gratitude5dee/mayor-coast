import { z } from "zod";

export const FREE_IMAGE_LIMIT = 10;
export const FREE_VIDEO_LIMIT = 10;
export const FREE_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const TOPUP_PRICE_CENTS = 999;
export const TOPUP_CREDIT_CENTS = 1_000;
export const IMAGE_PRICE_CENTS = 50;
export const VIDEO_PRICE_CENTS = 100;
export const VIDEO_DURATION_SECONDS = 15;
export const MAX_TOTAL_INPUT_BYTES = 40 * 1024 * 1024;
export const MAX_IMAGE_OR_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_REFERENCES = 9;
export const MAX_VIDEO_REFERENCES = 3;
export const MAX_AUDIO_REFERENCES = 3;
export const MAX_TOTAL_REFERENCES = 12;

// `edit` is an intake command. It always materializes as a Draw image job so
// the durable worker and accounting model do not grow a second image pipeline.
export const CreativeCommandSchema = z.enum(["imagine", "zap", "draw", "edit"]);
export type CreativeCommand = z.infer<typeof CreativeCommandSchema>;

export type CreativeAttachment = {
  id: string;
  kind: "image" | "video" | "audio";
  mimeType: string;
  byteLength: number;
  durationSeconds?: number;
  sourceUrl?: string;
};

export type CreativeRequest = {
  command: CreativeCommand;
  prompt: string;
  attachments: CreativeAttachment[];
};

export type UsageWindow = {
  kind: "image" | "video";
  admittedAtMs: number;
  reservationId: string;
  settled: boolean;
};

export type CreditLedgerEntry = {
  amountCents: number;
  kind: "topup" | "reserve" | "release" | "settle" | "refund";
  idempotencyKey: string;
};

export function parseCreativeCommand(text: string): CreativeCommand | null {
  const match = /^\s*\/(imagine|zap|draw|edit)(?:\s+|$)/iu.exec(text);
  return match?.[1]?.toLowerCase() as CreativeCommand | undefined ?? null;
}

export function parseCreativeRequest(
  text: string,
  attachments: CreativeAttachment[] = [],
): CreativeRequest | { error: string } {
  const command = parseCreativeCommand(text);
  if (!command) return { error: "Send /imagine, /zap, /draw, or /edit to create media." };
  const prompt = text.replace(/^\s*\/(?:imagine|zap|draw|edit)\b/iu, "").trim();
  if (prompt.length === 0 && command !== "draw") return { error: `Tell me what to ${command}.` };
  if (prompt.length > 2_000) return { error: "That creative prompt is too long." };
  if (command === "imagine" && attachments.some((item) => item.kind !== "image")) {
    return { error: "/imagine accepts text or one image to edit." };
  }
  if (command === "imagine" && attachments.length > 1) {
    return { error: "/imagine edits one image at a time." };
  }
  if (command === "draw") {
    if (attachments.some((item) => item.kind !== "image") || attachments.length > 1) {
      return { error: "/draw accepts one image canvas. Send only an image or draw in the card." };
    }
  }
  if (command === "edit" && (attachments.some((item) => item.kind !== "image") || attachments.length > 1)) {
    return { error: "/edit accepts one image, or edits your latest COAST Draw result." };
  }
  if (command === "zap" && attachments.some((item) => item.kind === "audio") &&
      !attachments.some((item) => item.kind === "image" || item.kind === "video")) {
    return { error: "Audio alone is not enough for /zap—send an image or video with it." };
  }
  const imageCount = attachments.filter((item) => item.kind === "image").length;
  const videoCount = attachments.filter((item) => item.kind === "video").length;
  const audioCount = attachments.filter((item) => item.kind === "audio").length;
  if (imageCount > MAX_IMAGE_REFERENCES || videoCount > MAX_VIDEO_REFERENCES ||
      audioCount > MAX_AUDIO_REFERENCES || attachments.length > MAX_TOTAL_REFERENCES) {
    return { error: "That request has too many references. Try fewer images, videos, or audio clips." };
  }
  return { command, prompt, attachments };
}

export function priceFor(command: CreativeCommand): number {
  return command === "zap" ? VIDEO_PRICE_CENTS : IMAGE_PRICE_CENTS;
}

/**
 * Keep image completion pickup inside its 10–20 second target without polling
 * long-running video renders at image frequency.
 */
export function creativePollDelayMs(command: CreativeCommand, elapsedMs: number): number {
  if (command === "zap") return elapsedMs < 60_000 ? 3_000 : 5_000;
  if (elapsedMs < 20_000) return 1_000;
  if (elapsedMs < 60_000) return 2_000;
  return 5_000;
}

/** A bounded delivery score for production latency monitoring. */
export function creativeLatencyReward(command: CreativeCommand, totalMs: number): number {
  const targetMs = command === "zap" ? 60_000 : 10_000;
  const maximumMs = command === "zap" ? 180_000 : 20_000;
  if (totalMs <= targetMs) return 1;
  if (totalMs >= maximumMs) return 0;
  return Number(((maximumMs - totalMs) / (maximumMs - targetMs)).toFixed(4));
}

export function countFreeUsage(
  windows: readonly UsageWindow[],
  kind: "image" | "video",
  nowMs: number,
): number {
  return windows.filter((window) =>
    window.kind === kind && window.admittedAtMs > nowMs - FREE_WINDOW_MS,
  ).length;
}

export function availableFreeUsage(
  windows: readonly UsageWindow[],
  kind: "image" | "video",
  nowMs: number,
): number {
  const limit = kind === "image" ? FREE_IMAGE_LIMIT : FREE_VIDEO_LIMIT;
  return Math.max(0, limit - countFreeUsage(windows, kind, nowMs));
}

export function availableCreditCents(entries: readonly CreditLedgerEntry[]): number {
  return entries.reduce((balance, entry) => balance + entry.amountCents, 0);
}

export function admissionCost(
  command: CreativeCommand,
  windows: readonly UsageWindow[],
  entries: readonly CreditLedgerEntry[],
  nowMs: number,
): { source: "free" | "credit" | "payment"; amountCents: number } {
  const kind = command === "zap" ? "video" : "image";
  if (availableFreeUsage(windows, kind, nowMs) > 0) return { source: "free", amountCents: 0 };
  const amountCents = priceFor(command);
  return availableCreditCents(entries) >= amountCents
    ? { source: "credit", amountCents }
    : { source: "payment", amountCents };
}

export function validateAttachmentSizes(attachments: readonly CreativeAttachment[]): string | null {
  const total = attachments.reduce((sum, item) => sum + item.byteLength, 0);
  if (total > MAX_TOTAL_INPUT_BYTES) return "The combined attachments must be 40 MB or smaller.";
  for (const item of attachments) {
    const limit = item.kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_OR_AUDIO_BYTES;
    if (item.byteLength > limit) return `That ${item.kind} is too large.`;
    if (item.kind !== "image" && item.durationSeconds !== undefined &&
        (item.durationSeconds < 2 || item.durationSeconds > 15)) {
      return "Reference video and audio clips must be between 2 and 15 seconds.";
    }
  }
  return null;
}

export function topupMessage(kind: "image" | "video", nextFreeAtMs: number | null): string {
  const noun = kind === "image" ? "images" : "videos";
  const next = nextFreeAtMs === null ? "" : ` Free ${noun} return after ${new Date(nextFreeAtMs).toISOString()}.`;
  return `You’ve used your 10 free ${noun} for now. Add $10 credit for $9.99: images are $0.50 and 15-second videos are $1. Connect Link for future top-ups, or pay directly here.` + next;
}

export type ProviderRequest = {
  provider: "gmi" | "fal";
  model: string;
  input: Record<string, unknown>;
};

export function buildProviderRequest(request: CreativeRequest): ProviderRequest {
  if (request.command === "draw" || request.command === "edit") throw new Error("DRAW_USES_OPENAI_WORKER");
  if (request.command === "imagine") {
    const image = request.attachments[0];
    return image
      ? { provider: "gmi", model: "gpt-image-2-edit", input: { prompt: request.prompt, image: image.sourceUrl, size: "auto", quality: "auto", n: 1 } }
      : { provider: "gmi", model: "gpt-image-2-generate", input: { prompt: request.prompt, size: "auto", quality: "auto", output_format: "png", n: 1 } };
  }
  const images = request.attachments.filter((item) => item.kind === "image");
  const videos = request.attachments.filter((item) => item.kind === "video");
  const audio = request.attachments.filter((item) => item.kind === "audio");
  const shared = { prompt: request.prompt, duration: VIDEO_DURATION_SECONDS, resolution: "768P", prompt_expansion_mode: "balanced", enable_safety_checker: true };
  if (videos.length > 0 || audio.length > 0 || images.length > 2) {
    return {
      provider: "fal",
      model: "minimax/h3-max/reference-to-video",
      input: {
        ...shared,
        aspect_ratio: "adaptive",
        ...(images.length ? { reference_image_urls: images.map((item) => item.sourceUrl) } : {}),
        ...(videos.length ? { reference_video_urls: videos.map((item) => item.sourceUrl) } : {}),
        ...(audio.length ? { reference_audio_urls: audio.map((item) => item.sourceUrl) } : {}),
      },
    };
  }
  if (images.length > 0) {
    return { provider: "fal", model: "minimax/h3-max-turbo/image-to-video", input: { ...shared, image_url: images[0]?.sourceUrl, ...(images[1] ? { end_image_url: images[1].sourceUrl } : {}) } };
  }
  return { provider: "fal", model: "minimax/h3-max-turbo/text-to-video", input: { ...shared, aspect_ratio: "16:9" } };
}
