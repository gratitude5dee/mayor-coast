import OpenAI, { toFile } from "openai";
import { get as getPrivateBlob, put } from "@vercel/blob";
import { z } from "zod";
import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { getConvexHttpClient } from "@/lib/convex";
import { parseServerEnv } from "@/lib/env";
import { decryptCreativePayload } from "@/lib/security/identity";
import { authorizeInternalRequest, privateJson } from "@/lib/security/internal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const inputSchema = z.object({ jobId: z.string(), attemptId: z.string(), fencingToken: z.number(), command: z.literal("draw"), encryptedPayload: z.string().min(24) }).strict();

export async function POST(request: Request): Promise<Response> {
  if (!authorizeInternalRequest(request)) return privateJson({ error: "unauthorized" }, { status: 401 });
  try {
    const env = parseServerEnv(); const input = inputSchema.parse(await request.json());
    const payload = JSON.parse(decryptCreativePayload(input.encryptedPayload, env.convexServiceSecret)) as { prompt?: unknown; inputMediaId?: unknown };
    const prompt = typeof payload.prompt === "string" ? payload.prompt.replace(/[\u0000-\u001f]/gu, " ").trim().slice(0, 2_000) : "";
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 0 });
    const imageId = typeof payload.inputMediaId === "string" ? payload.inputMediaId as Id<"creativeMedia"> : null;
    let stream;
    if (imageId) {
      const media = await getConvexHttpClient(env.CONVEX_URL).action(api.service.getCreativeMedia, { serviceSecret: env.convexServiceSecret, mediaId: imageId, nowMs: Date.now() });
      if (!media) throw new Error("DRAW_INPUT_EXPIRED");
      const blobToken = process.env.BLOB_READ_WRITE_TOKEN; if (!blobToken) throw new Error("DRAW_BLOB_NOT_CONFIGURED");
      const stored = await getPrivateBlob(media.sourceUrl, { access: "private", token: blobToken, useCache: false }); if (!stored) throw new Error("DRAW_INPUT_UNAVAILABLE");
      const bytes = Buffer.from(await new Response(stored.stream).arrayBuffer());
      stream = await client.images.edit({ model: "gpt-image-2.5-sunburst", image: await toFile(bytes, "coast-draw.png", { type: "image/png" }), prompt: prompt || "Turn this sketch into a finished image while preserving the composition and requested details.", size: "1024x1024", quality: "medium", output_format: "png", stream: true, partial_images: 2 });
    } else {
      stream = await client.images.generate({ model: "gpt-image-2.5-sunburst", prompt, size: "1024x1024", quality: "medium", output_format: "png", stream: true, partial_images: 2 });
    }
    let finalBase64: string | undefined;
    for await (const event of stream) {
      if ((event.type === "image_generation.completed" || event.type === "image_edit.completed") && typeof event.b64_json === "string") finalBase64 = event.b64_json;
      if ((event.type === "image_generation.partial_image" || event.type === "image_edit.partial_image") && typeof event.b64_json === "string" && !finalBase64) finalBase64 = event.b64_json;
    }
    if (!finalBase64) throw new Error("DRAW_COMPLETION_MISSING");
    const token = process.env.BLOB_READ_WRITE_TOKEN; if (!token) throw new Error("DRAW_BLOB_NOT_CONFIGURED");
    const blob = await put(`coast/draw/${crypto.randomUUID()}.png`, Buffer.from(finalBase64, "base64"), { access: "private", token, addRandomSuffix: false, contentType: "image/png" });
    return privateJson({ url: blob.url, mimeType: "image/png", filename: "coast-draw.png", caption: "Here’s your finished drawing." });
  } catch (error) { return privateJson({ error: error instanceof Error ? error.message.slice(0, 120) : "draw_failed" }, { status: 502 }); }
}
