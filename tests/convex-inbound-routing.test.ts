import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

describe("Convex inbound creative routing", () => {
  it("ignores an ambiguity flag that has no creative command", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(internal.inbound.claimDelivery, {
      encryptedThreadRef: "encrypted-thread-reference",
      creativeCommandAmbiguous: true,
      providerMessageId: "ordinary-message",
      receivedAtMs: Date.parse("2026-09-09T17:35:43Z"),
      senderHash: "a".repeat(64),
      text: "What’s going on today?",
      threadKeyHash: "b".repeat(64),
      webhookId: "photon-webhook",
    });

    expect(result.controlReply).toBeNull();
    expect(result.command).toBe("none");
    expect(result.shouldStartTyping).toBe(true);

    const persisted = await t.run(async (ctx) => ({
      message: await ctx.db.get(result.messageId),
      turn: await ctx.db.get(result.turnId),
    }));
    expect(persisted.message?.body).toBe("What’s going on today?");
    expect(persisted.turn?.state).toBe("debouncing");
    expect(persisted.turn).not.toHaveProperty("creativeCommand");
  });
});
