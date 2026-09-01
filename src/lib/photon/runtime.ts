import type { CoastPhotonRuntimeDependencies } from "./contracts";
import { createCoastBot, type CoastBot } from "./bot";
import {
  ConvexChatStateAdapter,
  ConvexCoastApplicationService,
  getConvexHttpClient,
} from "../convex";
import { parseServerEnv } from "../env";

const RUNTIME_KEY = Symbol.for("coast.photon.runtime");

type RuntimeGlobal = typeof globalThis & {
  [RUNTIME_KEY]?: CoastBot;
};

/**
 * Installs the production runtime with Convex-backed state and application
 * services. Calling code supplies credentials through environment variables;
 * their values are never returned or logged.
 */
export function installCoastPhotonRuntime(
  dependencies: CoastPhotonRuntimeDependencies,
): CoastBot {
  const target = globalThis as RuntimeGlobal;
  target[RUNTIME_KEY] ??= createCoastBot({
    ...dependencies,
    credentials: readPhotonCredentials(),
  });
  return target[RUNTIME_KEY];
}

export function getCoastPhotonRuntime(): CoastBot | undefined {
  return (globalThis as RuntimeGlobal)[RUNTIME_KEY];
}

export function getOrCreateCoastPhotonRuntime(): CoastBot {
  const existing = getCoastPhotonRuntime();
  if (existing) return existing;

  const env = parseServerEnv();
  const client = getConvexHttpClient(env.CONVEX_URL);
  return installCoastPhotonRuntime({
    application: new ConvexCoastApplicationService({
      client,
      identityPepper: env.COAST_IDENTITY_PEPPER,
      serviceSecret: env.convexServiceSecret,
    }),
    state: new ConvexChatStateAdapter(
      client,
      env.convexServiceSecret,
    ),
  });
}

function readPhotonCredentials() {
  const projectId = process.env.IMESSAGE_PROJECT_ID?.trim();
  const projectSecret = process.env.IMESSAGE_PROJECT_SECRET?.trim();
  const webhookSecret = process.env.IMESSAGE_WEBHOOK_SECRET?.trim();

  if (!(projectId && projectSecret && webhookSecret)) {
    throw new Error("Photon environment is incomplete");
  }
  return { projectId, projectSecret, webhookSecret };
}
