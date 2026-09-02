import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const CATALOG_VERSION = "bay-norcal-public-v1";
const EXPECTED_SOURCE_ROWS = 100;
const EXPECTED_ACCEPTED_ROWS = 68;
const EXPECTED_WITHHELD_ROWS = 32;

const REQUIRED_HEADERS = [
  "Artist",
  "Lane",
  "Bay / NorCal anchor",
  "Instagram handle",
  "Instagram URL",
  "Verification status",
] as const;

type CatalogRecord = {
  externalId: string;
  displayName: string;
  lane: string;
  regionAnchor: string;
  instagramUrl: string;
  status: "verified";
};

type Catalog = {
  catalogVersion: typeof CATALOG_VERSION;
  inputRowCount: number;
  acceptedCount: number;
  withheldCount: number;
  records: CatalogRecord[];
};

function parseArgs(argv: string[]): { input: string; output: string } {
  const inputIndex = argv.indexOf("--input");
  const outputIndex = argv.indexOf("--output");
  const input = inputIndex >= 0 ? argv[inputIndex + 1] : undefined;
  const output = outputIndex >= 0 ? argv[outputIndex + 1] : undefined;
  if (!input || !output) {
    throw new Error("Usage: pnpm artists:build -- --input <private.csv> --output <catalog.json>");
  }
  return { input: resolve(input), output: resolve(output) };
}

/** Minimal RFC 4180 parser: quoted commas and newlines are data, never code. */
function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]!;
    if (quoted) {
      if (current === '"' && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (current === '"') {
        quoted = false;
      } else {
        value += current;
      }
      continue;
    }
    if (current === '"') {
      quoted = true;
    } else if (current === ",") {
      row.push(value);
      value = "";
    } else if (current === "\n") {
      row.push(value.replace(/\r$/u, ""));
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += current;
    }
  }
  if (quoted) throw new Error("ARTIST_CSV_UNTERMINATED_QUOTE");
  if (value.length > 0 || row.length > 0) {
    row.push(value.replace(/\r$/u, ""));
    rows.push(row);
  }
  return rows;
}

function clean(value: string | undefined, field: string): string {
  const normalized = (value ?? "").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 240) throw new Error(`ARTIST_CATALOG_INVALID_${field}`);
  return normalized;
}

function instagramRecord(row: Record<string, string>): CatalogRecord {
  const rawHandle = clean(row["Instagram handle"], "HANDLE");
  const match = rawHandle.match(/^@?([a-z0-9._]{1,30})$/iu);
  if (!match) throw new Error("ARTIST_CATALOG_INVALID_HANDLE");
  const handle = match[1]!.toLowerCase();
  const suppliedUrl = new URL(clean(row["Instagram URL"], "INSTAGRAM_URL"));
  const validHost = suppliedUrl.hostname === "instagram.com" || suppliedUrl.hostname === "www.instagram.com";
  const suppliedHandle = suppliedUrl.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
  if (suppliedUrl.protocol !== "https:" || !validHost || suppliedHandle !== handle) {
    throw new Error("ARTIST_CATALOG_INVALID_INSTAGRAM_URL");
  }
  return {
    externalId: `artist:instagram:${handle}`,
    displayName: clean(row.Artist, "ARTIST"),
    lane: clean(row.Lane, "LANE"),
    regionAnchor: clean(row["Bay / NorCal anchor"], "REGION_ANCHOR"),
    instagramUrl: `https://www.instagram.com/${handle}/`,
    status: "verified",
  };
}

export function buildArtistCatalog(source: string): Catalog {
  const rows = parseCsv(source);
  const [headerRow, ...dataRows] = rows;
  if (!headerRow) throw new Error("ARTIST_CSV_MISSING_HEADER");
  const header = headerRow.map((value) => value.trim());
  for (const required of REQUIRED_HEADERS) {
    if (!header.includes(required)) throw new Error(`ARTIST_CSV_MISSING_${required}`);
  }
  const records = dataRows
    .filter((row) => row.some((value) => value.trim().length > 0))
    .map((row) => Object.fromEntries(header.map((key, index) => [key, row[index] ?? ""])))
    .filter((row) => row["Verification status"]?.trim().startsWith("Verified"))
    .map(instagramRecord)
    .sort((left, right) => left.externalId.localeCompare(right.externalId));
  const inputRowCount = dataRows.filter((row) => row.some((value) => value.trim().length > 0)).length;
  const externalIds = new Set(records.map((record) => record.externalId));
  if (externalIds.size !== records.length) throw new Error("ARTIST_CATALOG_DUPLICATE_HANDLE");
  if (
    inputRowCount !== EXPECTED_SOURCE_ROWS ||
    records.length !== EXPECTED_ACCEPTED_ROWS ||
    inputRowCount - records.length !== EXPECTED_WITHHELD_ROWS
  ) {
    throw new Error("ARTIST_CATALOG_EXPECTED_COUNTS_MISMATCH");
  }
  return {
    catalogVersion: CATALOG_VERSION,
    inputRowCount,
    acceptedCount: records.length,
    withheldCount: inputRowCount - records.length,
    records,
  };
}

async function main() {
  const { input, output } = parseArgs(process.argv.slice(2));
  const catalog = buildArtistCatalog(await readFile(input, "utf8"));
  const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, serialized, "utf8");
  process.stdout.write(
    `Artist catalog built: ${catalog.acceptedCount} accepted, ${catalog.withheldCount} withheld, sha256=${createHash("sha256").update(serialized).digest("hex")}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
