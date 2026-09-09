import { TURBO_DRAW_MODEL, turboDrawInput, type DrawInputCategory } from "./provider";

export type TurboSubmission = {
  requestId: string;
  model: string;
  statusUrl: string;
  responseUrl: string;
};

export type TurboPoll =
  | { status: "queued" | "running"; requestId: string }
  | { status: "completed"; requestId: string; bytes: Buffer };

function queueUrl(value: string | undefined, requestId: string) {
  if (!value) throw new Error("DRAW_TURBO_QUEUE_URL_MISSING");
  const url = new URL(value);
  if (url.origin !== "https://queue.fal.run" || !url.pathname.includes(`/requests/${requestId}`)) {
    throw new Error("DRAW_TURBO_INVALID_QUEUE_URL");
  }
  return url.toString();
}

function authHeaders(key: string) {
  return { authorization: `Key ${key}`, accept: "application/json" };
}

export function turboSubmissionForRequest(model: string, requestId: string): TurboSubmission {
  const base = model.replace(/\/image-to-image$/u, "");
  if (!base.startsWith(`${TURBO_DRAW_MODEL}`)) throw new Error("DRAW_TURBO_MODEL_INVALID");
  const root = `https://queue.fal.run/${base}/requests/${encodeURIComponent(requestId)}`;
  return { requestId, model, statusUrl: `${root}/status`, responseUrl: root };
}

export async function submitTurboDraw(options: {
  key: string;
  prompt: string;
  imageUrl?: string;
  inputCategory?: DrawInputCategory;
}): Promise<TurboSubmission> {
  const model = TURBO_DRAW_MODEL + (options.imageUrl ? "/image-to-image" : "");
  const response = await fetch(`https://queue.fal.run/${model}`, {
    method: "POST",
    headers: { ...authHeaders(options.key), "content-type": "application/json" },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify(turboDrawInput(options.prompt, options.imageUrl, options.inputCategory)),
  });
  if (!response.ok) {
    const error = new Error(`DRAW_TURBO_HTTP_${response.status}`) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  const queue = await response.json() as { request_id?: string; requestId?: string; status_url?: string; response_url?: string };
  const requestId = queue.request_id ?? queue.requestId;
  if (!requestId) throw new Error("DRAW_TURBO_REQUEST_ID_MISSING");
  return {
    requestId,
    model,
    statusUrl: queueUrl(queue.status_url, requestId),
    responseUrl: queueUrl(queue.response_url, requestId),
  };
}

async function readOutput(urlValue: unknown): Promise<Buffer> {
  if (typeof urlValue !== "string") throw new Error("DRAW_TURBO_RESULT_MISSING_URL");
  const url = new URL(urlValue);
  if (url.protocol !== "https:" || !["fal.media", "fal.ai", "storage.googleapis.com"].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new Error("DRAW_TURBO_INVALID_OUTPUT");
  }
  const image = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: "error" });
  if (!image.ok || Number(image.headers.get("content-length")) > 10 * 1024 * 1024 || !image.body) {
    throw new Error("DRAW_TURBO_OUTPUT_FAILED");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = image.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 10 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("DRAW_TURBO_OUTPUT_TOO_LARGE");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function pollTurboDraw(options: { key: string; submission: TurboSubmission }): Promise<TurboPoll> {
  const statusResponse = await fetch(options.submission.statusUrl, {
    headers: authHeaders(options.key), signal: AbortSignal.timeout(15_000),
  });
  if (!statusResponse.ok) {
    const error = new Error(`DRAW_TURBO_STATUS_HTTP_${statusResponse.status}`) as Error & { status: number };
    error.status = statusResponse.status;
    throw error;
  }
  const status = await statusResponse.json() as { status?: string };
  if (status.status === "IN_QUEUE") return { status: "queued", requestId: options.submission.requestId };
  if (status.status === "IN_PROGRESS") return { status: "running", requestId: options.submission.requestId };
  if (status.status !== "COMPLETED") throw new Error("DRAW_TURBO_STATUS_REJECTED");
  const resultResponse = await fetch(options.submission.responseUrl, {
    headers: authHeaders(options.key), signal: AbortSignal.timeout(30_000),
  });
  if (!resultResponse.ok) {
    const error = new Error(`DRAW_TURBO_RESULT_HTTP_${resultResponse.status}`) as Error & { status: number };
    error.status = resultResponse.status;
    throw error;
  }
  const result = await resultResponse.json() as { images?: Array<{ url?: string }>; has_nsfw_concepts?: boolean[] };
  if (result.has_nsfw_concepts?.some(Boolean)) throw new Error("DRAW_TURBO_REFUSED");
  return { status: "completed", requestId: options.submission.requestId, bytes: await readOutput(result.images?.[0]?.url) };
}

// Focused canaries can use the full cycle. Durable production jobs submit and
// poll separately so no server invocation owns Fal's queue wait.
export async function runTurboDraw(options: {
  key: string;
  prompt: string;
  image?: string;
  inputCategory?: DrawInputCategory;
  onSubmitted: (id: string, model: string) => Promise<void>;
}) {
  const submission = await submitTurboDraw({
    key: options.key,
    prompt: options.prompt,
    ...(options.image ? { imageUrl: options.image } : {}),
    ...(options.inputCategory ? { inputCategory: options.inputCategory } : {}),
  });
  await options.onSubmitted(submission.requestId, submission.model);
  const deadline = Date.now() + 240_000;
  for (;;) {
    const result = await pollTurboDraw({ key: options.key, submission });
    if (result.status === "completed") return { bytes: result.bytes, requestId: result.requestId, model: submission.model };
    if (Date.now() >= deadline) throw new Error("DRAW_TURBO_POLL_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
