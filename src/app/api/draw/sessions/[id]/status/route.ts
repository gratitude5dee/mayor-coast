/* eslint-disable @typescript-eslint/no-explicit-any */
import { getConvexHttpClient } from "@/lib/convex";
import { api } from "../../../../../../../convex/_generated/api";
import { parseServerEnv } from "@/lib/env";
import { drawBrowserToken } from "@/lib/draw/auth";
import { privateJson } from "@/lib/security/internal-auth";
export const runtime = "nodejs";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) { try { const env=parseServerEnv(); const {id}=await params; const auth=await drawBrowserToken(id); if(!auth)return privateJson({error:"unauthorized"},{status:401}); const result=await getConvexHttpClient(env.CONVEX_URL).action((api.service as any).listDrawEvents,{serviceSecret:env.convexServiceSecret,sessionId:id as never,browserTokenHash:auth.hash,nowMs:Date.now()}); if(!result)return privateJson({error:"session_expired"},{status:410}); return privateJson(result); } catch { return privateJson({error:"status_unavailable"},{status:503}); } }
