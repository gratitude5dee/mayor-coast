import { api } from "../../../../../convex/_generated/api";
import { adminError, adminRequest } from "@/lib/admin-route";
import { adminUserView } from "@/lib/admin-view";
import { privateJson } from "@/lib/security/internal-auth";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const statuses = z.enum(["active", "stopped", "forgetting", "forgotten"]);

export async function GET(request: Request) {
  try {
    const admin = await adminRequest();
    if (!admin) return privateJson({ error: "Sign in required" }, { status: 401 });
    const url = new URL(request.url);
    const status = statuses.optional().parse(url.searchParams.get("status") ?? undefined);
    const result = await admin.client.query(api.admin.directory, {
      serviceSecret: admin.env.convexServiceSecret,
      ...(status ? { status } : {}),
      paginationOpts: { numItems: 25, cursor: url.searchParams.get("cursor") },
    });
    return privateJson({ ...result, users: result.page.map(user => adminUserView(user, admin.env.convexServiceSecret)), updatedAt: Date.now() });
  } catch (error) { return adminError(error, "Users unavailable"); }
}
