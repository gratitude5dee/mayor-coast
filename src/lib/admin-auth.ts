import { createHmac, timingSafeEqual } from "node:crypto";
export const ADMIN_COOKIE = "__Host-coast_admin";
export function adminSession(secret: string, now = Date.now()) {
  const expires = String(now + 8 * 60 * 60_000);
  return `${expires}.${createHmac("sha256", secret).update(`coast-admin-v1:${expires}`).digest("hex")}`;
}
export function validAdminSession(value: string | undefined, secret: string, now = Date.now()) {
  if (!value) return false;
  const [expires, signature, extra] = value.split(".");
  if (!expires || !signature || extra || !/^\d+$/.test(expires) || !/^[a-f0-9]{64}$/.test(signature) || Number(expires) <= now || Number(expires) > now + 8 * 60 * 60_000) return false;
  const expected = createHmac("sha256", secret).update(`coast-admin-v1:${expires}`).digest("hex");
  return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
}
