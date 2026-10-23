# ADR 0021: Bounded diagnostics and fixture load drill

Status: proposed for OPS04 engineering choices (Jit #34). Requirements: FR-10, FR-14, FR-15, FR-18, NFR-04, NFR-05, NFR-06, NFR-07, NFR-09, NFR-10.

## Context

The confirmed decisions are in CONTEXT.md, the MVP spec and ADR 0009. OPS04 must give the owner inspectable operating state and a repeatable load drill without live inference, paid APIs or Pi access. Blocked contract paths (PR03 #24, OPS02 #33, OPS03 #31) are open, so the drill must record honest gates for quarantine and export instead of executing them. TG02 (#21) and JOB03 (#27) are closed and their seams are exercised for real.

## Decisions

The rest of this record lists proposed engineering choices, not product decisions.

1. **Separate `ops` module with evidence-style validation.** `src/ops/` mirrors the FEAS01 host-evidence shape: strict exact-key validation, allowlisted outputs, 32 KiB record bound, mode-0600 records under private `.local/ops-evidence`, no symlink traversal. Reuse `safeAlias` for identifier grammar and `route-N`/`redacted` export redaction.
2. **Strict finite drill configuration.** `parseDrillConfig` requires every workload size with explicit maxima; only the deadline and disk watermark fall back to validated installation `ops` knobs (`JIT_OPS_DISK_WATERMARK_BYTES`, `JIT_OPS_RETENTION_DAYS`, `JIT_OPS_DRILL_DEADLINE_MS`). Missing, non-integer or unbounded values throw instead of defaulting to unlimited.
3. **Pure diagnostics, read-only gather.** `inspectDiagnostics` performs no I/O and emits no telemetry; `gatherDiagnostics` opens the store for reads only and claims no scheduler ownership. Route and model identifiers are validated, then replaced with ordinal references. `main.ts diagnose` exposes this path without queue, timers or server.
4. **Fixture drill with a network-throwing stub.** `runLoadDrill` runs N project groups, scripted PR-snapshot jobs, read-only memory queries, fixture delivery classifications including unknown, explicit-clock reminder schedules and a cooperative cancel probe in disposable state. Global fetch throws for the drill duration, so any network escape fails loudly; the record carries `fetchCalls: 0`. PR legs are marked `scripted`, quarantine `blocked` and export `not-run`, with honesty notes naming the blocking issues.
5. **Profile and checklist never claim Pi readiness.** `composeProfile` fixes `piReadiness` to `not-claimed` and keeps sample limitations visible. `composeReleaseChecklist` requires an explicit sanitized evidence ID for any non-`not-run` human row and throws instead of auto-passing; deterministic J01–J05/crash/trust rows carry caller-attested states.
6. **CLI mirrors evidence-cli.** `ops:drill` offers only `diagnose`, `drill --config` and `report --id --checklist`, exits 0 on honestly blocked outcomes and 2 on invalid invocations, and prints safe JSON only.

## Consequences

- Deterministic tests prove redaction, bounds, cancellation fencing, watermark behavior, unknown-delivery classification, checklist honesty and storage safety without accounts, Pi or network.
- A blocked drill or checklist is a valid result with a fixed next action; it must not be re-run with looser limits to force a pass.
- Target (`arm64`) dependency compatibility, live route readiness and unattended boot remain S01/OPS05 evidence gates owned by human-involved tickets.
