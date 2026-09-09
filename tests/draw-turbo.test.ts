import { afterEach, expect, it, vi } from "vitest";
import { runTurboDraw } from "../src/lib/draw/turbo";
import { turboDrawInput } from "../src/lib/draw/provider";

afterEach(() => vi.unstubAllGlobals());
it.each([undefined, "data:image/png;base64,sketch"])("submits four steps once and records the identity before polling (%s)", async (image) => {
  let recorded = false;
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (init?.method === "POST") {
      expect(JSON.parse(init.body as string)).toEqual(turboDrawInput("test", image));
      expect(url.endsWith(image ? "/image-to-image" : "/turbo")).toBe(true);
      return Response.json({ request_id: "test-id", status_url: "https://queue.fal.run/fal-ai/z-image/requests/test-id/status", response_url: "https://queue.fal.run/fal-ai/z-image/requests/test-id" });
    }
    expect(recorded).toBe(true);
    if (url.endsWith("/status")) return Response.json({ status: "COMPLETED" });
    if (url.includes("queue.fal.run")) return Response.json({ images: [{ url: "https://fal.media/result.jpg" }], has_nsfw_concepts: [false] });
    return new Response(new Uint8Array([1, 2, 3]));
  }));
  const result = await runTurboDraw({ key: "secret", prompt: "test", ...(image ? { image } : {}), onSubmitted: async (id) => { expect(id).toBe("test-id"); recorded = true; } });
  expect(result.bytes.byteLength).toBe(3);
  expect(calls).toHaveLength(4);
  expect(turboDrawInput("test", image)).toMatchObject({ num_inference_steps: 4, num_images: 1, enable_safety_checker: true });
});
