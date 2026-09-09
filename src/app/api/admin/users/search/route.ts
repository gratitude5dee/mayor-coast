import { api } from "../../../../../../convex/_generated/api";
import { adminError, adminRequest } from "@/lib/admin-route";
import { adminUserView } from "@/lib/admin-view";
import { pseudonymizeSender } from "@/lib/security/identity";
import { privateJson } from "@/lib/security/internal-auth";
import { z } from "zod";

export const runtime = "nodejs";
const input = z.object({ query: z.string().trim().min(1).max(254) });

export async function POST(request: Request) {
  try {
    const admin = await adminRequest();
    if (!admin) return privateJson({ error: "Sign in required" }, { status: 401 });
    if (request.headers.get("origin") !== new URL(request.url).origin) return privateJson({ error: "Forbidden" }, { status: 403 });
    const { query } = input.parse(await request.json());
    const user = await admin.client.query(api.admin.searchUser, {
      serviceSecret: admin.env.convexServiceSecret,
      ...(query.startsWith("k") ? { userId: query } : { senderHash: pseudonymizeSender(query, admin.env.COAST_IDENTITY_PEPPER) }),
    });
    return privateJson({ user: user ? adminUserView(user, admin.env.convexServiceSecret) : null });
  } catch (error) { return adminError(error, "Search unavailable"); }
}
