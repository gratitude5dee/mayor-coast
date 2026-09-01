import { randomUUID } from "node:crypto";

import type { ConvexHttpClient } from "convex/browser";
import type { Lock, QueueEntry, StateAdapter } from "chat";

import { api } from "../../../convex/_generated/api";

const SUBSCRIBER_ID = "coast-imessage-v1";
const DEFAULT_LIST_LENGTH = 1_000;

function encode(value: unknown): string {
  const encoded = JSON.stringify({ value });
  if (encoded === undefined) throw new Error("State value is not serializable");
  return encoded;
}

function decode<T>(value: string): T {
  const parsed = JSON.parse(value) as { value: T };
  return parsed.value;
}

export class ConvexChatStateAdapter implements StateAdapter {
  constructor(
    private readonly client: ConvexHttpClient,
    private readonly serviceSecret: string,
    private readonly now: () => number = Date.now,
  ) {}

  async connect(): Promise<void> {
    await this.client.mutation(api.chatState.connect, this.auth());
  }

  async disconnect(): Promise<void> {
    await this.client.mutation(api.chatState.disconnect, this.auth());
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const value = await this.client.mutation(api.chatState.get, {
      ...this.auth(),
      key,
      nowMs: this.now(),
    });
    return value === null ? null : decode<T>(value);
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    await this.client.mutation(api.chatState.set, {
      ...this.auth(),
      key,
      value: encode(value),
      nowMs: this.now(),
      ...(ttlMs === undefined ? {} : { ttlMs }),
    });
  }

  async setIfNotExists(
    key: string,
    value: unknown,
    ttlMs?: number,
  ): Promise<boolean> {
    return await this.client.mutation(api.chatState.setIfNotExists, {
      ...this.auth(),
      key,
      value: encode(value),
      nowMs: this.now(),
      ...(ttlMs === undefined ? {} : { ttlMs }),
    });
  }

  async delete(key: string): Promise<void> {
    await this.client.mutation(api.chatState.deleteKey, {
      ...this.auth(),
      key,
      nowMs: this.now(),
    });
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ): Promise<void> {
    await this.client.mutation(api.chatState.appendToList, {
      ...this.auth(),
      key,
      value: encode(value),
      nowMs: this.now(),
      maxLength: options?.maxLength ?? DEFAULT_LIST_LENGTH,
      ...(options?.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    });
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    const values = await this.client.mutation(api.chatState.getList, {
      ...this.auth(),
      key,
      nowMs: this.now(),
    });
    return values.map((value) => decode<T>(value));
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const token = randomUUID();
    const nowMs = this.now();
    const acquired = await this.client.mutation(api.chatState.acquireLock, {
      ...this.auth(),
      key: threadId,
      token,
      nowMs,
      ttlMs,
    });
    return acquired ? { threadId, token, expiresAt: nowMs + ttlMs } : null;
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    const nowMs = this.now();
    const extended = await this.client.mutation(api.chatState.extendLock, {
      ...this.auth(),
      key: lock.threadId,
      token: lock.token,
      nowMs,
      ttlMs,
    });
    if (extended) lock.expiresAt = nowMs + ttlMs;
    return extended;
  }

  async releaseLock(lock: Lock): Promise<void> {
    await this.client.mutation(api.chatState.releaseLock, {
      ...this.auth(),
      key: lock.threadId,
      token: lock.token,
    });
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    await this.client.mutation(api.chatState.forceReleaseLock, {
      ...this.auth(),
      key: threadId,
    });
  }

  async enqueue(
    threadId: string,
    entry: QueueEntry,
    maxSize: number,
  ): Promise<number> {
    return await this.client.mutation(api.chatState.enqueue, {
      ...this.auth(),
      key: threadId,
      value: encode(entry),
      nowMs: this.now(),
      maxSize,
      expiresAtMs: entry.expiresAt,
    });
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    const value = await this.client.mutation(api.chatState.dequeue, {
      ...this.auth(),
      key: threadId,
      nowMs: this.now(),
    });
    return value === null ? null : decode<QueueEntry>(value);
  }

  async queueDepth(threadId: string): Promise<number> {
    return await this.client.mutation(api.chatState.queueDepth, {
      ...this.auth(),
      key: threadId,
      nowMs: this.now(),
    });
  }

  async subscribe(threadId: string): Promise<void> {
    await this.client.mutation(api.chatState.subscribe, {
      ...this.auth(),
      key: threadId,
      subscriberId: SUBSCRIBER_ID,
      nowMs: this.now(),
    });
  }

  async unsubscribe(threadId: string): Promise<void> {
    await this.client.mutation(api.chatState.unsubscribe, {
      ...this.auth(),
      key: threadId,
      subscriberId: SUBSCRIBER_ID,
    });
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    return await this.client.mutation(api.chatState.isSubscribed, {
      ...this.auth(),
      key: threadId,
      subscriberId: SUBSCRIBER_ID,
      nowMs: this.now(),
    });
  }

  private auth() {
    return { serviceSecret: this.serviceSecret };
  }
}
