import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { serviceSecretFingerprintHex } from "../convex/lib/service_auth";

const modules = import.meta.glob("../convex/**/*.ts");
const secret = "admin-directory-test-service-secret";

function enableServiceAuth() {
  process.env.COAST_VERCEL_SERVICE_SECRET_HASH = serviceSecretFingerprintHex(secret);
}

describe("COAST admin directory", () => {
  it("pages users by recent activity beyond the former 100-user limit", async () => {
    enableServiceAuth();
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let index = 0; index < 105; index += 1) {
        await ctx.db.insert("coastUsers", {
          senderHash: `${index}`.padStart(64, "0"), status: "active",
          createdAtMs: index, updatedAtMs: index, lastSeenAtMs: index,
        });
      }
    });
    const first = await t.query(api.admin.directory, { serviceSecret: secret, paginationOpts: { numItems: 25, cursor: null } });
    expect(first.page).toHaveLength(25);
    expect(first.isDone).toBe(false);
    expect(first.page[0]?.lastSeenAtMs).toBe(104);
    const later = await t.query(api.admin.directory, { serviceSecret: secret, paginationOpts: { numItems: 25, cursor: first.continueCursor } });
    expect(later.page[0]?.lastSeenAtMs).toBe(79);
  });

  it("backfills verified delivery ownership before user-scoped pagination", async () => {
    enableServiceAuth();
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("coastUsers", { senderHash: "a".repeat(64), status: "active", createdAtMs: 1, updatedAtMs: 1, lastSeenAtMs: 1 });
      const threadId = await ctx.db.insert("coastThreads", { userId, provider: "imessage", providerThreadKeyHash: "b".repeat(64), encryptedProviderThreadRef: "ciphertext", status: "active", latestInboundAtMs: 1, createdAtMs: 1, updatedAtMs: 1 });
      const turnId = await ctx.db.insert("coastTurns", { userId, threadId, state: "sent", revision: 0, messageIds: [], carryForwardTurnIds: [], scheduledForMs: 1, attemptCount: 0, createdAtMs: 1, updatedAtMs: 1 });
      await ctx.db.insert("outboundDeliveries", { turnId, threadId, stage: "response", payload: {}, idempotencyKey: "delivery", status: "sent", attemptCount: 1, nextAttemptAtMs: 1, createdAtMs: 1, updatedAtMs: 1, sentAtMs: 1 });
      return { userId };
    });
    const migration = await t.mutation(internal.admin.backfillOwners, { table: "outboundDeliveries", cursor: null });
    expect(migration.updated).toBe(1);
    const deliveries = await t.query(api.admin.records, { serviceSecret: secret, section: "deliveries", userId: ids.userId, paginationOpts: { numItems: 25, cursor: null } });
    expect(deliveries.page).toHaveLength(1);
    expect(deliveries.page[0]?.status).toBe("sent");
  });

  it("finds an exact verified identity while keeping forgotten identities unavailable", async () => {
    enableServiceAuth();
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("coastUsers", {
        senderHash: "identity-active", status: "active", createdAtMs: 1, updatedAtMs: 1, lastSeenAtMs: 1,
      });
      await ctx.db.insert("coastUsers", {
        senderHash: "identity-forgotten", status: "forgotten", createdAtMs: 2, updatedAtMs: 2, lastSeenAtMs: 2,
      });
    });
    const active = await t.query(api.admin.searchUser, { serviceSecret: secret, senderHash: "identity-active" });
    const forgotten = await t.query(api.admin.searchUser, { serviceSecret: secret, senderHash: "identity-forgotten" });
    expect(active?.status).toBe("active");
    expect(forgotten).toBeNull();
  });
});
