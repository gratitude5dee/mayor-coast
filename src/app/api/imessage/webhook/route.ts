import { after } from "next/server";

import { getOrCreateCoastPhotonRuntime } from "@/lib/photon/runtime";
import {
  handleVerifiedNativePollVote,
  parseNativePollVoteWebhook,
} from "@/lib/photon/poll-webhook";
import { handlePhotonWebhook } from "@/lib/photon/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  let messaging;
  try {
    messaging = getOrCreateCoastPhotonRuntime();
  } catch {
    return new Response("Messaging runtime unavailable", { status: 503 });
  }

  return handlePhotonWebhook(request, {
    dispatch: async (forwarded, options) => {
      // Keep a private copy solely long enough to recognize a selected native
      // poll after the adapter validates the exact webhook signature. The
      // adapter's modal registry is process-local, whereas poll state lives in
      // Convex and must work across Vercel cold starts.
      const payloadCopy = forwarded.clone();
      const response = await messaging.bot.webhooks.imessage(forwarded, options);
      if (!response.ok) return response;

      try {
        const vote = parseNativePollVoteWebhook(
          await payloadCopy.json(),
          messaging.adapter,
        );
        if (vote !== null) {
          await handleVerifiedNativePollVote({
            adapter: messaging.adapter,
            application: messaging.application,
            vote,
          });
        }
      } catch {
        // A selected poll is durable user input. Returning a failure lets
        // Spectrum retry rather than silently losing it.
        return new Response("Durable poll intake unavailable", { status: 503 });
      }
      return response;
    },
    defer: (task) => after(() => task),
  });
}
