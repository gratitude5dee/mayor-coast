import OpenAI, { toFile } from "openai";
import { del, get as getPrivateBlob, put } from "@vercel/blob";
import sharp from "sharp";
import { z } from "zod";
import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { getConvexHttpClient } from "@/lib/convex";
import { parseServerEnv } from "@/lib/env";
import {
  DEFAULT_DRAW_MODEL,
  DrawModeSchema,
  drawImageSettings,
  drawStreamEvent,
  safeDrawErrorCode,
} from "@/lib/draw/provider";
import { decryptCreativePayload } from "@/lib/security/identity";
import { authorizeInternalRequest, privateJson } from "@/lib/security/internal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const inputSchema = z.object({
  jobId: z.string(),
  attemptId: z.string(),
  fencingToken: z.number(),
  command: z.literal("draw"),
  encryptedPayload: z.string().min(24),
}).strict();
const canarySchema = z.object({ operation: z.literal("canary"), kind: z.enum(["generate", "edit"]).default("generate") }).strict();

type Outcome = "definitive" | "retryable" | "unknown";

function normalizedErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    const code = error.code.toUpperCase().replace(/[^A-Z0-9_]/gu, "_").slice(0, 100);
    return code.startsWith("DRAW_") || code.startsWith("OPENAI_") ? code : safeDrawErrorCode(code);
  }
  if (error instanceof OpenAI.APIError) {
    return safeDrawErrorCode(error.code ?? error.type ?? `HTTP_${error.status}`);
  }
  return safeDrawErrorCode(error instanceof Error ? error.message : "FAILED");
}

function errorOutcome(error: unknown, submitted: boolean): Outcome {
  if (submitted) return "unknown";
  if (error instanceof OpenAI.APIError && typeof error.status === "number") {
    if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 409 && error.status !== 429) return "definitive";
    return "retryable";
  }
  const code = normalizedErrorCode(error);
  if (["DRAW_INPUT_EXPIRED", "DRAW_INPUT_UNAVAILABLE", "DRAW_BLOB_NOT_CONFIGURED", "DRAW_PROMPT_REQUIRED"].includes(code)) return "definitive";
  return "retryable";
}

