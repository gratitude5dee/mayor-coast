import { describe, expect, it } from "vitest";

import {
  countConstraints,
  LUNA_MODEL,
  selectInitialModel,
  TERRA_MODEL,
} from "../src/lib/agent/model-routing";
import { classifyCoastCommand } from "../src/lib/coast/commands";

describe("COAST model routing", () => {
  it("uses Luna for a routine request", () => {
    expect(selectInitialModel({ message: "What should I do tonight?" }).model)
      .toBe(LUNA_MODEL);
  });

  it("uses Terra for itineraries", () => {
    const route = selectInitialModel({
      message: "Plan my night in SF",
    });
    expect(route.model).toBe(TERRA_MODEL);
    expect(route.reasons).toContain("itinerary_intent");
  });

  it("uses Terra for three distinct constraints", () => {
    const message = "Find a cheap romantic Italian dinner in the Mission";
    expect(countConstraints(message)).toBeGreaterThanOrEqual(3);
    expect(selectInitialModel({ message }).model).toBe(TERRA_MODEL);
  });

  it("uses Terra when upstream retrieval is weak", () => {
    expect(
      selectInitialModel({
        message: "Find something fun",
        retrievalQuality: "weak",
      }).model,
    ).toBe(TERRA_MODEL);
  });

  it("does not count legacy stored-preference keys as current constraints", () => {
    const route = selectInitialModel({
      message: "Find me a spot",
      explicitConstraints: [
        "preference:cuisines",
        "preference:priceBands",
        "preference:vibeTags",
      ],
    });
    expect(route.model).toBe(LUNA_MODEL);
    expect(route.constraintCount).toBe(0);
  });

  it("still counts application-supplied current constraint kinds", () => {
    const route = selectInitialModel({
      message: "Find me a spot",
      explicitConstraints: ["neighborhood", "price", "occasion"],
    });
    expect(route.model).toBe(TERRA_MODEL);
    expect(route.reasons).toContain("three_or_more_constraints");
  });
});

describe("COAST commands", () => {
  it.each([
    [" HELP ", "help"],
    ["STOP!", "stop"],
    ["start", "start"],
    ["Forget   me.", "forget_me"],
  ])("classifies %s", (input, expected) => {
    expect(classifyCoastCommand(input)).toBe(expected);
  });

  it("does not treat conversational text as a command", () => {
    expect(classifyCoastCommand("help me find dinner")).toBeNull();
  });
});
