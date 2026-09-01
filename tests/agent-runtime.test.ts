import { describe, expect, it, vi } from "vitest";

import type { CoastDataSource } from "../src/lib/agent/data-source";
import {
  OpenAIResponsesRuntime,
  type ResponsesApi,
} from "../src/lib/agent/openai-responses-runtime";
import { buildAgentContextMessage } from "../src/lib/agent/runtime";
import { COAST_RESPONSE_TOOLS } from "../src/lib/agent/tools";
import { LUNA_MODEL, TERRA_MODEL } from "../src/lib/agent/model-routing";
import { currentSanFranciscoDay } from "../src/lib/agent/today-events";
import type {
  ExperienceRecord,
  PreferenceUpdate,
  SourceBackedRecommendation,
  TurnPlan,
} from "../src/lib/coast/contracts";

const EMPTY_PLAN: TurnPlan = {
  responseText: "I’m on it.",
  selectedExternalIds: [],
  poll: null,
  preferenceUpdates: [],
  provenanceIds: [],
};

function fakeResponse(input: {
  output?: unknown[];
  outputParsed?: unknown;
  outputText?: string;
}) {
  return {
    output: input.output ?? [],
    output_parsed: input.outputParsed ?? null,
    output_text: input.outputText ?? "",
  } as never;
}

function dataSource(): CoastDataSource {
  return {
    searchExperiences: vi.fn(async () => ({ items: [], weak: false })),
    getExperienceDetails: vi.fn(async () => []),
    getRecommendations: vi.fn(async () => []),
    savePreferences: vi.fn(async (_user, updates) => ({ applied: updates.length })),
  };
}

function place(
  externalId: string,
  observedSummary = "A source-backed summary.",
): ExperienceRecord {
  return {
    externalId,
    entityType: "place",
    title: externalId,
    canonicalUrl: `https://example.com/${externalId}`,
    timingLabel: "Mission",
    observedSummary,
    provenanceIds: [`claim:${externalId}`],
    matchBasis: "observed",
    lifecycleStatus: "active",
  };
}

function responsesQueue(...responses: never[]) {
  const parse = vi.fn(async (request: unknown, options?: unknown) => {
    void request;
    void options;
    return responses.shift();
  });
  return { parse, api: { parse } as unknown as ResponsesApi };
}

