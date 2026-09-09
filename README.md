# COAST

COAST is San Francisco’s unofficial mayor, delivered over iMessage. It uses Photon for the native messaging surface, raw OpenAI Responses behind an application-owned runtime, and Convex for the SF serving database and all durable operational state.

The implementation contract is documented in this repository’s source, tests, and architecture notes below.

## Architecture

```mermaid
flowchart LR
    U[iMessage user] --> P[Photon + Chat iMessage adapter]
    P -->|signed webhook| V[Vercel / Next.js]
    V -->|claim, dedupe, queue| C[Convex]
    C -->|bounded retrieval| D[(SF experience cards)]
    V -->|structured tool loop| O[OpenAI Responses API]
    O -->|external IDs only| V
    C -->|durable delivery + sparse schedules| V
    V -->|cards, calendar, polls, Find My, Maps| P
    P --> U
    C --> M[(Pseudonymous memory\nturns, polls, preferences)]
```

### Conversation flow

1. A signed Photon webhook is verified at Vercel; Convex atomically claims and deduplicates the inbound message.
2. COAST marks the message read, reacts, and keeps typing active while the durable turn runs.
3. The agent searches `sfExperienceCards` through bounded indexes and returns only source-backed external IDs.
4. When the next step is a clear set of choices, COAST sends one native poll instead of listing alternatives in prose. A vote starts typing immediately and settles for two seconds, so changing the selection revises the same durable turn instead of sending two answers.
5. Verified matches render as native cards. Event results and user-requested place holds can be added to Apple Calendar in one tap; every `.ics` includes a 15-minute reminder and is followed by a source-backed registration, reservation, or phone-confirmation action. Calendar holds never claim availability.
6. Opted-in post-visit check-ins and six-hour inactivity scans run in Convex. Idle nudges require prior taste signals, respect 10 AM–10 PM SF quiet hours, are capped at one per six hours, and skip stopped, stale, or currently active conversations.
7. A “near me” or directions request sends one native Find My request. A consented, fresh location is used only in the serverless resolver to rank public destinations or make a Maps handoff; exact origin never enters Convex, OpenAI, logs, or outbound URLs.

## Creative generation

COAST accepts `/imagine` for GMI images and one-image edits, `/zap` for 15-second Fal MiniMax H3 videos, and `/draw` for an iMessage sketch canvas backed by OpenAI `gpt-image-2.5-flare`. Draw defaults to Fast mode (low quality, JPEG, 85% compression) and offers Detailed mode (medium quality, JPEG, 92% compression); both use durable partial-image events and the shared image allowance. Photon’s URL mini-app keeps the hosted canvas in Messages today. A completed Draw image remains in the authenticated Preview tab until the user taps **Save to iMessage**; only that action queues the native attachment and caption. The native PencilKit Messages extension in `ios/CoastDraw` enables a live transcript canvas after it is signed and installed. Each user receives 10 images and 10 videos per rolling 24 hours. After an allowance is exhausted, images cost $0.50 and videos cost $1.00 from purchased credit; a fixed $9.99 Stripe Checkout top-up grants $10.00 credit. Link wallet onboarding is optional and begins only when the user selects Connect Link. Creative prompts and media are isolated from concierge context and expire from COAST storage within 24 hours. `/draw` admission is independently controlled by `COAST_DRAW_ENABLED`.

## Experience guarantees

- Results are source-backed; model output cannot create destination URLs.
- Native result cards, calendar attachments, polls, location requests, and Maps cards are persisted as idempotent delivery stages before sending.
- HMAC-pseudonymized users, preferences, threads, and delivery records live in Convex. Raw message text expires after 30 days; `FORGET ME` clears the user’s saved state.
- The beta is 1:1 DM only and uses Photon’s free shared line. Third-party ticket/reservation links remain source-backed; creative top-ups are processed through the fixed Stripe Checkout flow.

## Local validation

```bash
pnpm install
pnpm snapshot:verify
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Copy `.env.example` to `.env.local` only for local development. Real values belong in Convex/Vercel encrypted environment settings and must never be committed or printed.

Creative deployment settings are `COAST_CREATIVE_RUNTIME_URL`, `COAST_DRAW_RUNTIME_URL`, `COAST_DRAW_ENABLED`, `COAST_DRAW_MODEL`, `COAST_CREATIVE_CLEANUP_URL`, `OPENAI_API_KEY`, `GMI_CLOUD_API_KEY`, `GMI_REQUEST_QUEUE_URL`, `FAL_KEY`, `GROQ_API_KEY` (optional prompt compiler), `BLOB_READ_WRITE_TOKEN`, `COAST_PUBLIC_URL`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET`. `COAST_DRAW_MODEL` defaults to `gpt-image-2.5-flare`; do not silently substitute another model when Flare access is unavailable. A live transcript card additionally uses `COAST_DRAW_APPLE_TEAM_ID`, `COAST_DRAW_EXTENSION_BUNDLE_ID`, and the optional `COAST_DRAW_APP_STORE_ID`; the values must match the signed target under `ios/CoastDraw`. Convex must also hold the matching `COAST_CONVEX_SERVICE_SECRET`; Link CLI runtime files are packaged through the pinned `@stripe/link-cli` dependency.

## Operations dashboard

The private dashboard at `/admin` shows paginated creative jobs, turn and message metadata, free-usage reservations, top-up orders, payment-event deduplication records, purchased balances, ledger entries, Link connection status, and outbound delivery state. It refreshes every 15 seconds. Record tables use a fixed allowlist: prompts, message bodies, private media, checkout URLs, and wallet credentials never reach the browser. The authenticated user header may show the user address and originating Photon line as described below.