function workerFailure(error: unknown, submitted: boolean, providerRequestId?: string): Response {
  const code = normalizedErrorCode(error);
  const outcome = errorOutcome(error, submitted);
  const details = error instanceof OpenAI.APIError ? error.message.replace(/[\r\n]+/gu, " ").slice(0, 240) : undefined;
  return privateJson(
    { error: code, code, outcome, ...(details ? { details } : {}), ...(providerRequestId ? { providerRequestId } : {}) },
    { status: outcome === "definitive" ? 422 : 502, headers: { "x-coast-error-code": code, "x-coast-outcome": outcome } },
  );
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
      const client = new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 0, timeout: 240_000 });
      const settings = drawImageSettings("fast");
      const streamResponse = canary.data.kind === "edit"
        ? await client.images.edit({
          model: env.COAST_DRAW_MODEL || DEFAULT_DRAW_MODEL,
          image: await toFile(await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer(), "canary.png", { type: "image/png" }),
          prompt: "Turn this blank canvas into a clean abstract color study",
          size: settings.size,
          quality: settings.quality,
          output_format: settings.outputFormat,
          output_compression: settings.outputCompression,
          stream: true,
          partial_images: settings.partialImages,
        }).withResponse()
        : await client.images.generate({
          model: env.COAST_DRAW_MODEL || DEFAULT_DRAW_MODEL,
          prompt: "A small abstract color study",
          size: settings.size,
          quality: settings.quality,
          output_format: settings.outputFormat,
          output_compression: settings.outputCompression,
          stream: true,
          partial_images: settings.partialImages,
        }).withResponse();
      const requestId = streamResponse.request_id ?? streamResponse.response.headers.get("x-request-id") ?? null;
      let partials = 0;
      let completed = false;
      for await (const event of streamResponse.data) {
        const parsed = drawStreamEvent(event);
        if (parsed?.kind === "preview") partials += 1;
        if (parsed?.kind === "completed") completed = true;
      }
      return privateJson({ status: completed ? "ok" : "missing_completion", model: env.COAST_DRAW_MODEL || DEFAULT_DRAW_MODEL, partials, hasRequestId: Boolean(requestId) }, { status: completed ? 200 : 502 });
    }
    const input = inputSchema.parse(rawInput);
    const payload = JSON.parse(decryptCreativePayload(input.encryptedPayload, env.convexServiceSecret)) as {
      prompt?: unknown;
      inputMediaId?: unknown;
      mode?: unknown;
    };
    const prompt = typeof payload.prompt === "string"
      ? payload.prompt.replace(/[\u0000-\u001f]/gu, " ").trim().slice(0, 2_000)
      : "";
    const mode = DrawModeSchema.catch("fast").parse(payload.mode);
    const settings = drawImageSettings(mode);
    const model = env.COAST_DRAW_MODEL || DEFAULT_DRAW_MODEL;
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 0, timeout: 240_000 });
    const imageId = typeof payload.inputMediaId === "string" ? payload.inputMediaId as Id<"creativeMedia"> : null;
    if (!imageId && !prompt) throw Object.assign(new Error("DRAW_PROMPT_REQUIRED"), { code: "DRAW_PROMPT_REQUIRED" });

    let streamResponse;
    if (imageId) {
      const media = await getConvexHttpClient(env.CONVEX_URL).action(api.service.getCreativeMedia, {
        serviceSecret: env.convexServiceSecret,
        mediaId: imageId,
        nowMs: Date.now(),
      });
      if (!media) throw Object.assign(new Error("DRAW_INPUT_EXPIRED"), { code: "DRAW_INPUT_EXPIRED" });
      const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
      if (!blobToken) throw Object.assign(new Error("DRAW_BLOB_NOT_CONFIGURED"), { code: "DRAW_BLOB_NOT_CONFIGURED" });
      const stored = await getPrivateBlob(media.sourceUrl, { access: "private", token: blobToken, useCache: false });
      if (!stored) throw Object.assign(new Error("DRAW_INPUT_UNAVAILABLE"), { code: "DRAW_INPUT_UNAVAILABLE" });
      const bytes = Buffer.from(await new Response(stored.stream).arrayBuffer());
      streamResponse = await client.images.edit({
        model,
        image: await toFile(bytes, "coast-draw.png", { type: media.mimeType }),
        prompt: prompt || "Turn this sketch into a finished image. Preserve its composition and intentional details.",
        size: settings.size,
        quality: settings.quality,
        output_format: settings.outputFormat,
        output_compression: settings.outputCompression,
        stream: true,
        partial_images: settings.partialImages,
      }).withResponse();
    } else {
      streamResponse = await client.images.generate({
        model,
        prompt,
        size: settings.size,
        quality: settings.quality,
        output_format: settings.outputFormat,
        output_compression: settings.outputCompression,
        stream: true,
        partial_images: settings.partialImages,
      }).withResponse();
    }

    providerRequestId = streamResponse.request_id
      ?? streamResponse.response.headers.get("x-request-id")
      ?? undefined;
    if (!providerRequestId) throw Object.assign(new Error("DRAW_REQUEST_ID_MISSING"), { code: "DRAW_REQUEST_ID_MISSING" });

    const convex = getConvexHttpClient(env.CONVEX_URL);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recorded = await convex.action((api.service as any).recordDrawSubmission, {
      serviceSecret: env.convexServiceSecret,
      jobId: input.jobId,
      attemptId: input.attemptId,
      fencingToken: input.fencingToken,
      providerRequestId,
      providerModel: model,
      nowMs: Date.now(),
    });
    if (!recorded) throw Object.assign(new Error("DRAW_STALE_ATTEMPT"), { code: "DRAW_STALE_ATTEMPT" });
    submitted = true;

    let finalBase64: string | undefined;
    let acceptedPartials = 0;
    for await (const rawEvent of streamResponse.data) {
      const event = drawStreamEvent(rawEvent);
      if (!event) continue;
      if (event.kind === "completed") {
        finalBase64 = event.base64;
        continue;
      }
      const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
      if (!blobToken) throw Object.assign(new Error("DRAW_BLOB_NOT_CONFIGURED"), { code: "DRAW_BLOB_NOT_CONFIGURED" });
      const blob = await put(
        `coast/draw/${input.jobId}/preview-${event.index}-${crypto.randomUUID()}.jpg`,
        Buffer.from(event.base64, "base64"),
        { access: "private", token: blobToken, addRandomSuffix: false, contentType: "image/jpeg" },
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const accepted = await convex.action((api.service as any).recordDrawPreview, {
        serviceSecret: env.convexServiceSecret,
        jobId: input.jobId,
        attemptId: input.attemptId,
        fencingToken: input.fencingToken,
        previewIndex: event.index,
        sourceUrl: blob.url,
        mimeType: "image/jpeg",
        filename: `coast-draw-preview-${event.index}.jpg`,
        byteLength: Buffer.byteLength(event.base64, "base64"),
        nowMs: Date.now(),
      });
      if (!accepted) await del(blob.url, { token: blobToken });
      else acceptedPartials += 1;
    }

    if (!finalBase64) throw Object.assign(new Error("DRAW_COMPLETION_MISSING"), { code: "DRAW_COMPLETION_MISSING" });
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (!blobToken) throw Object.assign(new Error("DRAW_BLOB_NOT_CONFIGURED"), { code: "DRAW_BLOB_NOT_CONFIGURED" });
    const finalBytes = Buffer.from(finalBase64, "base64");
    const blob = await put(`coast/draw/${input.jobId}/final-${crypto.randomUUID()}.jpg`, finalBytes, {
      access: "private",
      token: blobToken,
      addRandomSuffix: false,
      contentType: "image/jpeg",
    });
    return privateJson({
      url: blob.url,
      mimeType: "image/jpeg",
      filename: "coast-draw.jpg",
      caption: "Here’s your finished drawing.",
      providerRequestId,
      providerModel: model,
      acceptedPartials,
    });
  } catch (error) {
    return workerFailure(error, submitted, providerRequestId);
  }
}
