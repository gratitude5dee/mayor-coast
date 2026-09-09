import { api } from "../../../../../convex/_generated/api";
import { adminError, adminRequest } from "@/lib/admin-route";
import { privateJson } from "@/lib/security/internal-auth";
import { z } from "zod";
import type { Id } from "../../../../../convex/_generated/dataModel";
const sections = z.enum(["jobs", "interactions", "messages", "usage", "payments", "paymentEvents", "balances", "ledger", "link", "deliveries"]);
const optionalId = z.string().min(1).max(128).optional();
const optionalMs = z.coerce.number().int().min(0).optional();
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const admin = await adminRequest();
    if (!admin) return privateJson({ error: "Sign in required" }, { status: 401 });
    const url = new URL(request.url);
    const section = sections.parse(url.searchParams.get("section") ?? "jobs");
    const userId = optionalId.parse(url.searchParams.get("userId") ?? undefined);
    const threadId = optionalId.parse(url.searchParams.get("threadId") ?? undefined);
    const fromMs = optionalMs.parse(url.searchParams.get("fromMs") ?? undefined);
    const toMs = optionalMs.parse(url.searchParams.get("toMs") ?? undefined);
    const result = await admin.client.query(api.admin.records, {
      serviceSecret: admin.env.convexServiceSecret,
      section,
      ...(userId ? { userId: userId as Id<"coastUsers"> } : {}),
      ...(threadId ? { threadId: threadId as Id<"coastThreads"> } : {}),
      ...(fromMs === undefined ? {} : { fromMs }),
      ...(toMs === undefined ? {} : { toMs }),
      ...(url.searchParams.get("status") ? { status: z.string().min(1).max(80).parse(url.searchParams.get("status")) } : {}),
      paginationOpts: { numItems: 25, cursor: url.searchParams.get("cursor") },
    });
    return privateJson({ ...result, updatedAt: Date.now() });
  } catch (error) { return adminError(error, "Records unavailable"); }
}
