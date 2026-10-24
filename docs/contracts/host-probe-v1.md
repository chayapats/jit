# Host probe, v1 (concrete)

Owner: Jit #17 (FEAS02). Implementation: `src/evidence/bridge-probe.ts`
(builds `ProbePorts` over the concrete Schway bridge), `src/evidence/probe.ts`
(persistence, fencing, restart reconciliation, sanitized export) and
`src/probe-cli.ts` (operator command boundary). Consumes
`jit.host.evidence/v1` classifiers (see [host-evidence-v1](host-evidence-v1.md))
and the concrete `jit.schway.bridge/v1` (see [schway-bridge-v1](schway-bridge-v1.md)).
It makes no Pi, account, login or reboot claim; live proof belongs to
FEAS04/05 and the pilot to OPS05.

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
| `liveProbe(label, options, ports, root, signal?)` | Persists the `started` attempt before any inference; the public orchestration composes the caller signal with an internally owned deadline so a blocked store fails closed at the bound. Every admission is durably reserved (persisted count rechecked `started` inside the transaction) before provider contact, so cancel serializes against new requests and restarts preserve admitted counts. Every transport send passes a shared before-send gate that rechecks `started`, records the intent and invokes the transport synchronously inside the same cross-process serialization (plus the shared in-process lock, released before awaiting) — fenced or over-budget sends are refused, never transmitted; completed sends are confirmed, and crash-window entries stay explicitly unconfirmed. A response is returned to the transport only after confirmation commits, so a terminal record never upgrades to confirmed. Credential-store mutations recheck dispatch first and fail closed when unreadable — on explicitly provided stores. The default production path uses Schway's internal native store, which the supported host surface does not expose for wrapping: a late token response there can still be processed into a credential write after cancellation. That residual is Schway-owned (tracked by schway#416); Jit never claims fenced production writes, and no probe evidence depends on it — terminal lifecycles and the send ledger are fenced regardless. Late completions after cancel/deadline never become success; exact per-admission send counts persist in the renewal ledger and surface in the self sample. Terminal writers preserve durable attempts and ledgers, accepting only caller-owned event fields. |
| `reconcileProbeAttempts(root)` | Restart recovery: every started attempt becomes `interrupted` up to an explicit file cap with a fail-closed error beyond it; unreadable records are reported, never silently skipped. Terminal records are never rewritten. |
| `cancelProbeAttempt(root, id)` / `commitProbeOutcome(root, id, ...)` | Owner stop wins; every terminal transition runs inside one SQLite `BEGIN IMMEDIATE` transaction that re-reads the record and writes only `started` rows, so exactly one claimant terminalizes each attempt across processes and losers report the settled record byte-for-byte unchanged. Terminal writes are atomic (exclusive temp file, fsync, synchronous rename, required directory fsync) with the abort recheck immediately before the rename. A deadline/cancel that fires during the owning invocation's own terminal write rewrites its live-request observation to non-success in the same transaction rather than leaving aborted success behind. Terminal writers preserve durable attempts and renewal ledgers; only caller-owned terminal events are accepted. |
| `exportProbeSummary(value)` | Allowlisted projection; route/model become redacted markers, no secrets. |
| `bridgeProbePorts(options)` in `src/evidence/bridge-probe.ts` | Builds live-boundary ports on the pinned `schway/host` release: local `checkAuthReadiness` for the credential boundary, one bounded route-bound request per `infer` with the fixed prompt, empty tools and strict context. Non-Grok/Codex routes and models outside the host grammar fail before any host contact. |
| `probeHostDirs(root)` | Service-owned `.local/host-probe-host/` directories (mode 0700, symlink/permission-checked); never a developer checkout or home. |
| `runProbeCommand(args, root, ports?)` in `src/probe-cli.ts` | Returns `{exitCode, output}`. CLI prints that safe JSON only. Explicit ports are the test seam; without them, `live` requires an exact `grok`/`codex` route and builds bridge ports, while anything else fails closed. Honest blocked outcomes exit 0; usage/config/storage failures exit 2. |

