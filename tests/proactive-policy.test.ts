import { describe, expect, it } from "vitest";

import { isProactiveNudgeEligible } from "../convex/proactive";

const NOW_MS = Date.parse("2026-09-01T18:00:00-07:00");

describe("proactive nudge policy", () => {
  it("requires six hours of inactivity and a prior taste signal", () => {
    expect(isProactiveNudgeEligible({
      latestInboundAtMs: NOW_MS - 6 * 60 * 60_000,
      nowMs: NOW_MS,
      localHour: 18,
      hasTasteSignal: true,
    })).toBe(true);
    expect(isProactiveNudgeEligible({
      latestInboundAtMs: NOW_MS - 6 * 60 * 60_000,
      nowMs: NOW_MS,
      localHour: 18,
      hasTasteSignal: false,
    })).toBe(false);
  });

  it("enforces quiet hours and the six-hour outbound cooldown", () => {
    const base = {
      latestInboundAtMs: NOW_MS - 7 * 60 * 60_000,
      nowMs: NOW_MS,
      localHour: 18,
      hasTasteSignal: true,
    };
    expect(isProactiveNudgeEligible({ ...base, localHour: 9 })).toBe(false);
    expect(isProactiveNudgeEligible({
      ...base,
      lastProactiveAtMs: NOW_MS - 5 * 60 * 60_000,
    })).toBe(false);
  });
});
