import { Modal, Select, SelectOption } from "chat";
import { z } from "zod";

import { api } from "../../../../../convex/_generated/api";
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
      "poll",
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
