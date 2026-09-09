import { cookies } from "next/headers";

import { ADMIN_COOKIE, validAdminSession } from "@/lib/admin-auth";
import { getConvexHttpClient } from "@/lib/convex";
import { parseServerEnv } from "@/lib/env";
import { privateJson } from "@/lib/security/internal-auth";

export async function adminRequest() {
  const env = parseServerEnv();
  const session = (await cookies()).get(ADMIN_COOKIE)?.value;
  if (!validAdminSession(session, env.convexServiceSecret)) return null;
  return { env, client: getConvexHttpClient(env.CONVEX_URL) };
}

export function adminError(error: unknown, fallback: string) {
  if (error instanceof Error && /ADMIN_(?:RECORD_UNAVAILABLE|FILTER_INVALID)/.test(error.message)) {
    return privateJson({ error: "That record is unavailable." }, { status: 404 });
  }
  return privateJson({ error: fallback }, { status: 503 });
}
