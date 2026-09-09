/* eslint-disable @typescript-eslint/no-explicit-any */
import { api } from "../../../../../../../../../convex/_generated/api";
import { getConvexHttpClient } from "@/lib/convex";
import { drawBrowserToken } from "@/lib/draw/auth";
import { isSameOriginMutation } from "@/lib/draw/request";
import { parseServerEnv } from "@/lib/env";
import { privateJson } from "@/lib/security/internal-auth";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; jobId: string }> }): Promise<Response> {
  try {
    if (!isSameOriginMutation(request)) return privateJson({ error: "cross_origin_request" }, { status: 403 });
    const env = parseServerEnv();
    const { id, jobId } = await params;
    const auth = await drawBrowserToken(id);
    if (!auth) return privateJson({ error: "unauthorized" }, { status: 401 });
    const cancelled = await getConvexHttpClient(env.CONVEX_URL).action((api.service as any).cancelDrawJob, {
      serviceSecret: env.convexServiceSecret,
      sessionId: auth.id,
      browserTokenHash: auth.hash,
      jobId,
      nowMs: Date.now(),
    });
    return cancelled ? privateJson({ ok: true }) : privateJson({ error: "not_cancellable" }, { status: 409 });
  } catch {
    return privateJson({ error: "cancel_failed" }, { status: 400 });
  }
}
