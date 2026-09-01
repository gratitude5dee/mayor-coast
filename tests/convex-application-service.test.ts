import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";

import { ConvexCoastApplicationService } from "../src/lib/convex/application-service";

describe("Convex application privacy boundary", () => {
  it("pseudonymizes synthetic poll event ids before persistence", async () => {
    const rawAddress = "+14155550100";
    const rawPollEventId = `poll-guid:${rawAddress}:option-guid:vote`;
    const action = vi.fn(async (...args: unknown[]) => {
      void args;
      return {
        accepted: false,
        command: "none",
        controlReply: null,
        duplicate: true,
        messageId: "message-id",
        shouldAcknowledge: false,
        shouldStartTyping: false,
        threadId: "thread-id",
        turnId: "turn-id",
        userId: "user-id",
      };
    });
    const service = new ConvexCoastApplicationService({
      client: { action } as unknown as ConvexHttpClient,
      identityPepper: "identity-pepper-that-is-long-enough-for-tests",
      serviceSecret: "internal-service-secret-that-is-long-enough",
    });

    await service.claimInbound({
      deliveryKey: `photon-live-gateway:${rawPollEventId}`,
      messages: [
        { providerMessageId: rawPollEventId, sentAtMs: 1, text: "" },
      ],
      pollVote: {
        optionLabel: "Mission",
        pollTitle: "Which neighborhood?",
        providerPollId: "poll-guid",
        selected: true,
      },
      providerMessageId: rawPollEventId,
      receivedAtMs: 1,
      senderAddress: rawAddress,
      threadId: "imessage:any;-;+14155550100~shared",
      webhookId: "photon-live-gateway",
    });

    const persisted = action.mock.calls[0]?.[1] as {
      providerMessageId: string;
      providerPollId: string;
      senderHash: string;
    };
    expect(persisted.providerMessageId).not.toContain(rawAddress);
    expect(persisted.providerMessageId).not.toBe(rawPollEventId);
    expect(persisted.providerMessageId.length).toBeGreaterThanOrEqual(32);
    expect(persisted.providerPollId).toBe("poll-guid");
    expect(persisted.senderHash).not.toContain(rawAddress);
  });

  it("drops a replayed poll vote after newer conversation input", async () => {
    const action = vi.fn(async (...args: unknown[]) => {
      void args;
      throw new Error("POLL_SELECTION_SUPERSEDED");
    });
    const service = new ConvexCoastApplicationService({
      client: { action } as unknown as ConvexHttpClient,
      identityPepper: "identity-pepper-that-is-long-enough-for-tests",
      serviceSecret: "internal-service-secret-that-is-long-enough",
    });

    await expect(
      service.claimInbound({
        deliveryKey: "photon-live-gateway:stale-vote",
        messages: [{ providerMessageId: "stale-vote", sentAtMs: 1, text: "" }],
        pollVote: {
          optionLabel: "Mission",
          pollTitle: "",
          providerPollId: "poll-guid",
          selected: true,
        },
        providerMessageId: "stale-vote",
        receivedAtMs: 1,
        senderAddress: "+14155550100",
        threadId: "imessage:any;-;+14155550100~shared",
        webhookId: "photon-live-gateway",
      }),
    ).resolves.toEqual({ status: "blocked" });
  });
});
