---
status: accepted
scope: BOT14-01/AUTH14-01 implementation delivery; S14-D01/D04/D05/D12/D16
---

# Opt-in S14 foundation beside the legacy runtime

Owner orchestration explicitly chooses strangler delivery on 2026-10-30. The shippable legacy composition root remains the default until a separate final cutover. `--s14` selects `src/s14/main.ts`, a distinct SQLite application_id/schema and default store path. No runtime legacy Project API, engine shim or hidden permission alias is reused. Existing receipt, opaque-actor, fencing, outbox and credential-sanitization algorithms inform the implementation; shared credential redaction is reused directly. Schway integration imports only `schway/host` at the existing pinned artifact.

Confirmed authority is typed authenticated owner commands. `message.post` is conversational intake; exact proposal acceptance creates a permanent Bot; later `task.accept` retains obligations and `work.start` atomically records bounded execution authority. JSON and plain forms call one boundary. An injectable renderer leaves product UI/UX to the designated Claude Opus agent. No style/layout is authored in the logic slice.

New store versions are explicitly refused rather than implicitly migrated. Legacy detection uses a fixed filesystem-read SQLite header before every writable open and before runtime locks/hosts/workers. Legacy database/profile/backup/native state stays on its old path/build. The foundation root is loopback-only; exposure through the production service, full backup/upgrade, Bot lifecycle and replay-safe native recovery remain their tracked slices.

ADR 0045 remains proposed: this foundation implements identity/fresh refusal but does not yet implement all source/memory/share/lifecycle/restore behavior required by that ADR. ADR 0048 likewise awaits bounded graph scheduling and supported native discovery. This ADR records the delivery choice without claiming those later contracts shipped.
