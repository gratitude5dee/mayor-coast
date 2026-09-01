import { describe, expect, it } from "vitest";

import { withNativeChoiceRecovery } from "../src/lib/agent/conversation-recovery";
import type { TurnPlan } from "../src/lib/coast/contracts";

const emptyPlan: TurnPlan = {
  responseText: "I need a little more to go on.",
  selectedExternalIds: [],
  poll: null,
  preferenceUpdates: [],
  provenanceIds: [],
};

function recover(
  latestMessage: string,
  recentMessages: Array<{ direction: "inbound" | "outbound"; body: string }> = [],
) {
  return withNativeChoiceRecovery({
    plan: emptyPlan,
    command: null,
    latestMessage,
    recentMessages,
  });
}

describe("native choice recovery", () => {
  it("turns a greeting into one short native discovery poll", () => {
    const plan = recover("Hi");

    expect(plan.responseText).toBe("COAST is on. What’s the move tonight?");
    expect(plan.poll).toEqual({
      question: "What are we getting into?",
      options: ["Food", "Drinks", "Something to do", "Pick for me"],
      multiple: false,
    });
  });

  it("uses the requested food-mood choices", () => {
    const plan = recover("Food");

    expect(plan.responseText).toBe("Nice. What kind of food mood are we chasing?");
    expect(plan.poll?.options).toEqual([
      "Casual bite",
      "Date-night dinner",
      "Great noodles",
      "Tacos or burritos",
      "Vegetarian-friendly",
      "Surprise me",
    ]);
  });

  it("keeps the discovery lane across a short reply such as a neighborhood", () => {
    const plan = recover("Downtown", [
      { direction: "inbound", body: "A drink" },
      { direction: "outbound", body: "What kind of drink are you after?" },
    ]);

    expect(plan.responseText).toBe(
      "Say less—what kind of drink move are you after?",
    );
    expect(plan.poll?.options).toEqual([
      "Cocktails",
      "Wine bar",
      "Beer & casual",
      "Surprise me",
    ]);
  });

  it("does not override a real result, a model poll, or a command", () => {
    const withResult = withNativeChoiceRecovery({
      plan: { ...emptyPlan, selectedExternalIds: ["place:bar-iris"] },
      command: null,
      latestMessage: "A drink",
      recentMessages: [],
    });
    const modelPoll = withNativeChoiceRecovery({
      plan: {
        ...emptyPlan,
        poll: { question: "Budget?", options: ["$", "$$"], multiple: false },
      },
      command: null,
      latestMessage: "Dinner",
      recentMessages: [],
    });
    const command = withNativeChoiceRecovery({
      plan: emptyPlan,
      command: "help",
      latestMessage: "HELP",
      recentMessages: [],
    });

    expect(withResult).toEqual({
      ...emptyPlan,
      selectedExternalIds: ["place:bar-iris"],
    });
    expect(modelPoll.poll?.question).toBe("Budget?");
    expect(command).toEqual(emptyPlan);
  });

  it("never creates a third clarification poll in the same discovery cycle", () => {
    const result = withNativeChoiceRecovery({
      plan: {
        ...emptyPlan,
        poll: {
          question: "Another question?",
          options: ["Yes", "No"],
          multiple: false,
        },
      },
      command: null,
      latestMessage: "Mission",
      recentMessages: [],
      clarificationDepth: 2,
    });

    expect(result.poll).toBeNull();
    expect(result.responseText).toContain("widened the verified search");
  });
});
