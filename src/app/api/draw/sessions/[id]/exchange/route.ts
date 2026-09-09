import { z } from "zod";
import { getConvexHttpClient } from "@/lib/convex";
import { api } from "../../../../../../../convex/_generated/api";
import { parseServerEnv } from "@/lib/env";
import { drawCookieName, drawBrowserToken } from "@/lib/draw/auth";
import { drawSessionCookie } from "@/lib/draw/launch";
import { privateJson } from "@/lib/security/internal-auth";
import { isSameOriginMutation } from "@/lib/draw/request";

export const runtime = "nodejs";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isSameOriginMutation(request)) return privateJson({ error: "cross_origin_request" }, { status: 403 });
    const env = parseServerEnv(); const { id } = await params;
    const existing = await drawBrowserToken(id);
    if (existing) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = await getConvexHttpClient(env.CONVEX_URL).action((api.service as any).getDrawSession, {
        serviceSecret: env.convexServiceSecret, sessionId: existing.id,
        browserTokenHash: existing.hash, nowMs: Date.now(),
      });
      if (session) return privateJson({ ok: true, expiresAtMs: session.expiresAtMs });
    }
    const body = z.object({ secret: z.string().min(20).max(256) }).parse(await request.json());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getConvexHttpClient(env.CONVEX_URL).action((api.service as any).exchangeDrawSession, { serviceSecret: env.convexServiceSecret, sessionId: id as never, launchSecret: body.secret, nowMs: Date.now() });
    if (!result) return privateJson({ error: "invalid_or_expired_session" }, { status: 401 });
    const response = privateJson({ ok: true, expiresAtMs: result.expiresAtMs });
    response.headers.append("set-cookie", drawSessionCookie(drawCookieName(id), result.browserToken, (result.expiresAtMs - Date.now()) / 1_000));
    return response;
  } catch { return privateJson({ error: "invalid_request" }, { status: 400 }); }
}
