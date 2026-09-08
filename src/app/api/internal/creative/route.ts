import { z } from "zod";
import { put } from "@vercel/blob";

import {
  buildProviderRequest,
  parseCreativeRequest,
  validateAttachmentSizes,
  type CreativeAttachment,
} from "@/lib/creative";
import { decryptCreativePayload } from "@/lib/security/identity";
import { authorizeInternalRequest, privateJson } from "@/lib/security/internal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 25;

const requestSchema = z.object({
  command: z.enum(["imagine", "zap"]),
  encryptedPayload: z.string().min(24).max(90_000),
}).strict();

export async function POST(request: Request): Promise<Response> {
  if (!authorizeInternalRequest(request)) return privateJson({ error: "unauthorized" }, { status: 401 });
  const secret = process.env.COAST_CONVEX_SERVICE_SECRET;
  if (!secret) return privateJson({ error: "creative_not_configured" }, { status: 503 });
  let input: z.infer<typeof requestSchema>;
  try { input = requestSchema.parse(await request.json()); } catch { return privateJson({ error: "invalid_request" }, { status: 400 }); }
  try {
    const decrypted = decryptCreativePayload(input.encryptedPayload, secret);
    const envelope = JSON.parse(decrypted) as {
      messages?: Array<{
        text?: unknown;
        sentAtMs?: unknown;
        attachments?: Array<{
          id?: unknown;
          type?: unknown;
          mimeType?: unknown;
          size?: unknown;
          url?: unknown;
        }>;
      }>;
    };
    const messages = Array.isArray(envelope.messages) ? envelope.messages : [];
    const text = messages.map((message) => (typeof message.text === "string" ? message.text : "")).join("\n");
    const attachments: CreativeAttachment[] = [];
    const seen = new Set<string>();
    for (const message of messages) {
      for (const attachment of message.attachments ?? []) {
        const type = attachment.type;
        if (type !== "image" && type !== "video" && type !== "audio") {
          return privateJson({ error: "unsupported_attachment" }, { status: 422 });
        }
        const id = typeof attachment.id === "string" ? attachment.id : "unknown";
        if (seen.has(id)) continue;
        seen.add(id);
        attachments.push({
          id,
          kind: type,
          mimeType: typeof attachment.mimeType === "string" ? attachment.mimeType : "application/octet-stream",
          byteLength: typeof attachment.size === "number" && Number.isFinite(attachment.size) ? attachment.size : 0,
          ...(typeof attachment.url === "string" ? { sourceUrl: attachment.url } : {}),
        });
      }
    }
    const sizeError = validateAttachmentSizes(attachments);
    if (sizeError) return privateJson({ error: sizeError }, { status: 422 });
    if (attachments.some((attachment) => attachment.sourceUrl === undefined)) {
      return privateJson({ error: "attachment_reference_missing" }, { status: 422 });
    }
    for (const attachment of attachments) {
      try {
        if (!attachment.sourceUrl || new URL(attachment.sourceUrl).protocol !== "https:") {
          return privateJson({ error: "attachment_reference_invalid" }, { status: 422 });
        }
      } catch {
        return privateJson({ error: "attachment_reference_invalid" }, { status: 422 });
      }
    }
    const parsed = parseCreativeRequest(text, attachments);
    if ("error" in parsed || parsed.command !== input.command) return privateJson({ error: "invalid_creative_payload" }, { status: 422 });
    const provider = buildProviderRequest({ ...parsed, prompt: await compileCreativePrompt(parsed.prompt, parsed.command) });
    const result = provider.provider === "fal"
      ? await submitFal(provider.model, provider.input)
      : await submitGmi(provider.model, provider.input);
    return privateJson(await materializePrivateMedia(result, parsed.command));
  } catch (error) {
    return privateJson({ error: error instanceof Error ? error.message.slice(0, 120) : "creative_provider_failed" }, { status: 502 });
  }
}

async function materializePrivateMedia(
  result: { url: string; mimeType: string; filename: string; caption: string },
  command: "imagine" | "zap",
): Promise<typeof result> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error("CREATIVE_BLOB_NOT_CONFIGURED");
  const response = await fetch(result.url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("CREATIVE_PROVIDER_MEDIA_UNAVAILABLE");
  const bytes = Buffer.from(await response.arrayBuffer());
  const limit = command === "imagine" ? 40 * 1024 * 1024 : 40 * 1024 * 1024;
  if (bytes.byteLength > limit) throw new Error("CREATIVE_MEDIA_TOO_LARGE");
  const blob = await put(`coast/creative/${crypto.randomUUID()}-${result.filename}`, bytes, {
    access: "private",
    token,
    addRandomSuffix: false,
    contentType: result.mimeType,
  });
  return { ...result, url: blob.url };
}

