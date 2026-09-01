import { describe, expect, it, vi } from "vitest";

import type { CoastApplicationService } from "../src/lib/photon/contracts";
import {
  handleVerifiedNativePollVote,
  parseNativePollVoteWebhook,
} from "../src/lib/photon/poll-webhook";
import { runWithPhotonDeliveryContext } from "../src/lib/photon/delivery-context";

const payload = {
  event: "messages",
  message: {
    content: {
      option: { title: "Casual bite" },
      poll: { title: "What kind of food mood are we chasing?" },
      selected: true,
      type: "poll_option",
    },
    direction: "inbound",
    id: "poll-vote-message-1",
    sender: { id: "+14155550100" },
    timestamp: "2026-08-31T19:35:00.000Z",
  },
  space: { id: "iMessage;-;+14155550100", phone: "shared" },
};

function application(): CoastApplicationService {
  return {
    claimInbound: vi.fn(async () => ({
      claimId: "claim_poll_1",
      command: "none" as const,
      shouldAcknowledge: true,
      shouldStartTyping: true,
      status: "claimed" as const,
      turnId: "turn_poll_1",
    })),
    executeTurn: vi.fn(async () => ({ status: "completed" as const })),
  };
}

describe("serverless native poll votes", () => {
  it("turns an authenticated selected option into durable conversational input", async () => {
    const adapter = {
      encodeThreadId: vi.fn(() => "imessage;-;+14155550100|shared"),
      isDM: vi.fn(() => true),
      startTyping: vi.fn(async () => undefined),
    };
    const vote = parseNativePollVoteWebhook(payload, adapter);

    expect(vote).toEqual({
      optionLabel: "Casual bite",
      pollTitle: "What kind of food mood are we chasing?",
      providerMessageId: "poll-vote-message-1",
      receivedAtMs: Date.parse("2026-08-31T19:35:00.000Z"),
      senderAddress: "+14155550100",
      threadId: "imessage;-;+14155550100|shared",
    });

    const app = application();
    const context = {
      webhookId: "webhook_poll_1",
      criticalTasks: [] as Promise<unknown>[],
      continuations: [] as Promise<unknown>[],
    };
    await runWithPhotonDeliveryContext(context, () =>
      handleVerifiedNativePollVote({
        adapter,
        application: app,
        vote: vote!,
      }),
    );
    await Promise.all(context.criticalTasks);
    await Promise.all(context.continuations);

    expect(app.claimInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryKey: "webhook_poll_1:poll-vote-message-1",
        pollVote: {
          optionLabel: "Casual bite",
          pollTitle: "What kind of food mood are we chasing?",
          selected: true,
        },
      }),
    );
    expect(app.executeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: "turn_poll_1" }),
    );
  });

  it("ignores unselected, outbound, malformed, and non-DM poll events", () => {
    const adapter = {
      encodeThreadId: vi.fn(() => "thread"),
      isDM: vi.fn(() => false),
    };
    expect(parseNativePollVoteWebhook(payload, adapter)).toBeNull();
    expect(
      parseNativePollVoteWebhook(
        { ...payload, message: { ...payload.message, direction: "outbound" } },
        { ...adapter, isDM: vi.fn(() => true) },
      ),
    ).toBeNull();
    expect(
      parseNativePollVoteWebhook(
        {
          ...payload,
          message: {
            ...payload.message,
            content: { ...payload.message.content, selected: false },
          },
        },
        { ...adapter, isDM: vi.fn(() => true) },
      ),
    ).toBeNull();
  });
});
