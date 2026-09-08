import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import type { Id } from "../../../convex/_generated/dataModel";

export function drawCookieName(sessionId: string) { return `coast_draw_${sessionId}`; }
export function drawTokenHash(token: string) { return createHash("sha256").update(token).digest("hex"); }
export async function drawBrowserToken(sessionId: string): Promise<{ id: Id<"drawSessions">; hash: string } | null> {
  const token = (await cookies()).get(drawCookieName(sessionId))?.value;
  return token ? { id: sessionId as Id<"drawSessions">, hash: drawTokenHash(token) } : null;
}
