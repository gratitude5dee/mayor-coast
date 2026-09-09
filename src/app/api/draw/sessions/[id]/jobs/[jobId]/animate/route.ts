import { z } from "zod";
import { api } from "../../../../../../../../../convex/_generated/api";
import { getConvexHttpClient } from "@/lib/convex";
import { drawBrowserToken } from "@/lib/draw/auth";
import { isSameOriginMutation } from "@/lib/draw/request";
import { parseServerEnv } from "@/lib/env";
import { encryptCreativePayload } from "@/lib/security/identity";
import { privateJson } from "@/lib/security/internal-auth";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; jobId: string }> }) {
  try {
    if (!isSameOriginMutation(request)) return privateJson({ error: "cross_origin_request" }, { status: 403 });
    const env = parseServerEnv();
    const { id, jobId } = await params;
    const auth = await drawBrowserToken(id);
    if (!auth) return privateJson({ error: "unauthorized" }, { status: 401 });
    const body = z.object({ requestKey: z.string().uuid(), motionPrompt: z.string().trim().max(1_000).optional() }).parse(await request.json());
    const motion = body.motionPrompt || "Natural cinematic motion while preserving the original composition.";
    const encryptedPayload = encryptCreativePayload(JSON.stringify({
      messages: [{ text: `/zap ${motion}`, sentAtMs: Date.now(), attachments: [] }],
    }), env.convexServiceSecret);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getConvexHttpClient(env.CONVEX_URL).action((api.service as any).animateDrawJob, {
      serviceSecret: env.convexServiceSecret,
      sessionId: auth.id,
      browserTokenHash: auth.hash,
      jobId: jobId as never,
      requestKey: body.requestKey,
      encryptedPayload,
      nowMs: Date.now(),
    });
    return privateJson(result);
  } catch (error) {
    return privateJson({ error: error instanceof Error ? error.message.slice(0, 80) : "animate_failed" }, { status: 400 });
  }
}
