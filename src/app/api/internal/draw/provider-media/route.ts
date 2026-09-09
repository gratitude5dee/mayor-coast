import { get as getPrivateBlob } from "@vercel/blob";
import { api } from "../../../../../../convex/_generated/api";
import { getConvexHttpClient } from "@/lib/convex";
import { parseServerEnv } from "@/lib/env";
import { verifyDrawProviderMediaSignature } from "@/lib/draw/provider-media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fal can fetch this one-use scoped download URL. It intentionally does not
// use COAST's internal bearer auth because providers cannot send that header.
export async function GET(request: Request): Promise<Response> {
  try {
    const env = parseServerEnv();
    const url = new URL(request.url);
    const jobId = url.searchParams.get("job");
    const mediaId = url.searchParams.get("media");
    const expiresAtMs = Number(url.searchParams.get("expires"));
    const signature = url.searchParams.get("sig");
    if (!jobId || !mediaId || !signature || !Number.isSafeInteger(expiresAtMs) || expiresAtMs < Date.now() || expiresAtMs > Date.now() + 16 * 60_000 || !verifyDrawProviderMediaSignature(env.convexServiceSecret, jobId, mediaId, expiresAtMs, signature)) {
      return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const media = await getConvexHttpClient(env.CONVEX_URL).action((api.service as any).getCreativeProviderInput, {
      serviceSecret: env.convexServiceSecret,
      jobId: jobId as never,
      mediaId: mediaId as never,
      nowMs: Date.now(),
    });
    if (!media) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (!blobToken) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
    const stored = await getPrivateBlob(media.sourceUrl, {
      access: "private",
      token: blobToken,
      useCache: false,
    });
    if (!stored) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
    return new Response(stored.stream, {
      headers: {
        "content-type": media.mimeType,
        "cache-control": "no-store, private",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  }
}
