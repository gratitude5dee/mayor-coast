import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const EXPECTED_SNAPSHOT_ID = "snapshot-99f2d46a008bec47efae";
const DATA_ROOT = resolve(process.cwd(), "../data/convex");
const CURRENT_PATH = resolve(DATA_ROOT, "CURRENT.json");
const PRIVATE_KEY_MARKERS = ["email", "password", "secret", "guest", "attendee"];
const SAFE_AGGREGATE_KEYS = new Set([
  "guestcount",
  "publicattendancecount",
  "publicinterestcount",
  "publicwaitlistcount",
  "tokencount",
  "inputtokencount",
  "outputtokencount",
  "totaltokencount",
  "registrationcount",
]);
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const SECRET_PATTERN =
  /(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\s*[:=]\s*[A-Za-z0-9_./+\-=]{8,}/i;

type Manifest = {
  snapshotId: string;
  dq: { status: string; privacyChecked: boolean; referentialIntegrityChecked: boolean };
  collections: Record<
    string,
    { file: string; rows: number; bytes: number; sha256: string; canonicalIdSetSha256: string }
  >;
};

type PortableDocument = {
  externalId: string;
  schemaVersion: number;
  sourceRefs: string[];
  observed: Record<string, unknown>;
  inferred: Record<string, unknown>;
  [key: string]: unknown;
};

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function privacyIssue(value: unknown, path = "$"): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const issue = privacyIssue(value[index], `${path}[${index}]`);
      if (issue) return issue;
    }
    return null;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      const folded = key.toLowerCase().replace(/[_-]/g, "");
      if (!SAFE_AGGREGATE_KEYS.has(folded)) {
        if (PRIVATE_KEY_MARKERS.some((marker) => folded.includes(marker))) {
          return `private key ${path}.${key}`;
        }
        if (folded.includes("registration") && !folded.endsWith("url")) {
          return `registration data ${path}.${key}`;
        }
        if (["answers", "privatelocation", "privateaddress"].includes(folded)) {
          return `private data ${path}.${key}`;
        }
      }
      const issue = privacyIssue(child, `${path}.${key}`);
      if (issue) return issue;
    }
    return null;
  }
  if (typeof value === "string") {
    if (EMAIL_PATTERN.test(value)) return `email value ${path}`;
    if (SECRET_PATTERN.test(value)) return `secret-like value ${path}`;
    try {
      const url = new URL(value);
      for (const key of url.searchParams.keys()) {
        if (["access_token", "api_key", "apikey", "auth", "code", "invite_code", "password", "secret", "signature", "token"].includes(key.toLowerCase())) {
          return `sensitive URL parameter ${path}`;
        }
      }
    } catch {
      // Ordinary prose is expected.
    }
  }
  return null;
}

async function verify(): Promise<void> {
  const currentBytes = await readFile(CURRENT_PATH);
  const current = JSON.parse(currentBytes.toString("utf8")) as {
    snapshotId: string;
    snapshotPath: string;
    manifestSha256: string;
    bundleSchemaVersion: number;
  };
  if (current.snapshotId !== EXPECTED_SNAPSHOT_ID || current.bundleSchemaVersion !== 2) {
    throw new Error("CURRENT points at an unapproved snapshot or schema version");
  }
  const snapshotRoot = resolve(DATA_ROOT, current.snapshotPath);
  const manifestBytes = await readFile(resolve(snapshotRoot, "manifest.json"));
  if (sha256(manifestBytes) !== current.manifestSha256) throw new Error("Manifest checksum mismatch");
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
  if (
    manifest.snapshotId !== current.snapshotId ||
    manifest.dq.status !== "passed" ||
    !manifest.dq.privacyChecked ||
    !manifest.dq.referentialIntegrityChecked
  ) {
    throw new Error("Manifest data-quality gate is not passed");
  }

  const globalIds = new Set<string>();
  const references: Array<{ from: string; to: string }> = [];
  const counts: Record<string, number> = {};

  for (const [collection, metadata] of Object.entries(manifest.collections)) {
    const filePath = resolve(snapshotRoot, metadata.file);
    const fileBytes = await readFile(filePath);
    const fileStat = await stat(filePath);
    if (fileStat.size !== metadata.bytes || sha256(fileBytes) !== metadata.sha256) {
      throw new Error(`${collection} file checksum/size mismatch`);
    }

    const ids = new Set<string>();
    const canonicalIds: string[] = [];
    let rows = 0;
    const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      rows += 1;
      const document = JSON.parse(line) as PortableDocument;
      if (
        typeof document.externalId !== "string" ||
        document.schemaVersion !== 2 ||
        "_id" in document ||
        !Array.isArray(document.sourceRefs)
      ) {
        throw new Error(`${collection} row ${rows} violates the portable schema`);
      }
      if (ids.has(document.externalId)) throw new Error(`${collection} duplicate ${document.externalId}`);
      ids.add(document.externalId);
      canonicalIds.push(
        typeof document.inferred.canonicalId === "string"
          ? document.inferred.canonicalId
          : document.externalId,
      );
      globalIds.add(document.externalId);
      const issue = privacyIssue(document);
      if (issue) throw new Error(`${collection} ${document.externalId}: ${issue}`);
      for (const sourceRef of document.sourceRefs) references.push({ from: document.externalId, to: sourceRef });
      const inferred = document.inferred;
      for (const field of ["placeExternalId", "eventSeriesExternalId", "entityExternalId", "sourceDocumentExternalId"]) {
        const target = inferred[field];
        if (typeof target === "string") references.push({ from: document.externalId, to: target });
      }
      const provenance = inferred.provenanceIds;
      if (Array.isArray(provenance)) {
        for (const target of provenance) if (typeof target === "string") references.push({ from: document.externalId, to: target });
      }
    }
    if (rows !== metadata.rows) throw new Error(`${collection} row count mismatch`);
    canonicalIds.sort();
    if (sha256(canonicalJson(canonicalIds)) !== metadata.canonicalIdSetSha256) {
      throw new Error(`${collection} canonical ID set checksum mismatch`);
    }
    counts[collection] = rows;
  }

  for (const reference of references) {
    if (!globalIds.has(reference.to)) {
      throw new Error(`Broken reference ${reference.from} -> ${reference.to}`);
    }
  }

  const totalDocuments = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (totalDocuments !== 251_679) throw new Error(`Unexpected total ${totalDocuments}`);
  process.stdout.write(
    `${canonicalJson({
      snapshotId: current.snapshotId,
      manifestSha256: current.manifestSha256,
      counts,
      totalDocuments,
      checksumsVerified: true,
      privacyVerified: true,
      referentialIntegrityVerified: true,
    })}\n`,
  );
}

await verify();
