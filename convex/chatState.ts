import { v } from "convex/values";

import type { MutationCtx } from "./_generated/server";
import { mutation } from "./_generated/server";
import { assertVercelServiceSecret as assertServiceSecret } from "./lib/service_auth";

const NEVER_EXPIRES_MS = 8_640_000_000_000_000;
const MAX_KEY_LENGTH = 512;
const MAX_TOKEN_LENGTH = 512;
const MAX_VALUE_LENGTH = 200_000;
const MAX_LIST_LENGTH = 1_000;
const MAX_QUEUE_DEPTH = 1_000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

function assertKey(key: string): void {
  if (key.length < 1 || key.length > MAX_KEY_LENGTH) throw new Error("INVALID_STATE_KEY");
}

function assertValue(value: string): void {
  if (value.length > MAX_VALUE_LENGTH) throw new Error("STATE_VALUE_TOO_LARGE");
}

function expiry(nowMs: number, ttlMs: number | undefined): number {
  if (ttlMs === undefined) return NEVER_EXPIRES_MS;
  return nowMs + Math.max(1, Math.min(MAX_TTL_MS, Math.floor(ttlMs)));
}

function entryExpiry(
  nowMs: number,
  ttlMs: number | undefined,
  expiresAtMs: number | undefined,
): number {
  if (expiresAtMs === undefined) return expiry(nowMs, ttlMs);
  return Math.max(nowMs + 1, Math.min(NEVER_EXPIRES_MS, Math.floor(expiresAtMs)));
}

async function nextSequence(ctx: MutationCtx, key: string, nowMs: number): Promise<number> {
  const counter = await ctx.db
    .query("chatStateCounters")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  if (counter === null) {
    await ctx.db.insert("chatStateCounters", { key, nextSequence: 2, updatedAtMs: nowMs });
    return 1;
  }
  await ctx.db.patch(counter._id, {
    nextSequence: counter.nextSequence + 1,
    updatedAtMs: nowMs,
  });
  return counter.nextSequence;
}

const authArgs = { serviceSecret: v.string() };

export const connect = mutation({
  args: authArgs,
  returns: v.boolean(),
  handler: async (_ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    return true;
  },
});

export const disconnect = mutation({
  args: authArgs,
  returns: v.boolean(),
  handler: async (_ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    return true;
  },
});

export const get = mutation({
  args: { ...authArgs, key: v.string(), nowMs: v.number() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    assertKey(args.key);
    const document = await ctx.db
      .query("chatStateKv")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (document === null) return null;
    if (document.expiresAtMs <= args.nowMs) {
      await ctx.db.delete(document._id);
      return null;
    }
    return document.value;
  },
});

export const set = mutation({
  args: {
    ...authArgs,
    key: v.string(),
    value: v.string(),
    nowMs: v.number(),
    ttlMs: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    assertKey(args.key);
    assertValue(args.value);
    const existing = await ctx.db
      .query("chatStateKv")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    const fields = {
      value: args.value,
      expiresAtMs: expiry(args.nowMs, args.ttlMs),
      updatedAtMs: args.nowMs,
    };
    if (existing === null) await ctx.db.insert("chatStateKv", { key: args.key, ...fields });
    else await ctx.db.patch(existing._id, fields);
    return null;
  },
});

