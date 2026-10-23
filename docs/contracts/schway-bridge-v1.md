# Schway bridge skeleton, v1

> SKELETON — `jit.schway.bridge/v1` is a behavior boundary, not a working
> adapter. Schway ENG03/05/06/07/08/09 are OPEN, so no pinned
> `schway.host.release/v1` artifact exists in the integration base and this
> contract cannot close JBR01 (#15). The implementation
> (`src/team/schway-port.ts`) validates at the application seam and then
> fails closed. It stays on issue #15 without a close.

Owner: Jit #15 (JBR01). Implementation: `src/team/schway-port.ts` — `SchwayRunPort`
implements `ApplicationRunPort` (`app.run_port/v1`, see [run-port-v1](run-port-v1.md)).
It imports nothing from Schway, spawns no process, performs no fetch and reads
no environment. Eligibility for real dispatch requires the tested artifact in
the integration base; this skeleton records that the gate is closed.

## Exact public surface

```ts
SCHWAY_RELEASE_CONTRACT: "schway.host.release/v1";
SCHWAY_SNAPSHOT_CONTRACT: "schway.host.session-snapshot/v1";
SCHWAY_NEXT_ACTION: "pin_supported_schway_host_release";
SCHWAY_SNAPSHOT_NEXT_ACTION: "await_supported_schway_snapshot_api";

classifyBridgeOutcome(reason: RunReason | "unknown"): ApplicationRunOutcome;

class SchwayRunPort implements ApplicationRunPort {
  constructor(store: TransactionStore, policy: TeamPolicy, outputBytes: number);
  status(): { available: false; contract: "schway.host.release/v1"; release: null; nextAction: "pin_supported_schway_host_release" };
  readonly requests: readonly ApplicationRunRequest[];
  invoke(request, signal, observe): Promise<ApplicationRunOutcome>;
  inspectRuns(after?: number): Promise<{ items: []; nextAfter: null }>;
  retire(context): Promise<ManagedContextOutcome>;
  delete(context): Promise<ManagedContextOutcome>;
  snapshot(context): Promise<{ supported: false; contract: "schway.host.session-snapshot/v1"; nextAction: "await_supported_schway_snapshot_api" }>;
}
```

## Behavior

- Pre-admission validation runs first through the existing `validateRunRequest`:
  unbounded, permissive or malformed requests throw before any observation or
  request logging, exactly as the scripted port rejects them.
- Valid requests check the application context fence (`team_contexts`) and the
  abort signal, then fail closed with `blocked` / `route_unavailable`,
  `mode: "fixture"`, zeroed usage and no session. Progress text names the
  missing `schway.host.release/v1` artifact. No fallback route, billing change
  or native dispatch is possible.
- Fencing rechecks after the gate: a concurrent retirement yields
  `context_retired`, a concurrent abort yields `cancelled`. Late results can
  never become success evidence because no result is ever produced.
- `retire` persists the application fence first (mirroring the scripted port),
  then reports `retire_failed` + `retry_managed_retire`. `delete` retires first,
  then reports `delete_failed` + `retry_managed_delete`. Unknown references
  throw `context_not_found`; malformed references throw
  `invalid_context_reference`. No native bytes are edited.
- `inspectRuns` validates the cursor and returns an empty page: no native run
  references exist without a pinned host artifact.
- `snapshot` is not on `ApplicationRunPort`; it returns an explicit
  unsupported diagnostic naming `schway.host.session-snapshot/v1` instead of
  native bytes.
- `status()` reports the closed gate for inspection surfaces; it never probes
  credentials or infers readiness.
- `classifyBridgeOutcome` documents the future blocked/waiting mapping for a
  pinned artifact; only `route_unavailable` is reachable now, and unknown
  future events normalize to `invalid_result`.

## Schway gap table

| Required host capability | Schway contract | Status |
| --- | --- | --- |
| Pinned public host release/version | `schway.host.release/v1` | OPEN — chayapats/schway#403 (ENG09) |
| Base host lifecycle | `schway.host.base/v1` | OPEN — chayapats/schway#395 |
| Context policy | `schway.host.context-policy/v1` | OPEN — chayapats/schway#396 |
| Tool policy | `schway.host.tool-policy/v1` | OPEN — chayapats/schway#399 |
| Durable sessions | `schway.host.durable-sessions/v1` | OPEN — chayapats/schway#397 |
| Auth routes | `schway.host.auth-routes/v1` | OPEN — chayapats/schway#398 |
| Run control (cancel/deadline) | `schway.host.run-control/v1` | OPEN — chayapats/schway#400 |
| Managed session data (retire/delete) | `schway.host.managed-session-data/v1` | OPEN — chayapats/schway#401 |
| Session snapshot | `schway.host.session-snapshot/v1` | OPEN — chayapats/schway#402 |

## Evidence

`tests/schway-bridge.test.ts`: artifact gate, pre-admission validation,
independent ancestry, strict tool policy, outcome mapping, cancel/generation
fencing including the crash/reopen matrix, retire/delete mapping, a
scripted-port swap scenario, and import-hygiene (no Schway/SDK/IO imports).
`bun test`, `bun run typecheck`. No network, accounts or Pi.
