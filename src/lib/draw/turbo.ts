import { TURBO_DRAW_MODEL, turboDrawInput } from "./provider";

export async function runTurboDraw(options: {
  key: string; prompt: string; image?: string;
  onSubmitted: (id: string, model: string) => Promise<void>;
}) {
  const model = TURBO_DRAW_MODEL + (options.image ? "/image-to-image" : "");
  const signal = AbortSignal.timeout(240_000);
  const headers = { authorization: `Key ${options.key}`, "content-type": "application/json" };
  // Submit exactly once. Persist the queue identity before polling it.
  const response = await fetch(`https://queue.fal.run/${model}`, {
    method: "POST", headers, signal, body: JSON.stringify(turboDrawInput(options.prompt, options.image)),
  });
  if (!response.ok) throw new Error(`DRAW_TURBO_HTTP_${response.status}`);
  const queue = await response.json() as { request_id?: string; status_url?: string; response_url?: string };
  if (!queue.request_id) throw new Error("DRAW_TURBO_REQUEST_ID_MISSING");
  await options.onSubmitted(queue.request_id, model);
  function queueUrl(value: string | undefined) {
    const url = new URL(value ?? "");
    if (url.origin !== "https://queue.fal.run" || !url.pathname.includes(`/requests/${queue.request_id}`)) throw new Error("DRAW_TURBO_INVALID_QUEUE_URL");
    return url.toString();
  }
  const statusUrl = queueUrl(queue.status_url);
  const resultUrl = queueUrl(queue.response_url);
  for (;;) {
    signal.throwIfAborted();
    const statusResponse = await fetch(statusUrl, { headers, signal });
    if (!statusResponse.ok) throw new Error("DRAW_TURBO_STATUS_FAILED");
    const status = await statusResponse.json() as { status?: string };
    if (status.status === "COMPLETED") break;
    if (!["IN_QUEUE", "IN_PROGRESS"].includes(status.status ?? "")) throw new Error("DRAW_TURBO_STATUS_UNKNOWN");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const resultResponse = await fetch(resultUrl, { headers, signal });
  if (!resultResponse.ok) throw new Error("DRAW_TURBO_RESULT_FAILED");
  const result = await resultResponse.json() as { images?: Array<{ url: string }>; has_nsfw_concepts?: boolean[] };
  if (result.has_nsfw_concepts?.some(Boolean)) throw new Error("DRAW_TURBO_REFUSED");
  const url = new URL(result.images?.[0]?.url ?? "");
  if (url.protocol !== "https:" || !["fal.media", "fal.ai", "storage.googleapis.com"].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new Error("DRAW_TURBO_INVALID_OUTPUT");
  const image = await fetch(url, { signal, redirect: "error" });
  if (!image.ok || Number(image.headers.get("content-length")) > 10 * 1024 * 1024 || !image.body) throw new Error("DRAW_TURBO_OUTPUT_FAILED");
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = image.body.getReader();
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    size += chunk.byteLength;
    if (size > 10 * 1024 * 1024) { await reader.cancel(); throw new Error("DRAW_TURBO_OUTPUT_TOO_LARGE"); }
    chunks.push(chunk);
  }
  return { bytes: Buffer.concat(chunks), requestId: queue.request_id, model };
}
