import { createHmac, timingSafeEqual } from "node:crypto";

export function drawProviderMediaSignature(secret: string, jobId: string, mediaId: string, expiresAtMs: number) {
  return createHmac("sha256", secret).update(`${jobId}:${mediaId}:${expiresAtMs}`).digest("base64url");
}

export function verifyDrawProviderMediaSignature(secret: string, jobId: string, mediaId: string, expiresAtMs: number, signature: string) {
  const expected = drawProviderMediaSignature(secret, jobId, mediaId, expiresAtMs);
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export function drawProviderMediaUrl(origin: string, secret: string, jobId: string, mediaId: string, nowMs: number) {
  const expiresAtMs = nowMs + 15 * 60_000;
  const url = new URL("/api/internal/draw/provider-media", origin);
  url.searchParams.set("job", jobId);
  url.searchParams.set("media", mediaId);
  url.searchParams.set("expires", String(expiresAtMs));
  url.searchParams.set("sig", drawProviderMediaSignature(secret, jobId, mediaId, expiresAtMs));
  return url.toString();
}

export function drawCanarySketchSignature(secret: string, expiresAtMs: number) {
  return createHmac("sha256", secret).update(`draw-canary-sketch:${expiresAtMs}`).digest("base64url");
}

export function verifyDrawCanarySketchSignature(secret: string, expiresAtMs: number, signature: string) {
  const expected = drawCanarySketchSignature(secret, expiresAtMs);
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/** A short-lived public fixture URL; it serves no customer data. */
export function drawCanarySketchUrl(origin: string, secret: string, nowMs: number) {
  const expiresAtMs = nowMs + 15 * 60_000;
  const url = new URL("/api/internal/draw/canary-sketch", origin);
  url.searchParams.set("expires", String(expiresAtMs));
  url.searchParams.set("sig", drawCanarySketchSignature(secret, expiresAtMs));
  return url.toString();
}
