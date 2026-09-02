import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CATALOG_PATH = resolve(APP_ROOT, "data/artists/bay-norcal-public-v1.json");
const PRODUCTION_CONVEX_URL = "https://acoustic-mastiff-766.convex.cloud";

type CatalogArtist = {
  externalId: string;
  displayName: string;
  lane: string;
  regionAnchor: string;
  instagramUrl: string;
  status: "verified";
};

type Catalog = {
  catalogVersion: string;
  inputRowCount: number;
  acceptedCount: number;
  withheldCount: number;
  records: CatalogArtist[];
};

function loadLocalEnvironment(): void {
  const envPath = resolve(APP_ROOT, ".env.local");
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

function isCatalog(value: unknown): value is Catalog {
  if (typeof value !== "object" || value === null) return false;
  const catalog = value as Record<string, unknown>;
  return (
    catalog.catalogVersion === "bay-norcal-public-v1" &&
    catalog.inputRowCount === 100 &&
    catalog.acceptedCount === 68 &&
    catalog.withheldCount === 32 &&
    Array.isArray(catalog.records) &&
    catalog.records.length === 68
  );
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  const serviceSecret = process.env.COAST_CONVEX_SERVICE_SECRET;
  if (!serviceSecret) throw new Error("COAST_CONVEX_SERVICE_SECRET is not configured.");
  const raw = JSON.parse(await readFile(CATALOG_PATH, "utf8")) as unknown;
  if (!isCatalog(raw)) throw new Error("The sanitized artist catalog failed validation.");
  const client = new ConvexHttpClient(process.env.CONVEX_PROD_URL ?? PRODUCTION_CONVEX_URL);
  const result = await client.mutation(api.artists.importCatalog, {
    serviceSecret,
    catalogVersion: raw.catalogVersion,
    artists: raw.records,
    nowMs: Date.now(),
  });
  if (result.total !== 68) throw new Error("Artist catalog import did not reach 68 verified records.");
  process.stdout.write(`Artist catalog imported: ${result.total} verified public records.\n`);
}

await main();
