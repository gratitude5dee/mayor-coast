import { httpRouter } from "convex/server";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const FIVE_MINUTES_MS = 5 * 60 * 1_000;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authenticate(request: Request, rawBody: string): Promise<boolean> {
  const secret = process.env.COAST_CONVEX_SERVICE_SECRET;
  const timestampHeader = request.headers.get("x-coast-timestamp");
  const signatureHeader = request.headers.get("x-coast-signature");
  if (!secret || !timestampHeader || !signatureHeader) return false;
  const timestampMs = Number(timestampHeader);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > FIVE_MINUTES_MS) {
    return false;
  }
  const expected = await hmacHex(secret, `${timestampHeader}.${rawBody}`);
  const supplied = signatureHeader.startsWith("v1=") ? signatureHeader.slice(3) : signatureHeader;
  return constantTimeEqual(expected, supplied);
}

const inbound = httpAction(async (ctx, request) => {
  const rawBody = await request.text();
  if (!(await authenticate(request, rawBody))) return json({ error: "unauthorized" }, 401);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const requiredStrings = [
    "webhookId",
    "providerMessageId",
    "senderHash",
    "threadKeyHash",
    "encryptedThreadRef",
    "text",
  ] as const;
  if (requiredStrings.some((field) => typeof body[field] !== "string")) {
    return json({ error: "invalid_payload" }, 400);
  }
  const receivedAtMs = typeof body.receivedAtMs === "number" ? body.receivedAtMs : Date.now();
  const result = await ctx.runMutation(internal.inbound.claimDelivery, {
    webhookId: body.webhookId as string,
    providerMessageId: body.providerMessageId as string,
    senderHash: body.senderHash as string,
    threadKeyHash: body.threadKeyHash as string,
    encryptedThreadRef: body.encryptedThreadRef as string,
    text: body.text as string,
    receivedAtMs,
  });
  return json(result);
});

const acknowledgement = httpAction(async (ctx, request) => {
  const rawBody = await request.text();
  if (!(await authenticate(request, rawBody))) return json({ error: "unauthorized" }, 401);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (typeof body.webhookId !== "string" || typeof body.providerMessageId !== "string") {
    return json({ error: "invalid_payload" }, 400);
  }
  await ctx.runMutation(internal.inbound.recordAcknowledgement, {
    webhookId: body.webhookId,
    providerMessageId: body.providerMessageId,
    reactionSent: body.reactionSent === true,
    readSent: body.readSent === true,
    typingStarted: body.typingStarted === true,
    recordedAtMs: typeof body.recordedAtMs === "number" ? body.recordedAtMs : Date.now(),
  });
  return json({ ok: true });
});

const http = httpRouter();
http.route({ path: "/coast/v1/inbound", method: "POST", handler: inbound });
http.route({ path: "/coast/v1/ack", method: "POST", handler: acknowledgement });

export default http;
