import { api } from "../../../../../../../convex/_generated/api";
import type { Id } from "../../../../../../../convex/_generated/dataModel";
import { adminError, adminRequest } from "@/lib/admin-route";
import { adminIdentityFromEncryptedThreadRef } from "@/lib/admin-identities";
import { privateJson } from "@/lib/security/internal-auth";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    const admin = await adminRequest();
    if (!admin) return privateJson({ error: "Sign in required" }, { status: 401 });
    const { userId } = await context.params;
    const id = z.string().min(1).max(128).parse(userId) as Id<"coastUsers">;
    const result = await admin.client.query(api.admin.threads, {
      serviceSecret: admin.env.convexServiceSecret, userId: id,
      paginationOpts: { numItems: 25, cursor: new URL(request.url).searchParams.get("cursor") },
    });
    return privateJson({ ...result, conversations: result.page.map(({ encryptedThreadRef, ...thread }) => ({
      ...thread, ...adminIdentityFromEncryptedThreadRef(encryptedThreadRef, admin.env.convexServiceSecret),
    })), updatedAt: Date.now() });
  } catch (error) { return adminError(error, "Conversations unavailable"); }
}
