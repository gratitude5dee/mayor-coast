import { createHmac, timingSafeEqual } from "node:crypto";

import { api } from "../../../../../convex/_generated/api";
import { getConvexHttpClient } from "@/lib/convex";
import { parseServerEnv } from "@/lib/env";
import { privateJson } from "@/lib/security/internal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return privateJson({ error: "webhook_not_configured" }, { status: 503 });
  const raw = await request.text();
  const signature = request.headers.get("stripe-signature") ?? "";
  if (!verifyStripeSignature(raw, signature, secret)) return privateJson({ error: "invalid_signature" }, { status: 400 });
  let event: {
    id?: unknown;
    type?: unknown;
    data?: { object?: { id?: unknown; metadata?: { coast_order_id?: unknown }; amount_total?: unknown; currency?: unknown; payment_status?: unknown } };
  };
  try { event = JSON.parse(raw) as typeof event; } catch { return privateJson({ error: "invalid_event" }, { status: 400 }); }
  if (event.type !== "checkout.session.completed" && event.type !== "charge.refunded" && event.type !== "charge.dispute.created") return privateJson({ received: true });
  const orderId = event.data?.object?.metadata?.coast_order_id;
  const paymentIdentity = event.data?.object?.id;
  const amount = event.data?.object?.amount_total;
  const currency = event.data?.object?.currency;
  const paymentStatus = event.data?.object?.payment_status;
  if (typeof event.id !== "string" || typeof orderId !== "string" || typeof paymentIdentity !== "string") {
    return privateJson({ error: "payment_validation_failed" }, { status: 422 });
  }
  let env;
  try { env = parseServerEnv(); } catch { return privateJson({ error: "webhook_not_configured" }, { status: 503 }); }
  if (event.type === "checkout.session.completed") {
    if (amount !== 999 || currency !== "usd" || paymentStatus !== "paid") return privateJson({ error: "payment_validation_failed" }, { status: 422 });
    await getConvexHttpClient(env.CONVEX_URL).action(api.service.settleCreativeTopup, {
      serviceSecret: env.convexServiceSecret,
      orderId,
      eventId: event.id,
      paymentIdentity,
      nowMs: Date.now(),
    });
  } else {
    await getConvexHttpClient(env.CONVEX_URL).action(api.service.reverseCreativeTopup, {
      serviceSecret: env.convexServiceSecret,
      orderId,
      eventId: event.id,
      paymentIdentity,
      nowMs: Date.now(),
    });
  }
  return privateJson({ received: true });
}

function verifyStripeSignature(payload: string, header: string, secret: string): boolean {
  const fields = new Map(header.split(",").map((part) => part.split("=", 2) as [string, string]));
  const timestamp = fields.get("t");
  const signature = fields.get("v1");
  if (!timestamp || !signature || !/^\d+$/u.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1_000 - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(signature, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