async function compileCreativePrompt(prompt: string, command: "imagine" | "zap"): Promise<string> {
  const fallback = prompt.replace(/[\u0000-\u001f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 1_800);
  const key = process.env.GROQ_API_KEY;
  if (!key || fallback.length === 0) return fallback;
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.GROQ_CREATIVE_MODEL ?? "llama-3.3-70b-versatile",
        temperature: 0,
        max_tokens: 280,
        messages: [
          { role: "system", content: `Rewrite one ${command === "imagine" ? "image" : "15-second video"} prompt. Preserve user intent, add concrete visual direction, and return prompt text only under 1,800 characters.` },
          { role: "user", content: fallback },
        ],
      }),
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return fallback;
    const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const compiled = body.choices?.[0]?.message?.content;
    return typeof compiled === "string" && compiled.trim().length > 0
      ? compiled.replace(/[\u0000-\u001f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 1_800)
      : fallback;
  } catch {
    return fallback;
  }
}

async function submitGmi(model: string, input: Record<string, unknown>) {
  const key = process.env.GMI_CLOUD_API_KEY;
  const url = process.env.GMI_REQUEST_QUEUE_URL;
  if (!key || !url) throw new Error("GMI_NOT_CONFIGURED");
  const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model, ...input }), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`GMI_HTTP_${response.status}`);
  const body = await response.json() as { output?: { url?: string }; url?: string; request_id?: string; id?: string; response_url?: string; status_url?: string };
  const immediate = body.output?.url ?? body.url;
  const result = immediate ? { output: { url: immediate } } : await pollProviderResult(
    body.request_id ?? body.id,
    body.status_url,
    body.response_url,
    key,
    (requestId) => `${url.replace(/\/$/u, "")}/${encodeURIComponent(requestId)}`,
  );
  const urlValue = result.output?.url ?? result.url;
  if (!urlValue) throw new Error("GMI_RESULT_MISSING_URL");
  return { url: urlValue, mimeType: "image/png", filename: "coast-imagine.png", caption: "Here’s your image." };
}

async function submitFal(model: string, input: Record<string, unknown>) {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("FAL_NOT_CONFIGURED");
  const response = await fetch(`https://queue.fal.run/${model}`, { method: "POST", headers: { authorization: `Key ${key}`, "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`FAL_HTTP_${response.status}`);
  const body = await response.json() as { video?: { url?: string }; url?: string; request_id?: string; id?: string; response_url?: string; status_url?: string };
  const immediate = body.video?.url ?? body.url;
  const result = immediate ? { video: { url: immediate } } : await pollProviderResult(
    body.request_id ?? body.id,
    body.status_url,
    body.response_url,
    key,
    (requestId) => `https://queue.fal.run/${model}/requests/${encodeURIComponent(requestId)}`,
    (requestId) => `https://queue.fal.run/${model}/requests/${encodeURIComponent(requestId)}/status`,
  );
  const urlValue = result.video?.url ?? result.url ?? result.output?.video?.url;
  if (!urlValue) throw new Error("FAL_RESULT_MISSING_URL");
  return { url: urlValue, mimeType: "video/mp4", filename: "coast-zap.mp4", caption: "Here’s your 15-second zap." };
}

async function pollProviderResult(
  requestId: string | undefined,
  statusUrl: string | undefined,
  responseUrl: string | undefined,
  key: string,
  resultUrl: (requestId: string) => string,
  statusUrlForRequest?: (requestId: string) => string,
): Promise<{ url?: string; output?: { url?: string; video?: { url?: string } }; video?: { url?: string } }> {
  if (!requestId) throw new Error("PROVIDER_REQUEST_ID_MISSING");
  const statusEndpoint = statusUrl ?? statusUrlForRequest?.(requestId) ?? resultUrl(requestId);
  const resultEndpoint = responseUrl ?? resultUrl(requestId);
  const deadline = Date.now() + 18_000;
  while (Date.now() < deadline) {
    const statusResponse = await fetch(statusEndpoint, {
      headers: { authorization: key.startsWith("sk-") ? `Bearer ${key}` : `Key ${key}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!statusResponse.ok) throw new Error(`PROVIDER_STATUS_HTTP_${statusResponse.status}`);
    const status = await statusResponse.json() as { status?: string };
    if (status.status === "COMPLETED" || status.status === "completed" || status.status === "succeeded") {
      const resultResponse = await fetch(resultEndpoint, {
        headers: { authorization: key.startsWith("sk-") ? `Bearer ${key}` : `Key ${key}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!resultResponse.ok) throw new Error(`PROVIDER_RESULT_HTTP_${resultResponse.status}`);
      return await resultResponse.json() as { url?: string; output?: { url?: string; video?: { url?: string } }; video?: { url?: string } };
    }
    if (status.status === "FAILED" || status.status === "failed") throw new Error("PROVIDER_RENDER_FAILED");
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error("PROVIDER_RENDER_TIMEOUT");
}
