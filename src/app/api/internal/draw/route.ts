import OpenAI, { toFile } from "openai";
import { del, get as getPrivateBlob, put } from "@vercel/blob";
import sharp from "sharp";
import { z } from "zod";
import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { getConvexHttpClient } from "@/lib/convex";
import { parseServerEnv } from "@/lib/env";
import {
  DrawModeSchema,
  drawImageSettings,
  drawStreamEvent,
  safeDrawErrorCode,
  type DrawInputCategory,
} from "@/lib/draw/provider";
import { drawCanarySketchUrl, drawProviderMediaUrl } from "@/lib/draw/provider-media";
import { pollTurboDraw, runTurboDraw, submitTurboDraw, turboSubmissionForRequest } from "@/lib/draw/turbo";
import { decryptCreativePayload } from "@/lib/security/identity";
import { authorizeInternalRequest, privateJson } from "@/lib/security/internal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const inputSchema = z.object({
  operation: z.enum(["submit", "poll"]).default("submit"),
  jobId: z.string(),
  attemptId: z.string(),
  fencingToken: z.number(),
  command: z.literal("draw"),
  encryptedPayload: z.string().min(24),
  providerRequestId: z.string().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.operation === "poll" && !value.providerRequestId) {
    ctx.addIssue({ code: "custom", path: ["providerRequestId"], message: "provider request id is required" });
  }
});
const canarySchema = z.object({
  operation: z.literal("canary"),
  kind: z.enum(["generate", "edit"]).default("generate"),
  mode: DrawModeSchema.default("fast"),
}).strict();

type Outcome = "definitive" | "retryable" | "unknown";
type Payload = { prompt?: unknown; inputMediaId?: unknown; inputCategory?: unknown; mode?: unknown; messages?: unknown };

function normalizedErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    const code = error.code.toUpperCase().replace(/[^A-Z0-9_]/gu, "_").slice(0, 100);
    return code.startsWith("DRAW_") || code.startsWith("OPENAI_") ? code : safeDrawErrorCode(code);
  }
  if (error instanceof OpenAI.APIError) return safeDrawErrorCode(error.code ?? error.type ?? `HTTP_${error.status}`);
  return safeDrawErrorCode(error instanceof Error ? error.message : "FAILED");
}

function errorStatus(error: unknown) {
  return error && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
}

function errorOutcome(error: unknown, submitted: boolean): Outcome {
  if (submitted) return "unknown";
  const status = errorStatus(error);
  if (status !== undefined) {
    if (status >= 400 && status < 500 && ![408, 409, 429].includes(status)) return "definitive";
    return "retryable";
  }
  const code = normalizedErrorCode(error);
  if (["DRAW_INPUT_EXPIRED", "DRAW_INPUT_UNAVAILABLE", "DRAW_BLOB_NOT_CONFIGURED", "DRAW_PROMPT_REQUIRED", "DRAW_TURBO_NOT_CONFIGURED"].includes(code)) return "definitive";
  return "retryable";
}

function workerFailure(error: unknown, submitted: boolean, providerRequestId?: string): Response {
  const code = normalizedErrorCode(error);
  const outcome = errorOutcome(error, submitted);
  return privateJson(
    { error: code, code, outcome, ...(providerRequestId ? { providerRequestId } : {}) },
    { status: outcome === "definitive" ? 422 : 502, headers: { "x-coast-error-code": code, "x-coast-outcome": outcome } },
  );
}

function promptFrom(payload: Payload) {
  const direct = typeof payload.prompt === "string" ? payload.prompt : null;
  const message = Array.isArray(payload.messages)
    ? [...payload.messages].reverse().find((item): item is { text?: unknown } => Boolean(item) && typeof item === "object" && "text" in item && typeof item.text === "string")?.text
    : null;
  const source = direct ?? (typeof message === "string" ? message : "");
  return source.replace(/^\s*\/(?:edit|draw)\b/iu, "").replace(/[\u0000-\u001f]/gu, " ").trim().slice(0, 2_000);
}

function assembleInstructions(payloads: string[], env: ReturnType<typeof parseServerEnv>) {
  const instructions = payloads.map((value) => promptFrom(JSON.parse(decryptCreativePayload(value, env.convexServiceSecret)) as Payload)).filter(Boolean);
  const assembled = instructions.map((instruction, index) => index === instructions.length - 1
    ? `Latest instruction (this overrides conflicting earlier instructions): ${instruction}`
    : `Earlier branch instruction: ${instruction}`).join("\n");
  if (assembled.length > 32_000) throw Object.assign(new Error("DRAW_CONTEXT_TOO_LONG"), { code: "DRAW_CONTEXT_TOO_LONG" });
  return assembled;
}

