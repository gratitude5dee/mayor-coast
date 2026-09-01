import { v } from "convex/values";

import { internalAction } from "./_generated/server";

/**
 * Keeps the authenticated Spectrum live stream warm for native poll changes.
 * Text messages still arrive through the signed Photon webhook; this companion
 * stream exists only because current cloud webhooks omit poll-change content.
 */
export const maintain = internalAction({
  args: {},
  returns: v.null(),
  handler: async () => {
    const deliveryUrl = process.env.COAST_DELIVERY_URL;
    const serviceSecret = process.env.COAST_CONVEX_SERVICE_SECRET;
    if (!deliveryUrl || !serviceSecret) return null;

    const gatewayUrl = new URL("/api/imessage/gateway", deliveryUrl);
    if (gatewayUrl.protocol !== "https:") return null;

    try {
      await fetch(gatewayUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${serviceSecret}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // The next bounded cron tick retries. No user content or secret is logged.
    }
    return null;
  },
});
