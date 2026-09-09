/* eslint-disable @typescript-eslint/no-explicit-any */
import { api } from "../../../../../../../convex/_generated/api";
import { getConvexHttpClient } from "@/lib/convex";
import { drawBrowserToken } from "@/lib/draw/auth";
import { parseServerEnv } from "@/lib/env";
import { privateJson } from "@/lib/security/internal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type DrawEvent = {
  jobId: string;
  sequence: number;
  kind: string;
  state: string;
  mediaId: string | null;
  previewIndex: number | null;
  errorCode: string | null;
};

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const env = parseServerEnv();
    const { id } = await params;
    const auth = await drawBrowserToken(id);
    if (!auth) return privateJson({ error: "unauthorized" }, { status: 401 });
    const url = new URL(request.url);
    const cursor = request.headers.get("last-event-id") ?? url.searchParams.get("after") ?? "0";
    let afterSequence = Number.isSafeInteger(Number(cursor)) ? Math.max(0, Number(cursor)) : 0;
    const convex = getConvexHttpClient(env.CONVEX_URL);
    const encoder = new TextEncoder();
    const startedAt = Date.now();
    let cancelled = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        request.signal.addEventListener("abort", () => { cancelled = true; }, { once: true });
        try {
          while (!cancelled && Date.now() - startedAt < 55_000) {
            const result = await convex.action((api.service as any).listDrawEvents, {
              serviceSecret: env.convexServiceSecret,
              sessionId: auth.id,
              browserTokenHash: auth.hash,
              afterSequence,
              nowMs: Date.now(),
            }) as { events: DrawEvent[] } | null;
            if (!result) {
              controller.enqueue(encoder.encode("event: error\ndata: {\"code\":\"session_expired\"}\n\n"));
              break;
            }
            for (const event of result.events) {
              if (event.sequence <= afterSequence) continue;
              afterSequence = event.sequence;
              controller.enqueue(encoder.encode(
                `id: ${event.sequence}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`,
              ));
            }
            if (result.events.length === 0) controller.enqueue(encoder.encode(": keep-alive\n\n"));
            await new Promise((resolve) => setTimeout(resolve, result.events.length > 0 ? 250 : 1_000));
          }
        } catch {
          if (!cancelled) controller.enqueue(encoder.encode("event: error\ndata: {\"code\":\"stream_unavailable\"}\n\n"));
        } finally {
          try { controller.close(); } catch { /* already closed by the client */ }
        }
      },
      cancel() { cancelled = true; },
    });

    return new Response(stream, {
      headers: {
        "cache-control": "no-store, no-cache, must-revalidate",
        "content-type": "text/event-stream; charset=utf-8",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  } catch {
    return privateJson({ error: "events_unavailable" }, { status: 503 });
  }
}
