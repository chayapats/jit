# OPS release evidence contract, v1

Owner: Jit #34 (OPS04). Contract: `ops.release_evidence/v1`, record schemas `jit.ops.profile/v1` and `jit.ops.release/v1`. Implementation: `src/ops/report.ts`, `src/ops-cli.ts`. It composes the deterministic results a drill actually executed with human gate states; it never fabricates a pass.

| Public entry | Behavior |
| --- | --- |
| `composeProfile({ installationLabel, drill, sampleLimitations, nextAction })` | Builds `jit.ops.profile/v1` from a validated drill record: tested revisions (`versions`, see `ops.load_drill/v1`), config, measurements, the drill's typed `exhaustedLimits` (never derived from leg states) and sample limitations. `piReadiness` is fixed to `not-claimed`. The result passes the exact profile validator; unsafe notes (shared credential detector, paths, addresses) are rejected. |
| `deriveDeterministicRows(drill)` | Derives the rows `J01 J02 J03 J04 J05 crash trust` from the drill's executed legs using `deterministicCoverage` (below). Callers cannot type these states. |
| `composeReleaseChecklist({ installationLabel, drill, human })` | Builds `jit.ops.release/v1`: deterministic rows from `deriveDeterministicRows`, human rows `FEAS OPS` from the owner. The drill record is re-validated; `null` leaves every deterministic row `not-run`. Unknown keys (including a caller-supplied `deterministic` map), unknown IDs, unknown states and secret-like notes throw. |
| `report --id <drill> --checklist <local file>` | Reads the stored drill record, writes one profile record and one checklist record under `.local/ops-evidence`, and prints the tested `revisions` and schema-specific summaries: the drill (versions, config, legs, measurements, exhausted limits), the full profile (versions, config, measurements, exhausted limits, sample limitations, `piReadiness: "not-claimed"` and a fixed `readinessDisclaimer`) and checklist `rows` (`id`, `state`, `evidenceId` only). Profile and release records are deep-validated (exact keys, IDs, timestamps, bounds, row order and invariants, outcome consistent with rows) on compose, write, read and export, and retention applies on every write. The `--checklist` file contains exactly `{ "human": { … } }`. |

## Deterministic coverage

| Row | Drill legs | Not covered by the drill |
| --- | --- | --- |
| J01 | `groups`, `memory-queries` | team dispatch and coordinator synthesis (bun test evidence) |
| J02 | `memory-queries`, `schedules` | task acceptance and memory correction (bun test evidence) |
| J03 | `pr-snapshots`, `pr-alerts` | — (fully drilled) |
| J04 | `deliveries` | Telegram project commands (bun test evidence); no Bot API traffic |
| J05 | `quota-wait`, `cancel` | service restart and reboot reconciliation (OPS05 human evidence) |
| crash | `backup`, `quarantine`, `upgrade-preflight` | crash-at-every-boundary matrices (bun test evidence) |
| trust | `network`, `export` | GitHub-write, shell and forged-command refusals (bun test evidence) |

Derivation: the worst mapped leg wins (`failed` > `blocked` > `not-run`); a leg absent from the record is `not-run`; `scripted` legs count as executed fixtures. If every mapped leg executed but the row has uncovered scope, the row is `blocked` and its note names the scope. Only a fully covered row whose legs all executed is `passed`. Rows that ran link the drill record ID as `evidenceId`; `not-run` rows link nothing. Notes are fixed text plus `leg=state` pairs.

## Human rows

`FEAS` and `OPS` stay `not-run` unless the owner supplies an explicit state plus a sanitized ops-evidence UUID. A human row in any state other than `not-run` without an evidence ID throws instead of auto-completing; a `not-run` row with an evidence ID also throws. They link human Pi/route/service evidence (S01, OPS05) and are never derived from desktop fixture runs.

Checklist outcome: `failed` if any row failed, `blocked` if any row is blocked or not run, `passed` only when every row passed. A fully passing checklist still requires owner review of the linked evidence before any pilot claim; the checklist is a gate record, not an approval.

```json
{
  "human": { "FEAS": { "state": "blocked", "evidenceId": "<uuid>", "note": "service identity inventory recorded" } }
}
```

Deterministic checks: `bun test tests/ops-drill.test.ts`, `bun test`, `bun run typecheck`.
