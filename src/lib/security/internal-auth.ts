import { createHash } from "node:crypto";

import { constantTimeStringEqual } from "./identity";

// Convex retains the raw credential. Vercel verifies only this SHA-256
// fingerprint, so its runtime configuration never contains that credential.
const CONVEX_TO_VERCEL_SECRET_FINGERPRINT =
  "4bfec08f77aebacd12a3ebfce6db23ecd5538ac7524ba9ef67a0e7c537410189";

export function authorizeInternalRequest(
  request: Request,
): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) return false;
  const suppliedFingerprint = createHash("sha256")
    .update(authorization.slice(prefix.length), "utf8")
    .digest("hex");
  return constantTimeStringEqual(
    suppliedFingerprint,
    CONVEX_TO_VERCEL_SECRET_FINGERPRINT,
  );
}

export function privateJson(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store, max-age=0");
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}
