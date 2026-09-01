import { createHmac } from "node:crypto";

import { createiMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import { describe, expect, it, vi } from "vitest";

import {
  getPhotonDeliveryContext,
  registerPhotonContinuation,
  registerPhotonCriticalTask,
} from "../src/lib/photon/delivery-context";
import { PhotonSafeLogger } from "../src/lib/photon/safe-logger";
import {
  handlePhotonWebhook,
  SPECTRUM_WEBHOOK_ID_HEADER,
} from "../src/lib/photon/webhook";

describe("Photon webhook boundary", () => {
  it("preserves exact raw bytes and delivery context", async () => {
    const body = '{"message":"héllo\\n🌉"}\n';
    const dispatch = vi.fn(async (forwarded: Request) => {
      expect(getPhotonDeliveryContext()?.webhookId).toBe("wh_123");
      expect(new Uint8Array(await forwarded.arrayBuffer())).toEqual(
        new TextEncoder().encode(body),
      );
      return new Response(null, { status: 200 });
    });

    const response = await handlePhotonWebhook(
      new Request("https://coast.example/api/imessage/webhook", {
        body,
        headers: { [SPECTRUM_WEBHOOK_ID_HEADER]: "wh_123" },
        method: "POST",
      }),
      { dispatch, defer: vi.fn() },
    );

    expect(response.status).toBe(200);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("rejects an undeduplicatable delivery before dispatch", async () => {
    const dispatch = vi.fn();
    const response = await handlePhotonWebhook(
      new Request("https://coast.example/api/imessage/webhook", {
        body: "{}",
        method: "POST",
      }),
      { dispatch, defer: vi.fn() },
    );

    expect(response.status).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects a declared oversized delivery before reading it", async () => {
    const dispatch = vi.fn();
    const response = await handlePhotonWebhook(
      new Request("https://coast.example/api/imessage/webhook", {
        body: "{}",
        headers: {
          "content-length": String(2 * 1024 * 1024 + 1),
          [SPECTRUM_WEBHOOK_ID_HEADER]: "wh_large",
        },
        method: "POST",
      }),
      { dispatch, defer: vi.fn() },
    );

    expect(response.status).toBe(413);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns 503 when the durable claim fails before acknowledgment", async () => {
    const dispatch = vi.fn(async (_request: Request, options: { waitUntil?: (task: Promise<unknown>) => void }) => {
      const claim = Promise.reject(new Error("convex unavailable"));
      registerPhotonCriticalTask(claim);
      options.waitUntil?.(claim.catch(() => undefined));
      return new Response(null, { status: 200 });
    });

    const response = await handlePhotonWebhook(
      new Request("https://coast.example/api/imessage/webhook", {
        body: "{}",
        headers: { [SPECTRUM_WEBHOOK_ID_HEADER]: "wh_failed_claim" },
        method: "POST",
      }),
      { dispatch, defer: vi.fn() },
    );

    expect(response.status).toBe(503);
  });

  it("defers noncritical UX work only after a successful claim", async () => {
    const continuation = Promise.resolve();
    const defer = vi.fn();
    const dispatch = vi.fn(async (_request: Request, options: { waitUntil?: (task: Promise<unknown>) => void }) => {
      const claim = Promise.resolve();
      registerPhotonCriticalTask(claim);
      registerPhotonContinuation(continuation);
      options.waitUntil?.(claim);
      return new Response(null, { status: 200 });
    });

    const response = await handlePhotonWebhook(
      new Request("https://coast.example/api/imessage/webhook", {
        body: "{}",
        headers: { [SPECTRUM_WEBHOOK_ID_HEADER]: "wh_good_claim" },
        method: "POST",
      }),
      { dispatch, defer },
    );

    expect(response.status).toBe(200);
    expect(defer).toHaveBeenCalledWith(continuation);
  });
});

describe("pinned adapter signature behavior", () => {
  const secret = "whsec_test_only";
  const rawBody = '{"event":"not-a-message"}';

  function adapterRequest(options?: {
    signature?: string;
    timestamp?: string;
  }) {
    const timestamp = options?.timestamp ?? String(Math.floor(Date.now() / 1_000));
    const signature =
      options?.signature ??
      `v0=${createHmac("sha256", secret)
        .update(`v0:${timestamp}:${rawBody}`)
        .digest("hex")}`;
    return new Request("https://coast.example/api/imessage/webhook", {
      body: rawBody,
      headers: {
        "x-spectrum-event": "messages",
        "x-spectrum-signature": signature,
        "x-spectrum-timestamp": timestamp,
      },
      method: "POST",
    });
  }

  function verifiedAdapter() {
    const adapter = createiMessageAdapter({
      logger: new PhotonSafeLogger("test", {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      }),
      projectId: "project_test",
      projectSecret: "project_secret_test",
      webhookSecret: secret,
    });
    // handleWebhook only needs to know a Chat instance exists for non-message
    // events. Avoid initializing Spectrum Cloud in this dependency contract test.
    (adapter as unknown as { chat: object }).chat = {};
    return adapter;
  }

  it("accepts a valid raw-body HMAC", async () => {
    const response = await verifiedAdapter().handleWebhook(adapterRequest());
    expect(response.status).toBe(204);
  });

  it("rejects a bad signature", async () => {
    const response = await verifiedAdapter().handleWebhook(
      adapterRequest({ signature: "v0=bad" }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a stale timestamp outside five minutes", async () => {
    const response = await verifiedAdapter().handleWebhook(
      adapterRequest({ timestamp: String(Math.floor(Date.now() / 1_000) - 301) }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects missing signature headers", async () => {
    const response = await verifiedAdapter().handleWebhook(
      new Request("https://coast.example/api/imessage/webhook", {
        body: rawBody,
        method: "POST",
      }),
    );
    expect(response.status).toBe(400);
  });
});
