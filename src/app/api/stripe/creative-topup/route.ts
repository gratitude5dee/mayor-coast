import { z } from "zod";

import { api } from "../../../../../convex/_generated/api";
import { getConvexHttpClient } from "@/lib/convex";
import { parseServerEnv } from "@/lib/env";
import { privateJson } from "@/lib/security/internal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inputSchema = z.object({ orderId: z.string().regex(/^ct_[a-zA-Z0-9_-]{8,100}$/) }).strict();

/** Creates only COAST's fixed $9.99 / $10 credit Checkout session. */
export async function POST(request: Request): Promise<Response> {
  let input: z.infer<typeof inputSchema>;
  try { input = inputSchema.parse(await request.json()); } catch { return privateJson({ error: "invalid_request" }, { status: 400 }); }
  return createSession(input.orderId);
}

export async function GET(request: Request): Promise<Response> {
  const orderId = new URL(request.url).searchParams.get("order_id");
  const parsed = inputSchema.safeParse({ orderId });
  if (!parsed.success) return privateJson({ error: "invalid_request" }, { status: 400 });
  const result = await createSession(parsed.data.orderId);
  if (result.status >= 300 && result.status < 400) return result;
  return result;
}

async function createSession(orderId: string): Promise<Response> {
  const secret = process.env.STRIPE_SECRET_KEY;
  const origin = process.env.COAST_PUBLIC_URL;
  if (!secret || !origin) return privateJson({ error: "checkout_not_configured" }, { status: 503 });
  let env;
  try { env = parseServerEnv(); } catch { return privateJson({ error: "checkout_not_configured" }, { status: 503 }); }
  const order = await getConvexHttpClient(env.CONVEX_URL).action(api.service.getCreativeTopup, {
    serviceSecret: env.convexServiceSecret,
    orderId,
  });
  if (order === null || order.chargeCents !== 999 || order.creditCents !== 1000 || order.status === "succeeded") {
    return privateJson({ error: "unknown_or_settled_order" }, { status: 404 });
  }
  const body = new URLSearchParams({
    mode: "payment",
    success_url: `${origin}/api/stripe/creative-topup/status?order_id=${encodeURIComponent(orderId)}`,
    cancel_url: `${origin}/api/stripe/creative-topup/status?order_id=${encodeURIComponent(orderId)}&cancelled=1`,
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][product_data][name]": "COAST generation credit",
    "line_items[0][price_data][product_data][description]": "$10 of image/video generation credit",
    "line_items[0][price_data][unit_amount]": "999",
    "line_items[0][quantity]": "1",
    "payment_method_types[0]": "card",
    "payment_method_types[1]": "link",
    "metadata[coast_order_id]": orderId,
  });
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": `coast-topup-${orderId}`,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return privateJson({ error: "checkout_unavailable" }, { status: 502 });
  const session = await response.json() as { url?: unknown };
  if (typeof session.url !== "string") return privateJson({ error: "checkout_missing_url" }, { status: 502 });
  return Response.redirect(session.url, 303);
}
