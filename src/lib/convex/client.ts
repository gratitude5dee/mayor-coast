import { ConvexHttpClient } from "convex/browser";

const CLIENT_KEY = Symbol.for("coast.convex.http-client");

type ClientGlobal = typeof globalThis & { [CLIENT_KEY]?: ConvexHttpClient };

export function getConvexHttpClient(url = process.env.CONVEX_URL): ConvexHttpClient {
  if (!url) throw new Error("CONVEX_URL is not configured");
  const target = globalThis as ClientGlobal;
  target[CLIENT_KEY] ??= new ConvexHttpClient(url, {
    logger: false,
    skipConvexDeploymentUrlCheck: false,
  });
  return target[CLIENT_KEY];
}