function inputCategory(payload: Payload, imageId: Id<"creativeMedia"> | null): DrawInputCategory {
  if (!imageId) return "prompt";
  return payload.inputCategory === "photo" || payload.inputCategory === "result" ? payload.inputCategory : "sketch";
}

async function privateInput(env: ReturnType<typeof parseServerEnv>, mediaId: Id<"creativeMedia">) {
  const media = await getConvexHttpClient(env.CONVEX_URL).action(api.service.getCreativeMedia, {
    serviceSecret: env.convexServiceSecret,
    mediaId,
    nowMs: Date.now(),
  });
  if (!media) throw Object.assign(new Error("DRAW_INPUT_EXPIRED"), { code: "DRAW_INPUT_EXPIRED" });
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw Object.assign(new Error("DRAW_BLOB_NOT_CONFIGURED"), { code: "DRAW_BLOB_NOT_CONFIGURED" });
  const stored = await getPrivateBlob(media.sourceUrl, { access: "private", token, useCache: false });
  if (!stored) throw Object.assign(new Error("DRAW_INPUT_UNAVAILABLE"), { code: "DRAW_INPUT_UNAVAILABLE" });
  return { bytes: Buffer.from(await new Response(stored.stream).arrayBuffer()), mimeType: media.mimeType };
}

async function recordSubmission(
  env: ReturnType<typeof parseServerEnv>,
  input: z.infer<typeof inputSchema>,
  providerRequestId: string,
  providerModel: string,
  state: "queued" | "running",
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recorded = await getConvexHttpClient(env.CONVEX_URL).action((api.service as any).recordDrawSubmission, {
    serviceSecret: env.convexServiceSecret,
    jobId: input.jobId,
    attemptId: input.attemptId,
    fencingToken: input.fencingToken,
    providerRequestId,
    providerModel,
    state,
    nowMs: Date.now(),
  });
  if (!recorded) throw Object.assign(new Error("DRAW_STALE_ATTEMPT"), { code: "DRAW_STALE_ATTEMPT" });
}

async function drawProviderContext(env: ReturnType<typeof parseServerEnv>, jobId: string) {
  // This service-only call returns ciphertext. It deliberately cannot be used
  // by a browser session, admin view, or provider URL.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const context = await getConvexHttpClient(env.CONVEX_URL).action((api.service as any).getDrawProviderContext, {
    serviceSecret: env.convexServiceSecret, jobId,
  }) as { drawApiMode: "images" | "responses" | "turbo"; drawMode: z.infer<typeof DrawModeSchema>; encryptedPayloads: string[] } | null;
  if (!context) throw Object.assign(new Error("DRAW_CONTEXT_UNAVAILABLE"), { code: "DRAW_CONTEXT_UNAVAILABLE" });
  return context;
}

async function putJpeg(path: string, bytes: Buffer, quality: number) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw Object.assign(new Error("DRAW_BLOB_NOT_CONFIGURED"), { code: "DRAW_BLOB_NOT_CONFIGURED" });
  const jpeg = await sharp(bytes, { limitInputPixels: 16_777_216 }).jpeg({ quality }).toBuffer();
  return await put(path, jpeg, { access: "private", token, addRandomSuffix: false, contentType: "image/jpeg" });
}

