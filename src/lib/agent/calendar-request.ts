import type { AgentPriorSelectionSet } from "./runtime";

export type CalendarRequestResolution =
  | {
      kind: "create";
      externalId: string;
      title: string;
      startAtMs: number;
      endAtMs: number | null;
    }
  | {
      /** Resolve a named place through the verified corpus, never the model. */
      kind: "lookup";
      title: string;
      startAtMs: number;
      endAtMs: number | null;
    }
  | {
      kind: "clarify";
      responseText: string;
      poll: { question: string; options: string[] } | null;
    };

const CALENDAR_INTENT = /\b(?:calendar|calender|add (?:it|this|that) to (?:my )?calendar|calendar (?:invite|link|hold))\b/iu;
const CALENDAR_POLL_ANSWER = /^poll answer:\s*(?:what date|what time|which spot)\?/iu;
const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

export function resolveCalendarRequest(input: {
  latestMessage: string;
  recentInboundMessages: readonly string[];
  priorSelections: readonly AgentPriorSelectionSet[];
  nowMs: number;
}): CalendarRequestResolution | null {
  const history = [...input.recentInboundMessages, input.latestMessage].slice(-8);
  const calendarIndex = history.findLastIndex((message) => CALENDAR_INTENT.test(message));
  const continuing = CALENDAR_POLL_ANSWER.test(input.latestMessage) || looksLikeDateReply(input.latestMessage);
  if (calendarIndex < 0 || (calendarIndex !== history.length - 1 && !continuing)) return null;

  const requestText = history.slice(calendarIndex).join(" \n ");
  const selectionItems = input.priorSelections.at(-1)?.items ?? [];
  const target = resolveTarget(requestText, selectionItems);
  const explicitTitle = target === null ? extractNamedPlace(requestText) : null;
  if (target === null && explicitTitle === null) {
    if (selectionItems.length >= 2) {
      return {
        kind: "clarify",
        responseText: "Which spot should I put on the calendar?",
        poll: {
          question: "Which spot?",
          options: selectionItems.slice(0, 5).map((item) => item.title.slice(0, 80)),
        },
      };
    }
    return null;
  }
  const calendarTitle = target?.title ?? explicitTitle!;

  const time = parseTime(requestText);
  if (time === null) {
    return {
      kind: "clarify",
      responseText: `What time should I hold for ${calendarTitle}?`,
      poll: {
        question: "What time?",
        options: ["5 PM", "6 PM", "7 PM", "8 PM"],
      },
    };
  }

  const date = parseLocalDate(requestText, input.nowMs);
  if (date === "another") {
    return {
      kind: "clarify",
      responseText: "Text me the date you want and I’ll make the one-tap calendar hold.",
      poll: null,
    };
  }
  if (date === null) {
    return {
      kind: "clarify",
      responseText: `What date should the ${formatHour(time.hour, time.minute)} ${calendarTitle} hold be for?`,
      poll: {
        question: "What date?",
        options: [
          `Today, ${formatLocalDay(input.nowMs)}`,
          `Tomorrow, ${formatLocalDay(addLocalDays(input.nowMs, 1))}`,
          "Another date",
        ],
      },
    };
  }

  const startAtMs = zonedSanFranciscoTimestamp(date.year, date.month, date.day, time.hour, time.minute);
  if (startAtMs <= input.nowMs - 5 * 60_000) {
    return {
      kind: "clarify",
      responseText: "That time has already passed. Send me a future date or time and I’ll make the hold.",
      poll: null,
    };
  }
  if (target === null) {
    return {
      kind: "lookup",
      title: explicitTitle!,
      startAtMs,
      endAtMs: startAtMs + 2 * 60 * 60_000,
    };
  }
  return {
    kind: "create",
    externalId: target.externalId,
    title: target.title,
    startAtMs,
    endAtMs: startAtMs + 2 * 60 * 60_000,
  };
}

