import type { iMessageAdapter } from "@photon-ai/chat-adapter-imessage";

import type { CoastApplicationService } from "./contracts";
import {
  getPhotonDeliveryContext,
  registerPhotonContinuation,
  registerPhotonCriticalTask,
} from "./delivery-context";
import { TypingLease } from "./typing";
import { makeDeliveryKey } from "./webhook";

type RecordValue = Record<string, unknown>;

export type NativePollVote = {
  optionLabel: string;
  pollTitle: string;
  providerPollId?: string;
  providerMessageId: string;
  receivedAtMs: number;
  senderAddress: string;
  threadId: string;
};

/**
 * Parse an already-authenticated Spectrum `messages` delivery containing an
 * iMessage native-poll vote. This deliberately accepts only the smallest
 * source-backed shape needed to advance the conversation; no provider payload
 * is retained or logged here.
 */
export function parseNativePollVoteWebhook(
  payload: unknown,
  adapter: Pick<iMessageAdapter, "encodeThreadId" | "isDM">,
): NativePollVote | null {
  if (!isRecord(payload) || payload.event !== "messages") return null;
  const message = record(payload.message);
  const space = record(payload.space);
  if (message === null || space === null || message.direction === "outbound") {
    return null;
  }
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
    typeof space.id !== "string"
  ) {
    return null;
  }

  const phone =
    typeof space.phone === "string"
      ? space.phone
      : record(message.space)?.phone;
  const threadId = adapter.encodeThreadId({
    chatGuid: space.id,
    ...(typeof phone === "string" ? { phone } : {}),
  });
  if (!adapter.isDM(threadId)) return null;

  const timestamp = typeof message.timestamp === "string"
    ? Date.parse(message.timestamp)
    : Number.NaN;
  return {
    optionLabel: option.title,
    pollTitle: poll.title,
    ...(extractProviderPollId(message.id, sender.id) === null
      ? {}
      : { providerPollId: extractProviderPollId(message.id, sender.id) as string }),
    providerMessageId: message.id,
    receivedAtMs: Number.isFinite(timestamp) ? timestamp : Date.now(),
    senderAddress: sender.id,
    threadId,
  };
}

/**
 * Native poll selections are conversation input, not a one-off UI callback.
 * The adapter's in-memory modal registry cannot survive a serverless cold
 * start, so this bridge advances the durable Convex poll record directly after
 * the adapter has verified the webhook signature.
 */
export async function handleVerifiedNativePollVote(input: {
  adapter: Pick<iMessageAdapter, "startTyping">;
  application: CoastApplicationService;
  vote: NativePollVote;
}): Promise<void> {
  const context = getPhotonDeliveryContext();
  if (!context?.webhookId) {
    throw new Error("Missing verified Photon delivery context");
  }

  await handleNativePollVote({
    ...input,
    deliveryScope: context.webhookId,
  });
}

/**
 * Advances a selected native poll from any authenticated Photon transport.
 * Signed webhooks use their webhook id; the authenticated live gateway uses a
 * fixed scope and the provider message id remains the cross-transport dedupe
 * key in Convex.
 */
export async function handleNativePollVote(input: {
  adapter: Pick<iMessageAdapter, "startTyping">;
  application: CoastApplicationService;
  deliveryScope: string;
  markAsRead?: () => Promise<void>;
  vote: NativePollVote;
}): Promise<void> {
  const claimTask = input.application.claimInbound({
    deliveryKey: makeDeliveryKey(input.deliveryScope, input.vote.providerMessageId),
    messages: [
      {
        providerMessageId: input.vote.providerMessageId,
        sentAtMs: input.vote.receivedAtMs,
        text: "",
      },
    ],
    pollVote: {
      optionLabel: input.vote.optionLabel,
      pollTitle: input.vote.pollTitle,
      ...(input.vote.providerPollId === undefined
        ? {}
        : { providerPollId: input.vote.providerPollId }),
      selected: true,
    },
    providerMessageId: input.vote.providerMessageId,
    receivedAtMs: input.vote.receivedAtMs,
    senderAddress: input.vote.senderAddress,
    threadId: input.vote.threadId,
    webhookId: input.deliveryScope,
  });
  registerPhotonCriticalTask(claimTask);
  const claim = await claimTask;
  if (claim.status !== "claimed") return;

  const continuation = monitorSelectedPoll(input, claim);
  if (!registerPhotonContinuation(continuation)) await continuation;
}

/**
 * Spectrum 10 synthesizes poll vote message ids as
 * `<pollMessageGuid>:<senderId>:<optionId>:<action>:<eventTime>`. Isolating
 * that pinned-provider detail here lets Convex correlate on the durable poll
 * GUID without persisting the sender-bearing synthetic id.
 */
export function extractProviderPollId(
  providerMessageId: string,
  senderId: string,
): string | null {
  const marker = `:${senderId}:`;
  const markerIndex = providerMessageId.indexOf(marker);
  if (markerIndex <= 0) return null;
  const providerPollId = providerMessageId.slice(0, markerIndex);
  return providerPollId.length <= 512 ? providerPollId : null;
}

async function monitorSelectedPoll(
  input: {
    adapter: Pick<iMessageAdapter, "startTyping">;
    application: CoastApplicationService;
    markAsRead?: () => Promise<void>;
    vote: NativePollVote;
  },
  claim: Extract<
    Awaited<ReturnType<CoastApplicationService["claimInbound"]>>,
    { status: "claimed" }
  >,
): Promise<void> {
  const typing = new TypingLease(() => input.adapter.startTyping(input.vote.threadId));
  const acknowledgements: Promise<unknown>[] = [];
  if (claim.shouldAcknowledge && input.markAsRead) {
    acknowledgements.push(input.markAsRead());
  }
  if (claim.shouldStartTyping) acknowledgements.push(typing.start());
  await Promise.allSettled(acknowledgements);
  try {
    await input.application.executeTurn({
      claimId: claim.claimId,
      signal: new AbortController().signal,
      turnId: claim.turnId,
    });
  } finally {
    typing.stop();
  }
}

function record(value: unknown): RecordValue | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null;
}
