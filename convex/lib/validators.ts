import { v } from "convex/values";

export const nullableString = v.union(v.string(), v.null());
export const nullableNumber = v.union(v.number(), v.null());
export const nullableBoolean = v.union(v.boolean(), v.null());

const experienceScore = v.object({
  confidence: v.number(),
  modelVersion: v.string(),
  promptVersion: v.string(),
  score: v.number(),
  supportingSourceClaimIds: v.array(v.string()),
  supportingSourceObservationIds: v.array(v.string()),
  taxonomyVersion: v.string(),
});

export const portableCommonFields = {
  externalId: v.string(),
  schemaVersion: v.number(),
  entityVersion: v.number(),
  contentHash: v.string(),
  createdAtMs: nullableNumber,
  updatedAtMs: nullableNumber,
  lastVerifiedAtMs: nullableNumber,
  lastBundleId: v.string(),
  lifecycleStatus: v.string(),
  quality: v.record(v.string(), v.any()),
  freshness: v.record(v.string(), v.any()),
  sourceRefs: v.array(v.string()),
};

export const experienceCardObserved = v.object({
  canonicalUrl: v.string(),
  cardKind: v.string(),
  experienceFields: v.record(v.string(), v.any()),
  media: v.optional(v.object({
    imageUrl: v.string(),
    sourceClaimId: v.string(),
    sourceEntityExternalId: v.string(),
  })),
  observedSummary: nullableString,
  retrievalTextObserved: v.string(),
  sourceUrls: v.array(v.string()),
  title: v.string(),
});

export const experienceCardInferred = v.object({
  activeStatus: v.string(),
  entityExternalId: v.string(),
  entityType: v.union(v.literal("event"), v.literal("place")),
  h3R6: v.string(),
  h3R8: v.string(),
  inferenceVersion: v.string(),
  neighborhoodId: v.string(),
  occasionScores: v.record(v.string(), experienceScore),
  priceBand: v.string(),
  primaryType: nullableString,
  provenanceIds: v.array(v.string()),
  provenanceSummary: v.record(v.string(), v.any()),
  retrievalTextInferred: v.string(),
  startAtUtcMs: nullableNumber,
  startDateKey: nullableString,
  vibeScores: v.record(v.string(), experienceScore),
});

export const placeInferred = v.object({
  activeStatus: v.string(),
  boundaryEvidence: v.record(v.string(), v.any()),
  canonicalId: v.string(),
  features: v.array(v.any()),
  geoCellSystem: v.string(),
  geoCells: v.object({ h3R6: v.string(), h3R8: v.string() }),
  identityKey: v.string(),
  latE6: v.number(),
  lngE6: v.number(),
  // Place rows may be coordinate-verified inside SF yet fall outside a
  // published neighborhood polygon. They remain source/provenance records but
  // do not receive an experience card until a canonical neighborhood exists.
  neighborhoodId: nullableString,
  priceBand: v.string(),
  primaryType: v.string(),
  searchText: v.string(),
  sfScopeStatus: v.string(),
  verificationStatus: v.string(),
});

export const eventOccurrenceInferred = v.object({
  activeStatus: v.string(),
  boundaryEvidence: v.record(v.string(), v.any()),
  canonicalId: v.string(),
  eventSeriesExternalId: v.string(),
  features: v.array(v.any()),
  geoCellSystem: v.string(),
  geoCells: v.object({ h3R6: v.string(), h3R8: v.string() }),
  identityKey: v.string(),
  latE6: v.number(),
  lngE6: v.number(),
  neighborhoodId: v.string(),
  priceBand: v.string(),
  primaryType: v.string(),
  searchText: v.string(),
  sfScopeStatus: v.string(),
  startAtUtcMs: v.number(),
  startDateKey: v.string(),
  verificationStatus: v.string(),
});

export const sourceDocumentObserved = v.object({
  articleMetadata: v.optional(v.any()),
  author: v.optional(v.any()),
  inEditorialWindow: v.optional(v.any()),
  listingStatus: v.optional(v.any()),
  publishedAt: v.optional(v.any()),
  redactedFieldCount: v.optional(v.any()),
  sanitizedPayloadHash: v.optional(v.any()),
  sanitizedPayloadHashes: v.optional(v.any()),
  section: v.optional(v.any()),
  sourceEntityType: v.optional(v.any()),
  sourceName: v.string(),
  sourceNativeId: v.optional(v.any()),
  sourceRecordId: v.optional(v.any()),
  sourceRecordIds: v.optional(v.any()),
  sourceUrl: v.string(),
  summary: v.optional(v.any()),
  title: v.optional(v.any()),
  updatedAt: v.optional(v.any()),
});

