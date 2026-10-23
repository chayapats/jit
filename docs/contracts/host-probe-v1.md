# Host probe skeleton, v1

> SKELETON — `jit.host.probe/v1` is a behavior boundary, not a live check.
> Schway ENG03/05/06/07/08/09 are OPEN, so no supported inference, renewal or
> transport evidence exists here. Preflight reports `configured-unverified`
> with zero port invocations; live mode is an explicit opt-in shape over
> scripted ports in tests and fails closed on a real machine. This contract
> cannot close FEAS02 (#17) and stays on that issue without a close.

Owner: Jit #17 (FEAS02). Implementation: `src/evidence/probe.ts`,
`src/probe-cli.ts`. Consumes `jit.host.evidence/v1` classifiers
(see [host-evidence-v1](host-evidence-v1.md)) and the
[jit.schway.bridge/v1](schway-bridge-v1.md) skeleton. It makes no Pi, account,
login or reboot claim.

Run from the installation root:

```sh
bun run host:probe preflight --config .local/host-probe-config.json
bun run host:probe live --config .local/host-probe-config.json --route <alias> --model <id> --attempts <1-10> --deadline <1-60000>
bun run host:probe reconcile
bun run host:probe cancel --id <probe-uuid>
bun run host:probe export --id <probe-uuid>
```

The local config carries only an installation label plus candidate routes:

```json
{
  "installationLabel": "development-host",
  "routes": [{ "route": "codex-subscription", "model": "exact-model-id", "configured": true }]
}
```

Preflight requires exactly one configured route with an exact model ID and
performs zero credential/inference invocations. Live mode additionally
requires explicit `--route`, `--model`, `--attempts` (1–10) and `--deadline`
(1–60000 ms) flags on every call; nothing is inferred from config, and no
outer retry exists beyond the stated attempt budget.

## Exact public surface

| Public entry | Behavior |
| --- | --- |
| `PROBE_PROMPT` in `src/evidence/probe.ts` | Fixed non-sensitive live prompt; names no project, credential, path or person. |
| `PROBE_TOOLS` / `PROBE_DISCOVERY` | Empty tool registry; repository and hosted discovery off for every dispatch. Tests assert the dispatched input. |
| `parseLiveOptions(value)` | Strict explicit opt-in; unknown fields, non-alias route/model, attempts outside 1–10 or deadline outside 1–60000 ms fail with no invocation. |
| `parseProbeConfig(raw)` | Bounded local config; unknown keys fail. |
| `validateProbeAttempt(value)` | Rejects malformed, unknown-field and oversized (>8192 bytes) probe records. Four observations exactly once each: `service-start`, `credential-read`, `live-request`, `renewal`, each cross-checked against the `routeEvidence` classifier. |
| `preflightProbe(label, route, model, ports, root, bounds?)` | Persists one terminal `configured-unverified` record; calls no credential/inference port. |
| `liveProbe(label, options, ports, root, signal?)` | Persists the `started` attempt before any inference; counts every admitted request; late completions after cancel/deadline never become success; renewal stays `unobserved`. |
| `reconcileProbeAttempts(root)` | Restart recovery: `started` attempts become `interrupted`. Terminal records are never rewritten. |
| `cancelProbeAttempt(root, id)` / `commitProbeOutcome(root, id, ...)` | Owner stop wins; commit is a compare-and-set that returns false once the lifecycle left `started`. |
| `exportProbeSummary(value)` | Allowlisted projection; route/model become redacted markers, no secrets. |
| `runProbeCommand(args, root, ports?)` in `src/probe-cli.ts` | Returns `{exitCode, output}`. CLI prints that safe JSON only. Honest blocked outcomes exit 0; usage/config/storage failures exit 2. |

## Observation separation

Each record carries four labeled entries that cannot stand in for each other:

- `service-start` / `preflight`: the command ran. Never inference evidence.
- `credential-read` / `preflight`: local boundary readability only
  (`ok` keeps the route `configured-unverified`; `missing`/`locked` map to
  `store-unavailable`/`needs-login`). It never returns secret material and a
  successful read never proves inference.
- `live-request` / `inference`: bounded attempts with the fixed prompt, empty
  tools and strict discovery off. Only a successful selected-route request
  within deadline yields `observed-ready`.
- `renewal` / `renewal`: always `unobserved` in this skeleton. A successful
  login never becomes renewal evidence; renewal needs its own future client.

## Storage

Attempts persist as mode-0600 files under the ignored `.local/host-probe/`
directory (`<uuid>.json`, bounded reads, no overwrite of terminal states,
no symlink traversal). Export is a projection for review before sharing.

## Schway gap table

| Probe need | Schway contract | Status |
| --- | --- | --- |
| Supported inference transport + bounded retry | `schway.host.release/v1`, `schway.host.run-control/v1` | OPEN — chayapats/schway#403, #400 |
| Credential renewal observation | `schway.host.auth-routes/v1` | OPEN — chayapats/schway#398 |
| Native transport/session references | `schway.host.durable-sessions/v1`, `schway.host.base/v1` | OPEN — chayapats/schway#397, #395 |

## Evidence

`tests/probe.test.ts`: preflight zero-invocation, live gating and bounds,
classifier coverage for every outcome, budget honesty, persistence/restart
and late-after-cancel fencing, observation separation, stop/cleanup plus
self resources with secret sentinels absent. `bun test`,
`bun run typecheck`. No network, accounts or Pi.
