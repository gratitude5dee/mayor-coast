import { createHmac } from "node:crypto";

import { z } from "zod";

const serverEnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(20),
  OPENAI_MODEL_LUNA: z.string().min(1).default("gpt-5.6-luna"),
  OPENAI_MODEL_TERRA: z.string().min(1).default("gpt-5.6-terra"),
  CONVEX_DEPLOYMENT: z.string().min(1),
  NEXT_PUBLIC_CONVEX_URL: z.url(),
  CONVEX_URL: z.url(),
  COAST_IDENTITY_PEPPER: z.string().min(32),
  COAST_AGENT_RUNTIME_URL: z.url(),
  COAST_DELIVERY_URL: z.url(),
  IMESSAGE_PROJECT_ID: z.string().min(1),
  IMESSAGE_PROJECT_SECRET: z.string().min(20),
  IMESSAGE_WEBHOOK_SECRET: z.string().min(20),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type ResolvedServerEnv = ServerEnv & {
  convexServiceSecret: string;
};

export const REQUIRED_ENV_KEYS = Object.freeze(
  Object.keys(serverEnvSchema.shape) as Array<keyof ServerEnv>,
);

export function parseServerEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ResolvedServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (result.success) {
    return {
      ...result.data,
      convexServiceSecret: createHmac("sha256", result.data.IMESSAGE_WEBHOOK_SECRET.trim())
        .update("coast:convex-service:v1", "utf8")
        .digest("base64url"),
    };
  }

  const invalidKeys = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))]
    .sort()
    .join(", ");
  throw new Error(`Missing or invalid server configuration: ${invalidKeys}`);
}

export function configurationReadiness(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
) {
  const result = serverEnvSchema.safeParse(source);
  const invalidKeys = result.success
    ? []
    : [...new Set(result.error.issues.map((issue) => String(issue.path[0])))].sort();

  return { ready: result.success, invalidKeys } as const;
}
