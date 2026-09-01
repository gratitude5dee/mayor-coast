import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
  checkInStatus,
  decisionStatus,
  deliveryPolicy,
  experienceCardInferred,
  experienceCardObserved,
  entityAliasInferred,
  entityAliasObserved,
  eventOccurrenceInferred,
  facetInferred,
  facetObserved,
  locationRequestPurpose,
  locationRequestStatus,
  nullableNumber,
  nullableString,
  outboundStage,
  outboundStatus,
  placeInferred,
  pollPurpose,
  portableCommonFields,
  semanticPollOption,
  sourceClaimInferred,
  sourceClaimObserved,
  sourceDocumentFreshness,
  sourceDocumentInferred,
  sourceDocumentObserved,
  turnPlan,
  turnState,
  travelMode,
  userStatus,
} from "./lib/validators";

const portableDocument = {
  ...portableCommonFields,
  observed: v.record(v.string(), v.any()),
  inferred: v.record(v.string(), v.any()),
};

export default defineSchema({
  sfPlaces: defineTable({
    ...portableCommonFields,
    observed: v.record(v.string(), v.any()),
    inferred: placeInferred,
  })
    .index("by_externalId", ["externalId"])
    .index("by_h3R6_status", ["inferred.geoCells.h3R6", "lifecycleStatus"])
    .index("by_priceBand_neighborhood", [
      "inferred.priceBand",
      "inferred.neighborhoodId",
    ])
    .index("by_status_neighborhood", [
      "lifecycleStatus",
      "inferred.neighborhoodId",
    ])
    .index("by_type_neighborhood", [
      "inferred.primaryType",
      "inferred.neighborhoodId",
    ]),

  sfEventSeries: defineTable(portableDocument).index("by_externalId", [
    "externalId",
  ]),

  sfEventOccurrences: defineTable({
    ...portableCommonFields,
    observed: v.record(v.string(), v.any()),
    inferred: eventOccurrenceInferred,
  })
    .index("by_externalId", ["externalId"])
    .index("by_h3R6_status_start", [
      "inferred.geoCells.h3R6",
      "inferred.activeStatus",
      "inferred.startAtUtcMs",
    ])
    .index("by_neighborhood_start", [
      "inferred.neighborhoodId",
      "inferred.activeStatus",
      "inferred.startAtUtcMs",
    ])
    .index("by_series_start", [
      "inferred.eventSeriesExternalId",
      "inferred.startAtUtcMs",
    ])
    .index("by_upcoming_start", [
      "inferred.activeStatus",
      "inferred.startAtUtcMs",
    ]),

  sfRecommendations: defineTable({
    ...portableCommonFields,
    observed: v.record(v.string(), v.any()),
    inferred: v.object({
      boundaryEvidence: v.record(v.string(), v.any()),
      canonicalId: v.string(),
      features: v.array(v.any()),
      identityKey: v.string(),
      placeExternalId: v.string(),
      searchText: v.string(),
      sfScopeStatus: v.string(),
      verificationStatus: v.string(),
    }),
  })
    .index("by_externalId", ["externalId"])
    .index("by_place", ["inferred.placeExternalId"]),

  sfSourceDocuments: defineTable({
    ...portableCommonFields,
    freshness: sourceDocumentFreshness,
    observed: sourceDocumentObserved,
    inferred: sourceDocumentInferred,
  })
    .index("by_externalId", ["externalId"])
    .index("by_source_published", [
      "observed.sourceName",
      "freshness.sourcePublishedAtMs",
    ])
    .index("by_url", ["observed.sourceUrl"]),

  sfSourceClaims: defineTable({
    ...portableCommonFields,
    observed: sourceClaimObserved,
    inferred: sourceClaimInferred,
  })
    .index("by_externalId", ["externalId"])
    .index("by_entity", ["inferred.entityExternalId"])
    .index("by_observation", ["observed.observationId"])
    .index("by_sourceDocument", ["inferred.sourceDocumentExternalId"]),

  sfEntityAliases: defineTable({
    ...portableCommonFields,
    observed: entityAliasObserved,
    inferred: entityAliasInferred,
  })
    .index("by_externalId", ["externalId"])
    .index("by_alias", ["observed.aliasType", "observed.aliasValue"]),

  sfFacets: defineTable({
    ...portableCommonFields,
    observed: facetObserved,
    inferred: facetInferred,
  })
    .index("by_externalId", ["externalId"])
    .index("by_entity", ["inferred.entityExternalId"])
    .index("by_namespace_value", ["observed.facetName", "observed.facetValue"]),

  sfExperienceCards: defineTable({
    ...portableCommonFields,
    observed: experienceCardObserved,
    inferred: experienceCardInferred,
  })
    .index("by_externalId", ["externalId"])
    .index("by_h3R6_status_start", [
      "inferred.h3R6",
      "inferred.activeStatus",
      "inferred.startAtUtcMs",
    ])
    .index("by_h3R8_kind_status_start", [
      "inferred.h3R8",
      "inferred.entityType",
      "inferred.activeStatus",
      "inferred.startAtUtcMs",
    ])
    .index("by_kind_start", [
      "inferred.entityType",
      "inferred.activeStatus",
      "inferred.startAtUtcMs",
    ])
    .index("by_neighborhood_start", [
      "inferred.neighborhoodId",
      "inferred.activeStatus",
      "inferred.startAtUtcMs",
    ])
    .index("by_priceBand_neighborhood", [
      "inferred.priceBand",
      "inferred.neighborhoodId",
    ])
    .index("by_type_neighborhood", [
      "inferred.primaryType",
      "inferred.neighborhoodId",
    ])
    .searchIndex("search_experiences", {
      searchField: "observed.retrievalTextObserved",
      filterFields: [
        "inferred.entityType",
        "inferred.activeStatus",
        "inferred.neighborhoodId",
        "inferred.primaryType",
        "inferred.priceBand",
      ],
    })
    .searchIndex("search_experiences_inferred", {
      searchField: "inferred.retrievalTextInferred",
      filterFields: [
        "inferred.entityType",
        "inferred.activeStatus",
        "inferred.neighborhoodId",
        "inferred.primaryType",
        "inferred.priceBand",
      ],
    }),

  coastUsers: defineTable({
    senderHash: v.string(),
    status: userStatus,
    createdAtMs: v.number(),
    updatedAtMs: v.number(),
    lastSeenAtMs: v.number(),
    forgetRequestedAtMs: v.optional(v.number()),
    forgottenAtMs: v.optional(v.number()),
  })
    .index("by_sender_hash", ["senderHash"])
    .index("by_status_updated", ["status", "updatedAtMs"]),

  coastPreferences: defineTable({
    userId: v.id("coastUsers"),
    namespace: v.string(),
    key: v.string(),
    value: v.any(),
    confidence: v.number(),
    source: v.union(v.literal("explicit"), v.literal("inferred")),
    createdAtMs: v.number(),
    updatedAtMs: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_key", ["userId", "namespace", "key"]),

  coastThreads: defineTable({
    userId: v.id("coastUsers"),
    provider: v.literal("imessage"),
    providerThreadKeyHash: v.string(),
    encryptedProviderThreadRef: v.string(),
    status: v.union(v.literal("active"), v.literal("closed")),
    activeTurnId: v.optional(v.id("coastTurns")),
    latestInboundAtMs: v.number(),
    createdAtMs: v.number(),
    updatedAtMs: v.number(),
  })
    .index("by_provider_thread", ["provider", "providerThreadKeyHash"])
    .index("by_user_updated", ["userId", "updatedAtMs"]),

  coastMessages: defineTable({
    userId: v.id("coastUsers"),
    threadId: v.id("coastThreads"),
    turnId: v.optional(v.id("coastTurns")),
    providerMessageId: v.optional(v.string()),
    direction: v.union(v.literal("inbound"), v.literal("outbound")),
    body: nullableString,
    bodyExpiresAtMs: nullableNumber,
    createdAtMs: v.number(),
    deletedAtMs: v.optional(v.number()),
    privacyRedactedAtMs: v.optional(v.number()),
  })
    .index("by_thread_created", ["threadId", "createdAtMs"])
    .index("by_user_created", ["userId", "createdAtMs"])
    .index("by_user_privacy_redacted", ["userId", "privacyRedactedAtMs"])
    .index("by_body_expiry", ["bodyExpiresAtMs"]),

  inboundDeliveryClaims: defineTable({
    dedupeKey: v.string(),
    webhookId: v.string(),
    providerMessageId: v.string(),
    userId: v.id("coastUsers"),
    threadId: v.id("coastThreads"),
    messageId: v.id("coastMessages"),
    turnId: v.id("coastTurns"),
    status: v.union(
      v.literal("claimed"),
      v.literal("handled"),
      v.literal("ignored"),
    ),
    command: v.union(
      v.literal("none"),
      v.literal("help"),
      v.literal("stop"),
      v.literal("start"),
      v.literal("forget_me"),
    ),
    reactionClaimedAtMs: v.optional(v.number()),
    readClaimedAtMs: v.optional(v.number()),
    typingClaimedAtMs: v.optional(v.number()),
    createdAtMs: v.number(),
    handledAtMs: v.optional(v.number()),
  })
    .index("by_dedupe", ["dedupeKey"])
    .index("by_provider_message", ["providerMessageId"])
    .index("by_status_created", ["status", "createdAtMs"]),

  coastTurns: defineTable({
    userId: v.id("coastUsers"),
    threadId: v.id("coastThreads"),
    state: turnState,
    revision: v.number(),
    messageIds: v.array(v.id("coastMessages")),
    carryForwardTurnIds: v.array(v.id("coastTurns")),
    /** Clarification answers in this discovery lineage; hard-capped at two. */
    clarificationDepth: v.optional(v.number()),
    origin: v.optional(v.union(v.literal("inbound"), v.literal("proactive"))),
    checkInId: v.optional(v.id("coastCheckIns")),
    plan: v.optional(turnPlan),
    scheduledForMs: v.number(),
    generationStartedAtMs: v.optional(v.number()),
    generationElapsedMs: v.optional(v.number()),
    generationKind: v.optional(
      v.union(
        v.literal("model"),
        v.literal("deterministic"),
        v.literal("deadline_fallback"),
      ),
    ),
    actualServiceTier: v.optional(v.string()),
    deadlineFallbackReason: v.optional(v.string()),
    planPersistedAtMs: v.optional(v.number()),
    sendStartedAtMs: v.optional(v.number()),
    completedAtMs: v.optional(v.number()),
    supersededAtMs: v.optional(v.number()),
    attemptCount: v.number(),
    lastErrorCode: v.optional(v.string()),
    privacyRedactedAtMs: v.optional(v.number()),
    createdAtMs: v.number(),
    updatedAtMs: v.number(),
  })
    .index("by_thread_state_updated", ["threadId", "state", "updatedAtMs"])
    .index("by_user_updated", ["userId", "updatedAtMs"])
    .index("by_user_privacy_redacted", ["userId", "privacyRedactedAtMs"])
    .index("by_state_updated", ["state", "updatedAtMs"]),

  coastPolls: defineTable({
    userId: v.id("coastUsers"),
    threadId: v.id("coastThreads"),
    turnId: v.id("coastTurns"),
    providerPollId: v.optional(v.string()),
    question: v.string(),
    options: v.array(v.string()),
    purpose: v.optional(pollPurpose),
    decisionId: v.optional(v.id("coastDecisions")),
    checkInId: v.optional(v.id("coastCheckIns")),
    optionActions: v.optional(v.array(semanticPollOption)),
    status: v.union(
      v.literal("pending"),
      v.literal("answered"),
      v.literal("expired"),
    ),
    selectedOption: v.optional(v.string()),
    createdAtMs: v.number(),
    answeredAtMs: v.optional(v.number()),
    expiresAtMs: v.number(),
  })
    .index("by_provider_poll", ["providerPollId"])
    .index("by_turn", ["turnId"])
    .index("by_decision", ["decisionId"])
    .index("by_checkin", ["checkInId"])
    .index("by_user", ["userId"])
    .index("by_thread_status", ["threadId", "status"])
    .index("by_expiry", ["status", "expiresAtMs"]),

  coastItineraries: defineTable({
    userId: v.id("coastUsers"),
    threadId: v.id("coastThreads"),
    turnId: v.id("coastTurns"),
    title: v.string(),
    summary: v.string(),
    selectedExternalIds: v.array(v.string()),
    createdAtMs: v.number(),
    expiresAtMs: v.number(),
  })
    .index("by_user_created", ["userId", "createdAtMs"])
    .index("by_expiry", ["expiresAtMs"])
    .index("by_turn", ["turnId"]),

  coastDecisions: defineTable({
    userId: v.id("coastUsers"),
    threadId: v.id("coastThreads"),
    sourceTurnId: v.id("coastTurns"),
    sourceMessageIds: v.array(v.id("coastMessages")),
    experienceExternalId: v.string(),
    entityType: v.union(v.literal("event"), v.literal("place")),
    status: decisionStatus,
    revision: v.number(),
    proposedAtMs: v.number(),
    selectedAtMs: v.optional(v.number()),
    supersededByDecisionId: v.optional(v.id("coastDecisions")),
    updatedAtMs: v.number(),
    expiresAtMs: v.number(),
  })
    .index("by_thread_status", ["threadId", "status"])
    .index("by_user", ["userId"])
    .index("by_user_status", ["userId", "status"])
    .index("by_expiry", ["expiresAtMs"]),

  coastCheckIns: defineTable({
    userId: v.id("coastUsers"),
    threadId: v.id("coastThreads"),
    decisionId: v.id("coastDecisions"),
    decisionRevision: v.number(),
    consentPollId: v.id("coastPolls"),
    status: checkInStatus,
    revision: v.number(),
    snoozeCount: v.number(),
    scheduledForMs: v.number(),
    consentedAtMs: v.number(),
    anchorExternalId: v.string(),
    anchorEntityType: v.union(v.literal("event"), v.literal("place")),
    anchorTitle: v.string(),
    anchorH3R6: v.string(),
    anchorH3R8: v.string(),
    anchorContentHash: v.string(),
    anchorVerifiedAtMs: v.number(),
    anchorExpiresAtMs: v.number(),
    arrivalPollId: v.optional(v.id("coastPolls")),
    proactiveTurnId: v.optional(v.id("coastTurns")),
    lastErrorCode: v.optional(v.string()),
    dueAtMs: v.optional(v.number()),
    completedAtMs: v.optional(v.number()),
    cancelledAtMs: v.optional(v.number()),
    createdAtMs: v.number(),
    updatedAtMs: v.number(),
    expiresAtMs: v.number(),
  })
    .index("by_decision", ["decisionId"])
    .index("by_user", ["userId"])
    .index("by_user_status", ["userId", "status"])
    .index("by_thread_status", ["threadId", "status"])
    .index("by_status_schedule", ["status", "scheduledForMs"])
    .index("by_expiry", ["expiresAtMs"]),

  coastLocationRequests: defineTable({
    userId: v.id("coastUsers"),
    threadId: v.id("coastThreads"),
    sourceTurnId: v.id("coastTurns"),
    requestKey: v.string(),
    purpose: locationRequestPurpose,
    state: locationRequestStatus,
    revision: v.number(),
    entityType: v.union(v.literal("event"), v.literal("place"), v.literal("any")),
    searchText: v.optional(v.string()),
    targetExternalId: v.optional(v.string()),
    travelMode: travelMode,
    providerRequestMessageId: v.optional(v.string()),
    createdAtMs: v.number(),
    updatedAtMs: v.number(),
    expiresAtMs: v.number(),
    consumedAtMs: v.optional(v.number()),
    cancelledAtMs: v.optional(v.number()),
    lastErrorCode: v.optional(v.string()),
  })
    .index("by_request_key", ["requestKey"])
    .index("by_thread_state", ["threadId", "state"])
    .index("by_state_expiry", ["state", "expiresAtMs"])
    .index("by_user", ["userId"]),

  outboundDeliveries: defineTable({
    turnId: v.id("coastTurns"),
    threadId: v.id("coastThreads"),
    stage: outboundStage,
    sequence: v.optional(v.number()),
    itemKey: v.optional(v.string()),
    idempotencyKey: v.string(),
    payload: v.record(v.string(), v.any()),
    status: outboundStatus,
    deliveryPolicy: v.optional(deliveryPolicy),
    attemptCount: v.number(),
    nextAttemptAtMs: v.number(),
    providerMessageId: v.optional(v.string()),
    lastErrorCode: v.optional(v.string()),
    createdAtMs: v.number(),
    updatedAtMs: v.number(),
    sentAtMs: v.optional(v.number()),
  })
    .index("by_idempotency", ["idempotencyKey"])
    .index("by_status_next_attempt", ["status", "nextAttemptAtMs"])
    .index("by_turn_stage", ["turnId", "stage"])
    .index("by_turn_sequence", ["turnId", "sequence"]),

  sfDatasetState: defineTable({
    singletonKey: v.literal("current"),
    activeSnapshotId: v.string(),
    manifestSha256: v.string(),
    dqStatus: v.literal("passed"),
    collectionCounts: v.record(v.string(), v.number()),
    totalDocuments: v.number(),
    eventWindowStart: v.string(),
    eventWindowEndInclusive: v.string(),
    editorialWindowStart: v.string(),
    editorialWindowEndInclusive: v.string(),
    verifiedAtMs: v.number(),
    advancedAtMs: v.number(),
  }).index("by_singleton", ["singletonKey"]),

  sfImportRuns: defineTable({
    snapshotId: v.string(),
    status: v.union(
      v.literal("started"),
      v.literal("verified"),
      v.literal("failed"),
    ),
    expectedCounts: v.record(v.string(), v.number()),
    actualCounts: v.record(v.string(), v.number()),
    manifestSha256: v.string(),
    checksumsVerified: v.boolean(),
    referentialIntegrityVerified: v.boolean(),
    privacyVerified: v.boolean(),
    errors: v.array(v.string()),
    warnings: v.array(v.string()),
    startedAtMs: v.number(),
    completedAtMs: v.optional(v.number()),
  })
    .index("by_snapshot", ["snapshotId"])
    .index("by_status_started", ["status", "startedAtMs"]),

  processedDatasetOperations: defineTable({
    operationId: v.string(),
    operation: v.union(
      v.literal("upsert"),
      v.literal("retract"),
      v.literal("merge"),
    ),
    collection: v.string(),
    externalId: v.string(),
    snapshotId: v.string(),
    appliedAtMs: v.number(),
  }).index("by_operation", ["operationId"]),

  failureAudit: defineTable({
    correlationId: v.string(),
    component: v.string(),
    code: v.string(),
    redactedMessage: v.string(),
    retryable: v.boolean(),
    userId: v.optional(v.id("coastUsers")),
    threadId: v.optional(v.id("coastThreads")),
    turnId: v.optional(v.id("coastTurns")),
    elapsedMs: v.optional(v.number()),
    generationKind: v.optional(
      v.union(
        v.literal("model"),
        v.literal("deterministic"),
        v.literal("deadline_fallback"),
      ),
    ),
    createdAtMs: v.number(),
  })
    .index("by_component_created", ["component", "createdAtMs"])
    .index("by_turn_created", ["turnId", "createdAtMs"]),

  cronRunLogs: defineTable({
    jobName: v.string(),
    runId: v.string(),
    state: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    processedCount: v.number(),
    deletedCount: v.number(),
    recoveredCount: v.number(),
    errorCode: v.optional(v.string()),
    startedAtMs: v.number(),
    finishedAtMs: v.optional(v.number()),
  }).index("by_job_started", ["jobName", "startedAtMs"]),

  chatStateKv: defineTable({
    key: v.string(),
    value: v.string(),
    expiresAtMs: v.number(),
    updatedAtMs: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_expiry", ["expiresAtMs"]),

  chatStateListItems: defineTable({
    key: v.string(),
    sequence: v.number(),
    value: v.string(),
    expiresAtMs: v.number(),
    createdAtMs: v.number(),
  })
    .index("by_key_sequence", ["key", "sequence"])
    .index("by_expiry", ["expiresAtMs"]),

  chatStateLocks: defineTable({
    key: v.string(),
    token: v.string(),
    expiresAtMs: v.number(),
    updatedAtMs: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_expiry", ["expiresAtMs"]),

  chatStateQueueItems: defineTable({
    key: v.string(),
    sequence: v.number(),
    value: v.string(),
    expiresAtMs: v.number(),
    createdAtMs: v.number(),
  })
    .index("by_key_sequence", ["key", "sequence"])
    .index("by_expiry", ["expiresAtMs"]),

  chatStateSubscriptions: defineTable({
    key: v.string(),
    subscriberId: v.string(),
    expiresAtMs: v.number(),
    createdAtMs: v.number(),
  })
    .index("by_key_subscriber", ["key", "subscriberId"])
    .index("by_subscriber", ["subscriberId"])
    .index("by_expiry", ["expiresAtMs"]),

  chatStateCounters: defineTable({
    key: v.string(),
    nextSequence: v.number(),
    updatedAtMs: v.number(),
  }).index("by_key", ["key"]),
});
