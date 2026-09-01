import { describe, expect, it } from "vitest";

import {
  isCheckInScheduleAllowed,
  isDueCheckInClaimable,
} from "../convex/checkIns";

const NOW_MS = Date.parse("2026-09-01T12:00:00-07:00");
const EVENT_START_MS = Date.parse("2026-09-01T18:00:00-07:00");
const SEPTEMBER_30_LATE_MS = Date.parse("2026-09-30T22:00:00-07:00");
const OCTOBER_1_MS = Date.parse("2026-10-01T00:00:00-07:00");

describe("opt-in check-in scheduling policy", () => {
  it("accepts an explicit place schedule only within the bounded horizon", () => {
    expect(
      isCheckInScheduleAllowed({
        entityType: "place",
        eventStartAtMs: null,
        nowMs: NOW_MS,
        scheduledForMs: NOW_MS + 60_000,
      }),
    ).toBe(true);
    expect(
      isCheckInScheduleAllowed({
        entityType: "place",
        eventStartAtMs: null,
        nowMs: NOW_MS,
        scheduledForMs: NOW_MS + 59_999,
      }),
    ).toBe(false);
    expect(
      isCheckInScheduleAllowed({
        entityType: "place",
        eventStartAtMs: null,
        nowMs: NOW_MS,
        scheduledForMs: NOW_MS + 12 * 60 * 60 * 1_000 + 1,
      }),
    ).toBe(false);
  });

  it("allows event check-ins only from event start through the two-hour grace", () => {
    expect(
      isCheckInScheduleAllowed({
        entityType: "event",
        eventStartAtMs: EVENT_START_MS,
        nowMs: NOW_MS,
        scheduledForMs: EVENT_START_MS,
      }),
    ).toBe(true);
    expect(
      isCheckInScheduleAllowed({
        entityType: "event",
        eventStartAtMs: EVENT_START_MS,
        nowMs: NOW_MS,
        scheduledForMs: EVENT_START_MS - 1,
      }),
    ).toBe(false);
    expect(
      isCheckInScheduleAllowed({
        entityType: "event",
        eventStartAtMs: EVENT_START_MS,
        nowMs: NOW_MS,
        scheduledForMs: EVENT_START_MS + 2 * 60 * 60 * 1_000 + 1,
      }),
    ).toBe(false);
  });

  it("includes late September 30 but excludes October 1", () => {
    expect(
      isCheckInScheduleAllowed({
        entityType: "event",
        eventStartAtMs: SEPTEMBER_30_LATE_MS,
        nowMs: SEPTEMBER_30_LATE_MS - 60_000,
        scheduledForMs: SEPTEMBER_30_LATE_MS,
      }),
    ).toBe(true);
    expect(
      isCheckInScheduleAllowed({
        entityType: "event",
        eventStartAtMs: OCTOBER_1_MS,
        nowMs: OCTOBER_1_MS - 60_000,
        scheduledForMs: OCTOBER_1_MS,
      }),
    ).toBe(false);
  });
});

describe("due check-in revision and lifecycle guard", () => {
  const due = {
    checkInRevision: 3,
    expectedRevision: 3,
    nowMs: NOW_MS,
    scheduledForMs: NOW_MS,
    anchorExpiresAtMs: NOW_MS + 60_000,
    checkInStatus: "scheduled",
    decisionStatus: "selected",
    threadStatus: "active",
    userStatus: "active",
  };

  it("claims only a current, due, active opt-in", () => {
    expect(isDueCheckInClaimable(due)).toBe(true);
    expect(
      isDueCheckInClaimable({
        ...due,
        checkInRevision: due.checkInRevision + 1,
      }),
    ).toBe(false);
    expect(
      isDueCheckInClaimable({ ...due, scheduledForMs: due.nowMs + 1 }),
    ).toBe(false);
  });

  it("fails closed after stop, cancellation, or anchor expiry", () => {
    expect(isDueCheckInClaimable({ ...due, userStatus: "stopped" })).toBe(
      false,
    );
    expect(isDueCheckInClaimable({ ...due, decisionStatus: "cancelled" })).toBe(
      false,
    );
    expect(
      isDueCheckInClaimable({ ...due, anchorExpiresAtMs: due.nowMs }),
    ).toBe(false);
  });
});
