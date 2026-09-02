import type { CoastDataSource } from "./data-source";
import type { ExperienceRecord, TurnPlan } from "../coast/contracts";
import type { AgentRunDiagnostics, AgentRunResult } from "./runtime";

const SAN_FRANCISCO_TIME_ZONE = "America/Los_Angeles";
const TODAY_EVENT_PATTERN =
  /\b(?:what(?:'s| is)|whats|wats).{0,32}\b(?:(?:going|goin)\s+on|happening)\b.{0,32}\b(?:tonight|toight|tonite|today|tn)\b|\b(?:events?|shows?|concerts?|parties?)\b.{0,32}\b(?:tonight|toight|tonite|today|tn)\b/iu;
const MAX_DAILY_AGENDA_RESULTS = 30;
export const DAILY_AGENDA_POLL_QUESTION = "Want a tighter event lane?";

const AGENDA_FILTERS = [
  { label: "Live music", categories: ["live_music"] },
  { label: "DJs & dancing", categories: ["dj_dance", "nightlife_party"] },
  { label: "Comedy", categories: ["comedy"] },
  { label: "Arts & culture", categories: ["theatre_performance", "visual_arts", "film"] },
  { label: "Food & drink", categories: ["food_drink", "market_pop_up"] },
] as const;

type AgendaFilter = (typeof AGENDA_FILTERS)[number] | { label: "Keep the full agenda"; categories: [] };

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

/** Recognizes only COAST's own optional agenda poll, never free-form text. */
export function agendaFilterFromPollReply(message: string): AgendaFilter | null {
  const match = message.match(
    /^poll answer:\s*want a tighter event lane\?\s*[—-]\s*(.+)$/iu,
  );
  if (!match?.[1]) return null;
  const normalized = normalizeAgendaLabel(match[1]);
  if (normalized === normalizeAgendaLabel("Keep the full agenda")) {
    return { label: "Keep the full agenda", categories: [] };
  }
  return AGENDA_FILTERS.find(
    (filter) => normalizeAgendaLabel(filter.label) === normalized,
  ) ?? null;
}

function toPlan(
  experiences: readonly ExperienceRecord[],
  filter: AgendaFilter | null,
): TurnPlan {
  if (experiences.length === 0) {
    return {
      responseText:
        filter === null
          ? "I couldn’t verify a live SF event for today in this snapshot."
          : `I couldn’t verify a ${filter.label.toLowerCase()} event still active today.`,
      selectedExternalIds: [],
      dailyAgendaExternalIds: [],
      poll: null,
      preferenceUpdates: [],
      provenanceIds: [],
    };
  }
  const poll = filter === null ? buildAgendaFilterPoll(experiences) : null;
  return {
    responseText:
      filter === null
        ? experiences.length === 1
          ? "Here’s the verified SF move still on deck today."
          : `I pulled the full verified SF agenda: ${experiences.length} events still on deck today.`
        : filter.categories.length === 0
          ? `Keeping it wide: ${experiences.length} verified SF events are still on deck today.`
          : `${experiences.length} verified ${filter.label.toLowerCase()} move${experiences.length === 1 ? "" : "s"} still on deck today.`,
    selectedExternalIds: [],
    dailyAgendaExternalIds: experiences.map((item) => item.externalId),
    poll,
    ...(filter === null && poll !== null
      ? { pollKind: "agenda_filter" as const }
      : {}),
    preferenceUpdates: [],
    provenanceIds: [...new Set(experiences.flatMap((item) => item.provenanceIds))].slice(0, 30),
  };
}

function buildAgendaFilterPoll(
  experiences: readonly ExperienceRecord[],
): TurnPlan["poll"] {
  const available = AGENDA_FILTERS.filter((filter) =>
    experiences.some((experience) =>
      experience.eventCategories?.some((category) =>
        filter.categories.some((expected) => expected === category.trim().toLowerCase()),
      ),
    ),
  );
  if (available.length < 2) return null;
  return {
    question: DAILY_AGENDA_POLL_QUESTION,
    options: [...available.slice(0, 5).map((filter) => filter.label), "Keep the full agenda"],
    multiple: false,
  };
}

function normalizeAgendaLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

function hasAgendaCategory(
  experience: ExperienceRecord,
  categories: readonly string[],
): boolean {
  if (categories.length === 0) return true;
  const actual = new Set(
    (experience.eventCategories ?? [])
      .map((category) => category.trim().toLowerCase())
      .filter(Boolean),
  );
  return categories.some((category) => actual.has(category));
}

function agendaOrder(left: ExperienceRecord, right: ExperienceRecord): number {
  const leftStart = left.startAtMs ?? Number.MAX_SAFE_INTEGER;
  const rightStart = right.startAtMs ?? Number.MAX_SAFE_INTEGER;
  return leftStart - rightStart || left.title.localeCompare(right.title) || left.externalId.localeCompare(right.externalId);
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
  filter?: AgendaFilter | null;
}): Promise<AgentRunResult> {
  const window = currentSanFranciscoDay(input.nowMs);
  const directEvents = input.dataSource.listActiveEvents === undefined
    ? null
    : await input.dataSource.listActiveEvents({
      startAtMs: window.startAtMs,
      endAtMs: window.endAtMs,
      limit: MAX_DAILY_AGENDA_RESULTS,
    });
  const result = directEvents === null
    ? await input.dataSource.searchExperiences({
      query: "events",
      entityType: "event",
      neighborhoods: [],
      primaryTypes: [],
      priceBands: [],
      startAtMs: window.startAtMs,
      endAtMs: window.endAtMs,
      limit: MAX_DAILY_AGENDA_RESULTS,
      matchMode: "observed",
    })
    : { items: directEvents };
  const filter = input.filter ?? null;
  const experiences = result.items
    .filter((item) => item.entityType === "event")
    .filter((item) => hasAgendaCategory(item, filter?.categories ?? []))
    .sort(agendaOrder)
    .slice(0, MAX_DAILY_AGENDA_RESULTS);
  return {
    plan: toPlan(experiences, filter),
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
  const plan: TurnPlan = {
    responseText: "",
    selectedExternalIds: experiences.map((item) => item.externalId),
    poll: null,
    preferenceUpdates: [],
    provenanceIds: [...new Set(experiences.flatMap((item) => item.provenanceIds))].slice(0, 30),
  };
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
