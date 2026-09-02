import { v } from "convex/values";

import { mutation, query } from "./_generated/server";

const CATALOG_VERSION = "bay-norcal-public-v1";
const EXPECTED_ARTIST_COUNT = 68;

const artistRecord = v.object({
  externalId: v.string(),
  displayName: v.string(),
  lane: v.string(),
  regionAnchor: v.string(),
  instagramUrl: v.string(),
  status: v.literal("verified"),
});

function assertServiceSecret(candidate: string): void {
  const expected = process.env.COAST_CONVEX_SERVICE_SECRET;
  if (!expected || candidate.length !== expected.length) throw new Error("UNAUTHORIZED");
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ candidate.charCodeAt(index);
  }
  if (mismatch !== 0) throw new Error("UNAUTHORIZED");
}

function validInstagramUrl(value: string, externalId: string): boolean {
  const match = externalId.match(/^artist:instagram:([a-z0-9._]{1,30})$/u);
  if (!match) return false;
  try {
    const url = new URL(value);
    const handle = url.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
    return (
      url.protocol === "https:" &&
      (url.hostname === "instagram.com" || url.hostname === "www.instagram.com") &&
      handle === match[1]
    );
  } catch {
    return false;
  }
}

function validPublicText(value: string): boolean {
  return value.trim().length > 0 && value.length <= 240;
}

/** Idempotently upserts the strictly public, verified catalog only. */
export const importCatalog = mutation({
  args: {
    serviceSecret: v.string(),
    catalogVersion: v.string(),
    artists: v.array(artistRecord),
    nowMs: v.number(),
  },
  returns: v.object({ created: v.number(), updated: v.number(), total: v.number() }),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    if (args.catalogVersion !== CATALOG_VERSION || args.artists.length !== EXPECTED_ARTIST_COUNT) {
      throw new Error("ARTIST_CATALOG_NOT_APPROVED");
    }
    const ordered = [...args.artists].sort((left, right) => left.externalId.localeCompare(right.externalId));
    const ids = new Set<string>();
    for (const artist of ordered) {
      if (
        !ids.add(artist.externalId) ||
        !validPublicText(artist.displayName) ||
        !validPublicText(artist.lane) ||
        !validPublicText(artist.regionAnchor) ||
        !validInstagramUrl(artist.instagramUrl, artist.externalId)
      ) {
        throw new Error("ARTIST_CATALOG_INVALID_RECORD");
      }
    }
    let created = 0;
    let updated = 0;
    for (const artist of ordered) {
      const existing = await ctx.db
        .query("coastArtists")
        .withIndex("by_externalId", (q) => q.eq("externalId", artist.externalId))
        .unique();
      const publicRecord = {
        ...artist,
        catalogVersion: args.catalogVersion,
        updatedAtMs: Math.floor(args.nowMs),
      };
      if (existing === null) {
        await ctx.db.insert("coastArtists", {
          ...publicRecord,
          createdAtMs: Math.floor(args.nowMs),
        });
        created += 1;
      } else {
        await ctx.db.patch(existing._id, publicRecord);
        updated += 1;
      }
    }
    const total = (await ctx.db
      .query("coastArtists")
      .withIndex("by_status_externalId", (q) => q.eq("status", "verified"))
      .take(EXPECTED_ARTIST_COUNT + 1)).length;
    if (total !== EXPECTED_ARTIST_COUNT) throw new Error("ARTIST_CATALOG_TOTAL_MISMATCH");
    return { created, updated, total };
  },
});

/** The delivery route can resolve only these publicly approved display fields. */
export const getForDelivery = query({
  args: { externalId: v.string() },
  returns: v.union(
    v.object({
      externalId: v.string(),
      displayName: v.string(),
      lane: v.string(),
      regionAnchor: v.string(),
      instagramUrl: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const artist = await ctx.db
      .query("coastArtists")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .unique();
    if (artist === null || artist.status !== "verified") return null;
    return {
      externalId: artist.externalId,
      displayName: artist.displayName,
      lane: artist.lane,
      regionAnchor: artist.regionAnchor,
      instagramUrl: artist.instagramUrl,
    };
  },
});

export const catalogState = query({
  args: {},
  returns: v.object({ verified: v.number(), catalogVersion: v.union(v.string(), v.null()) }),
  handler: async (ctx) => {
    const artists = await ctx.db
      .query("coastArtists")
      .withIndex("by_status_externalId", (q) => q.eq("status", "verified"))
      .take(EXPECTED_ARTIST_COUNT + 1);
    return {
      verified: artists.length,
      catalogVersion: artists[0]?.catalogVersion ?? null,
    };
  },
});
