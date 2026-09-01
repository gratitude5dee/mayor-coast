import { gridDisk, latLngToCell } from "h3-js";
import { z } from "zod";

import { api } from "../../../../../../convex/_generated/api";
import type { Id } from "../../../../../../convex/_generated/dataModel";
import { locationFromExperienceFields } from "@/lib/coast";
import { getConvexHttpClient } from "@/lib/convex";
import { parseServerEnv } from "@/lib/env";
import { getSharedLocation } from "@/lib/photon/advanced-client";
import { getOrCreateCoastPhotonRuntime } from "@/lib/photon/runtime";
import {
  authorizeInternalRequest,
  privateJson,
} from "@/lib/security/internal-auth";
import { decryptThreadReference } from "@/lib/security/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const requestSchema = z.object({ requestId: z.string().min(1).max(256) }).strict();
const claimedRequestSchema = z
  .object({
    requestId: z.string(),
    revision: z.number().int().nonnegative(),
    encryptedThreadRef: z.string(),
    purpose: z.enum(["nearby_search", "directions"]),
    entityType: z.enum(["event", "place", "any"]),
    searchText: z.string().nullable(),
    targetExternalId: z.string().nullable(),
    travelMode: z.enum(["walking", "driving", "transit", "bicycling"]),
  })
  .passthrough();

const MAX_LOCATION_AGE_MS = 15 * 60 * 1_000;
const MAX_LOCATION_ACCURACY_METERS = 2_000;

export async function POST(request: Request): Promise<Response> {
  let env;
  try {
    env = parseServerEnv();
  } catch {
    return privateJson({ error: "resolver_not_configured" }, { status: 503 });
  }
  if (!authorizeInternalRequest(request)) {
    return privateJson({ error: "unauthorized" }, { status: 401 });
  }

  let input: z.infer<typeof requestSchema>;
  try {
    input = requestSchema.parse(await request.json());
  } catch {
    return privateJson({ error: "invalid_request" }, { status: 400 });
  }

  const client = getConvexHttpClient(env.CONVEX_URL);
  const nowMs = Date.now();
  const requestId = input.requestId as Id<"coastLocationRequests">;
  const claimedRaw = await client.action(api.service.claimLocationResolution, {
    serviceSecret: env.convexServiceSecret,
    requestId,
    nowMs,
  });
  if (claimedRaw === null) return privateJson({ status: "ignored" });
  const claimed = claimedRequestSchema.safeParse(claimedRaw);
  if (!claimed.success) {
    await release(client, env.convexServiceSecret, requestId, nowMs, "INVALID_REQUEST");
    return privateJson({ status: "pending" });
  }

  try {
    const threadId = decryptThreadReference(
      claimed.data.encryptedThreadRef,
      env.convexServiceSecret,
    );
    const neighborhoodId = coarseNeighborhoodFromSearch(claimed.data.searchText);
    if (claimed.data.purpose === "nearby_search" && neighborhoodId !== null) {
      const candidates = await client.action(api.service.searchNeighborhoodCandidates, {
        serviceSecret: env.convexServiceSecret,
        neighborhoodId,
        entityType: claimed.data.entityType,
        nowMs,
      });
      await client.action(api.service.completeNearbyLocation, {
        serviceSecret: env.convexServiceSecret,
        requestId,
        expectedRevision: claimed.data.revision,
        selectedExternalIds: candidates.map((candidate) => candidate.externalId).slice(0, 5),
        nowMs,
      });
      return privateJson({ status: "completed" });
    }
    const { adapter } = getOrCreateCoastPhotonRuntime();
    const location = await getSharedLocation({ adapter, threadId });
    if (!isValidSharedLocation(location, nowMs)) {
      await release(client, env.convexServiceSecret, requestId, nowMs, "LOCATION_UNAVAILABLE");
      return privateJson({ status: "pending" });
    }

    if (claimed.data.purpose === "directions") {
      if (claimed.data.targetExternalId === null) {
        await release(client, env.convexServiceSecret, requestId, nowMs, "DESTINATION_REQUIRED");
        return privateJson({ status: "pending" });
      }
      await client.action(api.service.completeDirectionsLocation, {
        serviceSecret: env.convexServiceSecret,
        requestId,
        expectedRevision: claimed.data.revision,
        nowMs,
      });
      return privateJson({ status: "completed" });
    }

    // The exact source coordinate is used only in this invocation. H3 cells
    // are transient query inputs; neither the coordinate nor the origin cell
    // is stored in Convex, sent to OpenAI, logged, or put in a Maps URL.
    const originCell = latLngToCell(location.latitude, location.longitude, 8);
    let candidates = await searchCandidates(client, env.convexServiceSecret, {
      cells: gridDisk(originCell, 1),
      entityType: claimed.data.entityType,
      nowMs,
    });
    if (candidates.length < 5) {
      candidates = await searchCandidates(client, env.convexServiceSecret, {
        cells: gridDisk(originCell, 2),
        entityType: claimed.data.entityType,
        nowMs,
      });
    }
    const selectedExternalIds = rankNearby(candidates, location.latitude, location.longitude);
    await client.action(api.service.completeNearbyLocation, {
      serviceSecret: env.convexServiceSecret,
      requestId,
      expectedRevision: claimed.data.revision,
      selectedExternalIds,
      nowMs,
    });
    return privateJson({ status: "completed" });
  } catch {
    await release(client, env.convexServiceSecret, requestId, nowMs, "LOCATION_RESOLUTION_FAILED");
    return privateJson({ status: "pending" });
  }
}

