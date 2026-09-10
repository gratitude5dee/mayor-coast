# COAST `/imagine`, `/zap`, and generation credits

This is the implementation handoff for the existing 1:1 Photon iMessage experience in `gratitude5dee/mayor-coast`.

## Product contract

- Give every pseudonymous user 10 free images and 10 free 15-second videos in independent rolling 24-hour windows.
- Use free allowance before purchased credit. Purchased credit never expires in this release and has no paid daily cap or application-wide dollar ceiling.
- Charge 50 cents per paid image, including edits, and 100 cents per paid 15-second video.
- A fixed $9.99 USD top-up grants 1,000 cents. All accounting is integer cents.
- Permit one active creative job and one saved request awaiting payment per user.
- Show payment onboarding only after the relevant free allowance is exhausted. A successful top-up resumes the saved request once.

## Routing and privacy

Recognize exactly one `/imagine`, `/zap`, or `/draw` command in a debounced burst. Preserve STOP, START, and FORGET ME precedence, reject mixed creative commands, deduplicate attachment source identifiers, and leave noncreative attachments on the existing rejection path. Route creative turns before concierge/calendar/poll/artist/recommendation logic. Creative payloads are AES-GCM encrypted before Convex admission, while ordinary message records contain only a redacted placeholder and creative turns are excluded from concierge history and preference learning.

Support deterministic `/credits`, `/topup`, and `/disconnect-link` responses. `/credits` reports both free windows and purchased balance; `/topup` does not promote payment while free generations remain; disconnect revokes stored Link auth without deleting purchased balance.

## Providers and media

- `/imagine` uses GMI `gpt-image-2-generate` for text and `gpt-image-2-edit` for one image.
- `/zap` uses Fal MiniMax H3 turbo text-to-video, turbo image-to-video for one or two ordered images, and reference-to-video for additional image/video/audio references.
- Enforce 15 seconds, 768P, bounded prompt compilation with deterministic fallback, native audio, safety checking, deterministic aspect ratio, and 9 image/3 video/3 audio/12 total reference limits.
- Enforce 40 MB aggregate input, 10 MB image/audio, and 20 MB video limits. Validate actual MIME, dimensions, and duration in the worker; reject audio-only requests. HEIC/HEIF and audio normalization are bounded server-side conversions.
- Fetch Photon references server-side, materialize provider results into private Vercel Blob, expose only opaque Convex media IDs to delivery, stream without caching, and expire inputs/outputs within 24 hours.

## Durable Convex state

`creativeJobs`, encrypted payloads, `creativeMedia`, usage reservations, credit accounts and immutable ledgers, top-up orders, Link connections, and payment-event dedupe records are additive schema tables. Admission deduplicates the inbound request, checks user status and the active-job lock, reserves free usage or 50/100 cents atomically, or places the saved request in `awaiting_payment`. Worker leases, fencing fields, explicit unknown-submission states, no automatic non-idempotent resubmission, delivery-confirmed settlement, reservation release, expiry tombstones, and one-time payment resumption are represented in the Convex worker and recovery code.

## Payments

Hosted Checkout is server-owned, fixed at 999 cents, Link-enabled, and metadata-bound only to an opaque order ID. The success redirect is informational; the raw-body verified webhook is authoritative and deduplicates both Stripe event and payment identity. Refund/dispute events add one compensating -1,000-cent ledger entry. The Link CLI is pinned, isolated in restricted temporary directories, invoked with fixed argument arrays and an allowlisted environment, and is only used after explicit Connect Link selection and per-purchase approval. If merchant MPP/SPT support is unavailable, Checkout remains the working fallback.

## Delivery, cleanup, and deployment

Creative acknowledgment, native attachment, caption, status, and billing stages use the existing idempotent outbound contract. Attachment delivery precedes its caption, retries reuse the same artifact, STOP cancels unsubmitted creative/payment work, and FORGET ME redacts payloads/media and revokes Link credentials while retaining only minimal billing records. Recovery runs every minute and bounded cleanup removes expired manifests; physical Blob deletion must be enabled with the deployment token.

Deploy additive Convex schema first, then Vercel routes/workers, then enable independent creative, Checkout, and Link flags. Configure GMI/Fal/Groq, Blob, Stripe webhook, encryption, Convex service, and Link CLI secrets in deployment settings. Validate `pnpm check`, Convex transaction tests, deployed CLI/media-converter smoke tests, Stripe/Link test mode, native iMessage media delivery, and canaries proving prompts, media, addresses, credentials, and provider tokens never enter plaintext operational records, concierge inputs, or logs.

Implementation order: contracts and routing → ledger/jobs → providers/media → Checkout → Link CLI → delivery/privacy → deployment validation.

## `/draw` iMessage canvas and progressive image preview

