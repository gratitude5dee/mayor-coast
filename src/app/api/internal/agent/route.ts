import OpenAI from "openai";
import { z } from "zod";

import {
  buildAgentContextMessage,
  OpenAIResponsesAgentRuntime,
  resolveCalendarRequest,
  sanitizeAgentHistoryText,
  shouldDeliverClarificationPoll,
  withNativeChoiceRecovery,
} from "@/lib/agent";
import { withCoastFirstTurnIntro } from "@/lib/coast";
import { ConvexCoastDataSource, getConvexHttpClient } from "@/lib/convex";
import { parseServerEnv } from "@/lib/env";
import {
  authorizeInternalRequest,
  privateJson,
} from "@/lib/security/internal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 5;

/** Leave a little time for the signed caller to persist and deliver a fallback. */
const PLANNING_DEADLINE_MS = 2_400;

const messageSchema = z
  .object({
    direction: z.enum(["inbound", "outbound"]),
    body: z.string().max(12_000),
    createdAtMs: z.number().int().nonnegative(),
  })
  .strict();

const priorSelectionSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            externalId: z.string().min(1).max(240),
            title: z.string().min(1).max(200),
          })
          .strict(),
      )
      .min(1)
      .max(5),
  })
  .strict();

const requestSchema = z
  .object({
    turnId: z.string().min(1).max(256),
    threadId: z.string().min(1).max(256),
    messages: z.array(messageSchema).min(1).max(20),
    isFirstTurn: z.boolean().optional(),
    priorSelections: z.array(priorSelectionSchema).max(3).optional(),
    preferences: z
      .array(
        z
          .object({
            namespace: z.string().max(64),
            key: z.string().max(64),
            value: z.unknown(),
            confidence: z.number().min(0).max(1),
            source: z.enum(["explicit", "inferred"]),
          })
          .strict(),
      )
      .max(50),
    clarificationDepth: z.number().int().min(0).max(2).optional(),
    limits: z
      .object({
        modelSteps: z.literal(2),
        toolCalls: z.literal(4),
      })
      .strict(),
  })
  .strict();

function deadlineFallback(input: {
  isFirstTurn: boolean;
  elapsedMs: number;
}): Response {
  return privateJson({
    responseText: withCoastFirstTurnIntro(
      "I hit a brief delay pulling the verified guide. Send that move again and I’ll keep it tight.",
      input.isFirstTurn,
    ),
    selectedExternalIds: [],
    poll: null,
    preferenceUpdates: [],
    provenanceIds: [],
    modelRoute: "luna_high_fast",
    routeReasons: ["planning_deadline_fallback"],
    modelSteps: 0,
    toolCalls: 0,
    retrievalMode: "none",
    generationKind: "deadline_fallback",
    elapsedMs: input.elapsedMs,
    serviceTier: null,
  });
}

