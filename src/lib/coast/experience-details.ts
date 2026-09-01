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

export type BookingDetails = {
  phone: string | null;
  url: string | null;
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

export function bookingDetailsFromExperienceFields(
  fields: Record<string, unknown>,
): BookingDetails {
  const urls: string[] = [];
  const phones: string[] = [];
  collectBookingValues(fields, "", urls, phones, 0);
  urls.sort((left, right) => bookingUrlRank(left) - bookingUrlRank(right));
  return { url: urls[0] ?? null, phone: phones[0] ?? null };
}

function collectBookingValues(
  value: Record<string, unknown>,
  path: string,
  urls: string[],
  phones: string[],
  depth: number,
): void {
  if (depth > 3) return;
  for (const [key, candidate] of Object.entries(value).slice(0, 80)) {
    const nextPath = `${path}.${key}`.toLowerCase();
    if (typeof candidate === "string") {
      if (/reservation|booking|opentable|resy|tock|ticket|registration|rsvp/u.test(nextPath)) {
        const url = safeHttpUrl(candidate);
        if (url) urls.push(url);
      }
      if (/phone|telephone|contact/u.test(nextPath)) {
        const phone = normalizePhone(candidate);
        if (phone) phones.push(phone);
      }
    } else if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
      collectBookingValues(candidate as Record<string, unknown>, nextPath, urls, phones, depth + 1);
    }
  }
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizePhone(value: string): string | null {
  const digits = value.replace(/\D/gu, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function bookingUrlRank(value: string): number {
  if (/opentable\.com/iu.test(value)) return 0;
  if (/resy\.com|exploretock\.com/iu.test(value)) return 1;
  if (/ticket|register|rsvp|eventbrite/iu.test(value)) return 2;
  return 3;
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
