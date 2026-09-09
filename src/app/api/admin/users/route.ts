import { cookies } from "next/headers";

import { api } from "../../../../../convex/_generated/api";
import { adminIdentityFromEncryptedThreadRef } from "@/lib/admin-identities";
import { ADMIN_COOKIE, validAdminSession } from "@/lib/admin-auth";
import { getConvexHttpClient } from "@/lib/convex";
import { parseServerEnv } from "@/lib/env";
import { privateJson } from "@/lib/security/internal-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const env = parseServerEnv();
    if (!validAdminSession((await cookies()).get(ADMIN_COOKIE)?.value, env.convexServiceSecret)) {
      return privateJson({ error: "Sign in required" }, { status: 401 });
    }
    const users = await getConvexHttpClient(env.CONVEX_URL).query(api.admin.users, {
      serviceSecret: env.convexServiceSecret,
    });
    return privateJson({
      users: users.map(({ encryptedThreadRef, ...user }) => ({
        ...user,
        ...adminIdentityFromEncryptedThreadRef(encryptedThreadRef, env.convexServiceSecret),
      })),
      updatedAt: Date.now(),
    });
  } catch {
    return privateJson({ error: "Users unavailable" }, { status: 503 });
  }
}
