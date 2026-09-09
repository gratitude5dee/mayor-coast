import { api } from "../../../../../../../convex/_generated/api";
import type { Id } from "../../../../../../../convex/_generated/dataModel";
import { adminError, adminRequest } from "@/lib/admin-route";
import { privateJson } from "@/lib/security/internal-auth";
import { z } from "zod";

const section = z.enum(["interactions", "jobs", "payments"]);
const relation = z.enum(["messages", "deliveries", "ledger", "paymentEvents"]);
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ recordId: string }> }) {
  try {
    const admin = await adminRequest();
    if (!admin) return privateJson({ error: "Sign in required" }, { status: 401 });
    const { recordId } = await context.params;
    const url = new URL(request.url);
    const userId = z.string().min(1).max(128).parse(url.searchParams.get("userId")) as Id<"coastUsers">;
    const result = await admin.client.query(api.admin.related, {
      serviceSecret: admin.env.convexServiceSecret, userId, recordId: z.string().min(1).max(128).parse(recordId),
      section: section.parse(url.searchParams.get("section")), relation: relation.parse(url.searchParams.get("relation")),
      paginationOpts: { numItems: 25, cursor: url.searchParams.get("cursor") },
    });
    return privateJson({ ...result, updatedAt: Date.now() });
  } catch (error) { return adminError(error, "Related records unavailable"); }
}
