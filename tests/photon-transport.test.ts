import type { Message, Thread } from "chat";
import { describe, expect, it, vi } from "vitest";

import type { CoastApplicationService } from "../src/lib/photon/contracts";
import { runWithPhotonDeliveryContext } from "../src/lib/photon/delivery-context";
import {
  createCoastInboundHandler,
  contextualTapback,
  detectUnsupportedInboundContent,
  parsePollVote,
  renderResultsMarkdown,
} from "../src/lib/photon/transport";
import type { TypingLease } from "../src/lib/photon/typing";

function application(
  overrides: Partial<CoastApplicationService> = {},
): CoastApplicationService {
  return {
    claimInbound: vi.fn(async () => ({
      claimId: "claim_1",
      command: "none" as const,
      shouldAcknowledge: true,
      shouldStartTyping: true,
      status: "claimed" as const,
      turnId: "turn_1",
    })),
    executeTurn: vi.fn(async () => ({ status: "completed" as const })),
    ...overrides,
  };
}

function message(raw: unknown = {}): Message {
  return {
    attachments: [],
    author: {
      fullName: "+14155550100",
      isBot: false,
      isMe: false,
      userId: "+14155550100",
      userName: "+14155550100",
    },
    id: "message_1",
    metadata: { dateSent: new Date("2026-08-31T20:00:00Z"), edited: false },
    raw,
    text: "What should I do tonight?",
  } as unknown as Message;
}

function ports() {
  const posts: unknown[] = [];
  const adapter = {
    addReaction: vi.fn(async () => undefined),
    isDM: vi.fn(() => true),
    openModal: vi.fn(async () => ({ viewId: "poll_message_1" })),
    startTyping: vi.fn(async () => undefined),
  };
  const thread = {
    id: "imessage:dm:thread_1",
    isDM: true,
    markAsRead: vi.fn(async () => undefined),
    post: vi.fn(async (value: unknown) => {
      posts.push(value);
      return { id: `out_${posts.length}` };
    }),
    signal: new AbortController().signal,
  } as unknown as Thread;
  return { adapter, posts, thread };
}

