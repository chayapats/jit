# OPS load drill contract, v1

Owner: Jit #34. `ops.load_drill/v1` is implemented on the `jit/34-load-drill` branch, based on MVP merge `52c1736`. Downstream eligibility requires this reviewed artifact in the integration base. It makes no Pi, capacity or readiness claim.

Run from the installation root:

```sh
bun run ops:drill diagnose
bun run ops:drill drill --config .local/ops-drill.json [--label drill-fixture]
bun run ops:drill report --id <drill-uuid> --checklist .local/release-checklist.json
```

The drill config has exactly these fields (only `diskWatermarkBytes` and `deadlineMs` fall back to installation `ops` knobs; workload sizes are always required):

```json
{
  "groups": 2,
  "prSnapshots": 3,
  "memoryQueries": 4,
  "deliveries": 4,
  "schedules": 1,
  "diskWatermarkBytes": 16777216,
  "deadlineMs": 60000
}
```

Bounds: `groups` 1–8, `prSnapshots` 1–64, `memoryQueries` 1–256, `deliveries` 1–32, `schedules` 0–16, `diskWatermarkBytes` 4096–1073741824, `deadlineMs` 1000–300000. Missing, non-integer or unbounded values fail preflight with `invalid_drill_config`; there are no unlimited defaults.

| Public entry | Behavior |
| --- | --- |
| `parseDrillConfig(raw, fallback)` in `src/ops/config.ts` | Strict finite workload config. Unknown keys fail. Installation fallbacks are validated too. |
| `inspectDiagnostics(input)` in `src/ops/diagnostics.ts` | Pure read-only snapshot: queue/admission, per-route lifecycle with redacted `route-N` references, budget/deadline exhaustion counts, managed-state bytes vs watermark, Telegram configured/unconfigured, evidence references. No I/O, no telemetry. |
| `gatherDiagnostics(root, config, now?)` in `src/ops/diagnostics.ts` | Read-only store reads only: no scheduler claim, no pump, no timers, no secrets in output. |
| `runLoadDrill(config, ports?)` in `src/ops/drill.ts` | Bounded fixture workload in disposable state: N project groups, scripted PR-snapshot jobs, read-only memory queries, fixture delivery classifications (sent/unknown/failed), explicit-clock reminder schedules, cooperative cancel, disk-watermark check. Global fetch is stubbed to throw, so any network escape fails loudly. Quarantine and export are recorded gates (`blocked`/`not-run`), never executed. |
| `writeOpsRecord` / `readOpsRecord` in `src/ops/records.ts` | Private `.local/ops-evidence/<id>.json`, exclusive mode-0600 creation, file/directory sync, bounded reads, no overwrite or symlink traversal. Records over 32768 bytes are rejected. |
| `runOpsCommand(args, root, ports?)` in `src/ops-cli.ts` | Returns `{exitCode,output}`. Prints safe JSON only. Invalid/config/storage failures exit 2 with fixed codes. Stored records exit 0 even when the honest outcome is `blocked`. |

`bun run main.ts diagnose` (see `src/main.ts`) prints the same read-only snapshot for a live installation without starting background work.

Drill records carry `versions` (app, Bun, schema `user_version`), the exact config, per-leg states (`passed`/`failed`/`blocked`/`not-run`/`scripted`), measurements (peak RSS, state growth, queue wait, stop ack, delivery outcome counts, fetch calls) and `fixtureHonesty` notes naming the unavailable contract paths (#24/#33/#31). A non-fixture desktop timing is never a latency SLO and never Pi evidence.

Deterministic checks: `bun test tests/ops-drill.test.ts`, `bun test`, `bun run typecheck`. Tests cover redaction, finite-config rejection, the bounded fixture drill, failure fixtures (watermark breach, cancel fencing, unknown delivery), checklist honesty, symlink/oversize/sentinel negatives and the standalone CLI.
