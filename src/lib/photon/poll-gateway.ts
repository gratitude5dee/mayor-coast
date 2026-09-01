import { createHash } from "node:crypto";

import type { iMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import type { StateAdapter } from "chat";

import type { CoastApplicationService } from "./contracts";
import {
  getAdvancedEntries,
  type AdvancedEntry,
  type AdvancedPollEvent,
} from "./advanced-client";
import {
  extractProviderPollId,
  handleNativePollVote,
  type NativePollVote,
} from "./poll-webhook";

const GATEWAY_DELIVERY_SCOPE = "photon-live-gateway";
const INITIAL_CATCH_UP_MAX_AGE_MS = 30 * 60 * 1_000;
const CURSOR_KEY_PREFIX = "coast:photon:poll-cursor:v1";
const POLL_EVENT_SEEN_KEY_PREFIX = "coast:photon:poll-event-seen:v1";
const POLL_EVENT_SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

type RecordValue = Record<string, unknown>;

type PollGatewayDependencies = {
  adapter: Pick<
    iMessageAdapter,
    "encodeThreadId" | "isDM" | "startTyping"
  >;
  application: CoastApplicationService;
  messages: AsyncIterable<unknown>;
  signal: AbortSignal;
};

type AdvancedPollGatewayDependencies = {
  adapter: iMessageAdapter;
  application: CoastApplicationService;
  /**
   * Process the durable event backlog and return. This is the serverless-safe
   * mode: a scheduled invocation resumes from the stored cursor rather than
   * depending on one long-lived Vercel process to receive every native vote.
   */
  catchUpOnly?: boolean;
  entries?: readonly AdvancedEntry[];
  now?: () => number;
  signal: AbortSignal;
  state: Pick<StateAdapter, "get" | "set">;
};

/**
 * Consume raw Advanced iMessage poll events instead of Spectrum's synthesized
 * `poll_option` record. Photon can return an empty poll title for an otherwise
 * valid poll; Spectrum 10 rejects that record before application code sees it.
 * The raw event still has the durable poll GUID and option identifier, which
 * are sufficient to resolve the stored option and continue the conversation.
 */
export async function consumeAdvancedNativePollVotes(
  dependencies: AdvancedPollGatewayDependencies,
): Promise<void> {
  const entries = dependencies.entries ?? getAdvancedEntries(dependencies.adapter);
  await Promise.all(
    entries.map((entry, index) =>
      consumeAdvancedEntry(dependencies, entry, index),
    ),
  );
}

async function consumeAdvancedEntry(
  dependencies: AdvancedPollGatewayDependencies,
  entry: AdvancedEntry,
  index: number,
): Promise<void> {
  const cursorKey = `${CURSOR_KEY_PREFIX}:${index}`;
  const storedCursor = await dependencies.state.get<number>(cursorKey);
  let cursor =
    typeof storedCursor === "number" &&
    Number.isSafeInteger(storedCursor) &&
    storedCursor >= 0
      ? storedCursor
      : undefined;
  let persistedCursor = cursor;
  const now = dependencies.now ?? Date.now;

  const persistCursor = async (): Promise<void> => {
    if (cursor === undefined || cursor === persistedCursor) return;
    await dependencies.state.set(cursorKey, cursor);
    persistedCursor = cursor;
  };

  const catchUp = entry.client.events.catchUp(cursor);
  try {
    for await (const event of catchUp) {
      if (dependencies.signal.aborted) return;
      if (isCatchUpComplete(event)) {
        cursor = Math.max(cursor ?? 0, event.headSequence);
        await persistCursor();
        break;
      }
      if (
        isAdvancedPollEvent(event) &&
        (storedCursor !== null ||
          event.occurredAt.getTime() >= now() - INITIAL_CATCH_UP_MAX_AGE_MS)
      ) {
        const seenKey = pollEventSeenKey(index, event);
        const alreadyHandled =
          (await dependencies.state.get<boolean>(seenKey)) === true;
        if (!alreadyHandled) {
          try {
            await handleAdvancedPollEvent(dependencies, entry, event);
          } catch (error) {
            // A stale, already-answered, or expired native poll is terminal
            // input. It must not pin the durable cursor ahead of newer votes
            // in Photon’s catch-up stream. Transport failures remain retryable.
            if (!isTerminalPollVoteError(error)) throw error;
          }
          // The marker is a one-way hash of provider event metadata. It
          // protects against replay without retaining a participant address,
          // message body, raw poll GUID, or location.
          await dependencies.state.set(seenKey, true, POLL_EVENT_SEEN_TTL_MS);
        }
      }
      const sequence = eventSequence(event);
      if (sequence !== null) cursor = Math.max(cursor ?? 0, sequence);
    }
  } finally {
    // Photon may finish a catch-up iterable without emitting its optional
    // completion marker. Persist the highest event sequence either way so a
    // terminal old vote cannot be replayed on every scheduled invocation.
    await persistCursor();
    await catchUp.close?.().catch(() => undefined);
  }

  if (dependencies.catchUpOnly || dependencies.signal.aborted) return;
  const live = entry.client.polls.subscribeEvents();
  const iterator = live[Symbol.asyncIterator]();
  try {
    while (!dependencies.signal.aborted) {
      const result = await nextUntilAbort(iterator, dependencies.signal);
      if (result === null || result.done) break;
      if (result.value.sequence <= (cursor ?? -1)) continue;
      try {
        await handleAdvancedPollEvent(dependencies, entry, result.value);
      } catch (error) {
        if (!isTerminalPollVoteError(error)) throw error;
      }
      cursor = result.value.sequence;
      await persistCursor();
    }
  } finally {
    await iterator.return?.().catch(() => undefined);
    await live.close?.().catch(() => undefined);
  }
}

function isTerminalPollVoteError(error: unknown): boolean {
  // Errors crossing the Convex action boundary can be nested structured
  // values, not necessarily native Error instances in the Vercel runtime.
  const message = collectErrorText(error);
  return [
    "POLL_SELECTION_SUPERSEDED",
    "POLL_SELECTION_NOT_PENDING",
    "POLL_OPTION_NOT_FOUND",
    "POLL_THREAD_NOT_FOUND",
    "POLL_USER_NOT_ACTIVE",
  ].some((code) => message.includes(code));
}

function collectErrorText(value: unknown, seen = new Set<unknown>()): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || seen.has(value)) return "";
  seen.add(value);

  const fields: unknown[] = [];
  if (value instanceof Error) fields.push(value.message, value.cause);
  for (const nested of Object.values(value)) fields.push(nested);
  const record = value as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(value)) fields.push(record[key]);
  return [
    ...fields.map((field) => collectErrorText(field, seen)),
    String(value),
  ].join(" ");
}

