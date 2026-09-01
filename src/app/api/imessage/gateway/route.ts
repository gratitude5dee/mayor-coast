import { parseServerEnv } from "@/lib/env";
import { getOrCreateCoastPhotonRuntime } from "@/lib/photon/runtime";
import { consumeAdvancedNativePollVotes } from "@/lib/photon/poll-gateway";
import {
  authorizeInternalRequest,
  privateJson,
} from "@/lib/security/internal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  try {
    parseServerEnv();
  } catch {
    return privateJson({ error: "gateway_not_configured" }, { status: 503 });
  }
  if (!authorizeInternalRequest(request)) {
    return privateJson({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const messaging = getOrCreateCoastPhotonRuntime();
    await messaging.bot.initialize();
    if (!messaging.adapter.app) {
      return privateJson({ error: "gateway_unavailable" }, { status: 503 });
    }

    await consumeAdvancedNativePollVotes({
      adapter: messaging.adapter,
      application: messaging.application,
      // Photon keeps native poll changes in its durable event backlog. A
      // bounded catch-up per invocation is reliable on serverless; a process
      // held open with after() can miss votes when Vercel freezes or replaces
      // that invocation.
      catchUpOnly: true,
      signal: AbortSignal.timeout(50_000),
      state: messaging.state,
    });
    return privateJson({ status: "caught_up" }, { status: 202 });
  } catch {
    return privateJson({ error: "gateway_catch_up_failed" }, { status: 503 });
  }
}