/**
 * Supports "calendar invite for 5 PM today at Kin Khao" when that card has
 * aged out of the bounded conversation context. It returns only a title; the
 * route must resolve the canonical external ID from Convex before delivery.
 */
function extractNamedPlace(text: string): string | null {
  const afterAt = [...text.matchAll(/\bat\s+([a-z][a-z0-9&'’(). -]{1,80})/giu)]
    .map((match) => match[1]?.trim() ?? "")
    .map((value) => value.replace(/\s+(?:today|tomorrow|tonight|toight|tonite|on\s+\w.+)$/iu, "").trim())
    .filter((value) => value.length >= 2)
    .at(-1);
  if (afterAt) return afterAt;

  const beforeTime = text.match(
    /\b(?:for|to)\s+([a-z][a-z0-9&'’(). -]{1,80}?)\s+at\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)/iu,
  )?.[1]?.trim();
  return beforeTime && beforeTime.length >= 2 ? beforeTime : null;
}

function resolveTarget(
  text: string,
  items: readonly { externalId: string; title: string }[],
): { externalId: string; title: string } | null {
  const normalized = normalize(text);
  const explicit = items.find((item) => normalized.includes(normalize(item.title)));
  if (explicit) return explicit;
  const ordinal = normalized.match(/\b(?:the )?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)(?: one)?\b/u)?.[1];
  const positions: Record<string, number> = {
    first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2,
    fourth: 3, "4th": 3, fifth: 4, "5th": 4,
  };
  if (ordinal !== undefined) return items[positions[ordinal] ?? -1] ?? null;
  return items.length === 1 ? items[0] ?? null : null;
}

function parseTime(text: string): { hour: number; minute: number } | null {
  const matches = [...text.matchAll(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/giu)];
  const match = matches.at(-1);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3]?.toLowerCase().startsWith("p") ? "pm" : "am";
  if (hour === 12) hour = 0;
  if (meridiem === "pm") hour += 12;
  return { hour, minute };
}

function parseLocalDate(
  text: string,
  nowMs: number,
): { year: number; month: number; day: number } | "another" | null {
  if (/\banother date\b/iu.test(text)) return "another";
  const monthMatch = [...text.matchAll(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/giu)].at(-1);
  if (monthMatch) {
    const month = MONTHS[monthMatch[1]!.toLowerCase()];
    if (month !== undefined) {
      const now = localDateParts(nowMs);
      return { year: Number(monthMatch[3] ?? now.year), month, day: Number(monthMatch[2]) };
    }
  }
  if (/\btomorrow\b/iu.test(text)) return localDateParts(addLocalDays(nowMs, 1));
  if (/\btoday\b/iu.test(text)) return localDateParts(nowMs);
  return null;
}

function localDateParts(value: number): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month") - 1, day: get("day") };
}

function zonedSanFranciscoTimestamp(year: number, month: number, day: number, hour: number, minute: number): number {
  const noonUtc = Date.UTC(year, month, day, 12);
  const zoneLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", timeZoneName: "shortOffset",
  }).formatToParts(new Date(noonUtc)).find((part) => part.type === "timeZoneName")?.value ?? "GMT-7";
  const offsetHours = Number(zoneLabel.match(/GMT([+-]\d{1,2})/u)?.[1] ?? -7);
  return Date.UTC(year, month, day, hour - offsetHours, minute);
}

function addLocalDays(value: number, days: number): number {
  return value + days * 24 * 60 * 60_000;
}

function formatLocalDay(value: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", month: "short", day: "numeric",
  }).format(new Date(value));
}

function formatHour(hour: number, minute: number): string {
  const value = new Date(Date.UTC(2026, 0, 1, hour, minute));
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: minute === 0 ? undefined : "2-digit", timeZone: "UTC" }).format(value);
}

function looksLikeDateReply(value: string): boolean {
  return /\b(?:today|tomorrow|another date|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}[/-]\d{1,2})\b/iu.test(value);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}
