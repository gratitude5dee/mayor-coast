import { createHash } from "node:crypto";

export type PresentationEntityType = "event" | "place";

export type ExperiencePresentationInput = {
  canonicalUrl: string;
  contentHash?: string | null;
  endAtMs?: number | null;
  entityType: PresentationEntityType;
  externalId: string;
  neighborhoodId?: string | null;
  observedSummary?: string | null;
  primaryType?: string | null;
  startAtMs?: number | null;
  title: string;
  venueAddress?: string | null;
  venueName?: string | null;
};

export type ExperiencePresentation = {
  calendarFileName?: string;
  canonicalUrl: string;
  contentHash: string | null;
  description: string;
  endAtMs: number | null;
  entityType: PresentationEntityType;
  externalId: string;
  previewPath: string;
  startAtMs: number | null;
  title: string;
  venueAddress: string | null;
  venueName: string | null;
};

const DO_THE_BAY_TEMPLATE =
  /^check out .+? in san francisco on .+? and get detailed info for the event\s*[-–—]?\s*tickets,?\s*photos,?\s*video\s*(?:and|&)\s*reviews\.?$/iu;
const TICKETS_MEDIA_TRAILER =
  /\s*[-–—]?\s*tickets,?\s*photos,?\s*video\s*(?:and|&)\s*reviews\.?/giu;
const DATE_FRAGMENT =
  /\s*(?:[-–—]|on)\s*(?:mon|tues?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:,?\s*\d{4})?(?:,?\s*\d{1,2}:\d{2}\s*(?:am|pm))?/giu;

export function oneLine(value: string, maxLength = 220): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (compact.length <= maxLength) return compact;
  const clipped = compact.slice(0, Math.max(0, maxLength - 1));
  const boundary = clipped.lastIndexOf(" ");
  return `${(boundary > maxLength * 0.55 ? clipped.slice(0, boundary) : clipped).trimEnd()}…`;
}

export function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function cleanExperienceSummary(input: ExperiencePresentationInput): string {
  const source = oneLine(input.observedSummary ?? "", 420);
  let cleaned = source;
  if (DO_THE_BAY_TEMPLATE.test(cleaned)) cleaned = "";
  cleaned = cleaned.replace(TICKETS_MEDIA_TRAILER, "");
  if (input.entityType === "event") cleaned = cleaned.replace(DATE_FRAGMENT, "");
  cleaned = oneLine(cleaned.replace(/\s+([,.!?;:])/gu, "$1"), 180);
  if (cleaned) return cleaned;

  const venue = nullableText(input.venueName);
  const neighborhood = nullableText(input.neighborhoodId);
  const primaryType = nullableText(input.primaryType);
  if (primaryType && venue && neighborhood) return `${primaryType} at ${venue} in ${neighborhood}.`;
  if (venue && neighborhood) return `At ${venue} in ${neighborhood}.`;
  if (venue) return `At ${venue}.`;
  if (neighborhood) return `In ${neighborhood}.`;
  return "Source details are available in the listing.";
}

export function encodeExperienceKey(externalId: string): string {
  const normalized = externalId.trim();
  if (!normalized || normalized.length > 512) throw new Error("INVALID_EXPERIENCE_ID");
  return Buffer.from(normalized, "utf8").toString("base64url");
}

export function decodeExperienceKey(value: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,1024}$/u.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return decoded && encodeExperienceKey(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

export function experiencePreviewPath(input: Pick<ExperiencePresentationInput, "externalId" | "contentHash">): string {
  const version = input.contentHash?.replace(/[^a-f0-9]/giu, "").slice(0, 16) ?? "current";
  return `/x/${encodeExperienceKey(input.externalId)}?v=${version || "current"}`;
}

export function buildExperiencePresentation(
  input: ExperiencePresentationInput,
): ExperiencePresentation | null {
  const canonicalUrl = safeExternalUrl(input.canonicalUrl);
  if (!canonicalUrl) return null;
  const title = oneLine(input.title, 180);
  if (!title) return null;
  const startAtMs = finiteMs(input.startAtMs);
  const endAtMs = finiteMs(input.endAtMs);
  const isEvent = input.entityType === "event";
  return {
    canonicalUrl,
    contentHash: input.contentHash?.trim() || null,
    description: cleanExperienceSummary(input),
    endAtMs,
    entityType: input.entityType,
    externalId: input.externalId,
    previewPath: experiencePreviewPath(input),
    startAtMs,
    title,
    venueAddress: nullableText(input.venueAddress),
    venueName: nullableText(input.venueName),
    ...(isEvent && startAtMs !== null
      ? { calendarFileName: calendarFileName(startAtMs) }
      : {}),
  };
}

export function buildCalendarIcs(
  input: ExperiencePresentation,
  override?: { startAtMs: number; endAtMs?: number | null },
): string {
  const startAtMs = finiteMs(override?.startAtMs) ?? input.startAtMs;
  const endAtMs = override === undefined
    ? input.endAtMs
    : finiteMs(override.endAtMs);
  if (startAtMs === null) {
    throw new Error("CALENDAR_EVENT_REQUIRES_START_TIME");
  }
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//COAST//San Francisco Concierge//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${stableCalendarUid(input.externalId, startAtMs)}`,
    `DTSTAMP:${formatIcsUtc(startAtMs)}`,
    `DTSTART:${formatIcsUtc(startAtMs)}`,
    ...(endAtMs !== null && endAtMs > startAtMs
      ? [`DTEND:${formatIcsUtc(endAtMs)}`]
      : []),
    `SUMMARY:${escapeIcsText(input.title)}`,
    ...(input.venueName || input.venueAddress
      ? [`LOCATION:${escapeIcsText([input.venueName, input.venueAddress].filter(Boolean).join(", "))}`]
      : []),
    `URL:${input.canonicalUrl}`,
    `DESCRIPTION:${escapeIcsText(input.description)}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeIcsText(`Reminder: ${input.title}`)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.flatMap(foldIcsLine).join("\r\n")}\r\n`;
}

export function calendarFileName(startAtMs: number): string {
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
    .format(new Date(startAtMs))
    .replace(/, /gu, " ");
  return `${label} — Add to Calendar.ics`;
}

function nullableText(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/gu, " ").trim() ?? "";
  return normalized ? normalized.slice(0, 300) : null;
}

function finiteMs(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function stableCalendarUid(externalId: string, startAtMs: number): string {
  return `${createHash("sha256").update(`${externalId}\u0000${startAtMs}`, "utf8").digest("hex").slice(0, 40)}@coast.sf`;
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/;/gu, "\\;")
    .replace(/,/gu, "\\,")
    .replace(/\r\n|\n|\r/gu, "\\n");
}

function formatIcsUtc(value: number): string {
  const date = new Date(value);
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function foldIcsLine(line: string): string[] {
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of line) {
    const size = Buffer.byteLength(character, "utf8");
    const maximum = chunks.length === 0 ? 75 : 74;
    if (bytes + size > maximum && current) {
      chunks.push(current);
      current = ` ${character}`;
      bytes = 1 + size;
    } else {
      current += character;
      bytes += size;
    }
  }
  chunks.push(current);
  return chunks;
}