describe("OpenAIResponsesRuntime", () => {
  it("uses one exact America/Los_Angeles calendar day for today events", () => {
    expect(currentSanFranciscoDay(Date.parse("2026-09-01T18:00:00-07:00"))).toEqual({
      startAtMs: Date.parse("2026-09-01T00:00:00-07:00"),
      endAtMs: Date.parse("2026-09-02T00:00:00-07:00"),
    });
  });

  it("uses raw Responses with Luna/high on the Fast tier by default", async () => {
    const responses = responsesQueue(
      fakeResponse({ outputParsed: EMPTY_PLAN }),
    );
    const runtime = new OpenAIResponsesRuntime({
      responses: responses.api,
      dataSource: dataSource(),
    });

    const result = await runtime.run({
      message: "What should I do tonight?",
      pseudonymousUserId: "sender_hash",
      nowMs: Date.parse("2026-09-01T00:00:00-07:00"),
    });

    expect(result.diagnostics.model).toBe(LUNA_MODEL);
    expect(result.diagnostics.modelSteps).toBe(1);
    const request = responses.parse.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request.model).toBe(LUNA_MODEL);
    expect(request.store).toBe(false);
    expect(request.reasoning).toEqual({ effort: "high" });
    expect(request.service_tier).toBe("fast");
    expect(request.tools).toHaveLength(4);
  });

  it("forwards bounded application context as a developer message", async () => {
    const responses = responsesQueue(
      fakeResponse({ outputParsed: EMPTY_PLAN }),
    );
    const runtime = new OpenAIResponsesRuntime({
      responses: responses.api,
      dataSource: dataSource(),
    });
    const context = buildAgentContextMessage({
      isFirstTurn: false,
      savedPreferences: [
        {
          namespace: "preference",
          key: "cuisines",
          value: ["Japanese"],
          confidence: 1,
          source: "explicit",
        },
      ],
    });

    await runtime.run({
      message: "Find me dinner",
      pseudonymousUserId: "sender_hash",
      recentMessages: [context],
      nowMs: Date.parse("2026-09-01T00:00:00-07:00"),
    });

    const request = responses.parse.mock.calls[0]?.[0] as {
      input: Array<{ role?: string; content?: string }>;
    };
    expect(request.input[0]).toMatchObject({ role: "developer" });
    expect(request.input[0]?.content).toContain('"cuisines"');
    expect(request.input[0]?.content).toContain('"Japanese"');
  });

  it("escalates a failed Luna structured output to Terra within two steps", async () => {
    const responses = responsesQueue(
      fakeResponse({ outputParsed: null }),
      fakeResponse({ outputParsed: EMPTY_PLAN }),
    );
    const runtime = new OpenAIResponsesRuntime({
      responses: responses.api,
      dataSource: dataSource(),
    });

    const result = await runtime.run({
      message: "Find me a fun spot",
      pseudonymousUserId: "sender_hash",
      nowMs: Date.parse("2026-09-01T00:00:00-07:00"),
    });

    expect(responses.parse).toHaveBeenCalledTimes(2);
    expect(responses.parse.mock.calls[0]?.[0]).toMatchObject({ model: LUNA_MODEL });
    expect(responses.parse.mock.calls[1]?.[0]).toMatchObject({ model: TERRA_MODEL });
    expect(responses.parse.mock.calls[1]?.[0]).toMatchObject({
      reasoning: { effort: "low" },
    });
    expect(responses.parse.mock.calls[1]?.[0]).not.toHaveProperty("service_tier");
    expect(result.diagnostics.routeReasons).toContain(
      "failed_luna_structured_output",
    );
  });

  it("retrieves only current-day SF event cards for a tonight typo without polling the model", async () => {
    const responses = responsesQueue();
    const event: ExperienceRecord = {
      ...place("event:tonight"),
      entityType: "event",
      title: "Tonight's Source-Backed Show",
      startAtMs: Date.parse("2026-09-02T03:00:00Z"),
    };
    const source = dataSource();
    source.searchExperiences = vi.fn(async () => ({
      items: [event],
      weak: false,
    }));
    const runtime = new OpenAIResponsesRuntime({
      responses: responses.api,
      dataSource: source,
    });

    const result = await runtime.run({
      message: "What events are going on toight?",
      pseudonymousUserId: "sender_hash",
      nowMs: Date.parse("2026-09-01T18:00:00-07:00"),
    });

    expect(responses.parse).not.toHaveBeenCalled();
    expect(source.searchExperiences).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "events",
        entityType: "event",
        limit: 5,
        matchMode: "observed",
      }),
    );
    expect(result.plan.poll).toBeNull();
    expect(result.plan.selectedExternalIds).toEqual(["event:tonight"]);
    expect(result.experiences.every((item) => item.entityType === "event")).toBe(true);
  });

  it("broadens deterministically after two poll answers instead of creating a third poll", async () => {
    const responses = responsesQueue();
    const source = dataSource();
    source.searchExperiences = vi.fn(async () => ({
      items: [place("place:mission-dinner")],
      weak: false,
    }));
    const runtime = new OpenAIResponsesRuntime({
      responses: responses.api,
      dataSource: source,
    });

    const result = await runtime.run({
      message: "Mission",
      pseudonymousUserId: "sender_hash",
      clarificationDepth: 2,
      recentMessages: [{ role: "user", content: "Food tonight" }],
      nowMs: Date.parse("2026-09-01T18:00:00-07:00"),
    });

    expect(responses.parse).not.toHaveBeenCalled();
    expect(source.searchExperiences).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "dinner",
        entityType: "place",
        neighborhoods: ["Mission"],
      }),
    );
    expect(result.plan.poll).toBeNull();
    expect(result.plan.selectedExternalIds).toEqual(["place:mission-dinner"]);
  });

  it("stages preference tools without writing before plan persistence", async () => {
    const calls = Array.from({ length: 5 }, (_, index) => ({
      type: "function_call",
      call_id: `call_${index}`,
      name: "savePreferences",
      arguments: JSON.stringify({
        updates: [
          { key: "cuisines", operation: "add", values: [`value_${index}`] },
        ],
      }),
      parsed_arguments: null,
    }));
    const responses = responsesQueue(
      fakeResponse({ output: calls }),
      fakeResponse({ outputParsed: EMPTY_PLAN }),
    );
    const source = dataSource();
    const runtime = new OpenAIResponsesRuntime({
      responses: responses.api,
      dataSource: source,
    });
    let collected: readonly PreferenceUpdate[] = [];

    const result = await runtime.run({
      message: "I like a few cuisines",
      pseudonymousUserId: "sender_hash",
      nowMs: Date.parse("2026-09-01T00:00:00-07:00"),
      onPreferenceUpdatesStaged: (updates) => {
        collected = updates;
      },
    });

    expect(source.savePreferences).not.toHaveBeenCalled();
    expect(result.stagedPreferenceUpdates).toHaveLength(4);
    expect(result.plan.preferenceUpdates).toEqual(
      result.stagedPreferenceUpdates,
    );
    expect(collected).toEqual(result.stagedPreferenceUpdates);
    expect(result.diagnostics.toolCalls).toBe(4);
    expect(result.diagnostics.backendDataCalls).toBe(0);
    expect(result.diagnostics.rejectedToolCalls).toBe(1);
    expect(result.diagnostics.modelSteps).toBe(2);
    const continuationRequest = responses.parse.mock.calls[1]?.[0] as {
      input: Array<Record<string, unknown>>;
    };
    const continuedCalls = continuationRequest.input.filter(
      (item) => item.type === "function_call",
    );
    expect(continuedCalls).toHaveLength(5);
    expect(continuedCalls.every((item) => !("parsed_arguments" in item))).toBe(
      true,
    );
  });

  it("hydrates searched candidates before step two within four data calls", async () => {
    const searchCall = {
      type: "function_call",
      call_id: "search_1",
      name: "searchExperiences",
      arguments: JSON.stringify({
        query: "date night",
        entityType: "place",
        neighborhoods: ["Mission"],
        primaryTypes: ["restaurant"],
        priceBands: [],
        startAtMs: null,
        endAtMs: null,
        limit: 10,
      }),
      parsed_arguments: null,
    };
    const detailsCall = {
      type: "function_call",
      call_id: "details_1",
      name: "getExperienceDetails",
      arguments: JSON.stringify({ externalIds: ["place-a", "place-b"] }),
      parsed_arguments: null,
    };
    const recommendationsCall = {
      type: "function_call",
      call_id: "recommendations_1",
      name: "getRecommendations",
      arguments: JSON.stringify({
        placeExternalIds: ["place-a", "place-b"],
        limitPerPlace: 5,
      }),
      parsed_arguments: null,
    };
    const recommendation: SourceBackedRecommendation = {
      externalId: "recommendation-a",
      placeExternalId: "place-a",
      kind: "dish",
      itemName: "House noodles",
      description: "Explicitly recommended by the source.",
      provenanceIds: ["claim:recommendation-a"],
    };
    const finalPlan: TurnPlan = {
      ...EMPTY_PLAN,
      selectedExternalIds: ["place-a"],
      provenanceIds: ["claim:place-a", "claim:recommendation-a"],
    };
    const source: CoastDataSource = {
      searchExperiences: vi
        .fn<CoastDataSource["searchExperiences"]>()
        .mockResolvedValueOnce({ items: [place("place-a")], weak: true })
        .mockResolvedValueOnce({ items: [place("place-b")], weak: false }),
      getExperienceDetails: vi.fn(async () => [
        place("place-a", "Hydrated A"),
        place("place-b", "Hydrated B"),
      ]),
      getRecommendations: vi.fn(async () => [recommendation]),
      savePreferences: vi.fn(async () => ({ applied: 0 })),
    };
    const responses = responsesQueue(
      fakeResponse({
        output: [searchCall, detailsCall, recommendationsCall],
      }),
      fakeResponse({ outputParsed: finalPlan }),
    );
    const runtime = new OpenAIResponsesRuntime({
      responses: responses.api,
      dataSource: source,
    });

    const result = await runtime.run({
      message: "Find a date-night restaurant in the Mission",
      pseudonymousUserId: "sender_hash",
      nowMs: Date.parse("2026-09-01T00:00:00-07:00"),
    });

    expect(source.searchExperiences).toHaveBeenCalledTimes(2);
    expect(source.getExperienceDetails).toHaveBeenCalledTimes(1);
    expect(source.getRecommendations).toHaveBeenCalledTimes(1);
    expect(result.diagnostics.backendDataCalls).toBe(4);
    expect(result.diagnostics.modelSteps).toBe(2);
    expect(result.experiences[0]?.observedSummary).toBe("Hydrated A");

    const continuationRequest = responses.parse.mock.calls[1]?.[0] as {
      input: Array<{ type?: string; call_id?: string; output?: string }>;
    };
    const searchOutput = continuationRequest.input.find(
      (item) =>
        item.type === "function_call_output" && item.call_id === "search_1",
    );
    const payload = JSON.parse(searchOutput?.output ?? "{}") as {
      hydratedDetails?: Array<{ observedSummary: string }>;
      explicitRecommendations?: SourceBackedRecommendation[];
    };
    expect(payload.hydratedDetails?.map((item) => item.observedSummary)).toEqual(
      ["Hydrated A", "Hydrated B"],
    );
    expect(payload.explicitRecommendations).toEqual([recommendation]);
  });

  it("handles lifecycle commands without spending a model step", async () => {
    const responses = responsesQueue();
    const runtime = new OpenAIResponsesRuntime({
      responses: responses.api,
      dataSource: dataSource(),
    });
    const result = await runtime.run({
      message: "FORGET ME",
      pseudonymousUserId: "sender_hash",
    });
    expect(result.command).toBe("forget_me");
    expect(result.requiresLifecycleMutation).toBe(true);
    expect(result.diagnostics.modelSteps).toBe(0);
    expect(responses.parse).not.toHaveBeenCalled();
  });
});

describe("strict tool declarations", () => {
  it("exposes only the four allowlisted strict tools", () => {
    expect(COAST_RESPONSE_TOOLS.map((tool) => tool.name)).toEqual([
      "searchExperiences",
      "getExperienceDetails",
      "getRecommendations",
      "savePreferences",
    ]);
    expect(COAST_RESPONSE_TOOLS.every((tool) => tool.strict === true)).toBe(true);
    expect(COAST_RESPONSE_TOOLS[0]?.description).toContain(
      "trusted priorSelections reference",
    );
  });
});
