import type { StateAdapter } from "chat";

export type InboundMessagePart = {
  providerMessageId: string;
  sentAtMs: number;
  text: string;
};

export type UnsupportedInboundContent = "attachment" | "private_location";

export type InboundClaimInput = {
  deliveryKey: string;
  providerMessageId: string;
  receivedAtMs: number;
  senderAddress: string;
  threadId: string;
  webhookId: string;
  messages: InboundMessagePart[];
  /** A private Find My payload was seen. Its contents are deliberately omitted. */
  locationSignal?: true;
  unsupportedContent?: UnsupportedInboundContent;
  pollVote?: {
    optionLabel: string;
    pollTitle: string;
    providerPollId?: string;
    selected: true;
  };
};

export type InboundClaimResult =
  | { status: "blocked" | "duplicate" }
  | {
      claimId: string;
      command: "forget_me" | "help" | "none" | "start" | "stop";
      shouldAcknowledge: boolean;
      shouldStartTyping: boolean;
      status: "claimed";
      turnId: string;
    };

export type CoastResult = {
  description: string;
  externalId: string;
  name: string;
  timing: string;
  url: string;
};

export type CoastPoll = {
  externalId: string;
  options: Array<{ label: string; value: string }>;
  question: string;
};

export type CoastTurnPlan = {
  poll?: CoastPoll;
  provenanceIds: string[];
  response: string;
  results: CoastResult[];
  turnId: string;
};

export type TurnExecutionResult =
  { status: "completed" | "failed" | "ignored" | "superseded" };

export type OutboundPart = "poll" | "response" | "results";

/**
 * Durable application boundary implemented by Convex.
 *
 * The transport never owns user memory, message history, dedupe state, or
 * outbound progress. In particular, `claimInbound` must be atomic and
 * `reserveOutbound` must return false once a part has already been reserved.
 */
export interface CoastApplicationService {
  claimInbound(input: InboundClaimInput): Promise<InboundClaimResult>;
  executeTurn(input: {
    claimId: string;
    signal: AbortSignal;
    turnId: string;
  }): Promise<TurnExecutionResult>;
}

export type CoastPhotonRuntimeDependencies = {
  application: CoastApplicationService;
  state: StateAdapter;
};