export const setIfNotExists = mutation({
  args: {
    ...authArgs,
    key: v.string(),
    value: v.string(),
    nowMs: v.number(),
    ttlMs: v.optional(v.number()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    assertKey(args.key);
    assertValue(args.value);
    const existing = await ctx.db
      .query("chatStateKv")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (existing !== null && existing.expiresAtMs > args.nowMs) return false;
    if (existing !== null) await ctx.db.delete(existing._id);
    await ctx.db.insert("chatStateKv", {
      key: args.key,
      value: args.value,
      expiresAtMs: expiry(args.nowMs, args.ttlMs),
      updatedAtMs: args.nowMs,
    });
    return true;
  },
});

export const deleteKey = mutation({
  args: { ...authArgs, key: v.string(), nowMs: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    assertKey(args.key);
    let deleted = false;
    const kv = await ctx.db
      .query("chatStateKv")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (kv !== null) {
      await ctx.db.delete(kv._id);
      deleted = true;
    }
    const listItems = await ctx.db
      .query("chatStateListItems")
      .withIndex("by_key_sequence", (q) => q.eq("key", args.key))
      .take(MAX_LIST_LENGTH);
    for (const item of listItems) await ctx.db.delete(item._id);
    const queueItems = await ctx.db
      .query("chatStateQueueItems")
      .withIndex("by_key_sequence", (q) => q.eq("key", args.key))
      .take(MAX_QUEUE_DEPTH);
    for (const item of queueItems) await ctx.db.delete(item._id);
    const lock = await ctx.db
      .query("chatStateLocks")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (lock !== null) await ctx.db.delete(lock._id);
    return deleted || listItems.length > 0 || queueItems.length > 0 || lock !== null;
  },
});

export const appendToList = mutation({
  args: {
    ...authArgs,
    key: v.string(),
    value: v.string(),
    nowMs: v.number(),
    maxLength: v.number(),
    ttlMs: v.optional(v.number()),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    assertKey(args.key);
    assertValue(args.value);
    const maxLength = Math.max(1, Math.min(MAX_LIST_LENGTH, Math.floor(args.maxLength)));
    const items = await ctx.db
      .query("chatStateListItems")
      .withIndex("by_key_sequence", (q) => q.eq("key", args.key))
      .take(MAX_LIST_LENGTH + 1);
    const live = [];
    for (const item of items) {
      if (item.expiresAtMs <= args.nowMs) await ctx.db.delete(item._id);
      else live.push(item);
    }
    const sequence = await nextSequence(ctx, `list:${args.key}`, args.nowMs);
    await ctx.db.insert("chatStateListItems", {
      key: args.key,
      sequence,
      value: args.value,
      expiresAtMs: expiry(args.nowMs, args.ttlMs),
      createdAtMs: args.nowMs,
    });
    const overflow = Math.max(0, live.length + 1 - maxLength);
    for (const item of live.slice(0, overflow)) await ctx.db.delete(item._id);
    return Math.min(live.length + 1, maxLength);
  },
});

export const getList = mutation({
  args: { ...authArgs, key: v.string(), nowMs: v.number(), limit: v.optional(v.number()) },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    assertKey(args.key);
    const limit = Math.max(1, Math.min(MAX_LIST_LENGTH, Math.floor(args.limit ?? MAX_LIST_LENGTH)));
    const items = await ctx.db
      .query("chatStateListItems")
      .withIndex("by_key_sequence", (q) => q.eq("key", args.key))
      .take(limit);
    const values: string[] = [];
    for (const item of items) {
      if (item.expiresAtMs <= args.nowMs) await ctx.db.delete(item._id);
      else values.push(item.value);
    }
    return values;
  },
});

export const acquireLock = mutation({
  args: {
    ...authArgs,
    key: v.string(),
    token: v.string(),
    nowMs: v.number(),
    ttlMs: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    assertKey(args.key);
    if (args.token.length < 1 || args.token.length > MAX_TOKEN_LENGTH) throw new Error("INVALID_LOCK_TOKEN");
    const existing = await ctx.db
      .query("chatStateLocks")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (existing !== null && existing.expiresAtMs > args.nowMs) return false;
    if (existing !== null) await ctx.db.delete(existing._id);
    await ctx.db.insert("chatStateLocks", {
      key: args.key,
      token: args.token,
      expiresAtMs: expiry(args.nowMs, args.ttlMs),
      updatedAtMs: args.nowMs,
    });
    return true;
  },
});

export const extendLock = mutation({
  args: {
    ...authArgs,
    key: v.string(),
    token: v.string(),
    nowMs: v.number(),
    ttlMs: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    assertKey(args.key);
    const existing = await ctx.db
      .query("chatStateLocks")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (existing === null || existing.expiresAtMs <= args.nowMs || existing.token !== args.token) {
      if (existing !== null && existing.expiresAtMs <= args.nowMs) await ctx.db.delete(existing._id);
      return false;
    }
    await ctx.db.patch(existing._id, {
      expiresAtMs: expiry(args.nowMs, args.ttlMs),
      updatedAtMs: args.nowMs,
    });
    return true;
  },
});

export const releaseLock = mutation({
  args: { ...authArgs, key: v.string(), token: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    assertKey(args.key);
    const existing = await ctx.db
      .query("chatStateLocks")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (existing === null || existing.token !== args.token) return false;
    await ctx.db.delete(existing._id);
    return true;
  },
});

export const forceReleaseLock = mutation({
  args: { ...authArgs, key: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    assertKey(args.key);
    const existing = await ctx.db
      .query("chatStateLocks")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (existing === null) return false;
    await ctx.db.delete(existing._id);
    return true;
  },
});