function isCatchUpComplete(
  value: unknown,
): value is { headSequence: number; type: "catchup.complete" } {
  const item = record(value);
  return (
    item?.type === "catchup.complete" &&
    typeof item.headSequence === "number" &&
    Number.isSafeInteger(item.headSequence) &&
    item.headSequence >= 0
  );
}

function isAdvancedPollEvent(value: unknown): value is AdvancedPollEvent {
  const item = record(value);
  const delta = item === null ? null : record(item.delta);
  return (
    item?.type === "poll.changed" &&
    typeof item.chatGuid === "string" &&
    typeof item.pollMessageGuid === "string" &&
    typeof item.sequence === "number" &&
    typeof item.isFromMe === "boolean" &&
    item.occurredAt instanceof Date &&
    delta !== null &&
    typeof delta.type === "string"
  );
}

function eventSequence(value: unknown): number | null {
  const sequence = record(value)?.sequence;
  return typeof sequence === "number" && Number.isSafeInteger(sequence)
    ? sequence
    : null;
}

function pollEventSeenKey(index: number, event: AdvancedPollEvent): string {
  const option = "optionIdentifier" in event.delta
    ? event.delta.optionIdentifier
    : event.delta.type;
  const fingerprint = createHash("sha256")
    .update(`${event.pollMessageGuid}\u0000${option}\u0000${event.occurredAt.getTime()}`)
    .digest("hex");
  return `${POLL_EVENT_SEEN_KEY_PREFIX}:${index}:${fingerprint}`;
}

