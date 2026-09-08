import { api } from "../../../../../../convex/_generated/api";
import { getConvexHttpClient } from "@/lib/convex";
import { parseServerEnv } from "@/lib/env";
import { privateJson } from "@/lib/security/internal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const orderId = new URL(request.url).searchParams.get("order_id");
  if (!orderId) return privateJson({ error: "missing_order" }, { status: 400 });
  let env;
  try { env = parseServerEnv(); } catch { return privateJson({ error: "status_not_configured" }, { status: 503 }); }
  const order = await getConvexHttpClient(env.CONVEX_URL).action(api.service.getCreativeTopup, {
    serviceSecret: env.convexServiceSecret,
    orderId,
  });
  if (order === null) return privateJson({ error: "unknown_order" }, { status: 404 });
  return privateJson({ status: order.status, message: order.status === "succeeded" ? "Credit added. Return to iMessage to continue." : "Payment is being confirmed. Return to iMessage shortly." });
}