Access uses an eight-hour Secure, HttpOnly session. Store only the SHA-256 hash of the access key in the production Convex environment as `COAST_ADMIN_PASSWORD_HASH`. Login attempts are rate limited per client. Rotate the key by replacing that hash; existing browser sessions expire independently after eight hours.

The user selector groups jobs, interactions, usage, payments, balances, ledger entries, Link state, and delivery records by COAST user. The authenticated user summary decrypts the latest verified iMessage thread reference in the Vercel route so operators can see the user phone or email and the originating Photon line. Convex and the dashboard record tables continue to use pseudonymous user IDs, and a Photon `shared` line is labeled as shared rather than represented as a phone number.

## Fixed dataset

The beta is locked to `snapshot-99f2d46a008bec47efae` in `../data/convex/snapshots/`. It contains 129 places, 444 event series, 514 event occurrences, 107 explicit recommendations, and 636 serving experience cards. All nine source collections total 251,679 documents.

`sfExperienceCards` is the recommendation hot path. `sfSourceClaims` is provenance storage and must never be scanned during a live recommendation.

### Verified import

The importer always validates checksums, row counts, privacy, and cross-document references before touching Convex. It then replaces all nine tables individually and advances `sfDatasetState` only after every import exits successfully. If any step fails, the prior dataset pointer remains active.

```bash
# Personal Convex dev deployment
pnpm snapshot:import -- --yes

# Approved COAST production deployment; both flags are mandatory
pnpm snapshot:import -- --prod --yes
```

`COAST_INTERNAL_SERVICE_SECRET` must already be loaded from a secure environment manager. The importer sends it directly to Convex for the final attestation, never prints it, and rejects secrets supplied as command arguments. Do not paste this or any other secret into chat.

## Runtime endpoints

- `GET /api/health` — redacted configuration readiness.
- `POST /api/imessage/webhook` — signed Photon delivery endpoint.
- `POST /api/internal/agent` — service-authenticated Responses runtime.
- `POST /api/internal/creative` — service-authenticated GMI/Fal creative worker with private Blob materialization.
- `POST /api/internal/delivery` — service-authenticated Photon delivery bridge.
- `GET /api/stripe/creative-topup?order_id=...` — fixed $9.99 Checkout redirect for a server-owned order.
- `POST /api/stripe/webhook` — raw-body verified Stripe settlement endpoint.
- `POST /api/admin/session` and `GET /api/admin/records` — same-origin login and authenticated, privacy-projected operations data.

The webhook is a Node route. The Photon adapter verifies the exact raw request body and its five-minute signature window. Convex claims every delivery before any acknowledgment or generation work.

### Outbound idempotency limitation

Convex reserves outbound work with the deterministic key `<turnId>:<stage>`, and the internal Vercel delivery route rejects a mismatched key. This is not provider-level exactly-once delivery. In the pinned `@photon-ai/chat-adapter-imessage@3.2.0` API, `postMessage(threadId, message)` and `openModal(triggerId, modal, contextId?)` expose no send-options argument. Spectrum 10's public `Space.send(content)` path likewise exposes no `clientMessageId`, even though the lower-level `@photon-ai/advanced-imessage@1.0.0` client supports it for text and poll creation.

Do not reach through Spectrum's private `__internal` platform registry to work around this. The current Convex recovery loop retries failed or timed-out sends, so an ambiguous Photon timeout can produce a duplicate provider message. Public launch therefore requires either an adapter/Spectrum release that forwards a stable `clientMessageId`, or a separately reviewed direct-client transport. Until then, treat ambiguous sends as potentially delivered and do not claim end-to-end exactly-once messaging.

## Deployment boundaries

The beta uses a free Photon shared line. Do not upgrade or provision a dedicated public number without separate authorization. COAST returns existing third-party reservation/ticket URLs and processes fixed-price creative top-ups through Stripe Checkout, with optional Link wallet approval after a user chooses it.

## Current cloud state

- Vercel project: `5dee-studios/mayor`, with the stable production URL [mayor-blue.vercel.app](https://mayor-blue.vercel.app).
- Convex project: `gratitud3-eth/mayor`; production deployment `acoustic-mastiff-766` has `snapshot-99f2d46a008bec47efae` active with all 251,679 documents.
- Photon project: `mayor` on the free shared-line tier. The production webhook URL is `https://mayor-blue.vercel.app/api/imessage/webhook`.

The live beta has the required secure provider configuration. Credentials belong only in encrypted Vercel and Convex environment settings; never commit them, print them, include them in terminal arguments, or paste them into chat.

Current implementation includes source-backed cards, calendar attachments, native clarification polls, read states, typing, Find My nearby-search and directions handoff, and durable outbound recovery. Automated refresh scraping, embeddings, public launch, and a dedicated COAST phone line remain separate milestones.
# Draw model options

Draw offers Flare Fast (low quality), Flare Detailed (medium quality), and Z-Image Turbo through Fal. Turbo uses four inference steps, one square image, the safety checker, and strength 0.6 for sketches/imports. It chooses `fal-ai/z-image/turbo/image-to-image` for canvas input and `fal-ai/z-image/turbo` for text alone. All options share the existing image allowance and credit price. Turbo publishes its final image; progressive previews remain a Flare feature.

Reopening a consumed launch link recovers an existing valid session cookie. An expired or missing cookie requires a fresh `/draw` link. Generate displays preparation, prevents duplicate taps, and reports connection failures. Completion enters `ready_for_save`; Save is idempotent, reopens the durable delivery turn, and settles the generation only after Photon confirms the native attachment.
