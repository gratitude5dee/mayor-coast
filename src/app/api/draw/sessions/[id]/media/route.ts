import { put } from "@vercel/blob";
import sharp from "sharp";
import { getConvexHttpClient } from "@/lib/convex";
import { api } from "../../../../../../../convex/_generated/api";
import { parseServerEnv } from "@/lib/env";
import { drawBrowserToken } from "@/lib/draw/auth";
import { privateJson } from "@/lib/security/internal-auth";
import { isSameOriginMutation } from "@/lib/draw/request";

export const runtime = "nodejs";
export const maxDuration = 15;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isSameOriginMutation(request)) return privateJson({ error: "cross_origin_request" }, { status: 403 });
    const env = parseServerEnv(); const { id } = await params; const auth = await drawBrowserToken(id); if (!auth) return privateJson({ error: "unauthorized" }, { status: 401 });
    const bytes = Buffer.from(await request.arrayBuffer()); if (bytes.byteLength > 3 * 1024 * 1024) return privateJson({ error: "image_too_large" }, { status: 413 });
    const image = sharp(bytes); const metadata = await image.metadata(); if (!metadata.width || !metadata.height || !["jpeg", "png", "webp"].includes(metadata.format ?? "")) return privateJson({ error: "invalid_image" }, { status: 422 });
    const normalized = await image.png().toBuffer(); const token = process.env.BLOB_READ_WRITE_TOKEN; if (!token) return privateJson({ error: "storage_not_configured" }, { status: 503 });
    const blob = await put(`coast/draw/${crypto.randomUUID()}.png`, normalized, { access: "private", token, addRandomSuffix: false, contentType: "image/png" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mediaId = await getConvexHttpClient(env.CONVEX_URL).action((api.service as any).createDrawMedia, { serviceSecret: env.convexServiceSecret, sessionId: auth.id, browserTokenHash: auth.hash, sourceUrl: blob.url, mimeType: "image/png", filename: "coast-draw.png", byteLength: normalized.byteLength, width: metadata.width, height: metadata.height, nowMs: Date.now() });
    if (!mediaId) return privateJson({ error: "session_expired" }, { status: 401 }); return privateJson({ mediaId });
  } catch { return privateJson({ error: "invalid_image" }, { status: 422 }); }
}