## Observation separation

Each record carries four labeled entries that cannot stand in for each other:

- `service-start` / `preflight`: the command ran. Never inference evidence.
- `credential-read` / `preflight`: local boundary readability only
  (`ok` keeps the route `configured-unverified`; `missing`/`locked` map to
  `store-unavailable`/`needs-login`). It never returns secret material and a
  successful read never proves inference.
- `live-request` / `inference`: bounded attempts with the fixed prompt, empty
  tools and strict discovery off. Only a successful selected-route request
  within deadline yields `observed-ready`. One admitted attempt issues at most
  two inference sends on the pinned release (a single Schway-owned 401
  refresh plus its replay, structurally bounded with no loop); the counting
  transport fails the attempt closed if the bound is ever exceeded, and the
  exact per-attempt send counts are reported (see renewal). Ports instances
  are single-flight: overlapping infer calls on one instance throw instead
  of swapping counts. Credential-store mutations recheck dispatch first and
  fail closed when unreadable; the default native store (no explicit store
  passed) is Schway-owned and cannot be wrapped from Jit — that residual
  awaits schway#416, and Jit never claims fenced production writes.
- `renewal` / `renewal`: always `unobserved` with zero attempts — never a
  readiness or success claim. The renewal observation carries a validated
  per-send ledger (one `{inference, token, confirmed}` entry per transport
  send, exactly one send per entry, at most four entries per admitted attempt
  on the pinned 2+2 ceiling, empty on preflight), retained through restart
  reconciliation and included in the allowlisted export (with `confirmed`).
  `confirmed:false` marks a send that was authorized but whose completion was
  never observed — uncertainty, not exact evidence. Only renewal carries a
  ledger: any send array on another observation fails validation. A
  successful login never becomes renewal evidence on its own. Full per-request
  accounting awaits schway#415.

## Storage

Attempts persist as mode-0600 files under the ignored `.local/host-probe/`
directory (`<uuid>.json`, bounded reads, no overwrite of terminal states,
no symlink traversal). Every terminal transition additionally serializes
through an installation-local SQLite ledger (`lifecycle.db`, `BEGIN
IMMEDIATE` with a bounded busy timeout) that rejects planted symlinks and
foreign files, so concurrent CLI invocations agree on exactly one winner.
Export is a projection for review before sharing.

## Schway integration

Live inference runs on the pinned supported host (`schway/host@1.0.0-rc.2`,
revision `6fe3808`, `schway.host.release/v1`; see
[schway-bridge-v1](schway-bridge-v1.md)). Each `infer` call opens one runtime
with strict context, an exact empty tool registry, single-turn/single-attempt
bounds and the live deadline, then submits one route-bound request and closes.
The live loop bounds total attempts; no outer retry exists beyond the stated
budget. Provider-send budget per admitted attempt: at most two inference
sends plus two token sends on the pinned release (structurally bounded,
counted per send with confirmation, fail-closed on violation). The exact
per-send counts persist in the renewal observation ledger (confirmed entries
only) and surface in the self sample;
a successful login alone never becomes renewal evidence.

## Evidence

`tests/probe.test.ts`: preflight zero-invocation, live gating and bounds,
classifier coverage for every outcome, budget honesty, persistence/restart
and late-after-cancel fencing, observation separation, stop/cleanup plus
self resources with secret sentinels absent. `tests/probe-bridge.test.ts`:
concrete bridge over the pinned release — observed-ready only for a
successful selected-route request with measured tokens, local credential
boundary mapping (no secrets, no network), every classifier state with the
route unchanged, single-attempt admission accounting, grammar/alias gating,
symlinked-host rejection, self resource bounds, and CLI wiring that fails
closed for unselected routes. `bun test`, `bun run typecheck`. No network,
accounts or Pi.
