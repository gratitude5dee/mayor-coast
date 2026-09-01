import { describe, expect, it } from "vitest";

import { selectPendingPollCandidate } from "../convex/lib/pollMatching";

describe("native poll matching", () => {
  it("prefers the durable provider poll GUID", () => {
    const matching = selectPendingPollCandidate({
      pending: [
        {
          providerPollId: "poll-guid-1",
          question: "Pick a neighborhood.",
          options: ["Mission", "Dogpatch"],
        },
      ],
      pollTitle: "",
      providerPollId: "poll-guid-1",
      selectedOption: "Dogpatch",
    });

    expect(matching?.providerPollId).toBe("poll-guid-1");
  });

  it("continues a uniquely matched vote when a modal view ID differs from the poll GUID", () => {
    const matching = selectPendingPollCandidate({
      pending: [
        {
          providerPollId: "modal-view-id",
          question: "Pick a neighborhood.",
          options: ["Mission", "Dogpatch"],
        },
      ],
      pollTitle: "",
      providerPollId: "native-poll-guid",
      selectedOption: "Dogpatch",
    });

    expect(matching?.providerPollId).toBe("modal-view-id");
  });

  it("does not guess when an option could belong to more than one pending poll", () => {
    const matching = selectPendingPollCandidate({
      pending: [
        {
          providerPollId: "poll-guid-1",
          question: "Pick a neighborhood.",
          options: ["Mission", "Dogpatch"],
        },
        {
          providerPollId: "poll-guid-2",
          question: "Where should we start?",
          options: ["Dogpatch", "SoMa"],
        },
      ],
      pollTitle: "",
      providerPollId: "native-poll-guid",
      selectedOption: "Dogpatch",
    });

    expect(matching).toBeNull();
  });

  it("uses the exact visible question to disambiguate a repeated option", () => {
    const matching = selectPendingPollCandidate({
      pending: [
        {
          providerPollId: "poll-guid-1",
          question: "Pick a neighborhood.",
          options: ["Mission", "Dogpatch"],
        },
        {
          providerPollId: "poll-guid-2",
          question: "Where should we start?",
          options: ["Dogpatch", "SoMa"],
        },
      ],
      pollTitle: "Pick a neighborhood.",
      providerPollId: "native-poll-guid",
      selectedOption: "Dogpatch",
    });

    expect(matching?.providerPollId).toBe("poll-guid-1");
  });
});
