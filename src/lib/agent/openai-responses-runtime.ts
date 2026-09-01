import type OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type {
  ParsedResponse,
  ParsedResponseFunctionToolCall,
  ResponseInputItem,
} from "openai/resources/responses/responses";

import {
  buildCommandResult,
  classifyCoastCommand,
} from "../coast/commands";
import {
  containsDestinationUrl,
  isExperienceEligible,
  TurnPlanSchema,
  type ExperienceRecord,
  type PreferenceUpdate,
  type TurnPlan,
} from "../coast/contracts";
import { COAST_SYSTEM_PROMPT } from "../coast/persona";
import type { CoastDataSource } from "./data-source";
import {
  escalateRoute,
  selectInitialModel,
  TERRA_MODEL,
  type ModelRoute,
} from "./model-routing";
import {
  COAST_RESPONSE_TOOLS,
  createCoastDataCallBudget,
  createToolLedger,
  executeCoastTool,
  hydrateDiscoveredExperiences,
  type CoastSearchHydration,
  type FunctionCallLike,
  type FunctionCallOutputLike,
} from "./tools";
import {
  AgentRuntimeError,
  type AgentRunInput,
  type AgentRunResult,
  type AgentRuntime,
} from "./runtime";
import {
  isTodayEventsRequest,
  resolveExhaustedClarification,
  resolveTodayEvents,
} from "./today-events";

const MAX_MODEL_STEPS = 2;
const MAX_TOOL_CALLS = 4;
const MAX_BACKEND_DATA_CALLS = 4;
const TURN_PLAN_FORMAT = zodTextFormat(TurnPlanSchema, "coast_turn_plan");

export type ResponsesApi = Pick<OpenAI["responses"], "parse">;

export interface OpenAIResponsesRuntimeOptions {
  responses: ResponsesApi;
  dataSource: CoastDataSource;
  lunaModel?: string;
  terraModel?: string;
}

function asFunctionCalls(
  response: ParsedResponse<unknown>,
): ParsedResponseFunctionToolCall[] {
  return response.output.filter(
    (item): item is ParsedResponseFunctionToolCall =>
      item.type === "function_call",
  );
}

