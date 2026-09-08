import { Modal, Select, SelectOption } from "chat";
import { get as getPrivateBlob } from "@vercel/blob";
import { z } from "zod";

import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import {
  buildCalendarIcs,
  bookingDetailsFromExperienceFields,
  calendarFileName,
  locationFromExperienceFields,
  presentationFromExperienceDetails,
} from "@/lib/coast";
import { getConvexHttpClient } from "@/lib/convex";
import { parseServerEnv } from "@/lib/env";
import { requestLocationSharing } from "@/lib/photon/advanced-client";
import { buildGoogleMapsDirectionsUrl } from "@/lib/photon/maps";
import { getOrCreateCoastPhotonRuntime } from "@/lib/photon/runtime";
import { nativePollTitle } from "@/lib/photon/transport";
import {
  authorizeInternalRequest,
  privateJson,
} from "@/lib/security/internal-auth";
import {
  constantTimeStringEqual,
  decryptThreadReference,
} from "@/lib/security/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 25;

const requestSchema = z
  .object({
    turnId: z.string().min(1).max(256),
    idempotencyKey: z.string().min(1).max(512),
    encryptedThreadRef: z.string().min(24).max(4_096),
    stage: z.enum([
      "response",
      "results",
      "experience_card",
      "calendar_attachment",
      "reservation_action",
      "location_request",
      "maps_card",
      "artist_drop",
      "poll",
      "creative_attachment",
      "creative_caption",
      "billing",
      "draw_card",
    ]),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

const pollPayloadSchema = z
  .object({
    question: z.string().trim().min(1).max(120),
    options: z.array(z.string().trim().min(1).max(80)).min(2).max(6),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  let env;
  try {
    env = parseServerEnv();
  } catch {
    return privateJson({ error: "delivery_not_configured" }, { status: 503 });
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
  const suppliedIdempotencyKey = request.headers.get("idempotency-key") ?? "";
  if (!constantTimeStringEqual(input.idempotencyKey, suppliedIdempotencyKey)) {
    return privateJson({ error: "invalid_idempotency_key" }, { status: 409 });
  }
  try {
    const threadId = decryptThreadReference(
      input.encryptedThreadRef,
      env.convexServiceSecret,
    );
    const { adapter } = getOrCreateCoastPhotonRuntime();
    let providerMessageId: string;

    if (input.stage === "response") {
      const text = z.string().trim().min(1).max(2_000).parse(input.payload.text);
      providerMessageId = (await adapter.postMessage(threadId, text)).id;
    } else if (input.stage === "draw_card") {
      const sessionId = z.string().min(1).max(128).parse(input.payload.sessionId);
      const launchSecret = z.string().min(20).max(256).parse(input.payload.launchSecret);
      const publicBase = env.COAST_PUBLIC_URL ?? new URL(request.url).origin;
      const cardUrl = new URL(`/draw/${encodeURIComponent(sessionId)}`, publicBase);
      cardUrl.hash = `secret=${encodeURIComponent(launchSecret)}`;
      if (env.COAST_DRAW_APPLE_TEAM_ID && env.COAST_DRAW_EXTENSION_BUNDLE_ID) {
        providerMessageId = (await adapter.sendMiniApp(threadId, {
          appName: "COAST Draw",
          teamId: env.COAST_DRAW_APPLE_TEAM_ID,
          extensionBundleId: env.COAST_DRAW_EXTENSION_BUNDLE_ID,
          ...(env.COAST_DRAW_APP_STORE_ID ? { appStoreId: env.COAST_DRAW_APP_STORE_ID } : {}),
          url: cardUrl,
          layout: {
            caption: "COAST Draw",
            subcaption: "Tap to sketch, then generate",
            summary: "Open your private COAST drawing canvas",
          },
        })).id;
      } else {
        // Photon renders this as its native URL mini-app balloon. It keeps the
        // drawing experience in Messages while the signed extension is being
        // distributed, and needs no client-specific extension identifier.
        providerMessageId = (await adapter.sendMiniApp(threadId, cardUrl.toString())).id;
      }
    } else if (input.stage === "results") {
      const markdown = z
        .string()
        .trim()
        .min(1)
        .max(8_000)
        .parse(input.payload.markdown);
      providerMessageId = (
        await adapter.postMessage(threadId, { markdown })
      ).id;
    } else if (input.stage === "experience_card") {
      const { presentation } = await presentationForPayload(input.payload, env.CONVEX_URL);
      const previewUrl = new URL(presentation.previewPath, env.COAST_DELIVERY_URL).toString();
      providerMessageId = (await adapter.sendMiniApp(threadId, previewUrl)).id;
    } else if (input.stage === "calendar_attachment") {
      const { presentation } = await presentationForPayload(input.payload, env.CONVEX_URL);
      const overrideStartAtMs = optionalFiniteMs(input.payload.startAtMs);
      const overrideEndAtMs = optionalFiniteMs(input.payload.endAtMs);
      const effectiveStartAtMs = overrideStartAtMs ?? presentation.startAtMs;
      if (effectiveStartAtMs === null) {
        throw new Error("CALENDAR_EVENT_REQUIRES_START_TIME");
      }
      providerMessageId = (
        await adapter.postMessage(threadId, {
          raw: "",
          files: [
            {
              data: Buffer.from(
                buildCalendarIcs(
                  presentation,
                  overrideStartAtMs === null
                    ? undefined
                    : { startAtMs: overrideStartAtMs, endAtMs: overrideEndAtMs },
                ),
                "utf8",
              ),
              filename: presentation.calendarFileName ?? calendarFileName(effectiveStartAtMs),
              mimeType: "text/calendar; charset=utf-8",
            },
          ],
        })
      ).id;
    } else if (input.stage === "reservation_action") {
      const deliveryExperience = await presentationForPayload(input.payload, env.CONVEX_URL);
      const booking = bookingDetailsFromExperienceFields(
        deliveryExperience.experienceFields,
      );
      const action = booking.url !== null
        ? `Confirm here: ${booking.url}`
        : booking.phone !== null
          ? `Call to confirm: ${booking.phone}`
          : `Confirm details here: ${deliveryExperience.presentation.canonicalUrl}`;
      providerMessageId = (await adapter.postMessage(threadId, action)).id;
    } else if (input.stage === "location_request") {
      const request = await requestLocationSharing({
        adapter,
        clientMessageId: input.idempotencyKey,
        threadId,
      });
      providerMessageId = request.messageGuid ?? input.idempotencyKey;
    } else if (input.stage === "maps_card") {
      const deliveryExperience = await presentationForPayload(
        input.payload,
        env.CONVEX_URL,
        true,
      );
      if (deliveryExperience.destination === undefined) {
        throw new Error("MAP_DESTINATION_COORDINATES_MISSING");
      }
      const travelMode = z
        .enum(["walking", "driving", "transit", "bicycling"])
        .catch("walking")
        .parse(input.payload.travelMode);
      providerMessageId = (
        await adapter.sendMiniApp(
          threadId,
          buildGoogleMapsDirectionsUrl({
            destination: deliveryExperience.destination,
            travelMode,
          }),
        )
      ).id;
    } else if (input.stage === "artist_drop") {
      const payload = z
        .object({
          artistExternalId: z.string().trim().min(1).max(120),
          shareKind: z.enum(["direct", "automatic"]),
          localDayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        })
        .strict()
        .parse(input.payload);
      const artist = await getConvexHttpClient(env.CONVEX_URL).query(
        api.artists.getForDelivery,
        { externalId: payload.artistExternalId },
      );
      if (artist === null) throw new Error("ARTIST_NOT_AVAILABLE");
      providerMessageId = (
        await adapter.postMessage(
          threadId,
          `Bay soundcheck: ${artist.displayName} — ${artist.lane}. Bay/NorCal connection: ${artist.regionAnchor}. Tap in: ${artist.instagramUrl}`,
        )
      ).id;
    } else if (input.stage === "creative_attachment") {
      const payload = z
        .object({
          mediaId: z.string().min(1).max(128),
          filename: z.string().trim().min(1).max(120),
          mimeType: z.string().trim().min(1).max(120),
          caption: z.string().trim().max(480).optional(),
        })
        .strict()
        .parse(input.payload);
      const mediaRecord = await getConvexHttpClient(env.CONVEX_URL).action(api.service.getCreativeMedia, {
        serviceSecret: env.convexServiceSecret,
        mediaId: payload.mediaId as Id<"creativeMedia">,
        nowMs: Date.now(),
      });
      if (mediaRecord === null || !mediaRecord.sourceUrl.startsWith("https://")) throw new Error("CREATIVE_MEDIA_EXPIRED");
      const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
      if (!blobToken) throw new Error("CREATIVE_BLOB_NOT_CONFIGURED");
      const media = await getPrivateBlob(mediaRecord.sourceUrl, { access: "private", token: blobToken, useCache: false });
      if (media === null) throw new Error("CREATIVE_MEDIA_UNAVAILABLE");
      const bytes = Buffer.from(await new Response(media.stream).arrayBuffer());
      if (bytes.byteLength > 40 * 1024 * 1024) throw new Error("CREATIVE_MEDIA_TOO_LARGE");
      providerMessageId = (
        await adapter.postMessage(threadId, {
          raw: payload.caption ?? "",
          files: [{ data: bytes, filename: mediaRecord.filename, mimeType: mediaRecord.mimeType }],
        })
      ).id;
    } else if (input.stage === "creative_caption") {
      const caption = z.string().trim().min(1).max(480).parse(input.payload.text);
      providerMessageId = (await adapter.postMessage(threadId, caption)).id;
    } else if (input.stage === "billing") {
      const payload = z.object({ text: z.string().trim().min(1).max(2_000), orderId: z.string().regex(/^ct_[a-zA-Z0-9_-]{8,100}$/u).optional() }).strict().parse(input.payload);
      const checkoutUrl = payload.orderId && process.env.COAST_PUBLIC_URL
        ? new URL(`/api/stripe/creative-topup?order_id=${encodeURIComponent(payload.orderId)}`, process.env.COAST_PUBLIC_URL).toString()
        : null;
      const text = checkoutUrl ? `${payload.text} ${checkoutUrl}` : payload.text;
      providerMessageId = (await adapter.postMessage(threadId, text)).id;
    } else {
      const poll = pollPayloadSchema.parse(input.payload);
      const modal = Modal({
        callbackId: "coast-poll",
        children: [
          Select({
            id: "answer",
            label: poll.question,
            options: poll.options.map((option) =>
              SelectOption({ label: option, value: option }),
            ),
          }),
        ],
        privateMetadata: input.turnId,
        title: nativePollTitle(poll),
      });
      providerMessageId = (
        await adapter.openModal(threadId, modal, input.turnId)
      ).viewId;
    }

    return privateJson({ providerMessageId });
  } catch {
    return privateJson({ error: "delivery_failed" }, { status: 502 });
  }
}

async function presentationForPayload(
  payload: Record<string, unknown>,
  convexUrl: string,
  requireDestination = false,
) {
  const externalId = z.string().trim().min(1).max(240).parse(payload.externalId);
  const experience = await getConvexHttpClient(convexUrl).query(
    api.dataset.getExperienceDetails,
    { externalId, nowMs: Date.now() },
  );
  if (experience === null) throw new Error("EXPERIENCE_NOT_AVAILABLE");
  const presentation = presentationFromExperienceDetails(experience);
  if (presentation === null) throw new Error("EXPERIENCE_PRESENTATION_INVALID");
  const location = locationFromExperienceFields(experience.experienceFields);
  if (
    requireDestination &&
    (location.latitude === null || location.longitude === null)
  ) {
    throw new Error("MAP_DESTINATION_COORDINATES_MISSING");
  }
  return {
    presentation,
    experienceFields: experience.experienceFields,
    ...(location.latitude !== null && location.longitude !== null
      ? { destination: { latitude: location.latitude, longitude: location.longitude } }
      : {}),
  };
}

function optionalFiniteMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}
