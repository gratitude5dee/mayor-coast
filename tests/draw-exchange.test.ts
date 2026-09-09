import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/draw/sessions/[id]/exchange/route";
const mocks = vi.hoisted(() => ({ action: vi.fn(), token: vi.fn() }));
vi.mock("../src/lib/convex", () => ({ getConvexHttpClient: () => ({ action: mocks.action }) }));
vi.mock("../src/lib/env", () => ({ parseServerEnv: () => ({ CONVEX_URL: "https://test.convex.cloud", convexServiceSecret: "test-secret" }) }));
vi.mock("../src/lib/draw/auth", () => ({ drawBrowserToken: mocks.token, drawCookieName: () => "coast_draw_test" }));
beforeEach(() => { mocks.action.mockReset(); mocks.token.mockReset(); });
it("reopens an already-consumed link using its valid cookie without consuming the secret again", async () => {
  mocks.token.mockResolvedValue({ id: "test", hash: "valid" });
  mocks.action.mockResolvedValue({ expiresAtMs: Date.now() + 10000 });
  const response = await POST(new Request("https://coast.test/api/draw/sessions/test/exchange", { method: "POST", headers: { origin: "https://coast.test" }, body: JSON.stringify({ secret: "already-consumed-secret" }) }), { params: Promise.resolve({ id: "test" }) });
  expect(response.status).toBe(200);
  expect(mocks.action).toHaveBeenCalledTimes(1);
  expect(mocks.action.mock.calls[0]?.[1]).not.toHaveProperty("launchSecret");
});
it("does not revive an expired session from a stale cookie", async () => {
  mocks.token.mockResolvedValue({ id: "test", hash: "stale" });
  mocks.action.mockResolvedValue(null);
  const response = await POST(new Request("https://coast.test/api/draw/sessions/test/exchange", { method: "POST", headers: { origin: "https://coast.test" }, body: JSON.stringify({ secret: "already-consumed-secret" }) }), { params: Promise.resolve({ id: "test" }) });
  expect(response.status).toBe(401);
});
