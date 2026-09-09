import { describe, expect, it } from "vitest";

import { fields } from "../convex/admin";
import { adminSession, validAdminSession } from "@/lib/admin-auth";
import { adminIdentityFromEncryptedThreadRef } from "@/lib/admin-identities";
import { encryptThreadReference } from "@/lib/security/identity";

describe("COAST admin sessions", () => {
  const secret = "service-secret-with-at-least-thirty-two-characters";
  const now = Date.UTC(2026, 8, 9, 12);

  it("accepts a fresh signed session and rejects expiry or tampering", () => {
    const session = adminSession(secret, now);
    expect(validAdminSession(session, secret, now)).toBe(true);
    expect(validAdminSession(session, secret, now + 8 * 60 * 60_000 + 1)).toBe(false);
    expect(validAdminSession(`${session.slice(0, -1)}0`, secret, now)).toBe(false);
    expect(validAdminSession(session, `${secret}-wrong`, now)).toBe(false);
  });

  it("rejects malformed signatures without throwing", () => {
    const expires = now + 60_000;
    expect(validAdminSession(`${expires}.${"é".repeat(64)}`, secret, now)).toBe(false);
    expect(validAdminSession(`${expires}.${"z".repeat(64)}`, secret, now)).toBe(false);
    expect(validAdminSession(`${expires}.${"0".repeat(64)}.extra`, secret, now)).toBe(false);
  });
});

describe("COAST admin privacy projection", () => {
  it("excludes content, addresses, secrets, private media, and payment URLs", () => {
    const exposed = new Set(Object.values(fields).flat());
    const forbidden = [
      "body",
      "payload",
      "prompt",
      "encryptedPayload",
      "encryptedAuth",
      "encryptedProviderThreadRef",
      "providerMessageId",
      "senderHash",
      "sourceUrl",
      "checkoutUrl",
      "launchSecretHash",
      "encryptedLaunchSecret",
    ];
    for (const field of forbidden) expect(exposed.has(field as never), field).toBe(false);
  });

  it("keeps the records needed to monitor creative use and settlement", () => {
    expect(fields.jobs).toEqual(expect.arrayContaining(["state", "providerModel", "reservationSource", "reservedCents"]));
    expect(fields.payments).toEqual(expect.arrayContaining(["paymentPath", "status", "chargeCents", "creditCents"]));
    expect(fields.balances).toContain("balanceCents");
    expect(fields.usage).toEqual(expect.arrayContaining(["kind", "admittedAtMs", "settled"]));
  });
});

describe("COAST admin user identity", () => {
  const secret = "service-secret-with-at-least-thirty-two-characters";

  it("shows the user and dedicated Photon phone from an authenticated encrypted thread reference", () => {
    const encrypted = encryptThreadReference(
      "imessage:iMessage;-;+14155550100~+14155550999",
      secret,
    );
    expect(adminIdentityFromEncryptedThreadRef(encrypted, secret)).toEqual({
      userAddress: "+14155550100",
      userPhone: "+14155550100",
      userEmail: null,
      photonLine: "+14155550999",
      photonPhone: "+14155550999",
    });
  });

  it("labels a shared Photon line without inventing a phone number", () => {
    const encrypted = encryptThreadReference(
      "imessage:iMessage;-;person@example.com~shared",
      secret,
    );
    expect(adminIdentityFromEncryptedThreadRef(encrypted, secret)).toEqual({
      userAddress: "person@example.com",
      userPhone: null,
      userEmail: "person@example.com",
      photonLine: "shared",
      photonPhone: null,
    });
  });

  it("does not expose malformed or unauthenticated thread references", () => {
    expect(adminIdentityFromEncryptedThreadRef("malformed", secret)).toEqual({
      userAddress: null,
      userPhone: null,
      userEmail: null,
      photonLine: null,
      photonPhone: null,
    });
  });
});
