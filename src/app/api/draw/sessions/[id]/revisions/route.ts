import { getConvexHttpClient } from "@/lib/convex";
import { api } from "../../../../../../../convex/_generated/api";
import { drawBrowserToken } from "@/lib/draw/auth";
import { parseServerEnv } from "@/lib/env";
import { privateJson } from "@/lib/security/internal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const env = parseServerEnv();
    const { id } = await params;
    const auth = await drawBrowserToken(id);
    if (!auth) return privateJson({ error: "unauthorized" }, { status: 401 });
    const rawCursor = Number(new URL(request.url).searchParams.get("cursor"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getConvexHttpClient(env.CONVEX_URL).action((api.service as any).listDrawRevisions, {
      serviceSecret: env.convexServiceSecret, sessionId: auth.id, browserTokenHash: auth.hash,
      ...(Number.isSafeInteger(rawCursor) && rawCursor >= 0 ? { cursor: rawCursor } : {}), nowMs: Date.now(),
    });
    if (!result) return privateJson({ error: "session_expired" }, { status: 410 });
    return privateJson(result);
  } catch { return privateJson({ error: "revisions_unavailable" }, { status: 503 }); }
}
