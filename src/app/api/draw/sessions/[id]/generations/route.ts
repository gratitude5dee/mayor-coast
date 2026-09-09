import { z } from "zod";
import { getConvexHttpClient } from "@/lib/convex";
import { api } from "../../../../../../../convex/_generated/api";
import { parseServerEnv } from "@/lib/env";
import { drawBrowserToken } from "@/lib/draw/auth";
import { encryptCreativePayload } from "@/lib/security/identity";
import { privateJson } from "@/lib/security/internal-auth";
import { DrawModeSchema } from "@/lib/draw/provider";
import { isSameOriginMutation } from "@/lib/draw/request";

export const runtime = "nodejs";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isSameOriginMutation(request)) return privateJson({ error: "cross_origin_request" }, { status: 403 });
    const env = parseServerEnv(); const { id } = await params; const auth = await drawBrowserToken(id); if (!auth) return privateJson({ error: "unauthorized" }, { status: 401 });
    const body = z.object({ requestKey: z.string().uuid(), prompt: z.string().trim().max(2_000), mediaId: z.string().optional(), inputCategory: z.enum(["prompt", "sketch", "photo", "result"]).optional(), mode: DrawModeSchema.default("fast") }).parse(await request.json());
    if (!body.prompt && !body.mediaId) return privateJson({ error: "prompt_or_sketch_required" }, { status: 422 });
    const encryptedPayload = encryptCreativePayload(JSON.stringify({ prompt: body.prompt, inputMediaId: body.mediaId, mode: body.mode, ...(body.inputCategory ? { inputCategory: body.inputCategory } : {}) }), env.convexServiceSecret);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getConvexHttpClient(env.CONVEX_URL).action((api.service as any).admitDrawGeneration, { serviceSecret: env.convexServiceSecret, sessionId: id as never, browserTokenHash: auth.hash, requestKey: body.requestKey, encryptedPayload, prompt: body.prompt, mode: body.mode, ...(body.mediaId ? { inputMediaId: body.mediaId as never } : {}), ...(body.inputCategory ? { inputCategory: body.inputCategory } : {}), nowMs: Date.now() });
    return privateJson({ jobId: result.jobId, state: result.state, source: result.source, amountCents: result.amountCents });
  } catch (error) { return privateJson({ error: error instanceof Error ? error.message.slice(0, 80) : "generation_failed" }, { status: 400 }); }
}
