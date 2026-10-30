# Jit MVP Definition

Current target: [S14](../specs/S14-bot-first-local-assistant.md), confirmed 2026-10-30. The existing S09–S13 runtime is a historical implemented baseline; this scope is not yet shipped.

## First useful outcome

An authenticated owner asks Jit for research without creating a Project. Enabled Bots work independently and concurrently within finite grants, use free-first Parallel search/fetch and deliver an immutable report with citations and downloadable artifacts. The owner can inspect, stop, share, correct memory and return after restart.

## Required in phase A

Persistent Bots and proposal acceptance; owner/global and Bot-private sourced memory; isolated persistent local computers with input leases/takeover; exact external-action approvals; explicit snapshot sharing; bounded concurrent work; honest quota/partial evidence; replay-safe recovery; owner-authorized routines and quiet/grouped delivery; Linux x64/arm64 operation with opt-in evidence.

Fresh store/domain/schema is allowed. No legacy-data conversion or deletion is implied. Reuse existing receipt/fencing/outbox/sanitization/lifecycle algorithms where appropriate.

## Required later phases

B: authorized repository work inside the Bot boundary, actual edit/test evidence and a reviewable diff, with approved exact push/PR actions and unknown-effect reconciliation.

C: owner-scoped email/calendar read/triage/briefs, drafts and exact approved sends/changes, routines, timezone and revocation handling.

B/C are required roadmap outcomes, not optional exclusions.

## Outside this MVP

Multi-user tenancy, native host-desktop runner, cloud computer dependency, automatic creation of permanent Bots, unrestricted autonomous scope expansion, automatic paid/provider/model fallback, auto-merge, voice/image generation and a marketplace. SearXNG fallback and Parallel deep-research products are not silently enabled.

## Release gates

1. S14-AC01–AC14 pass deterministic product/authority/lineage/partial/recovery fixtures.
2. Actual multi-Bot overlap and independent contexts are demonstrated. The supported Schway credential-lifecycle prerequisite is pinned and passes packed-consumer conformance.
3. Crash-created native orphans are discoverable/reconcilable using supported #414 behavior before automatic resume is advertised.
4. Bot/profile/private-memory and egress/effect boundaries hold across shell/browser/MCP, with no credential/state/control-socket leakage.
5. Reports bind actual evidence, disclose gaps and provide checked artifact snapshots.
6. Supported Linux profiles record limits and persistence/reboot/selected-route evidence separately from fixtures.
7. A small owner-approved live research corpus records actual source coverage/failures before making quality claims about Parallel.
8. Opus-authored UI/UX is reviewable in Thai/English, dark/light and responsive states. Unverified device/screen-reader/takeover behavior remains explicit.

No model done text, queued jobs, transcript on disk, configured token or fixture success substitutes for these gates.
