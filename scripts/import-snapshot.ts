import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";

const SNAPSHOT_ID = "snapshot-99f2d46a008bec47efae";
const MANIFEST_SHA256 = "64ecc382f2c382215b18d7eea163e3421bac0d5f8655bcbc1c33239126b0bcc1";
const PRODUCTION_CONVEX_URL = "https://acoustic-mastiff-766.convex.cloud";
const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SNAPSHOT_ROOT = resolve(APP_ROOT, "../data/convex/snapshots", SNAPSHOT_ID);
const VERIFY_SCRIPT = resolve(APP_ROOT, "scripts/verify-snapshot.ts");

const COLLECTIONS = [
  "sfSourceDocuments",
  "sfPlaces",
  "sfEventSeries",
  "sfEventOccurrences",
  "sfRecommendations",
  "sfEntityAliases",
  "sfFacets",
  "sfSourceClaims",
  "sfExperienceCards",
] as const;

type CollectionName = (typeof COLLECTIONS)[number];

type VerificationAttestation = {
  snapshotId: string;
  manifestSha256: string;
  counts: Record<CollectionName, number>;
  totalDocuments: number;
  checksumsVerified: true;
  privacyVerified: true;
  referentialIntegrityVerified: true;
};

type ImportOptions = {
  prod: boolean;
  yes: boolean;
  help: boolean;
};

class SafeImportError extends Error {}

function usage(): string {
  return [
    "Usage:",
    "  pnpm snapshot:import -- --yes          # personal Convex dev deployment",
    "  pnpm snapshot:import -- --prod --yes   # default Convex production deployment",
    "",
    "The production path requires both --prod and --yes. All imports replace tables,",
    "so the dev path also requires --yes. COAST_CONVEX_SERVICE_SECRET must already",
    "be available in the process environment; never put it in command-line arguments.",
  ].join("\n");
}

function parseArgs(argv: string[]): ImportOptions {
  const options: ImportOptions = { prod: false, yes: false, help: false };
  for (const argument of argv) {
    if (argument === "--") continue;
    if (argument === "--prod") options.prod = true;
    else if (argument === "--yes" || argument === "-y") options.yes = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new SafeImportError(`Unknown option: ${argument}\n\n${usage()}`);
  }
  return options;
}

function loadLocalEnvironment(): void {
  const envPath = resolve(APP_ROOT, ".env.local");
  if (!existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch {
    throw new SafeImportError("Could not load .env.local.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseVerification(stdout: string): VerificationAttestation {
  const lastLine = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!lastLine) throw new SafeImportError("Snapshot verifier returned no attestation.");

  let candidate: unknown;
  try {
    candidate = JSON.parse(lastLine);
  } catch {
    throw new SafeImportError("Snapshot verifier returned an invalid attestation.");
  }
  if (!isRecord(candidate) || !isRecord(candidate.counts)) {
    throw new SafeImportError("Snapshot verifier attestation is incomplete.");
  }
  if (
    candidate.snapshotId !== SNAPSHOT_ID ||
    candidate.manifestSha256 !== MANIFEST_SHA256 ||
    candidate.totalDocuments !== 251_679 ||
    candidate.checksumsVerified !== true ||
    candidate.privacyVerified !== true ||
    candidate.referentialIntegrityVerified !== true
  ) {
    throw new SafeImportError("Snapshot verifier did not attest the approved bundle.");
  }
  const expectedCounts: Record<CollectionName, number> = {
    sfSourceDocuments: 737,
    sfPlaces: 129,
    sfEventSeries: 444,
    sfEventOccurrences: 514,
    sfRecommendations: 107,
    sfEntityAliases: 2_527,
    sfFacets: 3_675,
    sfSourceClaims: 242_910,
    sfExperienceCards: 636,
  };
  for (const collection of COLLECTIONS) {
    if (candidate.counts[collection] !== expectedCounts[collection]) {
      throw new SafeImportError(`Snapshot verifier count mismatch for ${collection}.`);
    }
  }

  return candidate as VerificationAttestation;
}

async function runCaptured(command: string, args: string[]): Promise<string> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: APP_ROOT,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", () => rejectPromise(new SafeImportError("Could not start snapshot verification.")));
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      if (stderr.trim()) process.stderr.write(stderr);
      rejectPromise(new SafeImportError("Snapshot verification failed; no cloud data was changed."));
    });
  });
}

