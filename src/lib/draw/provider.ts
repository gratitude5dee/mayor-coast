import { z } from "zod";

export const DrawModeSchema = z.enum(["fast", "detailed", "turbo", "hq"]);
export type DrawMode = z.infer<typeof DrawModeSchema>;

export const DEFAULT_DRAW_MODEL = "gpt-image-2.5-flare";
export const SUNBURST_DRAW_MODEL = "gpt-image-2.5-sunburst";
export const TURBO_DRAW_MODEL = "fal-ai/z-image/turbo";
export type DrawInputCategory = "prompt" | "sketch" | "photo" | "result";

export function turboDrawInput(
  prompt: string,
  imageUrl?: string,
  inputCategory: DrawInputCategory = "prompt",
) {
  return { prompt, image_size: "square_hd", num_inference_steps: 4, num_images: 1,
    enable_safety_checker: true, output_format: "jpeg", acceleration: "regular",
    ...(imageUrl ? { image_url: imageUrl, strength: inputCategory === "sketch" ? 0.9 : 0.6 } : {}) };
}

export function drawImageSettings(mode: DrawMode) {
  if (mode === "turbo") throw new Error("DRAW_TURBO_SETTINGS_UNAVAILABLE");
  return {
    model: mode === "hq" ? SUNBURST_DRAW_MODEL : DEFAULT_DRAW_MODEL,
    quality: mode === "fast" ? "low" as const : mode === "detailed" ? "medium" as const : "high" as const,
    outputCompression: mode === "fast" ? 85 : 92,
    outputFormat: "jpeg" as const,
    size: "1024x1024" as const,
    partialImages: 2,
  };
}

export function resolveDrawProvider(mode: DrawMode, configuredFlareModel?: string) {
  if (mode === "turbo") {
    return { provider: "fal" as const, model: TURBO_DRAW_MODEL, ...turboDrawInput(""), partialImages: 0 };
  }
  const settings = drawImageSettings(mode);
  return {
    provider: "openai" as const,
    ...settings,
    model: mode === "fast" || mode === "detailed" ? (configuredFlareModel || settings.model) : settings.model,
  };
}

export type DrawStreamEvent =
  | { kind: "completed"; base64: string }
  | { kind: "preview"; base64: string; index: number };

export function drawStreamEvent(event: { type?: unknown; b64_json?: unknown; partial_image_index?: unknown; partial_image_b64?: unknown; response?: unknown }): DrawStreamEvent | null {
  const type = event.type;
  const partialBase64 = typeof event.partial_image_b64 === "string" ? event.partial_image_b64 : event.b64_json;
  if (type === "response.image_generation_call.partial_image" && typeof partialBase64 === "string" && partialBase64.length > 0) {
    return { kind: "preview" as const, base64: partialBase64, index: typeof event.partial_image_index === "number" ? event.partial_image_index : 0 };
  }
  if (type === "response.completed" && event.response && typeof event.response === "object") {
    const output = "output" in event.response && Array.isArray(event.response.output) ? event.response.output : [];
    const image = output.find((item): item is { type: string; status?: string; result: string } => Boolean(item) && typeof item === "object" && "type" in item && item.type === "image_generation_call" && item.status === "completed" && "result" in item && typeof item.result === "string");
    if (image?.result) return { kind: "completed" as const, base64: image.result };
    return null;
  }
  if (typeof event.b64_json !== "string" || event.b64_json.length === 0) return null;
  if (type === "image_generation.completed" || type === "image_edit.completed") {
    return { kind: "completed" as const, base64: event.b64_json };
  }
  if (type === "image_generation.partial_image" || type === "image_edit.partial_image") {
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