async function canarySketchBytes() {
  const svg = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><rect width="1024" height="1024" fill="white"/><path d="M180 760C300 340 535 220 820 360C650 410 560 580 735 760C520 680 350 805 180 760Z" fill="none" stroke="#111827" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/><circle cx="735" cy="760" r="24" fill="#f4b544"/></svg>`;
  return await sharp(Buffer.from(svg)).png().toBuffer();
}

async function runOpenAiCanary(env: ReturnType<typeof parseServerEnv>, kind: "generate" | "edit", mode: Exclude<z.infer<typeof DrawModeSchema>, "turbo">) {
  const settings = drawImageSettings(mode);
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 0, timeout: 240_000 });
  const streamResponse = kind === "edit"
    ? await client.images.edit({
      model: mode === "hq" ? settings.model : env.COAST_DRAW_MODEL || settings.model,
      image: await toFile(await canarySketchBytes(), "sketch.png", { type: "image/png" }),
      prompt: "Turn this small black line sketch into a clean abstract color study.",
      size: settings.size, quality: settings.quality, output_format: settings.outputFormat, output_compression: settings.outputCompression, stream: true, partial_images: settings.partialImages,
    }).withResponse()
    : await client.images.generate({
      model: mode === "hq" ? settings.model : env.COAST_DRAW_MODEL || settings.model,
      prompt: "A small abstract color study.",
      size: settings.size, quality: settings.quality, output_format: settings.outputFormat, output_compression: settings.outputCompression, stream: true, partial_images: settings.partialImages,
    }).withResponse();
  let partials = 0;
  let completed = false;
  for await (const raw of streamResponse.data) {
    const event = drawStreamEvent(raw);
    partials += event?.kind === "preview" ? 1 : 0;
    completed ||= event?.kind === "completed";
  }
  return {
    status: completed ? "ok" : "missing_completion",
    model: mode === "hq" ? settings.model : env.COAST_DRAW_MODEL || settings.model,
    partials,
    hasRequestId: Boolean(streamResponse.request_id ?? streamResponse.response.headers.get("x-request-id")),
  };
}

export async function POST(request: Request): Promise<Response> {
  if (!authorizeInternalRequest(request)) return privateJson({ error: "unauthorized" }, { status: 401 });
  let submitted = false;
  let providerRequestId: string | undefined;
  try {
    const env = parseServerEnv();
    const rawInput = await request.json();
    const canary = canarySchema.safeParse(rawInput);
    if (canary.success) {
      if (canary.data.mode === "turbo") {
        if (!env.FAL_KEY) throw Object.assign(new Error("DRAW_TURBO_NOT_CONFIGURED"), { code: "DRAW_TURBO_NOT_CONFIGURED" });
        const input = canary.data.kind === "edit" ? await canarySketchBytes() : null;
        const result = await runTurboDraw({
          key: env.FAL_KEY,
          prompt: canary.data.kind === "edit" ? "Turn this sketch into a polished amber-and-green landscape. Preserve the composition." : "A geometric amber circle on a deep green background.",
          ...(input ? { image: drawCanarySketchUrl(new URL(request.url).origin, env.convexServiceSecret, Date.now()), inputCategory: "sketch" as const } : {}),
          onSubmitted: async () => undefined,
        });
        const metadata = await sharp(result.bytes).metadata();
        // Decode both images before comparing. This catches the common worker
        // regression where the input sketch is materialized as the output.
        const inputPixels = input ? await sharp(input).ensureAlpha().raw().toBuffer() : null;
        const outputPixels = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
        const changed = inputPixels === null || !inputPixels.equals(outputPixels);
        return privateJson({ status: metadata.width === 1024 && metadata.height === 1024 && changed ? "ok" : "invalid_image", model: result.model, partials: 0, hasRequestId: Boolean(result.requestId) });
      }
      return privateJson(await runOpenAiCanary(env, canary.data.kind, canary.data.mode), { status: 200 });
    }

    const input = inputSchema.parse(rawInput);
    const payload = JSON.parse(decryptCreativePayload(input.encryptedPayload, env.convexServiceSecret)) as Payload;
    const persistedContext = await drawProviderContext(env, input.jobId);
    const mode = DrawModeSchema.catch(persistedContext.drawMode).parse(payload.mode ?? persistedContext.drawMode);
    const imageId = typeof payload.inputMediaId === "string" ? payload.inputMediaId as Id<"creativeMedia"> : null;
    const prompt = assembleInstructions(persistedContext.encryptedPayloads, env) || promptFrom(payload);
    if (!imageId && !prompt) throw Object.assign(new Error("DRAW_PROMPT_REQUIRED"), { code: "DRAW_PROMPT_REQUIRED" });
    const category = inputCategory(payload, imageId);

    if (mode === "turbo") {
      if (!env.FAL_KEY) throw Object.assign(new Error("DRAW_TURBO_NOT_CONFIGURED"), { code: "DRAW_TURBO_NOT_CONFIGURED" });
      if (input.operation === "poll") {
        const result = await pollTurboDraw({
          key: env.FAL_KEY,
          submission: turboSubmissionForRequest("fal-ai/z-image/turbo" + (imageId ? "/image-to-image" : ""), input.providerRequestId!),
        });
        if (result.status !== "completed") return privateJson({ status: result.status, providerRequestId: result.requestId });
        const blob = await putJpeg(`coast/draw/${input.jobId}/final-${crypto.randomUUID()}.jpg`, result.bytes, 85);
        return privateJson({ status: "completed", url: blob.url, mimeType: "image/jpeg", filename: "coast-draw.jpg", caption: "Here’s your finished drawing.", providerRequestId: result.requestId, providerModel: "fal-ai/z-image/turbo" });
      }
      const providerImageUrl = imageId
        ? drawProviderMediaUrl(new URL(request.url).origin, env.convexServiceSecret, input.jobId, imageId, Date.now())
        : undefined;
      const submission = await submitTurboDraw({
        key: env.FAL_KEY,
        prompt: prompt || "Turn this sketch into a finished image. Preserve its composition and intentional details.",
        ...(providerImageUrl ? { imageUrl: providerImageUrl } : {}),
        inputCategory: category,
      });
      providerRequestId = submission.requestId;
      submitted = true;
      await recordSubmission(env, input, submission.requestId, submission.model, "queued");
      return privateJson({ status: "queued", providerRequestId: submission.requestId, providerModel: submission.model });
    }

    if (input.operation === "poll") throw Object.assign(new Error("DRAW_OPENAI_POLL_UNAVAILABLE"), { code: "DRAW_OPENAI_POLL_UNAVAILABLE" });
    const settings = drawImageSettings(mode);
    const model = mode === "hq" ? settings.model : env.COAST_DRAW_MODEL || settings.model;
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 0, timeout: 240_000 });
    const shouldUseResponses = persistedContext.drawApiMode === "responses";
    if (shouldUseResponses && !imageId) throw Object.assign(new Error("DRAW_PARENT_UNAVAILABLE"), { code: "DRAW_PARENT_UNAVAILABLE" });
    const streamResponse = shouldUseResponses
      ? await (async () => {
        const media = await privateInput(env, imageId!);
        // The app constructs context explicitly. No previous_response_id or
        // stored OpenAI conversation can retain a user's branch after expiry.
        return client.responses.create({
          model: process.env.COAST_DRAW_MULTITURN_MODEL || "gpt-5.6-luna",
          reasoning: { effort: "none" },
          store: false,
          stream: true,
          tool_choice: { type: "image_generation" },
          input: [{ role: "user", content: [
            { type: "input_text", text: prompt || "Refine this image while preserving its composition." },
            { type: "input_image", image_url: `data:${media.mimeType};base64,${media.bytes.toString("base64")}`, detail: "high" },
          ] }],
          tools: [{ type: "image_generation", action: "edit", model, quality: settings.quality, output_format: settings.outputFormat, output_compression: settings.outputCompression, size: settings.size, partial_images: settings.partialImages }],
        }).withResponse();
      })()
      : imageId
        ? await (async () => {
          const media = await privateInput(env, imageId);
          return client.images.edit({
            model,
            image: await toFile(media.bytes, "coast-draw.png", { type: media.mimeType }),
            prompt: prompt || "Turn this sketch into a finished image. Preserve its composition and intentional details.",
            size: settings.size, quality: settings.quality, output_format: settings.outputFormat, output_compression: settings.outputCompression, stream: true, partial_images: settings.partialImages,
          }).withResponse();
        })()
        : await client.images.generate({
          model, prompt, size: settings.size, quality: settings.quality, output_format: settings.outputFormat, output_compression: settings.outputCompression, stream: true, partial_images: settings.partialImages,
        }).withResponse();
    providerRequestId = streamResponse.request_id ?? streamResponse.response.headers.get("x-request-id") ?? undefined;
    // A stream without an OpenAI diagnostic ID is an unknown submission, never
    // a candidate for automatic replacement.
    if (!providerRequestId) throw Object.assign(new Error("DRAW_REQUEST_ID_MISSING"), { code: "DRAW_REQUEST_ID_MISSING" });
    submitted = true;
    await recordSubmission(env, input, providerRequestId, model, "running");
    const convex = getConvexHttpClient(env.CONVEX_URL);
    let finalBase64: string | undefined;
    const streamEvents = streamResponse.data as AsyncIterable<{ type?: unknown; b64_json?: unknown; partial_image_index?: unknown; partial_image_b64?: unknown; response?: unknown }>;
    for await (const rawEvent of streamEvents) {
      const event = drawStreamEvent(rawEvent);
      if (!event) continue;
      if (event.kind === "completed") { finalBase64 = event.base64; continue; }
      const blob = await putJpeg(`coast/draw/${input.jobId}/preview-${event.index}-${crypto.randomUUID()}.jpg`, Buffer.from(event.base64, "base64"), settings.outputCompression);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const accepted = await convex.action((api.service as any).recordDrawPreview, {
        serviceSecret: env.convexServiceSecret, jobId: input.jobId, attemptId: input.attemptId, fencingToken: input.fencingToken,
        previewIndex: event.index, sourceUrl: blob.url, mimeType: "image/jpeg", filename: `coast-draw-preview-${event.index}.jpg`, byteLength: Buffer.byteLength(event.base64, "base64"), nowMs: Date.now(),
      });
      if (!accepted) {
        const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
        if (blobToken) await del(blob.url, { token: blobToken });
      }
    }
    if (!finalBase64) throw Object.assign(new Error("DRAW_COMPLETION_MISSING"), { code: "DRAW_COMPLETION_MISSING" });
    const blob = await putJpeg(`coast/draw/${input.jobId}/final-${crypto.randomUUID()}.jpg`, Buffer.from(finalBase64, "base64"), settings.outputCompression);
    return privateJson({ status: "completed", url: blob.url, mimeType: "image/jpeg", filename: "coast-draw.jpg", caption: "Here’s your finished drawing.", providerRequestId, providerModel: model });
  } catch (error) {
    return workerFailure(error, submitted, providerRequestId);
  }
}
