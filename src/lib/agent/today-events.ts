import type { CoastDataSource } from "./data-source";
import type { ExperienceRecord, TurnPlan } from "../coast/contracts";
import type { AgentRunDiagnostics, AgentRunResult } from "./runtime";

const SAN_FRANCISCO_TIME_ZONE = "America/Los_Angeles";
const TODAY_EVENT_PATTERN =
  /\b(?:what(?:'s| is)|whats|wats).{0,32}\b(?:(?:going|goin)\s+on|happening)\b.{0,32}\b(?:tonight|toight|tonite|today|tn)\b|\b(?:events?|shows?|concerts?|parties?)\b.{0,32}\b(?:tonight|toight|tonite|today|tn)\b/iu;

type LocalDate = { year: number; month: number; day: number };

function localDateAt(value: number): LocalDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SAN_FRANCISCO_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const find = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: find("year"), month: find("month"), day: find("day") };
}

function offsetAt(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SAN_FRANCISCO_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(utcMs));
  const find = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const localAsUtc = Date.UTC(
    find("year"),
    find("month") - 1,
    find("day"),
    find("hour"),
    find("minute"),
    find("second"),
  );
  return localAsUtc - utcMs;
}

function localMidnightUtc(date: LocalDate): number {
  const guessedUtc = Date.UTC(date.year, date.month - 1, date.day);
  return guessedUtc - offsetAt(guessedUtc);
}

/** Exact current calendar-day boundaries in San Francisco, including DST. */
export function currentSanFranciscoDay(nowMs: number): {
  startAtMs: number;
  endAtMs: number;
} {
  const today = localDateAt(nowMs);
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  return {
    startAtMs: localMidnightUtc(today),
    endAtMs: localMidnightUtc({
      year: tomorrow.getUTCFullYear(),
      month: tomorrow.getUTCMonth() + 1,
      day: tomorrow.getUTCDate(),
    }),
  };
}

/** Direct local-language event asks should never begin with a clarification poll. */
export function isTodayEventsRequest(message: string): boolean {
  return TODAY_EVENT_PATTERN.test(message.replace(/\s+/gu, " ").trim());
}

function toPlan(experiences: readonly ExperienceRecord[]): TurnPlan {
  if (experiences.length === 0) {
    return {
      responseText:
        "I couldn’t verify a live SF event for today in this snapshot.",
      selectedExternalIds: [],
      poll: null,
      preferenceUpdates: [],
      provenanceIds: [],
    };
  }
  return {
    responseText:
      experiences.length === 1
        ? "Here’s the verified move on deck today."
        : `Here are ${experiences.length} verified moves on deck today.`,
    selectedExternalIds: experiences.map((item) => item.externalId),
    poll: null,
    preferenceUpdates: [],
    provenanceIds: [...new Set(experiences.flatMap((item) => item.provenanceIds))],
  };
}

function isEventContext(value: string): boolean {
  return /\b(?:event|concert|show|party|music|comedy|dj|dance|nightlife|festival)\b/iu.test(
    value,
  );
}

function isDrinkContext(value: string): boolean {
  return /\b(?:drink|bar|cocktail|wine|beer|brewery|happy hour|mocktail)\b/iu.test(
    value,
  );
}

function neighborhoodFrom(value: string): string[] {
  const matches: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bmission\b/iu, "Mission"],
    [/\bnorth beach\b/iu, "North Beach"],
    [/\bhayes valley\b/iu, "Hayes Valley"],
    [/\b(?:soma|south of market)\b/iu, "South of Market"],
    [/\b(?:downtown|financial district)\b/iu, "Financial District/South Beach"],
  ];
  return matches
    .filter(([pattern]) => pattern.test(value))
    .map(([, neighborhood]) => neighborhood)
    .slice(0, 1);
}

function exhaustedSearchInput(input: {
  message: string;
  recentMessages?: readonly { role: string; content: string }[];
}) {
  const context = [
    ...(input.recentMessages ?? [])
      .filter((message) => message.role === "user")
      .map((message) => message.content),
    input.message,
  ].join(" ");
  if (isEventContext(context)) {
    return { query: "events", entityType: "event" as const, context };
  }
  if (isDrinkContext(context)) {
    return { query: "drinks", entityType: "place" as const, context };
  }
  return { query: "dinner", entityType: "place" as const, context };
}

const DIRECT_EVENT_DIAGNOSTICS: AgentRunDiagnostics = {
  model: "deterministic",
  routeReasons: [],
  constraintCount: 0,
  modelSteps: 0,
  toolCalls: 1,
  backendDataCalls: 1,
  rejectedToolCalls: 0,
  inferredFallbackUsed: false,
  observedRetrievalWeak: false,
};

/**
 * Retrieves the active current-day SF event corpus without model latency or a
 * generic full-text result that might surface a restaurant instead of an event.
 */
export async function resolveTodayEvents(input: {
  dataSource: CoastDataSource;
  nowMs: number;
}): Promise<AgentRunResult> {
  const window = currentSanFranciscoDay(input.nowMs);
  const result = await input.dataSource.searchExperiences({
    query: "events",
    entityType: "event",
    neighborhoods: [],
    primaryTypes: [],
    priceBands: [],
    startAtMs: window.startAtMs,
    endAtMs: window.endAtMs,
    limit: 5,
    matchMode: "observed",
  });
  const experiences = result.items
    .filter((item) => item.entityType === "event")
    .slice(0, 5);
  return {
    plan: toPlan(experiences),
    stagedPreferenceUpdates: [],
    experiences,
    command: null,
    requiresLifecycleMutation: false,
    diagnostics: DIRECT_EVENT_DIAGNOSTICS,
  };
}

/**
 * The final clarification answer always produces a bounded broad search. This
 * prevents an otherwise valid model response from turning a two-question flow
 * into a third native poll.
 */
export async function resolveExhaustedClarification(input: {
  dataSource: CoastDataSource;
  nowMs: number;
  message: string;
  recentMessages?: readonly { role: string; content: string }[];
}): Promise<AgentRunResult> {
  const search = exhaustedSearchInput(input);
  const base = {
    query: search.query,
    entityType: search.entityType,
    neighborhoods: neighborhoodFrom(search.context),
    primaryTypes: [],
    priceBands: [],
    startAtMs: null,
    endAtMs: null,
    limit: 5,
  };
  const observed = await input.dataSource.searchExperiences({
    ...base,
    matchMode: "observed",
  });
  const fallback = observed.items.length > 0
    ? null
    : await input.dataSource.searchExperiences({ ...base, matchMode: "inferred" });
  const experiences = (fallback?.items ?? observed.items).slice(0, 5);
  const plan = toPlan(experiences);
  return {
    plan: {
      ...plan,
      responseText:
        experiences.length > 0
          ? "I widened the search—these are the cleanest verified fits."
          : "I widened the verified search and didn’t find a clean match in this snapshot.",
    },
    stagedPreferenceUpdates: [],
    experiences,
    command: null,
    requiresLifecycleMutation: false,
    diagnostics: {
      ...DIRECT_EVENT_DIAGNOSTICS,
      toolCalls: fallback === null ? 1 : 2,
      backendDataCalls: fallback === null ? 1 : 2,
      inferredFallbackUsed: fallback !== null && fallback.items.length > 0,
      observedRetrievalWeak: observed.weak,
    },
  };
}
