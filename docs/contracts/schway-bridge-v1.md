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
  `6532e76565fec3c10422c4a3bfa88136da269f2b` (Schway main, #416+#418+#420+#424+#426+#430+#437+#438 merged; adds schway.host.core-tools/v1 and composes schway.host.release/v2, plus the additive capabilities schway.host.web-tools/v1 (#433/#434) and schway.host.device-sign-in/v1 (#435)).
- Vendored tarball `vendor/schway-1.0.0-rc.2-6532e76.tgz`,
  SHA-256 `2862be51d5410c401c30f98e82e98276ca9ce3b73ccfc2b13975675858d961d3`.
- Behavior set `schway.host.release/v2` (composes `base`, `context-policy`,
  `tool-policy`, `durable-sessions`, `auth-routes`, `run-control`,
  `managed-session-data`, `session-snapshot` and `core-tools`). `release/v2` is
  `release/v1` plus `schway.host.core-tools/v1`; every `release/v1` behavior is
  unchanged. EXE03 (#127) re-pinned to this artifact for
  `coreToolDefinitions` over a host `ExecutionBackend`.
- Upgrade path: replace the vendored tarball with `schway@^1.0.0-rc.3` once
  published under repository authorization; the runtime `releaseContract`
  gate rejects any other behavior set.

## Exact public surface

```ts
SCHWAY_RELEASE_CONTRACT: "schway.host.release/v2";
SCHWAY_SNAPSHOT_CONTRACT: "schway.host.session-snapshot/v1";
SCHWAY_PINNED_REVISION: "6532e76...";
SCHWAY_PINNED_VERSION: "1.0.0-rc.2";
SCHWAY_PINNED_TARBALL_SHA256: "2862be51...";
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
  runtime's own capabilities against `schway.host.release/v2`. A mismatch
  throws before any native session exists; serve refuses to start in
  `schway` mode when `verifySchwayBridge` reports a blocked gate.
- Service-owned host directories (`<store-dir>/.jit-host/{workspace,home,sessions}`,
  mode 0700, symlink/permission-checked) keep native state out of developer
  checkouts and unrelated owner secrets. No developer cwd, TUI, global installs
  or environment credentials are read.
- One native Schway session backs one application run. The durable
  `schway_native_refs` table (schema 21) correlates each run with its opaque
  native session id/branch; the session id never leaves the store and native
  bytes are never parsed or rewritten. The intent row is reserved before
  native creation, so a crash in that window still leaves a fenced,
  discoverable row (unaddressable lifecycle stays explicitly retryable);
  full atomicity awaits the Schway correlation/enumeration contract
  (chayapats/schway#414). Attempt ledgers record `adapter: "schway"` so
  JOB02 reconciliation matches durable native refs across restart;
  interrupted rows stay `running` for explicit reconcile. Only fenced-active,
  live-signal progress is stored provisionally and it is cleared at commit;
  revoked participations clear retained progress and project null;
  transient progress never becomes committed evidence.
- Strict context mapping: fixed trusted system prompt plus responsibility,
  purpose and operator sections (mode-neutral wording: nothing tells the
  model it is scripted or live); manifest sources/claims become untrusted
  source documents with bounded ids, unique per project and kind before any
  observation or logging. Exact empty tool registry, hosted lookup
  off. Finite limits map from the request budgets (context/input windows,
  deadline, attempts); the bridge executes bounded single-turn runs
  (`maxTurns: 1`), so anything needing more turns surfaces as `max_turns`
  instead of silently spending unreserved calls. Schway mode pins route
  concurrency to one until a process-stable public credential-store handle
  exists, keeping the shared renewal lifecycle single-flight. Committed
  coordinator summaries label the actual evidence mode.
- Route runs use `submitWithRoute` on the exact selected Grok/Codex
  route/model with the shared route-scoped credential lifecycle. Jit supplies
  no credential client, renewal loop, billing fallback or model retry of its
  own. The owner credential alias (`authRoute`) is
  preserved end to end in the effective configuration, request history and
  committed evidence; the pinned host resolves one subscription identity per
  provider, so two aliases on one provider share that identity without any
  silent provider, model, billing or credential switch. Per-alias credential
  binding is proposed to Schway (see ADR 0023); until that contract exists
  the limitation is explicit and auditable rather than hidden. Fixture model
  runs (tests) use `submit` with a scripted model and no auth binding.
- Auth outcomes map to waiting/failed states without changing provider, model
  or billing: `needs-login` → `needs_login`, `quota-exceeded` → `quota`,
  `model-unavailable` → `unknown_model`, store/rejected/integration failures →
  `route_unavailable`. Control outcomes map to `cancelled`/`max_rounds`/
  `budget_exceeded`; empty output never becomes committed evidence.
  Production adapter exceptions normalize to a production `invalid_result`
  that never claims fixture evidence or an unchecked live route.
- Cancellation/deadline and Jit's attempt/deletion generations prevent late
  publication: fencing rechecks before admission, after host construction
  (before any intent is reserved, with no await in between), after native
  creation, and after the native settle; late results become
  `context_retired`/`cancelled` instead of success. A fence that closes
  between session creation and dispatch retires the orphan natively instead
  of running it; only a verified native retirement closes the row, otherwise
  the running intent stays visible for explicit reconciliation. Attempt
  ledgers record `adapter: "schway"` so JOB02 reconciliation matches durable
  native refs across restart; interrupted rows stay `running` for explicit
  reconcile. Only fenced-active, live-signal progress is stored provisionally
  and it is cleared at commit; revoked participations clear retained progress
  and project null; transient progress never becomes committed evidence.
- Worst-case retry admissions are pre-reserved (`calls`/`rounds` for
  `maxAttempts = retries + 1`); retry budgets above the pinned host ceiling
  of ten attempts fail before any native work instead of being silently
  capped. Because admission spends one call and one round and the attempt
  pre-reserves the rest, `team.dispatch` in Schway mode refuses limits whose
  `calls` or `rounds` are below `retries + 1` with
  `dispatch_limits_below_retry_minimum` (detail `retries`, `minimumCalls`,
  `minimumRounds`) before any job is admitted; the scripted port is unchanged.
  Single-output token accounting stays as committed with measured
  overrun in usage evidence (see ADR 0023). Usage
  records whether any token counter was unreported (`tokensUnknown`, absent
  only on pre-bridge fixture records which carry exact accounting) instead of
  persisting unknown consumption as measured zero, including on
  non-completed runs that consumed attempts. Outcome validation is
  mode- and reason-aware: fixture usage stays bounded by the request limits
  with exact token accounting, production completions require the worst-case
  admission shape (`rounds === calls`, `retries === calls - 1`, zero hops on
  the empty registry) with measured overrun, and pre-model blocked/error
  outcomes accept coherent zero-attempt usage. Malformed production results
  normalize to production `invalid_result`, never fixture evidence.
- `retire` fences the application generation first, then retires owned native
  sessions through `retireSession` (idempotent; only live-holder conflicts
  retry). A pending intent with no addressable session never reports success:
  unaddressable retirement stays `retire_failed` until the correlation
  contract lands. `delete` retires first, then removes owned native artifacts
  through `deleteSession`, converging to `deleted` only when the native call
  acknowledges; partial/blocked stays `delete_failed` with retry.
- `snapshot` captures a quiesced per-context snapshot through
  `snapshotSessions`. Empty backing resolves to the explicit unsupported
  diagnostic. Managed backups (`ops.backup_manifest/v1`, OPS01) capture the
  installation's native set through `SchwayBackupNativePort`
  (`src/ops/schway-backup.ts`) on the same lifecycle host; see
  `docs/contracts/ops-backup-manifest-v1.md`.
- `status()` reports the pinned release for inspection surfaces; it never
  probes credentials or infers readiness. Serve wiring (`JIT_RUN_PORT`,
  default `scripted`) selects the concrete port for specialist, coordinator
  and private PR review (`pr.review`) runs; role preview, schedule summaries
  and memory extraction stay scripted under their fixture authorizations.
  PR review runs on the owner-configured project-default, then owner-default
  route captured with configuration revisions at admission; the concrete port
  blocks admission without one and never falls back to the scripted fixture
  route (`pr.private_report/v1`). `serve` and `startFullApp` share one
  composition (`composeJobQueue`). Queue construction asserts the
  synchronous startup gate (service-owned `.jit-host` dirs plus pinned
  release) before any admission owner exists; `serve` additionally runs the
  full asynchronous gate before starting. Model identifiers outside the pinned
  host grammar fail pre-native with a clear diagnostic.

## Evidence

`tests/schway-bridge.test.ts`: pinned gate (including symlinked-base rejection),
tarball SHA, effective-run mapping with alias preservation and host-grammar
rejection, hostile-input neutrality, empty-output rejection, auth mapping over
fixture stores/transports (needs_login/quota/route_unavailable, no fallback, no
secret leakage), cancel/generation fencing across reopen, native
retire/delete/snapshot through the real host, fence-race orphan retirement
with no submit, startup gate blocking on unsafe host dirs, retry reservation
accounting with exact-budget coordinator coverage, stop-clears-progress,
unaddressable-intent lifecycle (never retired/deleted), mode-aware
normalization (zero-attempt production, malformed stays production, skewed
usage rejected), multi-attempt usage mapping, cursor pagination, shared
normalizer round-trip, and a full application scenario where dispatch commits
production specialist evidence while preview stays fixture, reopens after
restart, and keeps reads working while provider access is blocked.
`bun test`, `bun run typecheck`. No live accounts, no network, no Pi.
