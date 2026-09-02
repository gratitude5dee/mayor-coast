import { v } from "convex/values";

import { mutation } from "./_generated/server";

const BATCH_SIZE = 24;
const MAX_CLAIMS_PER_ENTITY = 64;
const MEDIA_BACKFILL_VERSION = "source-claim-media-v1";

function assertServiceSecret(candidate: string): void {
  const expected = process.env.COAST_CONVEX_SERVICE_SECRET;
  if (!expected || candidate.length !== expected.length) throw new Error("UNAUTHORIZED");
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ candidate.charCodeAt(index);
  }
  if (mismatch !== 0) throw new Error("UNAUTHORIZED");
}

function safeImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function chooseImage(claims: Array<{
  externalId: string;
  lifecycleStatus: string;
  inferred: { entityExternalId: string };
  observed: {
    assertedValue: unknown;
    confidence: number;
    fieldName: string;
    observedAtMs: number;
    selectedForCanonical: boolean;
  };
}>) {
  return claims
    .filter((claim) => claim.lifecycleStatus === "active" && claim.observed.fieldName === "image_url")
    .map((claim) => ({ claim, imageUrl: safeImageUrl(claim.observed.assertedValue) }))
    .filter((candidate): candidate is { claim: (typeof claims)[number]; imageUrl: string } =>
      candidate.imageUrl !== null,
    )
    .sort((left, right) =>
      Number(right.claim.observed.selectedForCanonical) - Number(left.claim.observed.selectedForCanonical) ||
      right.claim.observed.confidence - left.claim.observed.confidence ||
      right.claim.observed.observedAtMs - left.claim.observed.observedAtMs ||
      left.claim.externalId.localeCompare(right.claim.externalId),
    )[0] ?? null;
}

/**
 * Materializes the existing immutable image_url claims on the bounded serving
 * card. Delivery therefore never reads sfSourceClaims for a chat response.
 */
export const backfillBatch = mutation({
  args: {
    serviceSecret: v.string(),
    cursor: v.optional(v.string()),
  },
  returns: v.object({
    continueCursor: v.string(),
    done: v.boolean(),
    processed: v.number(),
    assigned: v.number(),
    skipped: v.number(),
  }),
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);
    const page = await ctx.db
      .query("sfExperienceCards")
      .order("asc")
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });
    let assigned = 0;
    let skipped = 0;

    for (const card of page.page) {
      if (card.observed.media !== undefined) {
        skipped += 1;
        continue;
      }
      const direct = await ctx.db
        .query("sfSourceClaims")
        .withIndex("by_entity", (q) =>
          q.eq("inferred.entityExternalId", card.inferred.entityExternalId),
        )
        .take(MAX_CLAIMS_PER_ENTITY);
      let chosen = chooseImage(direct);

      if (chosen === null && card.inferred.entityType === "event") {
        const occurrence = await ctx.db
          .query("sfEventOccurrences")
          .withIndex("by_externalId", (q) =>
            q.eq("externalId", card.inferred.entityExternalId),
          )
          .unique();
        if (occurrence !== null) {
          const seriesClaims = await ctx.db
            .query("sfSourceClaims")
            .withIndex("by_entity", (q) =>
              q.eq("inferred.entityExternalId", occurrence.inferred.eventSeriesExternalId),
            )
            .take(MAX_CLAIMS_PER_ENTITY);
          chosen = chooseImage(seriesClaims);
        }
      }

      if (chosen === null) {
        skipped += 1;
        continue;
      }
      await ctx.db.patch(card._id, {
        observed: {
          ...card.observed,
          media: {
            imageUrl: chosen.imageUrl,
            sourceClaimId: chosen.claim.externalId,
            sourceEntityExternalId: chosen.claim.inferred.entityExternalId,
          },
        },
        quality: {
          ...card.quality,
          mediaBackfillVersion: MEDIA_BACKFILL_VERSION,
        },
      });
      assigned += 1;
    }

    return {
      continueCursor: page.continueCursor,
      done: page.isDone,
      processed: page.page.length,
      assigned,
      skipped,
    };
  },
});
