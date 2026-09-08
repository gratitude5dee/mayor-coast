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

Recognize exactly one `/imagine` or `/zap` command in a debounced burst. Preserve STOP, START, and FORGET ME precedence, reject mixed creative commands, deduplicate attachment source identifiers, and leave noncreative attachments on the existing rejection path. Route creative turns before concierge/calendar/poll/artist/recommendation logic. Creative payloads are AES-GCM encrypted before Convex admission, while ordinary message records contain only a redacted placeholder and creative turns are excluded from concierge history and preference learning.

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

## Next: `/draw` iMessage canvas and progressive image preview

`/draw` should open a short-lived COAST mini-app card in the existing 1:1 iMessage thread. It is a drawing-first entry point for the existing image-generation product, not a separate balance or provider: submitting a canvas consumes one image allowance or 50 cents using the same free-before-paid admission transaction as `/imagine`.

### Interaction contract

1. `/draw optional prompt` creates an encrypted, 15-minute draw session and sends a card URL with a single-use, scoped session token. It does not reserve credit yet.
2. The card presents a responsive canvas, brush size and color, eraser, undo/redo, clear, a prompt field, and an explicit **Generate** action. Keep the surface limited to direct 1:1 threads.
3. The browser stores in-progress strokes only in memory. On **Generate**, it rasterizes a bounded PNG plus an optional compact vector-stroke record and posts them with a card-issued idempotency key. The server verifies the session, user, thread, expiry, size, and one-submit rule before calling the normal creative admission mutation.
4. `/draw` without a prompt uses the submitted sketch as the primary instruction; supplied text becomes the image-edit prompt. The worker uses the existing image-edit route with one input image. A cleared or blank canvas receives a concise prompt to draw something first.
5. If credit is needed, the card shows the existing Checkout/Link choices and the saved draw submission resumes once after settlement. The normal iMessage billing message remains the durable fallback if the card session has expired.

### Progressive rendering

OpenAI’s image API can request zero to three partial images. For `/draw`, request at most two partials, persist each only as private, job-owned preview media, and publish an opaque progress event to the card’s authenticated event stream. The card swaps the preview in place as events arrive; it must never receive a provider URL, Blob token, raw prompt, or wallet data. Final output follows the existing native iMessage attachment-then-caption contract. Do not send successive partial files as iMessage attachments: Photon supports media delivery and remote text edits, while the mini-app is the appropriate surface for live previews.

Use a short-lived `GET /api/draw/sessions/:id/events` SSE endpoint (with authenticated polling fallback for iMessage webviews), and an authorization endpoint that streams private preview bytes only after checking session ownership, job state, media identity, and expiry. Persist monotonic event sequence numbers so reconnects resume without duplicate UI state. A dropped event stream never affects durable generation or final delivery.

### State, privacy, and cancellation

Add `drawSessions` and `creativePreviewMedia` tables keyed by opaque IDs, with encrypted prompt/sketch references, idempotency key, session expiry, event sequence, and job linkage. Treat the submitted raster as creative input: it is encrypted at rest, excluded from concierge history and logs, stored in private Blob only when a worker needs it, and deleted no later than 24 hours. Partial preview objects expire sooner, on final delivery or at session expiry. `STOP` cancels an unsubmitted draw, `FORGET ME` revokes the card and deletes sketches/previews, and job cancellation immediately invalidates preview authorization.

### Build and verification

- Add a `/draw` router branch before concierge processing, with the same STOP/START/FORGET precedence and creative-command ambiguity checks.
- Build the card as an accessible mobile canvas with pointer/touch handling, keyboard controls, reduced-motion progress, and a non-canvas prompt fallback.
- Add durable tests for session/user/thread binding, double submit, expired session, blank canvas, free and paid admission, partial-event ordering/reconnect, private-preview authorization, cancellation, and 24-hour cleanup.
- Test on native iMessage before enabling the feature flag. Verify the card opens from a direct iMessage URL, the card receives at most two partials, and final image delivery survives card closure, network loss, and an iMessage send retry.
- Keep `/draw` behind an independent `COAST_DRAW_ENABLED` flag. The feature remains disabled until the deployed environment has image streaming credentials, private Blob access, and a verified mini-app delivery capability.
