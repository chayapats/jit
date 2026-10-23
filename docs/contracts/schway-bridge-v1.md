# Schway bridge, v1 (concrete)

Owner: Jit #15 (JBR01). Implementation: `src/team/schway-port.ts` — `SchwayRunPort`
implements `ApplicationRunPort` (`app.run_port/v1`, see [run-port-v1](run-port-v1.md))
on the pinned supported Schway public host artifact. It imports only the
`schway/host` entry point, never deep `schway/src` paths, provider SDKs,
the TUI, or ambient processes. Eligibility for real dispatch is the tested
artifact in the integration base plus a passing startup gate; anything else
fails closed before any native session exists.

Pinned artifact (verified, deterministic):

- npm `schway@1.0.0-rc.2`, git revision
  `6fe38083ded9fb8015ac97ed2aab4e9187179836` (Schway main, ENG09 merged).
- Vendored tarball `vendor/schway-1.0.0-rc.2-6fe3808.tgz`,
  SHA-256 `4579a059dc2ee844cf4a78b87874800a012dd3c5edfdcde6d52566bbf415d8a5`.
- Behavior set `schway.host.release/v1` (composes `base`, `context-policy`,
  `tool-policy`, `durable-sessions`, `auth-routes`, `run-control`,
  `managed-session-data`, `session-snapshot`).
- Upgrade path: replace the vendored tarball with `schway@^1.0.0-rc.3` once
  published under repository authorization; the runtime `releaseContract`
  gate rejects any other behavior set.

## Exact public surface

```ts
SCHWAY_RELEASE_CONTRACT: "schway.host.release/v1";
SCHWAY_SNAPSHOT_CONTRACT: "schway.host.session-snapshot/v1";
SCHWAY_PINNED_REVISION: "6fe3808...";
SCHWAY_PINNED_VERSION: "1.0.0-rc.2";
SCHWAY_PINNED_TARBALL_SHA256: "4579a059...";
SCHWAY_NEXT_ACTION: "pin_supported_schway_host_release";
SCHWAY_SNAPSHOT_NEXT_ACTION: "await_supported_schway_snapshot_api";
SCHWAY_SYSTEM_PROMPT: string;

describeEffectiveRun(request: ApplicationRunRequest): EffectiveSchwayRun;
classifyBridgeReason(reason: RunReason | "unknown"): ApplicationRunOutcome;
mapAuthStatus(status: HostAuthStatusCode): RunReason;
schwayHostDirs(storePath: string): { workspaceRoot; homeDirectory; sessionDirectory };
verifySchwayBridge(store: TransactionStore): Promise<{ ok: true; detail } | { ok: false; detail; nextAction }>;

class SchwayRunPort implements ApplicationRunPort {
  readonly adapter: "schway";
  constructor(store: TransactionStore, policy: TeamPolicy, outputBytes: number, options?: SchwayPortOptions);
  status(): { available: true; contract; release: { version; revision; tarballSha256 }; nextAction: "none" };
  readonly requests: readonly ApplicationRunRequest[];
  invoke(request, signal, observe): Promise<ApplicationRunOutcome>;
  inspectRuns(after?: number): Promise<{ items: NativeRunInspection[]; nextAfter: number | null }>;
  retire(context): Promise<ManagedContextOutcome>;
  delete(context): Promise<ManagedContextOutcome>;
  snapshot(context): Promise<SchwaySnapshotResult>;
  openLifecycleHost(): Promise<HostRuntime>;
}
```

`SchwayPortOptions` carries test seams only (`model`, `authFetch`, `authStore`,
`now`). Production sets none: route runs use the default OS credential store
and fixture-free protocol transport.

## Behavior

- Pre-admission validation runs first through the existing `validateRunRequest`:
  unbounded, permissive or malformed requests throw before any observation,
  request logging, directory creation or host contact, exactly as the scripted
  port rejects them. Oversized fixed evidence beyond host bounds throws
  `invalid_run_request` instead of silent truncation.
- Every dispatch verifies `hostCapabilities().releaseContract` and the
  runtime's own capabilities against `schway.host.release/v1`. A mismatch
  throws before any native session exists; serve refuses to start in
  `schway` mode when `verifySchwayBridge` reports a blocked gate.
- Service-owned host directories (`<store-dir>/.jit-host/{workspace,home,sessions}`,
  mode 0700, symlink/permission-checked) keep native state out of developer
  checkouts and unrelated owner secrets. No developer cwd, TUI, global installs
  or environment credentials are read.
- One native Schway session backs one application run. The durable
  `schway_native_refs` table (schema 21) correlates each run with its opaque
  native session id/branch; the session id never leaves the store and native
  bytes are never parsed or rewritten.
- Strict context mapping: fixed trusted system prompt plus responsibility,
  purpose and operator sections; manifest sources/claims become untrusted
  source documents with bounded ids. Exact empty tool registry, hosted lookup
  off. Finite limits map from the request budgets (turns, concurrency 1,
  context/input windows, deadline, attempts).
- Route runs use `submitWithRoute` on the exact selected Grok/Codex
  route/model with the shared route-scoped credential lifecycle. Jit supplies
  no credential client, renewal loop, billing fallback or model retry of its
  own. Fixture model runs (tests) use `submit` with a scripted model and no
  auth binding.
- Auth outcomes map to waiting/failed states without changing provider, model
  or billing: `needs-login` → `needs_login`, `quota-exceeded` → `quota`,
  `model-unavailable` → `unknown_model`, store/rejected/integration failures →
  `route_unavailable`. Control outcomes map to `cancelled`/`max_rounds`/
  `budget_exceeded`; empty output never becomes committed evidence.
- Cancellation/deadline and Jit's attempt/deletion generations prevent late
  publication: fencing rechecks after the native settle, and late results
  become `context_retired`/`cancelled` instead of success. Attempt ledgers
  record `adapter: "schway"` so JOB02 reconciliation matches durable native
  refs across restart; interrupted rows stay `running` for explicit reconcile.
- `retire` fences the application generation first, then retires owned native
  sessions through `retireSession` (idempotent; only live-holder conflicts
  retry). `delete` retires first, then removes owned native artifacts through
  `deleteSession`, converging to `deleted` only when the native call
  acknowledges; partial/blocked stays `delete_failed` with retry.
- `snapshot` captures a quiesced per-context snapshot through
  `snapshotSessions`. Empty backing resolves to the explicit unsupported
  diagnostic; backup integration stays a later slice.
- `status()` reports the pinned release for inspection surfaces; it never
  probes credentials or infers readiness. Serve wiring (`JIT_RUN_PORT`,
  default `scripted`) selects the concrete port; memory extraction stays
  scripted.

## Evidence

`tests/schway-bridge.test.ts`: pinned gate, tarball SHA, effective-run
mapping, hostile-input neutrality, empty-output rejection, auth mapping over
fixture stores/transports (needs_login/quota/route_unavailable, no fallback,
no secret leakage), cancel/generation fencing across reopen, native
retire/delete/snapshot through the real host, cursor pagination, shared
normalizer round-trip, startup gate, seam import hygiene, and a full
application preview scenario that commits production evidence, reopens after
restart, and keeps reads working while provider access is blocked.
`bun test`, `bun run typecheck`. No live accounts, no network, no Pi.
