import type { WebhookOptions } from "chat";

import { runWithPhotonDeliveryContext } from "./delivery-context";

export const SPECTRUM_WEBHOOK_ID_HEADER = "x-spectrum-webhook-id";
const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;

type PhotonWebhookDispatch = (
  request: Request,
  options: WebhookOptions,
) => Promise<Response>;

export type HandlePhotonWebhookOptions = {
  dispatch: PhotonWebhookDispatch;
  defer: (task: Promise<unknown>) => void;
};

/**
 * Preserves the exact request bytes while attaching delivery context to the
 * adapter's background handler. Signature validation remains exclusively in
 * `@photon-ai/chat-adapter-imessage`, which verifies the raw body, HMAC, and
 * five-minute timestamp window before dispatching a message.
 */
export async function handlePhotonWebhook(
  request: Request,
  options: HandlePhotonWebhookOptions,
): Promise<Response> {
  const webhookId = request.headers.get(SPECTRUM_WEBHOOK_ID_HEADER)?.trim();
  if (!webhookId || webhookId.length > 256) {
    return new Response("Missing or invalid webhook id", { status: 400 });
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }

  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > MAX_WEBHOOK_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }

  const forwarded = new Request(request.url, {
    body: rawBody,
    headers: request.headers,
    method: "POST",
  });

  const adapterTasks: Promise<unknown>[] = [];
  const context = {
    webhookId,
    criticalTasks: [] as Promise<unknown>[],
    continuations: [] as Promise<unknown>[],
    processingFailed: false,
  };
  const response = await runWithPhotonDeliveryContext(context, () =>
    options.dispatch(forwarded, {
      waitUntil: (task) => adapterTasks.push(task),
    }),
  );
  if (!response.ok || adapterTasks.length === 0) return response;

  const adapterResults = await Promise.allSettled(adapterTasks);
  const claimResults = await Promise.allSettled(context.criticalTasks);
  if (
    context.processingFailed ||
    adapterResults.some((result) => result.status === "rejected") ||
    claimResults.some((result) => result.status === "rejected")
  ) {
    return new Response("Durable intake unavailable", { status: 503 });
  }

  for (const continuation of context.continuations) options.defer(continuation);
  return response;
}

export function makeDeliveryKey(
  webhookId: string,
  providerMessageId: string,
): string {
  return `${webhookId}:${providerMessageId}`;
}
