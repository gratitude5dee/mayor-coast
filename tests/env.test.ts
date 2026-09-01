import { describe, expect, it } from "vitest";

import { configurationReadiness, parseServerEnv } from "@/lib/env";
import { normalizeSenderAddress, pseudonymizeSender } from "@/lib/security/identity";
import { serviceSecretFingerprintHex } from "../convex/lib/service_auth";

const completeEnv = {
  OPENAI_API_KEY: "sk-test-abcdefghijklmnopqrstuvwxyz",
  OPENAI_MODEL_LUNA: "gpt-5.6-luna",
  OPENAI_MODEL_TERRA: "gpt-5.6-terra",
  CONVEX_DEPLOYMENT: "dev:coast-test",
  NEXT_PUBLIC_CONVEX_URL: "https://coast-test.convex.cloud",
  CONVEX_URL: "https://coast-test.convex.cloud",
  COAST_IDENTITY_PEPPER: "p".repeat(32),
  COAST_AGENT_RUNTIME_URL: "https://coast-test.vercel.app/api/internal/agent",
  COAST_DELIVERY_URL: "https://coast-test.vercel.app/api/internal/delivery",
  IMESSAGE_PROJECT_ID: "project-test",
  IMESSAGE_PROJECT_SECRET: "project-secret-test-value",
  IMESSAGE_WEBHOOK_SECRET: "webhook-secret-test-value",
};

describe("server environment", () => {
  it("accepts a complete configuration", () => {
    expect(parseServerEnv(completeEnv).OPENAI_MODEL_LUNA).toBe("gpt-5.6-luna");
    expect(parseServerEnv(completeEnv).convexServiceSecret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(
      parseServerEnv({
        ...completeEnv,
        IMESSAGE_WEBHOOK_SECRET: ` ${completeEnv.IMESSAGE_WEBHOOK_SECRET} `,
      }).convexServiceSecret,
    ).toBe(parseServerEnv(completeEnv).convexServiceSecret);
    expect(configurationReadiness(completeEnv)).toEqual({ ready: true, invalidKeys: [] });
  });

  it("reports names but never secret values", () => {
    const source = { ...completeEnv, OPENAI_API_KEY: "secret-value" };
    expect(() => parseServerEnv(source)).toThrow("OPENAI_API_KEY");
    expect(() => parseServerEnv(source)).not.toThrow("secret-value");
  });
});

describe("sender pseudonyms", () => {
  it("normalizes equivalent phone forms", () => {
    expect(normalizeSenderAddress(" +1 (415) 555-1212 ")).toBe("+14155551212");
    expect(pseudonymizeSender("+1 415 555 1212", "p".repeat(32))).toBe(
      pseudonymizeSender("+14155551212", "p".repeat(32)),
    );
  });

  it("does not expose the source address", () => {
    const pseudonym = pseudonymizeSender("person@example.com", "p".repeat(32));
    expect(pseudonym).toMatch(/^[a-f0-9]{64}$/);
    expect(pseudonym).not.toContain("person");
  });
});

describe("service credential fingerprints", () => {
  it("uses the standard SHA-256 representation", () => {
    expect(serviceSecretFingerprintHex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
