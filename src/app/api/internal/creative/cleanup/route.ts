import { del } from "@vercel/blob";

import { authorizeInternalRequest, privateJson } from "@/lib/security/internal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!authorizeInternalRequest(request)) return privateJson({ error: "unauthorized" }, { status: 401 });
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return privateJson({ error: "blob_not_configured" }, { status: 503 });
  let body: { urls?: unknown };
  try { body = await request.json() as { urls?: unknown }; } catch { return privateJson({ error: "invalid_request" }, { status: 400 }); }
  if (!Array.isArray(body.urls) || body.urls.length > 20 || body.urls.some((value) => typeof value !== "string")) {
    return privateJson({ error: "invalid_request" }, { status: 400 });
  }
  const urls = body.urls.filter((value): value is string => {
    try { return new URL(value).hostname.endsWith(".blob.vercel-storage.com"); } catch { return false; }
  });
  if (urls.length !== body.urls.length) return privateJson({ error: "invalid_blob_url" }, { status: 422 });
  if (urls.length > 0) await del(urls, { token });
  return privateJson({ deleted: urls.length });
}