function parseTurnPlan(response: ParsedResponse<unknown>): TurnPlan | null {
  const parsed = TurnPlanSchema.safeParse(response.output_parsed);
  if (parsed.success) {
    return parsed.data;
  }

  if (response.output_text) {
    try {
      const fallback = TurnPlanSchema.safeParse(JSON.parse(response.output_text));
      return fallback.success ? fallback.data : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Remove SDK-only parsed fields before statelessly continuing a response. */
function toContinuationItems(
  response: ParsedResponse<unknown>,
): ResponseInputItem[] {
  return response.output.map((item) => {
    if (item.type === "function_call") {
      const wireItem = { ...item } as Partial<typeof item>;
      delete wireItem.parsed_arguments;
      return wireItem as ResponseInputItem;
    }
    if (item.type === "message") {
      return {
        ...item,
        content: item.content.map((content) => {
          if (content.type !== "output_text") {
            return content;
          }
          const wireContent = { ...content } as Partial<typeof content>;
          delete wireContent.parsed;
          return wireContent;
        }),
      } as ResponseInputItem;
    }
    return item as ResponseInputItem;
  });
}

function validateAndGroundPlan(
  plan: TurnPlan,
  experiences: ReadonlyMap<string, ExperienceRecord>,
  availableProvenanceIds: ReadonlySet<string>,
): TurnPlan {
  const pollText = plan.poll
    ? [plan.poll.question, ...plan.poll.options].join(" ")
    : "";
  if (
    containsDestinationUrl(plan.responseText) ||
    containsDestinationUrl(pollText) ||
    /(?:\$\s?\d|\b(?:available|sold out|tickets? cost|doors at|open until|performing|order the|serves? the)\b)/iu.test(
      plan.responseText,
    )
  ) {
    throw new AgentRuntimeError(
      "Model output attempted to provide a destination URL",
      "policy_violation",
    );
  }

  const selectedExternalIds = [...new Set(plan.selectedExternalIds)];
  if (selectedExternalIds.some((externalId) => !experiences.has(externalId))) {
    throw new AgentRuntimeError(
      "Model selected an experience that was not retrieved",
      "policy_violation",
    );
  }
  const provenanceIds = [...new Set(plan.provenanceIds)];
  if (provenanceIds.some((id) => !availableProvenanceIds.has(id))) {
    throw new AgentRuntimeError(
      "Model cited provenance that was not retrieved",
      "policy_violation",
    );
  }
  if (selectedExternalIds.length > 0) {
    if (provenanceIds.length === 0) {
      throw new AgentRuntimeError(
        "Selected results require source provenance",
        "policy_violation",
      );
    }
    const cited = new Set(provenanceIds);
    for (const externalId of selectedExternalIds) {
      const experience = experiences.get(externalId);
      if (!experience?.provenanceIds.some((id) => cited.has(id))) {
        throw new AgentRuntimeError(
          "Every selected result requires matching source provenance",
          "policy_violation",
        );
      }
    }
  }

  return { ...plan, selectedExternalIds, provenanceIds };
}

function modelName(
  route: ModelRoute,
  options: OpenAIResponsesRuntimeOptions,
): string {
  return route.model === TERRA_MODEL
    ? (options.terraModel ?? route.model)
    : (options.lunaModel ?? route.model);
}

function modelRequestOptions(
  route: ModelRoute,
  options: OpenAIResponsesRuntimeOptions,
) {
  const isTerra = route.model === TERRA_MODEL;
  return {
    model: modelName(route, options),
    reasoning: { effort: isTerra ? "low" as const : "high" as const },
    ...(isTerra ? {} : { service_tier: "fast" as const }),
  };
}

function serviceTierFrom(response: ParsedResponse<unknown>): string | undefined {
  const value = (response as { service_tier?: unknown }).service_tier;
  return typeof value === "string" ? value : undefined;
}

function baseConversation(input: AgentRunInput): ResponseInputItem[] {
  const recent = (input.recentMessages ?? []).slice(-8).map((message) => ({
    role: message.role,
    content: message.content,
  })) satisfies ResponseInputItem[];
  return [
    ...recent,
    {
      role: "user",
      content: `${input.message}\n\nCurrent time (Unix ms): ${input.nowMs ?? Date.now()}`,
    },
  ];
}

function safetyIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 64) || "anonymous";
}

function preferenceUpdateIdentity(update: PreferenceUpdate): string {
  return JSON.stringify([update.key, update.operation, update.values]);
}

function mergePreferenceUpdates(
  staged: readonly PreferenceUpdate[],
  planned: readonly PreferenceUpdate[],
): PreferenceUpdate[] {
  const updates: PreferenceUpdate[] = [];
  const seen = new Set<string>();
  for (const update of [...staged, ...planned]) {
    const identity = preferenceUpdateIdentity(update);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    updates.push({ ...update, values: [...update.values] });
  }
  return updates;
}

function attachSearchHydration(
  output: FunctionCallOutputLike,
  hydration: CoastSearchHydration,
): FunctionCallOutputLike {
  try {
    const parsed = JSON.parse(output.output) as Record<string, unknown>;
    if ("error" in parsed) {
      return output;
    }
    return {
      ...output,
      output: JSON.stringify({
        ...parsed,
        hydratedDetails: hydration.details,
        explicitRecommendations: hydration.explicitRecommendations,
      }),
    };
  } catch {
    return output;
  }
}

function duplicateSearchOutput(callId: string): FunctionCallOutputLike {
  return {
    type: "function_call_output",
    call_id: callId,
    output: JSON.stringify({
      error: "Only one searchExperiences call is allowed per turn",
    }),
  };
}

export class OpenAIResponsesRuntime implements AgentRuntime {
  constructor(private readonly options: OpenAIResponsesRuntimeOptions) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const command = classifyCoastCommand(input.message);
    if (command) {
      const result = buildCommandResult(command);
      return {
        plan: result.plan,
        stagedPreferenceUpdates: [],
        experiences: [],
        command,
        requiresLifecycleMutation: result.requiresLifecycleMutation,
        diagnostics: {
          model: "deterministic",
          routeReasons: [],
          constraintCount: 0,
          modelSteps: 0,
          toolCalls: 0,
          backendDataCalls: 0,
          rejectedToolCalls: 0,
          inferredFallbackUsed: false,
          observedRetrievalWeak: false,
        },
      };
    }

    const nowMs = input.nowMs ?? Date.now();
    if (isTodayEventsRequest(input.message)) {
      return resolveTodayEvents({ dataSource: this.options.dataSource, nowMs });
    }
    if ((input.clarificationDepth ?? 0) >= 2) {
      return resolveExhaustedClarification({
        dataSource: this.options.dataSource,
        nowMs,
        message: input.message,
        ...(input.recentMessages === undefined
          ? {}
          : { recentMessages: input.recentMessages }),
      });
    }
    let route = selectInitialModel(input);
    let modelSteps = 0;
    let toolCalls = 0;
    let rejectedToolCalls = 0;
    const ledger = createToolLedger();
    const dataCallBudget = createCoastDataCallBudget(MAX_BACKEND_DATA_CALLS);
    const conversation = baseConversation({ ...input, nowMs });

    const first = await this.options.responses.parse({
      ...modelRequestOptions(route, this.options),
      instructions: COAST_SYSTEM_PROMPT,
      input: conversation,
      tools: [...COAST_RESPONSE_TOOLS],
      parallel_tool_calls: true,
      text: { format: TURN_PLAN_FORMAT },
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: 1_200,
      safety_identifier: safetyIdentifier(input.pseudonymousUserId),
    }, { signal: input.signal });
    modelSteps += 1;
    let actualServiceTier = serviceTierFrom(first);

    const calls = asFunctionCalls(first);
    let rawPlan = parseTurnPlan(first);

    if (calls.length > 0) {
      const acceptedCalls = calls.slice(0, MAX_TOOL_CALLS);
      rejectedToolCalls = Math.max(0, calls.length - acceptedCalls.length);
      const outputs: FunctionCallOutputLike[] = new Array(
        acceptedCalls.length,
      );
      const primarySearchIndex = acceptedCalls.findIndex(
        (call) => call.name === "searchExperiences",
      );

      if (primarySearchIndex >= 0) {
        const searchCall = acceptedCalls[primarySearchIndex];
        if (searchCall) {
          let searchOutput = await executeCoastTool({
            call: searchCall as FunctionCallLike,
            dataSource: this.options.dataSource,
            ledger,
            nowMs,
            pseudonymousUserId: input.pseudonymousUserId,
            dataCallBudget,
          });
          if (ledger.experiences.size > 0) {
            const hydration = await hydrateDiscoveredExperiences({
              dataSource: this.options.dataSource,
              ledger,
              nowMs,
              dataCallBudget,
            });
            searchOutput = attachSearchHydration(searchOutput, hydration);
          }
          outputs[primarySearchIndex] = searchOutput;
        }
      }

      for (const [index, call] of acceptedCalls.entries()) {
        if (index === primarySearchIndex) {
          continue;
        }
        outputs[index] = call.name === "searchExperiences"
          ? duplicateSearchOutput(call.call_id)
          : await executeCoastTool({
              call: call as FunctionCallLike,
              dataSource: this.options.dataSource,
              ledger,
              nowMs,
              pseudonymousUserId: input.pseudonymousUserId,
              dataCallBudget,
            });
      }
      toolCalls = acceptedCalls.length;

      const rejectedOutputs = calls.slice(MAX_TOOL_CALLS).map((call) => ({
        type: "function_call_output" as const,
        call_id: call.call_id,
        output: JSON.stringify({ error: "Per-turn tool-call limit reached" }),
      }));

      if (ledger.observedRetrievalWeak) {
        route = escalateRoute(route, "weak_retrieval");
      }
      if (modelSteps >= MAX_MODEL_STEPS) {
        throw new AgentRuntimeError(
          "The model requested tools after the model-step limit",
          "model_step_limit",
        );
      }

      const continuation = await this.options.responses.parse({
        ...modelRequestOptions(route, this.options),
        instructions: COAST_SYSTEM_PROMPT,
        input: [
          ...conversation,
          ...toContinuationItems(first),
          ...outputs,
          ...rejectedOutputs,
        ],
        text: { format: TURN_PLAN_FORMAT },
        store: false,
        include: ["reasoning.encrypted_content"],
        max_output_tokens: 1_200,
        safety_identifier: safetyIdentifier(input.pseudonymousUserId),
      }, { signal: input.signal });
      modelSteps += 1;
      rawPlan = parseTurnPlan(continuation);
      actualServiceTier = serviceTierFrom(continuation) ?? actualServiceTier;
    } else if (!rawPlan && route.model !== TERRA_MODEL) {
      route = escalateRoute(route, "failed_luna_structured_output");
      const repair = await this.options.responses.parse({
        ...modelRequestOptions(route, this.options),
        instructions: `${COAST_SYSTEM_PROMPT}\n\nThe prior Luna output did not validate. Return one valid coast_turn_plan object now without calling tools.`,
        input: conversation,
        text: { format: TURN_PLAN_FORMAT },
        store: false,
        include: ["reasoning.encrypted_content"],
        max_output_tokens: 1_200,
        safety_identifier: safetyIdentifier(input.pseudonymousUserId),
      }, { signal: input.signal });
      modelSteps += 1;
      rawPlan = parseTurnPlan(repair);
      actualServiceTier = serviceTierFrom(repair) ?? actualServiceTier;
    }

    if (!rawPlan) {
      throw new AgentRuntimeError(
        "The model did not return a valid TurnPlan within two steps",
        "invalid_structured_output",
        TERRA_MODEL,
      );
    }

    const plan = validateAndGroundPlan(
      rawPlan,
      ledger.experiences,
      ledger.availableProvenanceIds,
    );
    const preferenceUpdates = mergePreferenceUpdates(
      ledger.stagedPreferenceUpdates,
      plan.preferenceUpdates,
    );

    const experiences: ExperienceRecord[] = plan.selectedExternalIds
      .map((externalId) => ledger.experiences.get(externalId))
      .filter((item): item is ExperienceRecord => Boolean(item))
      .filter((item) => isExperienceEligible(item, nowMs));

    const finalPlan: TurnPlan = {
      ...plan,
      selectedExternalIds: experiences.map((item) => item.externalId),
      preferenceUpdates,
    };
    const stagedPreferenceUpdates = finalPlan.preferenceUpdates.map(
      (update) => ({ ...update, values: [...update.values] }),
    );
    if (stagedPreferenceUpdates.length > 0) {
      input.onPreferenceUpdatesStaged?.(stagedPreferenceUpdates);
    }

    return {
      plan: finalPlan,
      stagedPreferenceUpdates,
      experiences,
      command: null,
      requiresLifecycleMutation: false,
      diagnostics: {
        model: route.model,
        routeReasons: route.reasons,
        constraintCount: route.constraintCount,
        modelSteps,
        toolCalls,
        backendDataCalls: dataCallBudget.usedCalls,
        rejectedToolCalls,
        inferredFallbackUsed: ledger.usedInferredFallback,
        observedRetrievalWeak: ledger.observedRetrievalWeak,
        ...(actualServiceTier === undefined ? {} : { serviceTier: actualServiceTier }),
      },
    };
  }
}

/** Explicit production name used from Convex Node actions. */
export { OpenAIResponsesRuntime as OpenAIResponsesAgentRuntime };