`/draw` opens a short-lived COAST mini-app card in the existing 1:1 iMessage thread. Photon’s URL card hosts the web canvas inside Messages without extension identifiers. The hosted surface uses a compact vertical workspace with a square sketch/preview viewport, a 44-point toolbar, and a sticky bottom prompt/mode sheet. The repository also contains a native PencilKit `MSMessagesAppViewController` target for a live transcript canvas; production activation requires signing, installation, and matching Vercel team/bundle settings. It is a drawing-first entry point for the existing image-generation product, not a separate balance or provider: submitting a canvas consumes one image allowance or 50 cents using the same free-before-paid admission transaction as `/imagine`.

### Interaction contract

1. `/draw optional prompt` creates an encrypted, 15-minute draw session and sends a card URL with a single-use, scoped session token. It does not reserve credit yet.
2. The card presents a responsive canvas, brush size and color, eraser, undo/redo, clear, a prompt field, and an explicit **Generate** action. Keep the surface limited to direct 1:1 threads.
3. The browser stores in-progress strokes only in memory. On **Generate**, it rasterizes a bounded PNG plus an optional compact vector-stroke record and posts them with a card-issued idempotency key. The server verifies the session, user, thread, expiry, size, and one-submit rule before calling the normal creative admission mutation.
4. `/draw` without a prompt uses the submitted sketch as the primary instruction; supplied text becomes the image-edit prompt. The worker uses the existing image-edit route with one input image. A cleared or blank canvas receives a concise prompt to draw something first.
5. A completed image remains visible in the authenticated Preview tab in `ready_for_save`. The user may discard it or tap **Save to iMessage**, which idempotently queues the native attachment and caption. Credit/free allowance settles only after Photon confirms attachment delivery.
6. If credit is needed, the card shows the existing Checkout/Link choices and the saved draw submission resumes once after settlement. The normal iMessage billing message remains the durable fallback if the card session has expired.

### Progressive rendering

OpenAI’s image API can request zero to three partial images. For `/draw`, request two partials from `gpt-image-2.5-flare`, persist each only as private, job-owned preview media, and publish an opaque progress event to the card’s authenticated SSE stream with polling fallback. Fast uses low quality and 85% JPEG compression; Detailed uses medium quality and 92% JPEG compression. The card swaps the preview in place as events arrive; it must never receive a provider URL, Blob token, raw prompt, or wallet data. The final output stays in the mini-app until explicit Save, then follows the native iMessage attachment-then-caption contract. Do not send successive partial files as iMessage attachments: Photon supports media delivery and remote text edits, while the mini-app is the appropriate surface for live previews.

Use a short-lived `GET /api/draw/sessions/:id/events` SSE endpoint (with authenticated polling fallback for iMessage webviews), and an authorization endpoint that streams private preview bytes only after checking session ownership, job state, media identity, and expiry. Persist monotonic event sequence numbers so reconnects resume without duplicate UI state. A dropped event stream never affects durable generation or final delivery.

### State, privacy, and cancellation

Add `drawSessions` and `creativePreviewMedia` tables keyed by opaque IDs, with encrypted prompt/sketch references, idempotency key, session expiry, event sequence, and job linkage. Treat the submitted raster as creative input: it is encrypted at rest, excluded from concierge history and logs, stored in private Blob only when a worker needs it, and deleted no later than 24 hours. Partial preview objects expire sooner, on final delivery or at session expiry. `STOP` cancels an unsubmitted draw, `FORGET ME` revokes the card and deletes sketches/previews, and job cancellation immediately invalidates preview authorization.

### Build and verification

- Add a `/draw` router branch before concierge processing, with the same STOP/START/FORGET precedence and creative-command ambiguity checks.
- Build the card as an accessible mobile canvas with pointer/touch handling, keyboard controls, reduced-motion progress, and a non-canvas prompt fallback.
- Add durable tests for session/user/thread binding, double submit, expired session, blank canvas, free and paid admission, partial-event ordering/reconnect, private-preview authorization, cancellation, and 24-hour cleanup.
- Test the Photon URL mini-app and the signed `ios/CoastDraw` extension on native iMessage before enabling the live layout. Verify the card opens from a direct iMessage URL, the card receives at most two partials, and final image delivery survives card closure, network loss, and an iMessage send retry.
- Keep `/draw` behind an independent `COAST_DRAW_ENABLED` flag. The production flag is currently `false`: the Flare canary reached OpenAI but returned `403 Your organization must be verified to use the model gpt-image-2.5-flare`. Enable the flag only after organization verification and a successful generate/edit stream canary; do not silently fall back to Sunburst.
# Generate repair and Turbo addition

Recover consumed Draw launch links using valid session cookies, with status-first browser authorization. Show immediate preparation and prevent duplicate Generate taps. Add Z-Image Turbo with four steps, safety enabled, one square image, and image-to-image strength 0.6. Persist its Fal request identity before polling; never resubmit an uncertain attempt. Keep Flare fast/detailed and their streamed previews. Validate session recovery and both Turbo input modes before deployment.

