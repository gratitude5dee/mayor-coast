import { createHash, createHmac } from "node:crypto";
import { api } from "../../../../../convex/_generated/api";
import { getConvexHttpClient } from "@/lib/convex";
import { parseServerEnv } from "@/lib/env";
import { ADMIN_COOKIE, adminSession } from "@/lib/admin-auth";
import { privateJson } from "@/lib/security/internal-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return privateJson({ error: "Forbidden" }, { status: 403 });
  try {
    const env = parseServerEnv();
    const { password } = await request.json();
    if (typeof password !== "string" || password.length < 4 || password.length > 256) return privateJson({ error: "Invalid access key" }, { status: 401 });
    const forwardedFor = request.headers.get("x-vercel-forwarded-for") ?? request.headers.get("x-forwarded-for") ?? "unknown";
    const clientHash = createHmac("sha256", env.convexServiceSecret).update(`coast-admin-client-v1:${forwardedFor.split(",")[0]?.trim()}`).digest("hex");
    const login = await getConvexHttpClient(env.CONVEX_URL).mutation(api.admin.loginRateLimited, {
      serviceSecret: env.convexServiceSecret,
      passwordHash: createHash("sha256").update(password).digest("hex"),
      clientHash,
      nowMs: Date.now(),
    });
    if (!login.allowed) return privateJson(
      { error: "Invalid access key" },
      login.retryAfterMs > 0
        ? { status: 429, headers: { "retry-after": String(Math.ceil(login.retryAfterMs / 1_000)) } }
        : { status: 401 },
    );
    return privateJson({ ok: true }, { headers: { "set-cookie": `${ADMIN_COOKIE}=${adminSession(env.convexServiceSecret)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800` } });
  } catch { return privateJson({ error: "Login unavailable" }, { status: 503 }); }
}
export async function DELETE(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return privateJson({ error: "Forbidden" }, { status: 403 });
  return privateJson({ ok: true }, { headers: { "set-cookie": `${ADMIN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` } });
}
