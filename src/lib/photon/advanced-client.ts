import type { iMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import type { Message } from "chat";

type SharedLocation = {
  accuracy?: number;
  expiresAt?: Date | string;
  isLocatingInProgress?: boolean;
  latitude?: number;
  locationTimestamp?: Date | string;
  locationType?: "legacy" | "live" | "shallow" | "unknown" | string;
  longitude?: number;
  shortAddress?: string;
};

export type AdvancedPollEvent = {
  actor?: { address?: string };
  chatGuid: string;
  delta:
    | { type: "voted" | "unvoted"; optionIdentifier: string }
    | { type: "created" | "optionAdded" };
  isFromMe: boolean;
  occurredAt: Date;
  pollMessageGuid: string;
  sequence: number;
  type: "poll.changed";
};

type CloseableAsyncIterable<T> = AsyncIterable<T> & {
  close?: () => Promise<void>;
};

export type AdvancedClient = {
  chats: {
    markRead(chatGuid: string): Promise<void>;
  };
  events: {
    catchUp(since?: number): CloseableAsyncIterable<unknown>;
  };
  locations: {
    get(address: string): Promise<SharedLocation>;
    request(
      chatGuid: string,
      address: string,
      options?: { clientMessageId?: string },
    ): Promise<{ messageGuid?: string; status: string }>;
  };
  polls: {
    get(pollMessageGuid: string): Promise<{
      options: ReadonlyArray<{ optionIdentifier: string; text: string }>;
      pollMessageGuid: string;
      title: string;
    }>;
    subscribeEvents(): CloseableAsyncIterable<AdvancedPollEvent>;
  };
};

export type AdvancedEntry = { client: AdvancedClient; phone: string };

type AdapterWithChatRead = iMessageAdapter & {
  markAsRead?: (
    threadId: string,
    messageId: string,
    message?: Message,
  ) => Promise<void>;
};

/**
 * Chat SDK 4 calls `markAsRead`; Photon adapter 3.2 exposes `markRead` instead.
 * The underlying pinned Spectrum 10 provider already owns an authenticated
 * Advanced iMessage client, whose chat-level read call is both session-free
 * and idempotent. Keep the compatibility shim isolated here.
 */
export function installReadReceiptCompatibility(adapter: iMessageAdapter): void {
  const compatible = adapter as AdapterWithChatRead;
  compatible.markAsRead ??= async (threadId) => {
    await markThreadRead(adapter, threadId);
  };
}

export async function markThreadRead(
  adapter: iMessageAdapter,
  threadId: string,
): Promise<void> {
  const { chatGuid } = adapter.decodeThreadId(threadId);
  const client = advancedClientForThread(adapter, threadId);
  await client.chats.markRead(chatGuid);
}

export async function requestLocationSharing(input: {
  adapter: iMessageAdapter;
  clientMessageId: string;
  threadId: string;
}): Promise<{ messageGuid?: string; status: string }> {
  const { chatGuid } = input.adapter.decodeThreadId(input.threadId);
  const address = participantAddressFromDmChatGuid(chatGuid);
  const client = advancedClientForThread(input.adapter, input.threadId);
  return await client.locations.request(chatGuid, address, {
    clientMessageId: input.clientMessageId,
  });
}

/**
 * Reads one consented Find My snapshot for immediate routing only. Callers
 * must not persist the returned precise coordinates or log this object.
 */
export async function getSharedLocation(input: {
  adapter: iMessageAdapter;
  threadId: string;
}): Promise<SharedLocation> {
  const { chatGuid } = input.adapter.decodeThreadId(input.threadId);
  const address = participantAddressFromDmChatGuid(chatGuid);
  const client = advancedClientForThread(input.adapter, input.threadId);
  return await client.locations.get(address);
}

export function participantAddressFromDmChatGuid(chatGuid: string): string {
  const parts = chatGuid.split(";");
  if (parts.length < 3 || parts.at(-2) !== "-") {
    throw new Error("LOCATION_REQUIRES_DIRECT_MESSAGE");
  }
  const address = parts.at(-1)?.trim() ?? "";
  const isPhone = /^\+[1-9]\d{6,14}$/.test(address);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
  if (!isPhone && !isEmail) throw new Error("LOCATION_PARTICIPANT_UNAVAILABLE");
  return address;
}

function advancedClientForThread(
  adapter: iMessageAdapter,
  threadId: string,
): AdvancedClient {
  const { phone } = adapter.decodeThreadId(threadId);
  const candidates = getAdvancedEntries(adapter);
  const selected = phone
    ? candidates.find((entry) => entry.phone === phone)
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  if (!selected) throw new Error("PHOTON_LINE_UNAVAILABLE");
  return selected.client;
}

export function getAdvancedEntries(adapter: iMessageAdapter): AdvancedEntry[] {
  const app = adapter.app;
  if (!app) throw new Error("PHOTON_NOT_INITIALIZED");
  const runtime = app.__internal.platforms.get("iMessage");
  const entries = runtime?.client;
  if (!Array.isArray(entries)) {
    throw new Error("PHOTON_ADVANCED_CLIENT_UNAVAILABLE");
  }
  const candidates = entries.filter(isAdvancedEntry);
  if (candidates.length === 0) {
    throw new Error("PHOTON_ADVANCED_CLIENT_UNAVAILABLE");
  }
  return candidates;
}

function isAdvancedEntry(value: unknown): value is AdvancedEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.phone !== "string") return false;
  if (typeof entry.client !== "object" || entry.client === null) return false;
  const client = entry.client as Record<string, unknown>;
  return (
    typeof client.chats === "object" &&
    client.chats !== null &&
    typeof (client.chats as Record<string, unknown>).markRead === "function" &&
    typeof client.events === "object" &&
    client.events !== null &&
    typeof (client.events as Record<string, unknown>).catchUp === "function" &&
    typeof client.locations === "object" &&
    client.locations !== null &&
    typeof (client.locations as Record<string, unknown>).request === "function" &&
    typeof (client.locations as Record<string, unknown>).get === "function" &&
    typeof client.polls === "object" &&
    client.polls !== null &&
    typeof (client.polls as Record<string, unknown>).get === "function" &&
    typeof (client.polls as Record<string, unknown>).subscribeEvents === "function"
  );
}
