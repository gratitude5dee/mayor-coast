import {
  buildExperiencePresentation,
  type ExperiencePresentation,
  type PresentationEntityType,
} from "./presentation";

export type AuthoritativeExperienceDetails = {
  activeStatus?: string;
  canonicalUrl: string;
  contentHash?: string | null;
  endAtUtcMs?: number | null;
  entityType: PresentationEntityType;
  experienceFields: Record<string, unknown>;
  externalId: string;
  neighborhoodId?: string | null;
  observedSummary: string;
  primaryType?: string | null;
  startAtUtcMs?: number | null;
  title: string;
};

type LocationFields = {
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  name: string | null;
};

export function presentationFromExperienceDetails(
  input: AuthoritativeExperienceDetails,
): ExperiencePresentation | null {
  const location = locationFromExperienceFields(input.experienceFields);
  return buildExperiencePresentation({
    canonicalUrl: input.canonicalUrl,
    contentHash: input.contentHash ?? null,
    endAtMs:
      finiteMs(input.endAtUtcMs) ?? endAtMsFromExperienceFields(input.experienceFields),
    entityType: input.entityType,
    externalId: input.externalId,
    neighborhoodId: input.neighborhoodId ?? null,
    observedSummary: input.observedSummary,
    primaryType: input.primaryType ?? null,
    startAtMs: input.startAtUtcMs ?? null,
    title: input.title,
    venueAddress: location.address,
    venueName: location.name,
  });
}

export function endAtMsFromExperienceFields(
  fields: Record<string, unknown>,
): number | null {
  const timing = objectField(fields, "timing");
  const value = timing?.endAtUtc ?? timing?.end_at_utc ?? fields.endAtUtcMs ?? fields.endAtMs;
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function locationFromExperienceFields(
  fields: Record<string, unknown>,
): LocationFields {
  const location = objectField(fields, "location");
  return {
    address: textField(location?.address),
    latitude: numberField(location?.latitude),
    longitude: numberField(location?.longitude),
    name: textField(location?.name),
  };
}

function objectField(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const candidate = value[key];
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : null;
}

function textField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, 300) : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteMs(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