describe("COAST inbound transport", () => {
  it("claims durably before acknowledging and leaves delivery to Convex", async () => {
    const app = application();
    const { adapter, posts, thread } = ports();
    const stop = vi.fn();
    const start = vi.fn(async () => undefined);
    const handler = createCoastInboundHandler({
      adapter,
      application: app,
      typingLeaseFactory: () => ({ start, stop }) as unknown as TypingLease,
    });

    await runWithPhotonDeliveryContext({ webhookId: "webhook_1" }, () =>
      handler(thread, message(), undefined),
    );

    expect(app.claimInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryKey: "webhook_1:message_1",
        providerMessageId: "message_1",
        webhookId: "webhook_1",
      }),
    );
    expect(thread.markAsRead).toHaveBeenCalledOnce();
    expect(adapter.addReaction).toHaveBeenCalledWith(
      thread.id,
      "message_1",
      contextualTapback("What should I do tonight?", "message_1"),
    );
    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(posts).toEqual([]);
    expect(adapter.openModal).not.toHaveBeenCalled();
    expect(app.executeTurn).toHaveBeenCalledOnce();
  });

  it("does not acknowledge or execute a duplicate delivery", async () => {
    const app = application({
      claimInbound: vi.fn(async () => ({ status: "duplicate" as const })),
    });
    const { adapter, thread } = ports();
    const handler = createCoastInboundHandler({ adapter, application: app });

    await runWithPhotonDeliveryContext({ webhookId: "webhook_replay" }, () =>
      handler(thread, message(), undefined),
    );

    expect(thread.markAsRead).not.toHaveBeenCalled();
    expect(adapter.addReaction).not.toHaveBeenCalled();
    expect(adapter.startTyping).not.toHaveBeenCalled();
    expect(app.executeTurn).not.toHaveBeenCalled();
  });

  it("ignores group chats", async () => {
    const app = application();
    const { adapter, thread } = ports();
    (thread as unknown as { isDM: boolean }).isDM = false;
    const handler = createCoastInboundHandler({ adapter, application: app });

    await runWithPhotonDeliveryContext({ webhookId: "webhook_group" }, () =>
      handler(thread, message(), undefined),
    );

    expect(app.claimInbound).not.toHaveBeenCalled();
  });

  it("atomically claims a selected native poll vote", async () => {
    const app = application();
    const { adapter, thread } = ports();
    const handler = createCoastInboundHandler({
      adapter,
      application: app,
      typingLeaseFactory: () =>
        ({ start: vi.fn(async () => undefined), stop: vi.fn() }) as unknown as TypingLease,
    });
    const voteMessage = message({
      content: {
        option: { title: "Asian" },
        poll: { title: "What food are you feeling? · 123456" },
        selected: true,
        type: "poll_option",
      },
    });

    await runWithPhotonDeliveryContext({ webhookId: "webhook_poll" }, () =>
      handler(thread, voteMessage, undefined),
    );

    expect(app.claimInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        pollVote: {
          optionLabel: "Asian",
          pollTitle: "What food are you feeling? · 123456",
          selected: true,
        },
      }),
    );
    expect(app.executeTurn).toHaveBeenCalledOnce();
  });

  it("rejects attachments before the persistence boundary and sends only a safe control turn", async () => {
    const claimInbound = vi.fn(async () => ({
      claimId: "claim_attachment",
      command: "none" as const,
      shouldAcknowledge: true,
      shouldStartTyping: false,
      status: "claimed" as const,
      turnId: "turn_attachment",
    }));
    const app = application({ claimInbound });
    const { adapter, thread } = ports();
    const start = vi.fn(async () => undefined);
    const handler = createCoastInboundHandler({
      adapter,
      application: app,
      typingLeaseFactory: () =>
        ({ start, stop: vi.fn() }) as unknown as TypingLease,
    });
    const attachmentMessage = message();
    attachmentMessage.text = "secret details from the attachment";
    attachmentMessage.attachments = [
      {
        mimeType: "image/jpeg",
        name: "private.jpg",
        type: "image",
        url: "https://private.invalid/image.jpg",
      },
    ];

    await runWithPhotonDeliveryContext({ webhookId: "webhook_attachment" }, () =>
      handler(thread, attachmentMessage, undefined),
    );

    expect(claimInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        unsupportedContent: "attachment",
        messages: [
          expect.objectContaining({
            text: "[unsupported inbound content omitted]",
          }),
        ],
      }),
    );
    expect(JSON.stringify(claimInbound.mock.calls)).not.toContain(
      "secret details from the attachment",
    );
    expect(JSON.stringify(claimInbound.mock.calls)).not.toContain("private.jpg");
    expect(thread.markAsRead).toHaveBeenCalledOnce();
    expect(adapter.addReaction).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(app.executeTurn).toHaveBeenCalledOnce();
  });

  it("redacts a private location share while signaling the durable resolver", async () => {
    const claimInbound = vi.fn(async () => ({
      claimId: "claim_location",
      command: "none" as const,
      shouldAcknowledge: true,
      shouldStartTyping: false,
      status: "claimed" as const,
      turnId: "turn_location",
    }));
    const app = application({ claimInbound });
    const { adapter, thread } = ports();
    const handler = createCoastInboundHandler({ adapter, application: app });
    const locationMessage = message({
      content: {
        location: { latitude: 37.7749, longitude: -122.4194 },
        type: "live_location",
      },
    });
    locationMessage.text = "my exact location";

    await runWithPhotonDeliveryContext({ webhookId: "webhook_location" }, () =>
      handler(thread, locationMessage, undefined),
    );

    expect(claimInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        locationSignal: true,
        messages: [
          expect.objectContaining({
            text: "[unsupported inbound content omitted]",
          }),
        ],
      }),
    );
    expect(adapter.addReaction).not.toHaveBeenCalled();
    expect(adapter.startTyping).not.toHaveBeenCalled();
    expect(
      detectUnsupportedInboundContent([
        { attachments: [], raw: { venue: { location: "Mission District" } } },
      ]),
    ).toBeUndefined();
  });

  it("acknowledges a control command without a tapback or typing indicator", async () => {
    const app = application({
      claimInbound: vi.fn(async () => ({
        claimId: "claim_stop",
        command: "stop" as const,
        shouldAcknowledge: true,
        shouldStartTyping: false,
        status: "claimed" as const,
        turnId: "turn_stop",
      })),
    });
    const { adapter, thread } = ports();
    const handler = createCoastInboundHandler({ adapter, application: app });
    const stopMessage = message();
    stopMessage.text = "STOP";

    await runWithPhotonDeliveryContext({ webhookId: "webhook_stop" }, () =>
      handler(thread, stopMessage, undefined),
    );

    expect(thread.markAsRead).toHaveBeenCalledOnce();
    expect(adapter.addReaction).not.toHaveBeenCalled();
    expect(adapter.startTyping).not.toHaveBeenCalled();
    expect(app.executeTurn).toHaveBeenCalledOnce();
  });
});

describe("transport formatting", () => {
  it("uses varied, optional, deterministic tapbacks", () => {
    expect(contextualTapback("Hi", "message_1")).toBeNull();
    expect(contextualTapback("Thank you", "message_2")).toBe("heart");
    expect(contextualTapback("lol", "message_3")).toBe("laugh");
    expect(contextualTapback("Dinner", "message_4")).toBe(
      contextualTapback("Dinner", "message_4"),
    );
  });

  it("uses a neutral second message when clarification has no results", () => {
    expect(renderResultsMarkdown([])).toContain("No picks yet");
  });

  it("recognizes only complete native poll vote payloads", () => {
    expect(parsePollVote({ content: { type: "poll_option" } })).toBeUndefined();
    expect(
      parsePollVote({
        content: {
          option: { title: "Yes" },
          poll: { title: "Want live music?" },
          selected: true,
          type: "poll_option",
        },
      }),
    ).toEqual({ optionLabel: "Yes", pollTitle: "Want live music?", selected: true });
  });
});