async function handleAdvancedPollEvent(
  dependencies: AdvancedPollGatewayDependencies,
  entry: AdvancedEntry,
  event: AdvancedPollEvent,
): Promise<void> {
  if (
    event.isFromMe ||
    event.delta.type !== "voted" ||
    typeof event.actor?.address !== "string"
  ) {
    return;
  }
  const threadId = dependencies.adapter.encodeThreadId({
    chatGuid: event.chatGuid,
    phone: entry.phone,
  });
  if (!dependencies.adapter.isDM(threadId)) return;

  const optionIdentifier = event.delta.optionIdentifier;
  const poll = await entry.client.polls.get(event.pollMessageGuid);
  const option = poll.options.find(
    (candidate) =>
      candidate.optionIdentifier === optionIdentifier,
  );
  if (!option?.text.trim()) return;

  const receivedAtMs = event.occurredAt.getTime();
  const providerMessageId = [
    event.pollMessageGuid,
    event.actor.address,
    optionIdentifier,
    "selected",
    receivedAtMs,
  ].join(":");

  await handleNativePollVote({
    adapter: dependencies.adapter,
    application: dependencies.application,
    deliveryScope: GATEWAY_DELIVERY_SCOPE,
    markAsRead: async () => {
      await entry.client.chats.markRead(event.chatGuid);
    },
    vote: {
      optionLabel: option.text,
      pollTitle: poll.title,
      providerMessageId,
      providerPollId: event.pollMessageGuid,
      receivedAtMs,
      senderAddress: event.actor.address,
      threadId,
    },
  });
}

/**
 * Spectrum Cloud webhooks currently omit native poll changes, so the live
 * Spectrum stream is the authoritative companion intake for `poll_option`.
 * Ordinary messages remain on the signed webhook path. Every vote is still
 * claimed atomically in Convex before it can produce a turn.
 */
export async function consumeNativePollVotes(
  dependencies: PollGatewayDependencies,
): Promise<void> {
  const iterator = dependencies.messages[Symbol.asyncIterator]();
  try {
    while (!dependencies.signal.aborted) {
      const result = await nextUntilAbort(iterator, dependencies.signal);
      if (result === null || result.done) break;
      const parsed = parseNativePollVoteStream(result.value, dependencies.adapter);
      if (parsed === null) continue;

      await handleNativePollVote({
        adapter: dependencies.adapter,
        application: dependencies.application,
        deliveryScope: GATEWAY_DELIVERY_SCOPE,
        markAsRead: parsed.markAsRead,
        vote: parsed.vote,
      });
    }
  } finally {
    await iterator.return?.().catch(() => undefined);
  }
}

export function parseNativePollVoteStream(
  value: unknown,
  adapter: Pick<iMessageAdapter, "encodeThreadId" | "isDM">,
): { markAsRead: () => Promise<void>; vote: NativePollVote } | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const space = record(value[0]);
  const message = record(value[1]);
  if (space === null || message === null) return null;

  const content = record(message.content);
  const poll = content === null ? null : record(content.poll);
  const option = content === null ? null : record(content.option);
  const sender = record(message.sender);
  if (
    content?.type !== "poll_option" ||
    content.selected !== true ||
    poll === null ||
    option === null ||
    typeof poll.title !== "string" ||
    typeof option.title !== "string" ||
    typeof message.id !== "string" ||
    typeof sender?.id !== "string" ||
    typeof space.id !== "string" ||
    typeof message.read !== "function"
  ) {
    return null;
  }

  const threadId = adapter.encodeThreadId({
    chatGuid: space.id,
    ...(typeof space.phone === "string" ? { phone: space.phone } : {}),
  });
  if (!adapter.isDM(threadId)) return null;

  const timestamp = message.timestamp;
  const receivedAtMs =
    timestamp instanceof Date
      ? timestamp.getTime()
      : typeof timestamp === "string"
        ? Date.parse(timestamp)
        : Number.NaN;

  return {
    markAsRead: async () => {
      await (message.read as () => Promise<void>)();
    },
    vote: {
      optionLabel: option.title,
      pollTitle: poll.title,
      ...(extractProviderPollId(message.id, sender.id) === null
        ? {}
        : {
            providerPollId: extractProviderPollId(
              message.id,
              sender.id,
            ) as string,
          }),
      providerMessageId: message.id,
      receivedAtMs: Number.isFinite(receivedAtMs) ? receivedAtMs : Date.now(),
      senderAddress: sender.id,
      threadId,
    },
  };
}

async function nextUntilAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T> | null> {
  if (signal.aborted) return null;
  return await new Promise<IteratorResult<T> | null>((resolve, reject) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    iterator.next().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function record(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null
    ? (value as RecordValue)
    : null;
}
