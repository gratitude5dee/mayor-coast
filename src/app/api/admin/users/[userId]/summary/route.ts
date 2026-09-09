import { api } from "../../../../../../../convex/_generated/api";
import type { Id } from "../../../../../../../convex/_generated/dataModel";
import { adminError, adminRequest } from "@/lib/admin-route";
import { adminUserView } from "@/lib/admin-view";
import { privateJson } from "@/lib/security/internal-auth";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    const admin = await adminRequest();
    if (!admin) return privateJson({ error: "Sign in required" }, { status: 401 });
    const { userId } = await context.params;
    const id = z.string().min(1).max(128).parse(userId) as Id<"coastUsers">;
    const summary = await admin.client.query(api.admin.summary, { serviceSecret: admin.env.convexServiceSecret, userId: id, nowMs: Date.now() });
    if (!summary) return privateJson({ error: "That user is unavailable." }, { status: 404 });
    return privateJson({ ...summary, user: adminUserView(summary.user, admin.env.convexServiceSecret), updatedAt: Date.now() });
  } catch (error) { return adminError(error, "Summary unavailable"); }
}
