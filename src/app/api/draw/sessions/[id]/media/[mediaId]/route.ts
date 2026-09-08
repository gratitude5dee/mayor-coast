import { get as getPrivateBlob } from "@vercel/blob";
import { getConvexHttpClient } from "@/lib/convex";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { api } from "../../../../../../../../convex/_generated/api";
import { parseServerEnv } from "@/lib/env";
import { drawBrowserToken } from "@/lib/draw/auth";
import { privateJson } from "@/lib/security/internal-auth";
export const runtime = "nodejs";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; mediaId: string }> }) {
  try { const env=parseServerEnv(); const {id,mediaId}=await params; const auth=await drawBrowserToken(id); if(!auth)return privateJson({error:"unauthorized"},{status:401}); const media=await getConvexHttpClient(env.CONVEX_URL).action((api.service as any).getAuthorizedDrawMedia,{serviceSecret:env.convexServiceSecret,sessionId:id as never,browserTokenHash:auth.hash,mediaId:mediaId as never,nowMs:Date.now()}); if(!media)return privateJson({error:"media_expired"},{status:410}); const token=process.env.BLOB_READ_WRITE_TOKEN; if(!token)return privateJson({error:"storage_not_configured"},{status:503}); const blob=await getPrivateBlob(media.sourceUrl,{access:"private",token,useCache:false}); if(!blob)return privateJson({error:"media_unavailable"},{status:404}); return new Response(blob.stream,{headers:{"content-type":media.mimeType,"cache-control":"no-store, max-age=0"}}); } catch { return privateJson({error:"media_unavailable"},{status:404}); }
}