export const sourceDocumentFreshness = v.object({
  lastSeenAtMs: v.optional(nullableNumber),
  scrapedAtMs: v.optional(nullableNumber),
  sourcePublishedAtMs: v.optional(nullableNumber),
  sourceUpdatedAtMs: v.optional(nullableNumber),
});

export const sourceDocumentInferred = v.object({
  crawlIds: v.optional(v.array(v.string())),
  documentKind: v.string(),
  observationIds: v.array(v.string()),
  runIds: v.array(v.string()),
});

export const sourceClaimObserved = v.object({
  assertedValue: v.any(),
  assertedValueHash: v.string(),
  confidence: v.number(),
  fieldName: v.string(),
  observationId: v.string(),
  observedAtMs: v.number(),
  partition: v.string(),
  selectedForCanonical: v.boolean(),
  selectionReason: nullableString,
  sourceRecordId: v.string(),
});

export const sourceClaimInferred = v.object({
  entityExternalId: v.string(),
  modelVersion: nullableString,
  promptVersion: nullableString,
  sourceDocumentExternalId: v.string(),
  supportingObservationIds: v.array(v.string()),
  taxonomyVersion: nullableString,
});

export const entityAliasObserved = v.object({
  aliasType: v.string(),
  aliasValue: v.string(),
});

export const entityAliasInferred = v.object({
  entityExternalId: v.string(),
});

export const facetObserved = v.object({
  facetName: v.string(),
  // Deterministic facets intentionally preserve typed JSONL values. Event
  // access flags are booleans while categorical facets are strings.
  facetValue: v.union(v.string(), v.boolean()),
});

export const facetInferred = v.object({
  collection: v.string(),
  entityExternalId: v.string(),
});

