import type { Message, MessageContext, Thread } from "chat";
import type { iMessageAdapter } from "@photon-ai/chat-adapter-imessage";

import type {
  CoastApplicationService,
  CoastPoll,
  CoastResult,
  InboundMessagePart,
  UnsupportedInboundContent,
} from "./contracts";
import {
  getPhotonDeliveryContext,
  registerPhotonContinuation,
  registerPhotonCriticalTask,
} from "./delivery-context";
import { TypingLease } from "./typing";
import { makeDeliveryKey } from "./webhook";

export type CoastInboundHandlerDependencies = {
  adapter: Pick<iMessageAdapter, "addReaction" | "isDM" | "startTyping">;
  application: CoastApplicationService;
  now?: () => number;
  typingLeaseFactory?: (pulse: () => Promise<void>) => TypingLease;
};

/**
 * The request-bound handler performs one durable operation: atomically claim
 * and schedule the inbound in Convex. Provider UX and the typing monitor are
 * continuations; generation and outbound delivery remain Convex-owned.
 */
export function createCoastInboundHandler(
  dependencies: CoastInboundHandlerDependencies,
): (
  thread: Thread,
  message: Message,
  _channel: unknown,
  context?: MessageContext,
) => Promise<void> {
  const now = dependencies.now ?? Date.now;

  return async (thread, message, _channel, context) => {
    if (!thread.isDM || !dependencies.adapter.isDM(thread.id)) return;

    const webhookId = getPhotonDeliveryContext()?.webhookId;
    if (!webhookId) throw new Error("Missing verified Photon delivery context");

    const inboundMessages = [...(context?.skipped ?? []), message];
    const detectedContent = detectUnsupportedInboundContent(inboundMessages);
    const locationSignal = detectedContent === "private_location";
    const unsupportedContent = locationSignal ? undefined : detectedContent;
    const vote = unsupportedContent || locationSignal ? undefined : parsePollVote(message.raw);
    if (vote?.selected === false) return;
    if (!unsupportedContent && !locationSignal && !vote && !message.text.trim()) return;

    const claimTask = dependencies.application.claimInbound({
      deliveryKey: makeDeliveryKey(webhookId, message.id),
      messages: toMessageParts(
        inboundMessages,
        unsupportedContent !== undefined || locationSignal,
      ),
      providerMessageId: message.id,
      receivedAtMs: now(),
      senderAddress: message.author.userId,
      threadId: thread.id,
      webhookId,
      ...(unsupportedContent ? { unsupportedContent } : {}),
      ...(locationSignal ? { locationSignal: true as const } : {}),
      ...(vote
        ? {
            pollVote: {
              optionLabel: vote.optionLabel,
              pollTitle: vote.pollTitle,
              selected: true as const,
            },
          }
        : {}),
    });
    registerPhotonCriticalTask(claimTask);
    const claim = await claimTask;
    if (claim.status !== "claimed") return;

    const continuation = acknowledgeAndMonitor(
      dependencies,
      thread,
      message,
      claim,
      unsupportedContent !== undefined || locationSignal,
    );
    if (!registerPhotonContinuation(continuation)) await continuation;
  };
}

async function acknowledgeAndMonitor(
  dependencies: CoastInboundHandlerDependencies,
  thread: Thread,
  message: Message,
  claim: Extract<
    Awaited<ReturnType<CoastApplicationService["claimInbound"]>>,
    { status: "claimed" }
  >,
  suppressReaction: boolean,
): Promise<void> {
  const typing =
    dependencies.typingLeaseFactory?.(() =>
      dependencies.adapter.startTyping(thread.id),
    ) ?? new TypingLease(() => dependencies.adapter.startTyping(thread.id));
  const acknowledgments: Promise<unknown>[] = [];

  if (claim.shouldAcknowledge) {
    acknowledgments.push(thread.markAsRead(message));
    if (claim.command === "none" && !suppressReaction) {
      acknowledgments.push(
        dependencies.adapter.addReaction(
          thread.id,
          message.id,
          contextualTapback(message.text),
        ),
      );
    }
  }
  if (claim.shouldStartTyping) acknowledgments.push(typing.start());
  await Promise.allSettled(acknowledgments);

  try {
    await dependencies.application.executeTurn({
      claimId: claim.claimId,
      signal: thread.signal,
      turnId: claim.turnId,
    });
  } finally {
    typing.stop();
  }
}

