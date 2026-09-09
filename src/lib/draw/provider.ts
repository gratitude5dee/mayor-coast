import { z } from "zod";

export const DrawModeSchema = z.enum(["fast", "detailed"]);
export type DrawMode = z.infer<typeof DrawModeSchema>;

export const DEFAULT_DRAW_MODEL = "gpt-image-2.5-flare";

export function drawImageSettings(mode: DrawMode) {
  return {
    quality: mode === "fast" ? "low" as const : "medium" as const,
    outputCompression: mode === "fast" ? 85 : 92,
    outputFormat: "jpeg" as const,
    size: "1024x1024" as const,
    partialImages: 2,
  };
}

export function drawStreamEvent(event: { type?: unknown; b64_json?: unknown; partial_image_index?: unknown }) {
  if (typeof event.b64_json !== "string" || event.b64_json.length === 0) return null;
  if (event.type === "image_generation.completed" || event.type === "image_edit.completed") {
    return { kind: "completed" as const, base64: event.b64_json };
  }
  if (event.type === "image_generation.partial_image" || event.type === "image_edit.partial_image") {
    return {
      kind: "preview" as const,
      base64: event.b64_json,
      index: typeof event.partial_image_index === "number" ? event.partial_image_index : 0,
    };
  }
  return null;
}

export function safeDrawErrorCode(value: unknown): string {
  const normalized = typeof value === "string"
    ? value.toUpperCase().replace(/[^A-Z0-9_]/gu, "_").replace(/_+/gu, "_").slice(0, 100)
    : "";
  return normalized.length >= 3 ? `OPENAI_${normalized}` : "OPENAI_DRAW_FAILED";
}