async function runImport(collection: CollectionName, prod: boolean): Promise<void> {
  const filePath = resolve(SNAPSHOT_ROOT, `${collection}.jsonl`);
  const targetArgs = prod ? ["--prod"] : ["--deployment", "dev"];
  const args = [
    "exec",
    "convex",
    "import",
    "--table",
    collection,
    "--format",
    "jsonLines",
    "--replace",
    "--yes",
    ...targetArgs,
    filePath,
  ];

  process.stdout.write(`Importing ${collection}...\n`);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("pnpm", args, {
      cwd: APP_ROOT,
      env: process.env,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", () => {
      rejectPromise(new SafeImportError(`Could not start the ${collection} import.`));
    });
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new SafeImportError(`${collection} import failed; sfDatasetState was not advanced.`));
    });
  });
}

function deploymentUrl(prod: boolean): string {
  const raw = prod
    ? process.env.CONVEX_PROD_URL ?? PRODUCTION_CONVEX_URL
    : process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!raw) {
    throw new SafeImportError("The target Convex deployment URL is not configured.");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SafeImportError("The target Convex deployment URL is invalid.");
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new SafeImportError("The target Convex deployment URL must use HTTPS.");
  }
  if (prod && parsed.origin !== PRODUCTION_CONVEX_URL) {
    throw new SafeImportError("Production imports are locked to the approved COAST Convex deployment.");
  }
  return parsed.origin;
}

async function activateSnapshot(
  attestation: VerificationAttestation,
  targetUrl: string,
  serviceSecret: string,
  startedAtMs: number,
): Promise<void> {
  const client = new ConvexHttpClient(targetUrl);
  try {
    const importRunId = await client.mutation(api.imports.begin, {
      serviceSecret,
      snapshotId: attestation.snapshotId,
      manifestSha256: attestation.manifestSha256,
      expectedCounts: attestation.counts,
      startedAtMs,
    });
    const advanced = await client.mutation(api.imports.verifyAndAdvance, {
      serviceSecret,
      importRunId,
      snapshotId: attestation.snapshotId,
      manifestSha256: attestation.manifestSha256,
      actualCounts: attestation.counts,
      checksumsVerified: attestation.checksumsVerified,
      referentialIntegrityVerified: attestation.referentialIntegrityVerified,
      privacyVerified: attestation.privacyVerified,
      warnings: [],
      verifiedAtMs: Date.now(),
    });
    if (!advanced) throw new Error("not advanced");
  } catch {
    throw new SafeImportError(
      "All tables imported, but activation failed; sfDatasetState was not advanced. Fix the secure Convex configuration, then rerun the importer.",
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.yes) {
    throw new SafeImportError(`Table replacement requires explicit --yes.\n\n${usage()}`);
  }

  loadLocalEnvironment();
  process.stdout.write("Verifying the immutable snapshot before any cloud write...\n");
  const verifierOutput = await runCaptured(process.execPath, ["--import", "tsx", VERIFY_SCRIPT]);
  const attestation = parseVerification(verifierOutput);
  process.stdout.write(`${verifierOutput.trim()}\n`);

  const targetUrl = deploymentUrl(options.prod);
  const serviceSecret = process.env.COAST_CONVEX_SERVICE_SECRET;
  if (!serviceSecret) {
    throw new SafeImportError(
      "COAST_CONVEX_SERVICE_SECRET is unavailable. Load it from the secure environment manager; never pass it on the command line or paste it into chat.",
    );
  }

  const startedAtMs = Date.now();
  for (const collection of COLLECTIONS) {
    await runImport(collection, options.prod);
  }
  await activateSnapshot(attestation, targetUrl, serviceSecret, startedAtMs);

  process.stdout.write(
    `Imported and activated ${attestation.snapshotId} (${attestation.totalDocuments.toLocaleString("en-US")} documents).\n`,
  );
}

try {
  await main();
} catch (error) {
  const message = error instanceof SafeImportError ? error.message : "Snapshot import failed safely.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