export const turnState = v.union(
  v.literal("debouncing"),
  v.literal("ready_generation"),
  v.literal("generating"),
  v.literal("response_planned"),
  v.literal("sending"),
  v.literal("sent"),
  v.literal("superseded"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export const userStatus = v.union(
  v.literal("active"),
  v.literal("stopped"),
  v.literal("forgetting"),
  v.literal("forgotten"),
);

export const controlCommand = v.union(
  v.literal("none"),
  v.literal("help"),
  v.literal("stop"),
  v.literal("start"),
  v.literal("forget_me"),
);

export const outboundStage = v.union(
  v.literal("response"),
  // Retained only so in-flight pre-card turns remain readable after rollout.
  v.literal("results"),
  v.literal("experience_card"),
  v.literal("calendar_attachment"),
  v.literal("reservation_action"),
  v.literal("location_request"),
  v.literal("maps_card"),
  v.literal("artist_drop"),
  v.literal("poll"),
);

export const locationRequestStatus = v.union(
  v.literal("pending_provider"),
  v.literal("awaiting_share"),
  v.literal("resolving"),
  v.literal("consumed"),
  v.literal("expired"),
  v.literal("cancelled"),
  v.literal("failed"),
);

export const locationRequestPurpose = v.union(
  v.literal("nearby_search"),
  v.literal("directions"),
);

export const travelMode = v.union(
  v.literal("walking"),
  v.literal("driving"),
  v.literal("transit"),
  v.literal("bicycling"),
);

export const outboundStatus = v.union(
  v.literal("pending"),
  v.literal("sending"),
  v.literal("sent"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export const deliveryPolicy = v.union(
  v.literal("retryable"),
  v.literal("at_most_once"),
);

export const decisionStatus = v.union(
  v.literal("proposed"),
  v.literal("selected"),
  v.literal("superseded"),
  v.literal("cancelled"),
  v.literal("completed"),
  v.literal("expired"),
);

export const checkInStatus = v.union(
  v.literal("scheduled"),
  v.literal("due"),
  v.literal("awaiting_arrival"),
  v.literal("suggesting"),
  v.literal("completed"),
  v.literal("cancelled"),
  v.literal("expired"),
  v.literal("failed"),
);

export const pollPurpose = v.union(
  v.literal("clarification"),
  v.literal("agenda_filter"),
  v.literal("decision_confirm_checkin"),
  v.literal("arrival_status"),
);

export const semanticPollAction = v.union(
  v.literal("confirm_without_checkin"),
  v.literal("schedule_checkin"),
  v.literal("reject_decision"),
  v.literal("arrived"),
  v.literal("snooze_30m"),
  v.literal("cancel_checkin"),
);

export const semanticPollOption = v.object({
  option: v.string(),
  action: semanticPollAction,
  scheduledForMs: v.optional(v.number()),
});

export const modelRoute = v.union(
  // Retained for already-persisted deterministic location/control turns.
  v.literal("luna_low"),
  v.literal("luna_high_fast"),
  v.literal("terra_low"),
);

export const preferenceUpdate = v.object({
  namespace: v.string(),
  key: v.string(),
  value: v.any(),
  confidence: v.number(),
  source: v.union(v.literal("explicit"), v.literal("inferred")),
});

export const pollPlan = v.object({
  question: v.string(),
  options: v.array(v.string()),
});

export const turnPlan = v.object({
  responseText: v.string(),
  selectedExternalIds: v.array(v.string()),
  dailyAgendaExternalIds: v.optional(v.array(v.string())),
  poll: v.union(pollPlan, v.null()),
  pollKind: v.optional(v.union(v.literal("clarification"), v.literal("agenda_filter"))),
  preferenceUpdates: v.array(preferenceUpdate),
  provenanceIds: v.array(v.string()),
  modelRoute,
  routeReasons: v.array(v.string()),
  modelSteps: v.number(),
  toolCalls: v.number(),
  retrievalMode: v.union(
    v.literal("observed"),
    v.literal("inferred_fallback"),
    v.literal("none"),
  ),
  nextAction: v.optional(
    v.union(
      v.object({ type: v.literal("none") }),
      v.object({
        type: v.literal("request_location"),
        purpose: locationRequestPurpose,
        targetExternalId: v.optional(v.string()),
        travelMode: v.optional(travelMode),
      }),
      v.object({
        type: v.literal("create_calendar"),
        targetExternalId: v.string(),
        startAtMs: v.number(),
        endAtMs: v.optional(v.union(v.number(), v.null())),
      }),
      v.object({
        type: v.literal("share_artist"),
        shareKind: v.union(v.literal("direct"), v.literal("automatic")),
      }),
    ),
  ),
  generationKind: v.optional(
    v.union(
      v.literal("model"),
      v.literal("deterministic"),
      v.literal("deadline_fallback"),
    ),
  ),
  elapsedMs: v.optional(v.number()),
  serviceTier: v.optional(v.union(v.string(), v.null())),
});

export const experienceResult = v.object({
  externalId: v.string(),
  contentHash: v.string(),
  entityExternalId: v.string(),
  title: v.string(),
  canonicalUrl: v.string(),
  observedSummary: v.string(),
  sourceUrls: v.array(v.string()),
  entityType: v.union(v.literal("event"), v.literal("place")),
  activeStatus: v.string(),
  neighborhoodId: v.string(),
  primaryType: nullableString,
  priceBand: v.string(),
  startAtUtcMs: nullableNumber,
  endAtUtcMs: nullableNumber,
  startDateKey: nullableString,
  h3R6: v.string(),
  h3R8: v.string(),
  provenanceIds: v.array(v.string()),
  experienceFields: v.record(v.string(), v.any()),
  media: v.optional(v.union(v.object({
    imageUrl: v.string(),
    sourceClaimId: v.string(),
    sourceEntityExternalId: v.string(),
  }), v.null())),
  matchSource: v.union(v.literal("observed"), v.literal("inferred")),
});

export const controlReply = v.object({
  command: controlCommand,
  text: v.string(),
});

export const inboundClaimResult = v.object({
  accepted: v.boolean(),
  duplicate: v.boolean(),
  shouldAcknowledge: v.boolean(),
  shouldStartTyping: v.boolean(),
  command: controlCommand,
  controlReply: v.union(controlReply, v.null()),
  userId: v.id("coastUsers"),
  threadId: v.id("coastThreads"),
  messageId: v.id("coastMessages"),
  turnId: v.id("coastTurns"),
});

/** A poll event that is validly stale or expired and must be consumed. */
export const terminalPollClaimResult = v.object({
  terminal: v.literal(true),
});

export const pollClaimResult = v.union(
  inboundClaimResult,
  terminalPollClaimResult,
);
