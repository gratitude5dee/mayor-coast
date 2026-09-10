import { getConvexHttpClient } from "@/lib/convex";
import { api } from "../../../../../../../../convex/_generated/api";
import { drawBrowserToken } from "@/lib/draw/auth";
import { parseServerEnv } from "@/lib/env";
import { decryptCreativePayload } from "@/lib/security/identity";
import { privateJson } from "@/lib/security/internal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function instructionFrom(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const direct = "prompt" in payload && typeof payload.prompt === "string" ? payload.prompt : null;
  const messages = "messages" in payload && Array.isArray(payload.messages) ? payload.messages : [];
  const message = [...messages].reverse().find((item): item is { text?: unknown } => Boolean(item) && typeof item === "object" && "text" in item && typeof item.text === "string")?.text;
  const source = direct ?? (typeof message === "string" ? message : "");
  return source.replace(/^\s*\/(?:edit|draw)\b/iu, "").trim().slice(0, 2_000);
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; jobId: string }> }) {
  try {
    const env = parseServerEnv(); const { id, jobId } = await params; const auth = await drawBrowserToken(id);
    if (!auth) return privateJson({ error: "unauthorized" }, { status: 401 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getConvexHttpClient(env.CONVEX_URL).action((api.service as any).getDrawRevisionInstruction, {
      serviceSecret: env.convexServiceSecret, sessionId: auth.id, browserTokenHash: auth.hash, jobId: jobId as never, nowMs: Date.now(),
    }) as { encryptedPayload: string } | null;
    if (!result) return privateJson({ error: "revision_unavailable" }, { status: 404 });
    const payload = JSON.parse(decryptCreativePayload(result.encryptedPayload, env.convexServiceSecret));
    return privateJson({ instruction: instructionFrom(payload) });
  } catch { return privateJson({ error: "revision_unavailable" }, { status: 503 }); }
}