export async function POST(request: Request): Promise<Response> {
  let env;
  try {
    env = parseServerEnv();
  } catch {
    return privateJson({ error: "runtime_not_configured" }, { status: 503 });
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

  const latestInboundIndex = input.messages.findLastIndex(
    (message) => message.direction === "inbound",
  );
  if (latestInboundIndex < 0) {
    return privateJson({ error: "missing_inbound_message" }, { status: 400 });
  }

  const startedAtMs = Date.now();
  const deadlineSignal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(PLANNING_DEADLINE_MS),
  ]);
  try {
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const nowMs = Date.now();
    const dataSource = new ConvexCoastDataSource(
      getConvexHttpClient(env.CONVEX_URL),
      nowMs,
    );
    const agent = new OpenAIResponsesAgentRuntime({
      responses: openai.responses,
      dataSource,
      lunaModel: env.OPENAI_MODEL_LUNA,
      terraModel: env.OPENAI_MODEL_TERRA,
    });
    const latest = input.messages[latestInboundIndex];
    if (!latest) throw new Error("missing latest message");
    const isFirstTurn =
      input.isFirstTurn ??
      !input.messages.some(
        (message, index) =>
          index !== latestInboundIndex && message.direction === "outbound",
      );
    const history = input.messages
      .filter((_, index) => index !== latestInboundIndex)
      .slice(-7)
      .map((message) => ({
        role: message.direction === "inbound" ? "user" as const : "assistant" as const,
        content: sanitizeAgentHistoryText(message.body),
      }));
    const savedPreferences = input.preferences.map((preference) => ({
      namespace: preference.namespace,
      key: preference.key,
      value: preference.value,
      confidence: preference.confidence,
      source: preference.source,
    }));
    const applicationContext = buildAgentContextMessage({
      isFirstTurn,
      savedPreferences,
      priorSelections: input.priorSelections ?? [],
      clarificationDepth: input.clarificationDepth ?? 0,
    });
    const calendarRequest = resolveCalendarRequest({
      latestMessage: latest.body,
      recentInboundMessages: input.messages
        .slice(0, latestInboundIndex)
        .filter((message) => message.direction === "inbound")
        .map((message) => message.body),
      priorSelections: input.priorSelections ?? [],
      nowMs,
    });
    if (calendarRequest?.kind === "clarify") {
      return privateJson({
        responseText: withCoastFirstTurnIntro(calendarRequest.responseText, isFirstTurn),
        selectedExternalIds: [],
        poll: calendarRequest.poll === null
          ? null
          : { question: calendarRequest.poll.question, options: calendarRequest.poll.options },
        preferenceUpdates: [],
        provenanceIds: [],
        modelRoute: "luna_high_fast",
        routeReasons: ["deterministic_calendar_clarification"],
        modelSteps: 0,
        toolCalls: 0,
        retrievalMode: "none",
        generationKind: "deterministic",
        elapsedMs: Date.now() - startedAtMs,
        serviceTier: null,
      });
    }
    if (calendarRequest?.kind === "create") {
      const [experience] = await dataSource.getExperienceDetails([
        calendarRequest.externalId,
      ]);
      if (experience?.externalId === calendarRequest.externalId) {
        return privateJson({
          responseText: withCoastFirstTurnIntro(
            `Locked: a one-tap calendar hold for ${calendarRequest.title}, with a 15-minute reminder. This is not a reservation—use the booking or contact option I send next to confirm it.`,
            isFirstTurn,
          ),
          selectedExternalIds: [],
          poll: null,
          preferenceUpdates: [],
          provenanceIds: [],
          modelRoute: "luna_high_fast",
          routeReasons: ["deterministic_calendar_hold"],
          modelSteps: 0,
          toolCalls: 1,
          retrievalMode: "observed",
          generationKind: "deterministic",
          elapsedMs: Date.now() - startedAtMs,
          serviceTier: null,
          nextAction: {
            type: "create_calendar",
            targetExternalId: calendarRequest.externalId,
            startAtMs: calendarRequest.startAtMs,
            endAtMs: calendarRequest.endAtMs,
          },
        });
      }
    }
    const result = await agent.run({
      message: latest.body,
      pseudonymousUserId: input.threadId,
      recentMessages: [...history, applicationContext],
      isFirstTurn,
      savedPreferences,
      priorSelections: input.priorSelections ?? [],
      retrievalQuality: "unknown",
      clarificationDepth: input.clarificationDepth ?? 0,
      nowMs,
      signal: deadlineSignal,
    });
    const plan = withNativeChoiceRecovery({
      plan: result.plan,
      command: result.command,
      latestMessage: latest.body,
      recentMessages: input.messages,
      clarificationDepth: input.clarificationDepth ?? 0,
      suppressRecovery: result.diagnostics.deterministicFallback ?? false,
    });

    const elapsedMs = Date.now() - startedAtMs;

    return privateJson({
      responseText: withCoastFirstTurnIntro(
        plan.responseText,
        isFirstTurn,
      ),
      selectedExternalIds: plan.selectedExternalIds,
      poll: shouldDeliverClarificationPoll(plan) && plan.poll
        ? {
            question: plan.poll.question,
            options: plan.poll.options,
          }
        : null,
      preferenceUpdates: plan.preferenceUpdates.map((update) => ({
        namespace: "preference",
        key: update.key,
        value: { operation: update.operation, values: update.values },
        confidence: 1,
        source: "explicit" as const,
      })),
      provenanceIds: plan.provenanceIds,
      modelRoute:
        result.diagnostics.model === "gpt-5.6-terra"
          ? "terra_low"
          : "luna_high_fast",
      routeReasons: result.diagnostics.routeReasons,
      modelSteps: result.diagnostics.modelSteps,
      toolCalls: result.diagnostics.toolCalls,
      retrievalMode: result.diagnostics.inferredFallbackUsed
        ? "inferred_fallback"
        : result.experiences.length > 0
          ? "observed"
          : "none",
      generationKind:
        result.diagnostics.model === "deterministic" ? "deterministic" : "model",
      elapsedMs,
      serviceTier: result.diagnostics.serviceTier ?? null,
    });
  } catch {
    return deadlineFallback({
      isFirstTurn:
        input.isFirstTurn ??
        !input.messages.some((message) => message.direction === "outbound"),
      elapsedMs: Date.now() - startedAtMs,
    });
  }
}
