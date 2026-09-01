import { after } from "next/server";

import { parseServerEnv } from "@/lib/env";
import { getOrCreateCoastPhotonRuntime } from "@/lib/photon/runtime";
import { consumeAdvancedNativePollVotes } from "@/lib/photon/poll-gateway";
import {
  authorizeInternalRequest,
  privateJson,
} from "@/lib/security/internal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const LISTENER_DURATION_MS = 9 * 60 * 1_000;
const LISTENER_KEY = Symbol.for("coast.photon.poll-gateway");

type GatewayLease = {
  expiresAtMs: number;
  promise: Promise<void>;
};

type GatewayGlobal = typeof globalThis & {
  [LISTENER_KEY]?: GatewayLease;
};

export async function POST(request: Request): Promise<Response> {
  try {
    parseServerEnv();
  } catch {
    return privateJson({ error: "gateway_not_configured" }, { status: 503 });
  }
  if (!authorizeInternalRequest(request)) {
    return privateJson({ error: "unauthorized" }, { status: 401 });
  }

  const target = globalThis as GatewayGlobal;
  const nowMs = Date.now();
  if (target[LISTENER_KEY] && target[LISTENER_KEY].expiresAtMs > nowMs) {
    return privateJson({ status: "already_listening" }, { status: 202 });
  }

  try {
    const messaging = getOrCreateCoastPhotonRuntime();
    await messaging.bot.initialize();
    if (!messaging.adapter.app) {
      return privateJson({ error: "gateway_unavailable" }, { status: 503 });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LISTENER_DURATION_MS);
    const promise = consumeAdvancedNativePollVotes({
      adapter: messaging.adapter,
      application: messaging.application,
      signal: controller.signal,
      state: messaging.state,
    })
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timeout);
        if (target[LISTENER_KEY]?.promise === promise) {
          delete target[LISTENER_KEY];
        }
      });
    target[LISTENER_KEY] = {
      expiresAtMs: nowMs + LISTENER_DURATION_MS,
      promise,
    };
    after(() => promise);
    return privateJson({ status: "listening" }, { status: 202 });
  } catch {
    return privateJson({ error: "gateway_start_failed" }, { status: 503 });
  }
}
