# COAST Soul implementation

`SOUL.md` is the source of truth for COAST’s shared identity and Bay Area dictionary. A deterministic generator produces `src/lib/coast/soul.generated.ts`; run `pnpm soul:generate` after editing the Markdown and `pnpm soul:check` in CI. Runtime code never reads the Markdown from disk.

`src/lib/coast/persona.ts` composes the generated soul with channel-specific guidance and the existing source-grounded retrieval, privacy, provenance, and structured-output rules. iMessage remains the integrated channel; voice and livestream receive typed prompt compositions for future agents without adding transports in this increment.

Application-owned greetings and deterministic event, artist, discovery, and check-in copy use the same voice deliberately. Commands, payments, privacy, errors, and uncertainty stay literal. No soul text enters creative prompts, billing records, preferences, or operational payloads.

Validation includes generated-source freshness, complete dictionary coverage, channel composition boundaries, first-turn and deterministic-copy regressions, ordinary concierge routing, and `pnpm check`. A separate 12-scenario Luna evaluation covers casual discovery, regional pride, uncertainty, unfamiliar users, money language, and sensitive support before broader channel rollout.