function coarseNeighborhoodFromSearch(value: string | null): string | null {
  if (!value?.startsWith("neighborhood:")) return null;
  const neighborhoodId = value.slice("neighborhood:".length).trim();
  return neighborhoodId && neighborhoodId.length <= 120 ? neighborhoodId : null;
}

async function release(
  client: ReturnType<typeof getConvexHttpClient>,
  serviceSecret: string,
  requestId: Id<"coastLocationRequests">,
  nowMs: number,
  errorCode: string,
) {
  await client.action(api.service.releaseLocationResolution, {
    serviceSecret,
    requestId,
    errorCode,
    nowMs,
  });
}

async function searchCandidates(
  client: ReturnType<typeof getConvexHttpClient>,
  serviceSecret: string,
  input: {
    cells: string[];
    entityType: "event" | "place" | "any";
    nowMs: number;
  },
): Promise<Array<{ externalId: string; experienceFields: Record<string, unknown> }>> {
  const value = await client.action(api.service.searchNearbyCandidates, {
    serviceSecret,
    cells: input.cells.slice(0, 19),
    entityType: input.entityType,
    nowMs: input.nowMs,
  });
  return value.map((item) => ({
    externalId: item.externalId,
    experienceFields: item.experienceFields,
  }));
}

function rankNearby(
  candidates: Array<{ externalId: string; experienceFields: Record<string, unknown> }>,
  originLatitude: number,
  originLongitude: number,
): string[] {
  const ranked = candidates
    .map((candidate) => {
      const destination = locationFromExperienceFields(candidate.experienceFields);
      if (destination.latitude === null || destination.longitude === null) return null;
      return {
        externalId: candidate.externalId,
        distance: haversineMeters(
          originLatitude,
          originLongitude,
          destination.latitude,
          destination.longitude,
        ),
      };
    })
    .filter((candidate): candidate is { externalId: string; distance: number } => candidate !== null)
    .sort((a, b) => a.distance - b.distance || a.externalId.localeCompare(b.externalId));
  return [...new Set(ranked.map((candidate) => candidate.externalId))].slice(0, 5);
}

export function isValidSharedLocation(
  location: {
    accuracy?: number;
    expiresAt?: Date | string;
    isLocatingInProgress?: boolean;
    latitude?: number;
    locationTimestamp?: Date | string;
    locationType?: string;
    longitude?: number;
  },
  nowMs: number,
): location is { latitude: number; longitude: number } {
  if (
    location.isLocatingInProgress === true ||
    location.locationType !== "legacy" &&
      location.locationType !== "live" &&
      location.locationType !== "shallow" ||
    !Number.isFinite(location.latitude) ||
    !Number.isFinite(location.longitude) ||
    (location.accuracy !== undefined &&
      (!Number.isFinite(location.accuracy) || location.accuracy > MAX_LOCATION_ACCURACY_METERS))
  ) {
    return false;
  }
  const observedAtMs = timestampMs(location.locationTimestamp);
  const expiresAtMs = timestampMs(location.expiresAt);
  return (
    observedAtMs !== null &&
    observedAtMs <= nowMs + 60_000 &&
    nowMs - observedAtMs <= MAX_LOCATION_AGE_MS &&
    (expiresAtMs === null || expiresAtMs > nowMs)
  );
}

function timestampMs(value: Date | string | undefined): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function haversineMeters(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const radians = (value: number) => (value * Math.PI) / 180;
  const latitudeDelta = radians(latitudeB - latitudeA);
  const longitudeDelta = radians(longitudeB - longitudeA);
  const root =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(latitudeA)) *
      Math.cos(radians(latitudeB)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(root), Math.sqrt(1 - root));
}