export const enqueue = mutation({
  args: {
    ...authArgs,
    key: v.string(),
    value: v.string(),
    nowMs: v.number(),
    maxSize: v.number(),
    ttlMs: v.optional(v.number()),
    expiresAtMs: v.optional(v.number()),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    assertKey(args.key);
    assertValue(args.value);
    const maxSize = Math.max(1, Math.min(MAX_QUEUE_DEPTH, Math.floor(args.maxSize)));
    const items = await ctx.db
      .query("chatStateQueueItems")
      .withIndex("by_key_sequence", (q) => q.eq("key", args.key))
      .take(MAX_QUEUE_DEPTH + 1);
    const live = [];
    for (const item of items) {
      if (item.expiresAtMs <= args.nowMs) await ctx.db.delete(item._id);
      else live.push(item);
    }
    const overflow = Math.max(0, live.length + 1 - maxSize);
    for (const item of live.slice(0, overflow)) await ctx.db.delete(item._id);
    const sequence = await nextSequence(ctx, `queue:${args.key}`, args.nowMs);
    await ctx.db.insert("chatStateQueueItems", {
      key: args.key,
      sequence,
      value: args.value,
      expiresAtMs: entryExpiry(args.nowMs, args.ttlMs, args.expiresAtMs),
      createdAtMs: args.nowMs,
    });
    return Math.min(live.length + 1, maxSize);
  },
});

export const dequeue = mutation({
  args: { ...authArgs, key: v.string(), nowMs: v.number() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    assertKey(args.key);
    const candidates = await ctx.db
      .query("chatStateQueueItems")
      .withIndex("by_key_sequence", (q) => q.eq("key", args.key))
      .take(MAX_QUEUE_DEPTH);
    for (const item of candidates) {
      await ctx.db.delete(item._id);
      if (item.expiresAtMs > args.nowMs) return item.value;
    }
    return null;
  },
});

export const queueDepth = mutation({
  args: { ...authArgs, key: v.string(), nowMs: v.number() },
  returns: v.number(),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    assertKey(args.key);
    const items = await ctx.db
      .query("chatStateQueueItems")
      .withIndex("by_key_sequence", (q) => q.eq("key", args.key))
      .take(MAX_QUEUE_DEPTH);
    let depth = 0;
    for (const item of items) {
      if (item.expiresAtMs <= args.nowMs) await ctx.db.delete(item._id);
      else depth += 1;
    }
    return depth;
  },
});

export const subscribe = mutation({
  args: {
    ...authArgs,
    key: v.string(),
    subscriberId: v.string(),
    nowMs: v.number(),
    ttlMs: v.optional(v.number()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    assertKey(args.key);
    const existing = await ctx.db
      .query("chatStateSubscriptions")
      .withIndex("by_key_subscriber", (q) =>
        q.eq("key", args.key).eq("subscriberId", args.subscriberId),
      )
      .unique();
    const expiresAtMs = expiry(args.nowMs, args.ttlMs);
    if (existing === null) {
      await ctx.db.insert("chatStateSubscriptions", {
        key: args.key,
        subscriberId: args.subscriberId,
        expiresAtMs,
        createdAtMs: args.nowMs,
      });
    } else {
      await ctx.db.patch(existing._id, { expiresAtMs });
    }
    return true;
  },
});

export const unsubscribe = mutation({
  args: { ...authArgs, key: v.string(), subscriberId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    assertKey(args.key);
    const existing = await ctx.db
      .query("chatStateSubscriptions")
      .withIndex("by_key_subscriber", (q) =>
        q.eq("key", args.key).eq("subscriberId", args.subscriberId),
      )
      .unique();
    if (existing === null) return false;
    await ctx.db.delete(existing._id);
    return true;
  },
});

export const isSubscribed = mutation({
  args: { ...authArgs, key: v.string(), subscriberId: v.string(), nowMs: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    assertKey(args.key);
    const existing = await ctx.db
      .query("chatStateSubscriptions")
      .withIndex("by_key_subscriber", (q) =>
        q.eq("key", args.key).eq("subscriberId", args.subscriberId),
      )
      .unique();
    if (existing === null) return false;
    if (existing.expiresAtMs <= args.nowMs) {
      await ctx.db.delete(existing._id);
      return false;
    }
    return true;
  },
});
