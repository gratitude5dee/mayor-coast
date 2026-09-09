import sharp from "sharp";

import { parseServerEnv } from "@/lib/env";
import { verifyDrawCanarySketchSignature } from "@/lib/draw/provider-media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Fal needs an HTTPS URL for image-to-image canaries. This signed endpoint
 * emits a deterministic, non-customer sketch and expires in fifteen minutes;
 * it is intentionally not a shortcut to any private user Blob.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const env = parseServerEnv();
    const url = new URL(request.url);
    const expiresAtMs = Number(url.searchParams.get("expires"));
    const signature = url.searchParams.get("sig");
    if (!signature || !Number.isSafeInteger(expiresAtMs) || expiresAtMs < Date.now() || expiresAtMs > Date.now() + 16 * 60_000 || !verifyDrawCanarySketchSignature(env.convexServiceSecret, expiresAtMs, signature)) {
      return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
    }
    const svg = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><rect width="1024" height="1024" fill="white"/><path d="M180 760C300 340 535 220 820 360C650 410 560 580 735 760C520 680 350 805 180 760Z" fill="none" stroke="#111827" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/><circle cx="735" cy="760" r="24" fill="#f4b544"/></svg>`;
    const bytes = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
    return new Response(bytes, { headers: { "content-type": "image/jpeg", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch {
    return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  }
}
