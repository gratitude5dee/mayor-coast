import type { iMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import { describe, expect, it, vi } from "vitest";

import {
  getSharedLocation,
  installReadReceiptCompatibility,
  participantAddressFromDmChatGuid,
  requestLocationSharing,
} from "../src/lib/photon/advanced-client";

function adapterFixture() {
  const markRead = vi.fn(async () => undefined);
  const request = vi.fn(async () => ({
    messageGuid: "location-request-guid",
    status: "sent",
  }));
  const get = vi.fn(async () => ({
    latitude: 37.77,
    locationType: "live",
    longitude: -122.42,
  }));
  const adapter = {
    app: {
      __internal: {
        platforms: new Map([
          [
            "iMessage",
            {
              client: [
                {
                  client: {
                    chats: { markRead },
                    events: { catchUp: vi.fn() },
                    locations: { get, request },
                    polls: {
                      get: vi.fn(),
                      subscribeEvents: vi.fn(),
                    },
                  },
                  phone: "shared",
                },
              ],
            },
          ],
        ]),
      },
    },
    decodeThreadId: vi.fn(() => ({
      chatGuid: "any;-;+14155550100",
      phone: "shared",
    })),
  } as unknown as iMessageAdapter;
  return { adapter, get, markRead, request };
}

describe("Photon Advanced iMessage compatibility", () => {
  it("bridges Chat SDK markAsRead to chat-level Advanced iMessage read state", async () => {
    const { adapter, markRead } = adapterFixture();
    installReadReceiptCompatibility(adapter);
    const compatible = adapter as iMessageAdapter & {
      markAsRead: (threadId: string, messageId: string) => Promise<void>;
    };

    await compatible.markAsRead("imessage:any;-;+14155550100~shared", "message-1");

    expect(markRead).toHaveBeenCalledWith("any;-;+14155550100");
  });

  it("requests Find My sharing with a retry-safe id without storing the address", async () => {
    const { adapter, request } = adapterFixture();
    const receipt = await requestLocationSharing({
      adapter,
      clientMessageId: "location-request-turn-1",
      threadId: "imessage:any;-;+14155550100~shared",
    });

    expect(receipt.status).toBe("sent");
    expect(request).toHaveBeenCalledWith(
      "any;-;+14155550100",
      "+14155550100",
      { clientMessageId: "location-request-turn-1" },
    );
  });

  it("reads a consented location snapshot ephemerally", async () => {
    const { adapter, get } = adapterFixture();
    const location = await getSharedLocation({
      adapter,
      threadId: "imessage:any;-;+14155550100~shared",
    });

    expect(location).toMatchObject({ locationType: "live" });
    expect(get).toHaveBeenCalledWith("+14155550100");
  });

  it("accepts only a validated participant from a direct chat", () => {
    expect(participantAddressFromDmChatGuid("any;-;alice@example.com")).toBe(
      "alice@example.com",
    );
    expect(() => participantAddressFromDmChatGuid("any;+;group-id")).toThrow(
      "LOCATION_REQUIRES_DIRECT_MESSAGE",
    );
    expect(() => participantAddressFromDmChatGuid("any;-;display name")).toThrow(
      "LOCATION_PARTICIPANT_UNAVAILABLE",
    );
  });
});