# User-centered operations dashboard

The private admin dashboard is organized around each pseudonymous COAST user rather than a set of unrelated global record tables. `/admin` provides a most-recently-active, cursor-paginated directory with status filtering and exact phone/email or user-ID lookup. Selecting a user opens `/admin/users/[userId]`, which retains selection across refresh and offers Overview, Activity, Generations, and Billing tabs.

Overview uses the existing transactional credit calculation for purchased credit, independent rolling image/video allowance, unresolved reservations, and active creative work. Activity groups concierge and creative summaries by verified conversation without exposing their content. Generations distinguish ready-to-save, sending, delivered, and unknown outcomes. Billing groups hosted Checkout and connected-Link top-ups with their immutable ledger and payment events.

All directory/profile APIs require the existing admin session, apply user/conversation/date/status filters before cursor pagination, and return explicit unavailable values when ownership cannot be established. User identity references are decrypted only by Vercel for operator display; response models exclude bodies, prompts, media URLs, credentials, encryption payloads, and raw identity references. Delivery and payment-event ownership fields are additive and backfilled in bounded, resumable batches from verified parent records.

## Draw repair and Draw-to-video release

Draw offers **Flare Fast** (low-quality JPEG, 85%), **Flare Detailed** (medium-quality JPEG, 92%), **Turbo · 4 steps** through `fal-ai/z-image/turbo`, and **Sunburst HQ** through `gpt-image-2.5-sunburst` at high quality. Turbo uses one square 1024px JPEG, the Fal safety checker, and strength `0.9` for sketches and `0.6` for imported photos or result refinements. It uses the image-to-image endpoint only with an image and the text endpoint otherwise. Turbo must materialize a real output different from its submitted raster before its canary passes; it publishes provider-backed states and its actual final image. Flare and Sunburst retain zero to two real partials and only a completion event produces the final artifact.

Every distinct `/draw` message receives a fresh blank workspace and a new 15-minute encrypted launch link. Retried webhooks reuse the same session/card. The fixed mini-app captures drawing pointers and prevents scroll chaining only in the square drawing surface, leaving controls and keyboard interactions available. The production canvas uses compact Toolcraft-inspired controls with source attribution. A client-only tldraw adapter is staged behind `COAST_DRAW_TLDRAW_ENABLED` and a production license; it remains off until licensed.

Image and video provider work use independent per-user slots. `/draw` and `/imagine` share the image slot and allowance; `/zap` owns the video slot. A completed Draw final artifact settles its free reservation or 50-cent debit once when it becomes available in the authenticated mini-app. Save retries only send that artifact through iMessage. **Animate** admits a new, independently priced `/zap` job with an opaque reference to the completed Draw image. `/zap animate this` can use the latest Draw result in the same conversation when it has no explicit attachment. Inputs, previews, and outputs retain their private, bounded deletion lifetimes.

## Multi-turn Draw revisions

`/edit <instruction>` admits an immediate Draw revision from the latest completed artifact in the same iMessage conversation and returns a fresh review card. A single attached image starts a new edit workspace; additional or unsupported attachments are rejected. The mini-app exposes authenticated revision metadata and private thumbnails through a branchable horizontal strip. Selecting a prior revision does not overwrite later branches, and a background status refresh cannot move a user out of a drawing or refinement draft.

Flare and Sunburst revisions are handled through a stateless Responses API call using `gpt-5.6-luna`, `reasoning: none`, `store: false`, one forced `image_generation` edit tool, a 240-second deadline, and up to two persisted partial images. The worker replays only encrypted ancestor instructions plus the selected private image; it never stores OpenAI conversation or image identifiers. Context is capped at 32,000 characters and **Start fresh from this image** begins an explicitly reset branch. Turbo retains its bounded four-step Fal submit/poll flow. `COAST_DRAW_MULTITURN_ENABLED` remains off until private-artifact generate/edit and three-turn branch canaries pass.

## Shared soul and Bay language

`SOUL.md` is the shared character source for iMessage, future voice, and livestream experiences. `scripts/generate-soul.ts` produces the hash-addressed `src/lib/coast/soul.generated.ts`; `pnpm soul:check` fails on stale generated output. `src/lib/coast/persona.ts` composes the soul with typed channel guidance while preserving source-grounded retrieval, privacy, provenance, and structured-output rules.

The supplied Bay Area dictionary is used naturally and contextually. Casual replies may use one or two fitting expressions; commands, payment, privacy, errors, and consequential uncertainty remain literal. The application owns a short first-turn greeting and deterministic event, artist, discovery, and check-in copy. No soul text enters creative prompts, billing records, saved preferences, or operational payloads.
