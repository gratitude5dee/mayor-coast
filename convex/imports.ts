import { v } from "convex/values";

import { mutation, query } from "./_generated/server";

const SNAPSHOT_ID = "snapshot-99f2d46a008bec47efae";
const MANIFEST_SHA256 = "64ecc382f2c382215b18d7eea163e3421bac0d5f8655bcbc1c33239126b0bcc1";
const EXPECTED_COUNTS: Record<string, number> = {
  sfPlaces: 129,
  sfEventSeries: 444,
  sfEventOccurrences: 514,
  sfRecommendations: 107,
  sfSourceDocuments: 737,
  sfSourceClaims: 242_910,
  sfEntityAliases: 2_527,
  sfFacets: 3_675,
  sfExperienceCards: 636,
};
const EXPECTED_TOTAL = 251_679;

function assertServiceSecret(candidate: string): void {
  const expected = process.env.COAST_CONVEX_SERVICE_SECRET;
  if (!expected || candidate.length !== expected.length) throw new Error("UNAUTHORIZED");
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ candidate.charCodeAt(index);
  }
  if (mismatch !== 0) throw new Error("UNAUTHORIZED");
}

function validateCounts(counts: Record<string, number>): void {
  const expectedNames = Object.keys(EXPECTED_COUNTS).sort();
  const actualNames = Object.keys(counts).sort();
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
    throw new Error("IMPORT_COLLECTION_SET_MISMATCH");
  }
  for (const [collection, expected] of Object.entries(EXPECTED_COUNTS)) {
    if (counts[collection] !== expected) throw new Error(`IMPORT_COUNT_MISMATCH_${collection}`);
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (total !== EXPECTED_TOTAL) throw new Error("IMPORT_TOTAL_MISMATCH");
}

export const begin = mutation({
  args: {
    serviceSecret: v.string(),
    snapshotId: v.string(),
    manifestSha256: v.string(),
    expectedCounts: v.record(v.string(), v.number()),
    startedAtMs: v.number(),
  },
  returns: v.id("sfImportRuns"),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    if (args.snapshotId !== SNAPSHOT_ID || args.manifestSha256 !== MANIFEST_SHA256) {
      throw new Error("UNAPPROVED_SNAPSHOT");
    }
    validateCounts(args.expectedCounts);
    const existing = await ctx.db
      .query("sfImportRuns")
      .withIndex("by_snapshot", (q) => q.eq("snapshotId", args.snapshotId))
      .order("desc")
      .first();
    if (existing !== null && existing.status !== "failed") return existing._id;
    return await ctx.db.insert("sfImportRuns", {
      snapshotId: args.snapshotId,
      status: "started",
      expectedCounts: args.expectedCounts,
      actualCounts: {},
      manifestSha256: args.manifestSha256,
      checksumsVerified: false,
      referentialIntegrityVerified: false,
      privacyVerified: false,
      errors: [],
      warnings: [],
      startedAtMs: args.startedAtMs,
    });
  },
});

export const verifyAndAdvance = mutation({
  args: {
    serviceSecret: v.string(),
    importRunId: v.id("sfImportRuns"),
    snapshotId: v.string(),
    manifestSha256: v.string(),
    actualCounts: v.record(v.string(), v.number()),
    checksumsVerified: v.boolean(),
    referentialIntegrityVerified: v.boolean(),
    privacyVerified: v.boolean(),
    warnings: v.array(v.string()),
    verifiedAtMs: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    const run = await ctx.db.get(args.importRunId);
    if (
      run === null ||
      run.snapshotId !== args.snapshotId ||
      args.snapshotId !== SNAPSHOT_ID ||
      args.manifestSha256 !== MANIFEST_SHA256 ||
      run.manifestSha256 !== MANIFEST_SHA256
    ) {
      throw new Error("IMPORT_ATTESTATION_MISMATCH");
    }
    if (
      !args.checksumsVerified ||
      !args.referentialIntegrityVerified ||
      !args.privacyVerified
    ) {
      await ctx.db.patch(run._id, {
        status: "failed",
        actualCounts: args.actualCounts,
        checksumsVerified: args.checksumsVerified,
        referentialIntegrityVerified: args.referentialIntegrityVerified,
        privacyVerified: args.privacyVerified,
        errors: ["Snapshot validation attestation failed"],
        warnings: args.warnings.slice(0, 100),
        completedAtMs: args.verifiedAtMs,
      });
      return false;
    }
    validateCounts(args.actualCounts);

    await ctx.db.patch(run._id, {
      status: "verified",
      actualCounts: args.actualCounts,
      checksumsVerified: true,
      referentialIntegrityVerified: true,
      privacyVerified: true,
      errors: [],
      warnings: args.warnings.slice(0, 100),
      completedAtMs: args.verifiedAtMs,
    });
    const existing = await ctx.db
      .query("sfDatasetState")
      .withIndex("by_singleton", (q) => q.eq("singletonKey", "current"))
      .unique();
    const state = {
      activeSnapshotId: SNAPSHOT_ID,
      manifestSha256: MANIFEST_SHA256,
      dqStatus: "passed" as const,
      collectionCounts: args.actualCounts,
      totalDocuments: EXPECTED_TOTAL,
      eventWindowStart: "2026-09-01",
      eventWindowEndInclusive: "2026-09-30",
      editorialWindowStart: "2025-08-30",
      editorialWindowEndInclusive: "2026-08-30",
      verifiedAtMs: args.verifiedAtMs,
      advancedAtMs: args.verifiedAtMs,
    };
    if (existing === null) {
      await ctx.db.insert("sfDatasetState", { singletonKey: "current", ...state });
    } else {
      await ctx.db.patch(existing._id, state);
    }
    return true;
  },
});

export const state = query({
  args: {},
  returns: v.union(
    v.object({
      activeSnapshotId: v.string(),
      manifestSha256: v.string(),
      totalDocuments: v.number(),
      collectionCounts: v.record(v.string(), v.number()),
      verifiedAtMs: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx) => {
    const document = await ctx.db
      .query("sfDatasetState")
      .withIndex("by_singleton", (q) => q.eq("singletonKey", "current"))
      .unique();
    if (document === null) return null;
    return {
      activeSnapshotId: document.activeSnapshotId,
      manifestSha256: document.manifestSha256,
      totalDocuments: document.totalDocuments,
      collectionCounts: document.collectionCounts,
      verifiedAtMs: document.verifiedAtMs,
    };
  },
});
