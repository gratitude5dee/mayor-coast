import { execFile as execFileCallback } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);

/**
 * Link CLI is deliberately isolated from the request handler. Callers pass
 * only a fixed subcommand and arguments, while auth material lives in a
 * per-invocation restricted directory and is removed in finally.
 */
export async function runLinkCli(
  command: "auth_login" | "spend_request_create" | "spend_request_retrieve" | "auth_logout",
  args: readonly string[],
  authMaterial?: string,
): Promise<{ stdout: string; stderr: string }> {
  if (args.some((value) => value.includes("\0") || value.length > 512)) {
    throw new Error("LINK_CLI_ARGUMENT_INVALID");
  }
  const workDir = await mkdtemp(join(tmpdir(), "coast-link-"));
  try {
    if (authMaterial !== undefined) {
      const authPath = join(workDir, "auth.json");
      await writeFile(authPath, authMaterial, { encoding: "utf8", mode: 0o600 });
      await chmod(authPath, 0o600);
    }
    const cliEntry = require.resolve("@stripe/link-cli/dist/cli.js");
    const fixedArgs = command === "auth_login"
      ? ["auth", "login"]
      : command === "auth_logout"
        ? ["auth", "logout"]
        : command === "spend_request_create"
          ? ["spend-request", "create"]
          : ["spend-request", "retrieve"];
    const environment: NodeJS.ProcessEnv = {
      PATH: [dirname(cliEntry), process.env.PATH ?? ""].filter(Boolean).join(delimiter),
      HOME: workDir,
      LINK_CLI_HOME: workDir,
      CI: "1",
      NODE_ENV: "production",
    };
    return await execFile(process.execPath, [cliEntry, ...fixedArgs, ...args], {
      cwd: workDir,
      env: environment,
      timeout: 15_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
