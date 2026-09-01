import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type {
  CoastApplicationService,
  InboundClaimInput,
  InboundClaimResult,
  TurnExecutionResult,
} from "../photon/contracts";
import {
  encryptThreadReference,
  pseudonymizeOpaqueIdentifier,
  pseudonymizeSender,
} from "../security/identity";

const TERMINAL_POLL_MS = 350;
const TYPING_MONITOR_LIMIT_MS = 55_000;

export type ConvexCoastApplicationOptions = {
  client: ConvexHttpClient;
  identityPepper: string;
  serviceSecret: string;
  now?: () => number;
};

export class ConvexCoastApplicationService implements CoastApplicationService {
  private readonly now: () => number;

  constructor(private readonly options: ConvexCoastApplicationOptions) {
    this.now = options.now ?? Date.now;
  }

  async claimInbound(input: InboundClaimInput): Promise<InboundClaimResult> {
    // Spectrum's synthetic poll event ids may embed the voter address. Replace
    // that provider value with a stable pseudonym before it crosses into
    // Convex; the separate senderAddress is already HMACed below.
    const providerMessageId = input.pollVote
      ? pseudonymizeOpaqueIdentifier(
          input.providerMessageId,
          this.options.identityPepper,
          "photon-poll-vote",
        )
      : input.providerMessageId;
    const common = {
      serviceSecret: this.options.serviceSecret,
      webhookId: input.webhookId,
      providerMessageId,
      senderHash: pseudonymizeSender(
        input.senderAddress,
        this.options.identityPepper,
      ),
      threadKeyHash: pseudonymizeOpaqueIdentifier(
        input.threadId,
        this.options.identityPepper,
        "photon-thread",
      ),
      encryptedThreadRef: encryptThreadReference(
        input.threadId,
        this.options.serviceSecret,
      ),
      receivedAtMs: input.receivedAtMs,
    };

    let result;
    try {
      result = input.pollVote
        ? await this.options.client.action(api.service.claimPollVote, {
            ...common,
            pollTitle: input.pollVote.pollTitle,
            ...(input.pollVote.providerPollId === undefined
              ? {}
              : { providerPollId: input.pollVote.providerPollId }),
            selectedOption: input.pollVote.optionLabel,
          })
        : await this.options.client.action(api.service.claimInbound, {
            ...common,
            text: input.messages.at(-1)?.text ?? "",
            ...(input.locationSignal ? { locationSignal: true } : {}),
            ...(input.unsupportedContent
              ? { unsupportedContent: input.unsupportedContent }
              : {}),
          });
    } catch (error) {
      if (input.pollVote && isNonRetryablePollError(error)) {
        return { status: "blocked" };
      }
      throw error;
    }

    if (result.duplicate) return { status: "duplicate" };
    if (!result.accepted) return { status: "blocked" };
    return {
      claimId: result.messageId,
      command: result.command,
      shouldAcknowledge: result.shouldAcknowledge,
      shouldStartTyping: result.shouldStartTyping,
      status: "claimed",
      turnId: result.turnId,
    };
  }

  async executeTurn(input: {
    claimId: string;
    signal: AbortSignal;
    turnId: string;
  }): Promise<TurnExecutionResult> {
    void input.claimId;
    const deadline = this.now() + TYPING_MONITOR_LIMIT_MS;
    while (!input.signal.aborted && this.now() < deadline) {
      const status = await this.options.client.action(api.service.getTurnStatus, {
        serviceSecret: this.options.serviceSecret,
        turnId: input.turnId as Id<"coastTurns">,
      });
      if (status === null) return { status: "ignored" };
      if (status.state === "sent") return { status: "completed" };
      if (status.state === "superseded") return { status: "superseded" };
      if (status.state === "failed" || status.state === "cancelled") {
        return { status: "failed" };
      }
      await abortableDelay(TERMINAL_POLL_MS, input.signal);
    }
    return { status: "ignored" };
  }
}

function isNonRetryablePollError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /POLL_(?:OPTION_NOT_FOUND|SELECTION_NOT_PENDING|SELECTION_SUPERSEDED|THREAD_NOT_FOUND|USER_NOT_ACTIVE)/.test(
    message,
  );
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, ms);
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
