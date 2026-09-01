import OpenAI from "openai";
import { z } from "zod";

import {
  buildAgentContextMessage,
  OpenAIResponsesAgentRuntime,
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
export const maxDuration = 30;

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
    limits: z
      .object({
        modelSteps: z.literal(2),
        toolCalls: z.literal(4),
      })
      .strict(),
  })
  .strict();

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

  try {
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const dataSource = new ConvexCoastDataSource(
      getConvexHttpClient(env.CONVEX_URL),
      Date.now(),
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
    });
    const result = await agent.run({
      message: latest.body,
      pseudonymousUserId: input.threadId,
      recentMessages: [...history, applicationContext],
      isFirstTurn,
      savedPreferences,
      priorSelections: input.priorSelections ?? [],
      retrievalQuality: "unknown",
      nowMs: Date.now(),
      signal: request.signal,
    });
    const plan = withNativeChoiceRecovery({
      plan: result.plan,
      command: result.command,
      latestMessage: latest.body,
      recentMessages: input.messages,
    });

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
          : "luna_low",
      routeReasons: result.diagnostics.routeReasons,
      modelSteps: result.diagnostics.modelSteps,
      toolCalls: result.diagnostics.toolCalls,
      retrievalMode: result.diagnostics.inferredFallbackUsed
        ? "inferred_fallback"
        : result.experiences.length > 0
          ? "observed"
          : "none",
    });
  } catch {
    return privateJson({ error: "generation_failed" }, { status: 502 });
  }
}
