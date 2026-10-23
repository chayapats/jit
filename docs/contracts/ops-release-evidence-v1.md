# OPS release evidence contract, v1

Owner: Jit #34. `ops.release_evidence/v1` is implemented on the `jit/34-load-drill` branch, based on MVP merge `52c1736`. It composes deterministic drill results with human gate states; it never fabricates a human pass.

| Public entry | Behavior |
| --- | --- |
| `composeProfile(input)` in `src/ops/report.ts` | Builds `jit.ops.profile/v1` from a validated drill record: versions, config, measurements, caller-reviewed exhausted limits and sample limitations. `piReadiness` is fixed to `not-claimed`. Secret-like text is rejected. |
| `composeReleaseChecklist(input)` in `src/ops/report.ts` | Builds `jit.ops.release/v1` with deterministic rows `J01 J02 J03 J04 J05 crash trust` and human rows `FEAS OPS`. A human row in any state other than `not-run` requires an explicit sanitized evidence ID; a passing human row without one throws instead of auto-completing. Unknown IDs, unknown states and secret-like notes throw. |
| `report --id <drill> --checklist <local file>` | Reads the stored drill record, writes one profile record and one checklist record under `.local/ops-evidence`, and prints both allowlisted summaries. `--checklist` files contain exactly `{deterministic,human}` row maps. |

Checklist outcome: `failed` if any row failed, `blocked` if any row is blocked or not run, `passed` only when every row passed. A fully passing checklist still requires owner review of the linked evidence before any pilot claim; the checklist is a gate record, not an approval.

The checklist input file shape:

```json
{
  "deterministic": { "J01": { "state": "passed", "evidenceId": "<uuid>", "note": "job admission evidence" } },
  "human": { "FEAS": { "state": "blocked", "evidenceId": "<uuid>", "note": "service identity inventory recorded" } }
}
```

Omitted rows stay `not-run` with a fixed disclosure note. `evidenceId` values must be sanitized ops-evidence UUIDs; rows never carry tokens, addresses or raw diagnostics.

Deterministic checks: `bun test tests/ops-drill.test.ts`, `bun test`, `bun run typecheck`.