export function renderResultsMarkdown(results: CoastResult[]): string {
  if (results.length === 0) {
    return "_No picks yet — answer the quick question below and I’ll dial it in._";
  }
  return results
    .map((result) => {
      const name = escapeMarkdownLabel(oneLine(result.name));
      return `[${name}](${result.url}) — ${oneLine(result.timing)}\n${oneLine(result.description)}`;
    })
    .join("\n\n");
}

/** Poll titles intentionally equal their persisted questions for cold starts. */
export function nativePollTitle(poll: Pick<CoastPoll, "question">): string {
  return oneLine(poll.question).slice(0, 120);
}

const OMITTED_INBOUND_TEXT = "[unsupported inbound content omitted]";

function toMessageParts(
  messages: Message[],
  redactText: boolean,
): InboundMessagePart[] {
  return messages.map((item) => ({
    providerMessageId: item.id,
    sentAtMs: item.metadata.dateSent.getTime(),
    text: redactText ? OMITTED_INBOUND_TEXT : item.text,
  }));
}

/**
 * Attachment metadata and private coordinates are rejected before the Convex
 * application boundary. Inspection is bounded and never stringifies or logs
 * the provider payload.
 */
export function detectUnsupportedInboundContent(
  messages: Array<Pick<Message, "attachments" | "raw">>,
): UnsupportedInboundContent | undefined {
  for (const message of messages) {
    if (containsPrivateLocation(message.raw)) return "private_location";
  }
  if (messages.some((message) => (message.attachments?.length ?? 0) > 0)) {
    return "attachment";
  }
  return undefined;
}

const PRIVATE_LOCATION_TOKENS = new Set([
  "livelocation",
  "locationshare",
  "locationsharing",
  "locationupdated",
  "sharedfriendlocation",
  "sharedlocation",
]);

function containsPrivateLocation(root: unknown): boolean {
  const seen = new Set<object>();
  let visited = 0;

  function visit(value: unknown, depth: number): boolean {
    if (depth > 6 || visited >= 200 || !isRecord(value)) return false;
    if (seen.has(value)) return false;
    seen.add(value);
    visited += 1;

    if (hasCoordinatePair(value)) return true;
    for (const key of ["type", "kind", "eventType", "contentType"]) {
      const token = value[key];
      if (typeof token === "string") {
        const normalized = token.toLowerCase().replace(/[^a-z]/g, "");
        if (normalized === "location" || PRIVATE_LOCATION_TOKENS.has(normalized)) {
          return true;
        }
      }
    }

    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, "");
      if (
        PRIVATE_LOCATION_TOKENS.has(normalizedKey) &&
        (isRecord(nested) || Array.isArray(nested))
      ) {
        return true;
      }
      if (Array.isArray(nested)) {
        for (const item of nested) {
          if (visit(item, depth + 1)) return true;
          if (visited >= 200) break;
        }
      } else if (visit(nested, depth + 1)) {
        return true;
      }
    }
    return false;
  }

  return visit(root, 0);
}

function hasCoordinatePair(value: Record<string, unknown>): boolean {
  const latitude = value.latitude ?? value.lat;
  const longitude = value.longitude ?? value.lng ?? value.lon;
  return typeof latitude === "number" && typeof longitude === "number";
}

function contextualTapback(text: string): "heart" | "like" | "question" {
  const normalized = text.trim().toLowerCase();
  if (/\?|\b(?:where|when|what|which|who|how|can|could|should)\b/.test(normalized)) {
    return "question";
  }
  if (/\b(?:thanks|thank you|love|perfect|amazing|great)\b/.test(normalized)) {
    return "heart";
  }
  return "like";
}

type PollVote = { optionLabel: string; pollTitle: string; selected: boolean };

export function parsePollVote(raw: unknown): PollVote | undefined {
  if (!isRecord(raw) || !isRecord(raw.content)) return;
  const content = raw.content;
  if (content.type !== "poll_option") return;
  if (!isRecord(content.poll) || !isRecord(content.option)) return;
  if (
    typeof content.poll.title !== "string" ||
    typeof content.option.title !== "string" ||
    typeof content.selected !== "boolean"
  ) {
    return;
  }
  return {
    optionLabel: content.option.title,
    pollTitle: content.poll.title,
    selected: content.selected,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\\[\]])/g, "\\$1");
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
