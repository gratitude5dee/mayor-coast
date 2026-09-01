import { describe, expect, it, vi } from "vitest";

import type { CoastApplicationService } from "../src/lib/photon/contracts";
import type { AdvancedEntry } from "../src/lib/photon/advanced-client";
import {
  consumeAdvancedNativePollVotes,
  consumeNativePollVotes,
  parseNativePollVoteStream,
} from "../src/lib/photon/poll-gateway";

function streamMessage(overrides: Record<string, unknown> = {}) {
  return [
    { id: "iMessage;-;+14155550100", phone: "shared" },
    {
      content: {
        option: { title: "Mission" },
        poll: {
          options: [{ title: "Mission" }, { title: "SoMa" }],
          title: "Which neighborhood should I hunt?",
          type: "poll",
        },
        selected: true,
        title: "Mission",
        type: "poll_option",
      },
      direction: "inbound",
      id: "poll-guid-1:+14155550100:option-guid-1:selected:1788205680000",
      read: vi.fn(async () => undefined),
      sender: { id: "+14155550100" },
      timestamp: new Date("2026-08-31T19:48:00.000Z"),
      ...overrides,
    },
  ];
}

function application(): CoastApplicationService {
  return {
    claimInbound: vi.fn(async () => ({
      claimId: "claim_poll_live_1",
      command: "none" as const,
      shouldAcknowledge: true,
      shouldStartTyping: true,
      status: "claimed" as const,
      turnId: "turn_poll_live_1",
    })),
    executeTurn: vi.fn(async () => ({ status: "completed" as const })),
  };
}

