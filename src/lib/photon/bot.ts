import { createiMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import { Chat } from "chat";

import type { CoastPhotonRuntimeDependencies } from "./contracts";
import { PhotonSafeLogger } from "./safe-logger";
import { createCoastInboundHandler } from "./transport";
import { installReadReceiptCompatibility } from "./advanced-client";

export type CreateCoastBotOptions = CoastPhotonRuntimeDependencies & {
  credentials?: {
    projectId: string;
    projectSecret: string;
    webhookSecret: string;
  };
};

/**
 * Creates the pinned Chat SDK + Photon adapter path used by Vercel webhooks.
 * The raw spectrum-ts `app.webhook()` path is deliberately not used.
 */
export function createCoastBot(options: CreateCoastBotOptions) {
  const logger = new PhotonSafeLogger();
  const adapter = createiMessageAdapter({
    logger,
    ...(options.credentials
      ? {
          projectId: options.credentials.projectId,
          projectSecret: options.credentials.projectSecret,
          webhookSecret: options.credentials.webhookSecret,
        }
      : {}),
  });
  installReadReceiptCompatibility(adapter);
  const bot = new Chat({
    adapters: { imessage: adapter },
    // Convex owns the durable 500 ms debounce and supersession protocol. Chat
    // must allow a newer delivery to reach Convex while an older turn is in
    // flight so the old generation can be cancelled before it sends.
    concurrency: { maxConcurrent: 4, strategy: "concurrent" },
    dedupeTtlMs: 24 * 60 * 60 * 1_000,
    logger,
    state: options.state,
    userName: "COAST",
  });

  bot.onDirectMessage(
    createCoastInboundHandler({
      adapter,
      application: options.application,
    }),
  );

  return { adapter, application: options.application, bot, state: options.state };
}

export type CoastBot = ReturnType<typeof createCoastBot>;
