import { describe, expect, it, vi } from "vitest";

import { PhotonSafeLogger } from "../src/lib/photon/safe-logger";
import { TypingLease } from "../src/lib/photon/typing";

describe("Photon logging safety", () => {
  it("drops provider arguments and redacts body-shaped messages", () => {
    const info = vi.fn();
    const logger = new PhotonSafeLogger("test", {
      debug: vi.fn(),
      error: vi.fn(),
      info,
      warn: vi.fn(),
    });

    logger.info("Webhook received", {
      body: "dinner tonight",
      phone: "+14155550100",
      secret: "should-never-appear",
    });
    logger.info("https://example.com/?token=secret");
    logger.info("dinner tonight");
    logger.info("person@example.com");
    logger.info("Call me at +14155550100");
    logger.child("+14155550100").info("Incoming message");

    const output = info.mock.calls.flat().join(" ");
    expect(output).toContain("Webhook received");
    expect(output).toContain("redacted provider event");
    expect(output).not.toContain("dinner tonight");
    expect(output).not.toContain("14155550100");
    expect(output).not.toContain("should-never-appear");
    expect(output).not.toContain("person@example.com");
    expect(output).not.toContain("Call me at");
    expect(output).toContain("[test:child] Incoming message");
    expect(output.match(/redacted provider event/g)).toHaveLength(4);
  });
});

describe("typing cleanup", () => {
  it("stops refreshing after delivery completes", async () => {
    vi.useFakeTimers();
    const pulse = vi.fn(async () => undefined);
    const lease = new TypingLease(pulse, { refreshMs: 100 });

    await lease.start();
    await vi.advanceTimersByTimeAsync(250);
    expect(pulse).toHaveBeenCalledTimes(3);

    lease.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(pulse).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
