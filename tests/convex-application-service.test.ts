import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";

import { ConvexCoastApplicationService } from "../src/lib/convex/application-service";

describe("Convex application privacy boundary", () => {
  it("forwards creative ambiguity only when a creative command is present", async () => {
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
    const common = {
      deliveryKey: "delivery-key",
      receivedAtMs: 1,
      senderAddress: "+14155550100",
      threadId: "imessage:any;-;+14155550100~shared",
      webhookId: "photon-live-gateway",
    };

    await service.claimInbound({
      ...common,
      creativeCommandAmbiguous: true,
      messages: [{ providerMessageId: "ordinary-message", sentAtMs: 1, text: "What’s going on today?" }],
      providerMessageId: "ordinary-message",
    });
    await service.claimInbound({
      ...common,
      creativeCommand: "draw",
      creativeCommandAmbiguous: true,
      messages: [{ providerMessageId: "creative-message", sentAtMs: 2, text: "/draw /draw" }],
      providerMessageId: "creative-message",
    });

    const ordinaryClaim = action.mock.calls[0]?.[1] as Record<string, unknown>;
    const creativeClaim = action.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(ordinaryClaim).not.toHaveProperty("creativeCommandAmbiguous");
    expect(ordinaryClaim).not.toHaveProperty("creativeCommand");
    expect(ordinaryClaim.text).toBe("What’s going on today?");
    expect(creativeClaim).toEqual(expect.objectContaining({
      creativeCommand: "draw",
      creativeCommandAmbiguous: true,
    }));
    expect(JSON.stringify(creativeClaim)).not.toContain("/draw /draw");
  });

  it("encrypts Draw launch material before it crosses into Convex", async () => {
    const action = vi.fn(async () => ({
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
    }));
    const service = new ConvexCoastApplicationService({
      client: { action } as unknown as ConvexHttpClient,
      identityPepper: "identity-pepper-that-is-long-enough-for-tests",
      serviceSecret: "internal-service-secret-that-is-long-enough",
    });
    await service.claimInbound({
      deliveryKey: "delivery-key",
      creativeCommand: "draw",
      messages: [{ providerMessageId: "draw-message", sentAtMs: 1, text: "/draw" }],
      providerMessageId: "draw-message",
      receivedAtMs: 1,
      senderAddress: "+14155550100",
      threadId: "imessage:any;-;+14155550100~shared",
      webhookId: "photon-live-gateway",
    });
    const firstCall = action.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    const persisted = firstCall[1];
    expect(persisted.drawLaunchSecretHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(persisted.encryptedDrawLaunchSecret).toMatch(/^v1\./u);
    expect(JSON.stringify(persisted)).not.toContain("launchSecret\":");
  });

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
      return { terminal: true };
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

  it("treats a replay after the two-second selection window as terminal", async () => {
    const action = vi.fn(async () => {
      throw new Error("POLL_SELECTION_NOT_CHANGEABLE");
    });
    const service = new ConvexCoastApplicationService({
      client: { action } as unknown as ConvexHttpClient,
      identityPepper: "identity-pepper-that-is-long-enough-for-tests",
      serviceSecret: "internal-service-secret-that-is-long-enough",
    });

    await expect(
      service.claimInbound({
        deliveryKey: "photon-live-gateway:settled-vote",
        messages: [{ providerMessageId: "settled-vote", sentAtMs: 1, text: "" }],
        pollVote: {
          optionLabel: "Yes—check in",
          pollTitle: "Want COAST to check in after?",
          selected: true,
        },
        providerMessageId: "settled-vote",
        receivedAtMs: 1,
        senderAddress: "+14155550100",
        threadId: "imessage:any;-;+14155550100~shared",
        webhookId: "photon-live-gateway",
      }),
    ).resolves.toEqual({ status: "blocked" });
  });
});
