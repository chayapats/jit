# ADR 0021: Bounded diagnostics and fixture load drill

Status: proposed for OPS04 engineering choices (Jit #34). Requirements: FR-10, FR-14, FR-15, FR-18, NFR-04, NFR-05, NFR-06, NFR-07, NFR-09, NFR-10.

## Context

The confirmed decisions are in CONTEXT.md, the MVP spec and ADR 0009. OPS04 must give the owner inspectable operating state and a repeatable load drill without live inference, paid APIs or Pi access. PR03 (#24), OPS03 (#31), OPS06 (#32), OPS01 (#18), TG02 (#21) and JOB03 (#27) are in the integration base and their paths are exercised for real with scripted adapters. OPS02 (#33) is not, so the restore leg is a seam with an honest gate.

## Decisions

The rest of this record lists proposed engineering choices, not product decisions.

1. **Separate `ops` module with evidence-style validation.** `src/ops/` mirrors the FEAS01 host-evidence shape: strict exact-key validation, allowlisted outputs, 32 KiB record bound, mode-0600 records under private `.local/ops-evidence`, no symlink traversal. Reuse `safeAlias` for identifier grammar and `route-N`/`redacted` export redaction.
2. **Strict finite drill configuration.** `parseDrillConfig` requires every workload size with explicit maxima; only the deadline and disk watermark fall back to validated installation `ops` knobs (`JIT_OPS_DISK_WATERMARK_BYTES`, `JIT_OPS_RETENTION_DAYS`, `JIT_OPS_DRILL_DEADLINE_MS`). Missing, non-integer or unbounded values throw instead of defaulting to unlimited.
3. **Pure diagnostics, read-only gather.** `inspectDiagnostics` performs no I/O and emits no telemetry; `gatherDiagnostics` opens the store for reads only, claims no scheduler ownership and never probes the engine or a provider. Route and model identifiers are validated, then replaced with ordinal references. Engine state is the declared release contract plus host-directory safety (`lstat` only); provider readiness reuses the host-evidence vocabulary and stays `configured-unverified` because diagnose never collects live evidence. Upgrade fence/journal, restore quarantine, schema, quota/login/authority waits and Telegram binding are reported with a priority-ordered `nextActions` list. `main.ts diagnose` exposes this path without queue, timers or server.
4. **Fixture drill over the real paths with a network-throwing stub.** `runLoadDrill` drives the Application boundary in disposable state: groups, the static PR path (in-memory GitHub fixture → `pr.snapshot` → `pr.review` with a scripted run port → alert admission), memory queries, delivery classifications including unknown, explicit-clock schedules, a quota wait, a cooperative cancel, a sanitized `export.create`, `backup.create` with integrity re-verification against a fixture engine, a read-only upgrade preflight, a restore seam, a network check and the disk watermark. Every leg state is derived from what executed; engine-dependent legs driven by the fixture engine read `scripted`. Without an OPS02 restore port the quarantine leg is `blocked: pending OPS02 (#33)`. Global fetch throws for the drill duration; the record carries `fetchCalls`. Records carry tested revisions (app, Bun, schema, git commit, bounded source content hash, engine contracts).
5. **Profile and checklist never claim Pi readiness.** `composeProfile` fixes `piReadiness` to `not-claimed` and keeps sample limitations visible. `composeReleaseChecklist` derives the deterministic J01–J05/crash/trust rows from the drill's executed legs through a fixed coverage map; a partially drilled row stays `blocked` with the uncovered scope named, so a desktop drill alone cannot pass a journey it did not exercise. Human FEAS/OPS rows require an explicit sanitized evidence ID for any non-`not-run` state and throw instead of auto-passing.
6. **CLI mirrors evidence-cli.** `ops:drill` offers only `diagnose`, `drill --config` and `report --id --checklist`, exits 0 on honestly blocked outcomes and 2 on invalid invocations, and prints safe JSON only.

## Consequences

- Deterministic tests prove redaction, bounds, cancellation fencing, watermark behavior, unknown-delivery classification, checklist honesty and storage safety without accounts, Pi or network.
- A blocked drill or checklist is a valid result with a fixed next action; it must not be re-run with looser limits to force a pass.
- Target (`arm64`) dependency compatibility, live route readiness and unattended boot remain S01/OPS05 evidence gates owned by human-involved tickets.
