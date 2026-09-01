import { configurationReadiness } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const readiness = configurationReadiness();

  return Response.json(
    {
      service: "coast",
      status: readiness.ready ? "ready" : "configuration_required",
      snapshotId: "snapshot-99f2d46a008bec47efae",
      missingConfiguration: readiness.invalidKeys,
      timestamp: new Date().toISOString(),
    },
    {
      status: readiness.ready ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
