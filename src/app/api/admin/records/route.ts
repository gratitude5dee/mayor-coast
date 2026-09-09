import { cookies } from "next/headers";
import { api } from "../../../../../convex/_generated/api";
import { getConvexHttpClient } from "@/lib/convex";
import { parseServerEnv } from "@/lib/env";
import { ADMIN_COOKIE, validAdminSession } from "@/lib/admin-auth";
import { privateJson } from "@/lib/security/internal-auth";
import { z } from "zod";
import type { Id } from "../../../../../convex/_generated/dataModel";
const sections = z.enum(["jobs", "interactions", "messages", "usage", "payments", "paymentEvents", "balances", "ledger", "link", "deliveries"]);
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const env = parseServerEnv();
    if (!validAdminSession((await cookies()).get(ADMIN_COOKIE)?.value, env.convexServiceSecret)) return privateJson({ error: "Sign in required" }, { status: 401 });
    const url = new URL(request.url);
    const section = sections.parse(url.searchParams.get("section") ?? "jobs");
    const userId = z.string().min(1).max(128).optional().parse(url.searchParams.get("userId") ?? undefined);
    const result = await getConvexHttpClient(env.CONVEX_URL).query(api.admin.records, {
      serviceSecret: env.convexServiceSecret,
      section,
      ...(userId === undefined ? {} : { userId: userId as Id<"coastUsers"> }),
      paginationOpts: { numItems: 50, cursor: url.searchParams.get("cursor") },
    });
    return privateJson({ ...result, updatedAt: Date.now() });
  } catch { return privateJson({ error: "Records unavailable" }, { status: 503 }); }
}