describe("native poll live gateway", () => {
  it("bypasses Spectrum's empty-title parser with the raw durable poll event", async () => {
    const controller = new AbortController();
    const occurredAt = new Date("2026-09-01T03:18:00.000Z");
    const event = {
      actor: { address: "+14155550100" },
      chatGuid: "any;-;+14155550100",
      delta: { type: "voted" as const, optionIdentifier: "option-guid-1" },
      isFromMe: false,
      occurredAt,
      pollMessageGuid: "poll-guid-1",
      sequence: 42,
      type: "poll.changed" as const,
    };
    const closeCatchUp = vi.fn(async () => undefined);
    const markRead = vi.fn(async () => undefined);
    const entry = {
      client: {
        chats: { markRead },
        events: {
          catchUp: vi.fn(() => ({
            close: closeCatchUp,
            async *[Symbol.asyncIterator]() {
              yield event;
              yield { headSequence: 42, type: "catchup.complete" as const };
            },
          })),
        },
        locations: {
          get: vi.fn(),
          request: vi.fn(),
        },
        polls: {
          get: vi.fn(async () => ({
            options: [
              { optionIdentifier: "option-guid-1", text: "Mission" },
            ],
            pollMessageGuid: "poll-guid-1",
            title: "",
          })),
          subscribeEvents: vi.fn(),
        },
      },
      phone: "shared",
    } as unknown as AdvancedEntry;
    const state = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {
        controller.abort();
      }),
    };
    const app = application();
    const adapter = {
      encodeThreadId: vi.fn(() => "imessage:any;-;+14155550100~shared"),
      isDM: vi.fn(() => true),
      startTyping: vi.fn(async () => undefined),
    };

    await consumeAdvancedNativePollVotes({
      adapter: adapter as never,
      application: app,
      entries: [entry],
      now: () => occurredAt.getTime() + 1_000,
      signal: controller.signal,
      state: state as never,
    });

    expect(markRead).toHaveBeenCalledWith("any;-;+14155550100");
    expect(app.claimInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        pollVote: {
          optionLabel: "Mission",
          pollTitle: "",
          providerPollId: "poll-guid-1",
          selected: true,
        },
      }),
    );
    expect(state.set).toHaveBeenCalledWith(
      "coast:photon:poll-cursor:v1:0",
      42,
    );
    expect(closeCatchUp).toHaveBeenCalledOnce();
  });

  it("uses the durable backlog without starting a serverless live listener", async () => {
    const subscribeEvents = vi.fn();
    const entry = {
      client: {
        chats: { markRead: vi.fn(async () => undefined) },
        events: {
          catchUp: vi.fn(() => ({
            close: vi.fn(async () => undefined),
            async *[Symbol.asyncIterator]() {
              yield { headSequence: 9, type: "catchup.complete" as const };
            },
          })),
        },
        locations: { get: vi.fn(), request: vi.fn() },
        polls: { get: vi.fn(), subscribeEvents },
      },
      phone: "shared",
    } as unknown as AdvancedEntry;
    const state = { get: vi.fn(async () => 8), set: vi.fn(async () => undefined) };

    await consumeAdvancedNativePollVotes({
      adapter: {} as never,
      application: application(),
      catchUpOnly: true,
      entries: [entry],
      signal: new AbortController().signal,
      state: state as never,
    });

    expect(subscribeEvents).not.toHaveBeenCalled();
    expect(state.set).toHaveBeenCalledWith("coast:photon:poll-cursor:v1:0", 9);
  });

  it("advances past a terminal stale vote so later poll activity is not blocked", async () => {
    const occurredAt = new Date("2026-09-01T08:30:00.000Z");
    const events = [
      {
        actor: { address: "+14155550100" },
        chatGuid: "any;-;+14155550100",
        delta: { type: "voted" as const, optionIdentifier: "old-option" },
        isFromMe: false,
        occurredAt,
        pollMessageGuid: "old-poll",
        sequence: 10,
        type: "poll.changed" as const,
      },
      {
        actor: { address: "+14155550100" },
        chatGuid: "any;-;+14155550100",
        delta: { type: "voted" as const, optionIdentifier: "current-option" },
        isFromMe: false,
        occurredAt,
        pollMessageGuid: "current-poll",
        sequence: 11,
        type: "poll.changed" as const,
      },
    ];
    const entry = {
      client: {
        chats: { markRead: vi.fn(async () => undefined) },
        events: {
          catchUp: vi.fn(() => ({
            close: vi.fn(async () => undefined),
            async *[Symbol.asyncIterator]() {
              yield* events;
              yield { headSequence: 11, type: "catchup.complete" as const };
            },
          })),
        },
        locations: { get: vi.fn(), request: vi.fn() },
        polls: {
          get: vi.fn(async (pollMessageGuid: string) => ({
            options: [
              {
                optionIdentifier:
                  pollMessageGuid === "old-poll" ? "old-option" : "current-option",
                text: pollMessageGuid === "old-poll" ? "Old choice" : "Food",
              },
            ],
            pollMessageGuid,
            title: "",
          })),
          subscribeEvents: vi.fn(),
        },
      },
      phone: "shared",
    } as unknown as AdvancedEntry;
    const app = application();
    vi.mocked(app.claimInbound)
      .mockRejectedValueOnce(new Error("POLL_SELECTION_NOT_PENDING"))
      .mockResolvedValueOnce({
        claimId: "claim_current_poll",
        command: "none",
        shouldAcknowledge: true,
        shouldStartTyping: true,
        status: "claimed",
        turnId: "turn_current_poll",
      });
    const state = { get: vi.fn(async () => 9), set: vi.fn(async () => undefined) };
    const adapter = {
      encodeThreadId: vi.fn(() => "imessage:any;-;+14155550100~shared"),
      isDM: vi.fn(() => true),
      startTyping: vi.fn(async () => undefined),
    };

    await consumeAdvancedNativePollVotes({
      adapter: adapter as never,
      application: app,
      catchUpOnly: true,
      entries: [entry],
      signal: new AbortController().signal,
      state: state as never,
    });

    expect(app.claimInbound).toHaveBeenCalledTimes(2);
    expect(app.executeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: "turn_current_poll" }),
    );
    expect(state.set).toHaveBeenCalledWith("coast:photon:poll-cursor:v1:0", 11);
  });

  it("parses selected poll content without relying on webhook-only fields", () => {
    const adapter = {
      encodeThreadId: vi.fn(() => "iMessage;-;+14155550100|shared"),
      isDM: vi.fn(() => true),
    };
    const parsed = parseNativePollVoteStream(streamMessage(), adapter);

    expect(parsed?.vote).toEqual({
      optionLabel: "Mission",
      pollTitle: "Which neighborhood should I hunt?",
      providerPollId: "poll-guid-1",
      providerMessageId:
        "poll-guid-1:+14155550100:option-guid-1:selected:1788205680000",
      receivedAtMs: Date.parse("2026-08-31T19:48:00.000Z"),
      senderAddress: "+14155550100",
      threadId: "iMessage;-;+14155550100|shared",
    });
  });

  it("marks the vote read and advances it through durable Convex intake", async () => {
    const raw = streamMessage();
    const read = (raw[1] as { read: ReturnType<typeof vi.fn> }).read;
    const app = application();
    const adapter = {
      encodeThreadId: vi.fn(() => "iMessage;-;+14155550100|shared"),
      isDM: vi.fn(() => true),
      startTyping: vi.fn(async () => undefined),
    };
    async function* messages() {
      yield raw;
    }

    await consumeNativePollVotes({
      adapter,
      application: app,
      messages: messages(),
      signal: new AbortController().signal,
    });

    expect(read).toHaveBeenCalledOnce();
    expect(app.claimInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryKey:
          "photon-live-gateway:poll-guid-1:+14155550100:option-guid-1:selected:1788205680000",
        pollVote: expect.objectContaining({
          optionLabel: "Mission",
          providerPollId: "poll-guid-1",
        }),
        webhookId: "photon-live-gateway",
      }),
    );
    expect(app.executeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: "turn_poll_live_1" }),
    );
  });

  it("ignores deselection and non-DM activity", () => {
    const nonDm = {
      encodeThreadId: vi.fn(() => "group"),
      isDM: vi.fn(() => false),
    };
    expect(parseNativePollVoteStream(streamMessage(), nonDm)).toBeNull();

    const direct = { ...nonDm, isDM: vi.fn(() => true) };
    const raw = streamMessage();
    const message = raw[1] as { content: { selected: boolean } };
    message.content.selected = false;
    expect(parseNativePollVoteStream(raw, direct)).toBeNull();
  });
});
