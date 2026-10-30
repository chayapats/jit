# OPS service package contract, v1

Owner: Jit #35 (ADR 0022). `ops.service_package/v1` is the install/operate package for the composed Jit application under a Linux supervisor (systemd). It performs no provisioning of users, VPN, credentials, accounts or reboots; those are OPS05 human gates. Consumed contracts: `jit.app.foundation/v1`, `app.owner_identity/v1`, `jobs.queue_admission/v1`, `jobs.attempt_fence/v1`, `jobs.session_reconcile/v1`, `delivery.outbox/v1`, `ops.schema_migrations/v1`, `ops.quarantined_restore/v1` (ledger, through a seam), `ops.load_drill/v1`, `jit.schway.bridge/v1`.

## 2026-10-29 — OPS09 installed container client (#224)

This dated refinement supersedes the original local-Podman/scripted-unit
description below. Every resolved-identity unit explicitly selects the Unix
remote API through `JIT_PODMAN_MODE=remote` and `XDG_RUNTIME_DIR`, preserves the
existing sandbox, binds only the optional user socket directory (plus Schway's
existing bus) through empty home trees and hides default container storage.
`renderServiceUnit` accepts the resolved `uid`, `gid` and `home` for these paths.
Custom Podman graphroots need operator exclusions outside Jit managed paths.

Plan exposes idempotent `optionalCommands` for linger, user-manager startup and
user `podman.socket` enable/start; they run only when Podman is installed.
Install and upgrade return separate optional `podman` status. Missing runtime
or socket leaves chat available and supplies a next action. Upgrade rewrites
the descriptor, requires successful daemon reload before startup, and restores
the previous descriptor on compatible health rollback. CLI status probes the
binary and the identity's API read-only, as that identity, separately.

## Build a versioned artifact (build host)

```sh
bun ops/package/bun-build.ts <srcDir> <outDir> jit.schway.bridge/v1 [engineRevision]
bun ops/package/bun-build.ts install-deps <outDir>     # on the host that will run it
```

| Public entry | Behavior |
| --- | --- |
| `buildPackage(options)` in `ops/package/bun-build.ts` | Copies `package.json`, `bun.lock`, `src/`, `ops/package/` and `vendor/` (pinned engine tarball) into a fresh output directory, canonicalizes modes (directories 0755, files 0644, no special files or symlinks) and writes `manifest.json` (`jit.service.artifact/v1`): app version, exact Bun version, lockfile SHA-256, schema `user_version`, engine contract/revision, build arch, `contentHash` (SHA-256 over the canonical manifest metadata — every other manifest field — followed by every packaged path with its type, mode and content, so no pin or mode can be edited after build) and `piValidation: pending`. Inputs are explicit absolute paths; the developer cwd, `.local`, `.git` and `node_modules` never enter. Output must lie outside the checkout or inside a designated ignored subtree of it (`.tmp`, `.local`, `dist`), never overlapping a packaged entry. Symlinks inside an artifact are rejected. |
| `installArtifactDependencies(dir, {bunPath, run})` | Explicit operator step: `bun install --frozen-lockfile --production --ignore-scripts --linker=hoisted` inside the artifact with an environment of only `PATH`, `HOME` (when set) and `BUN_INSTALL_CACHE_DIR`. The cache always lies outside the artifact: the operator's `BUN_INSTALL_CACHE_DIR`, else `$HOME/.bun/install/cache`, else a removed temporary directory. A configured cache inside the artifact, or a `node_modules/.bun-cache` left by the install, fails `dependency_cache_in_artifact` (#79: without a cache location Bun writes a symlinked cache into `node_modules`). Registry or pre-populated cache access is the operator's responsibility. The step then checks `bun --version` against the pin, removes the unused bin-link directory, canonicalizes modes (directories 0755, files 0644 or 0755) and seals the symlink-free `node_modules` tree into `dependencies.json` (`jit.service.dependencies/v1`, exact keys: artifact id, lock hash, content hash, platform, arch, Bun version, `dependencyHash` over every path, type, mode and file content, file count). Native dependencies are platform specific, so the record proves installation only for its own platform/arch. The unit and boot never install or download anything. |
| `readManifest(dir)` / `validateArtifact(dir, {runtime?})` | Reads the manifest strictly; validation checks required files, lock pin, content pin (a modified release or any edited manifest field fails), `app-version` (manifest equals packaged `package.json`), schema pin against the executing build and, with `runtime`, a strict dependency record for this exact platform/arch whose tree digest is recomputed (a modified, added, removed or symlinked dependency file fails). Plan, release staging, boot (artifact gate) and upgrade all validate with `runtime`. Never executes the artifact. |
| `artifactPiStatus(manifest)` | `not-run` for any non-arm64 build; `pending` for arm64 until OPS05 collects host evidence. Desktop packaging never certifies ARM64. |

## Trusted installation configuration

The operator writes ignored `.local/service-config.json`, then copies the reviewed file into root-owned storage before privileged plan/install; install copies it to `<configDir>/service-config.json` (default `/etc/jit`, mode 0640, read-only to the sandboxed service). Fields: `serviceUser` (existing dedicated non-root, non-login identity), absolute `executablePath` (active-release symlink; releases live in `<dirname>/releases/<artifactId>`), `workingDirectory`, `stateDirectory` (holds `app.sqlite`), `ledgerPath` (the one deletion/suppression ledger checkpoint location for this installation), `backupDirectory`, `routes` (non-secret selection), `secretRefs` (opaque `{name,store,key}`; file stores are absolute paths), `network` (`bindHost` loopback, or a private/VPN address — RFC 1918, 100.64/10, fc00::/7 — on a named `vpnInterface`; `origin` is required and HTTPS for any non-loopback bind, and only a loopback bind may default to `http://127.0.0.1:<port>`), `resources` (finite memory/restart/log/retention ceilings, optional `stopTimeoutSeconds`), optional `runPort` (`scripted` default or `schway`) and optional `channels.telegram` (`disabled` default or `enabled`, which requires the `telegram-bot-token` credential-file reference). The ledger and backups may not collide with the database (`<state>/app.sqlite`), its `-wal`/`-shm`/`-journal` sidecars, any `<db>.<suffix>` control path (backups, upgrades, restores, fences, swaps; the ledger alone may use the OPS02 default `<db>.lifecycle-ledger.json`), the `.jit-host` and `pr-cache` trees, the state/working directories or each other. State, backups and the ledger may not live inside releases, the working directory or a home tree (`/home`, `/root`, `/Users`, `/run/user`); unknown fields, wildcard/public binds and secret-value fields fail.

| Public entry | Behavior |
| --- | --- |
| `parseServiceConfig(raw)` in `ops/package/service-config.ts` | Strict validation of the shape above (`invalid_service_config`). |
| `planServiceConfig(current \| null, desired)` | Allowlisted non-secret diffs; secret references appear as count plus names, never stores or keys. |
| `renderServiceUnit(config, {bunPath, appDir?, configPath?})` + `ops/package/systemd/jit.service` | `ExecStart=<bun> <executablePath>/src/main.ts serve --service-config <configPath>`, `User=` and `Group=<numeric primary GID>` resolved at plan, `Environment=` for `JIT_DATABASE`, `JIT_HOST`, `JIT_PORT`, `JIT_ORIGIN`, `JIT_RUN_PORT` and the bot-token reference path, `Restart=on-failure` with `StartLimitBurst`/`StartLimitIntervalSec`, finite `TimeoutStartSec`/`TimeoutStopSec` (drain + 15 s, `KillMode=mixed`), `MemoryMax`, `TasksMax`, `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `ReadWritePaths` limited to state, backups and the ledger directory, `UMask=0077`, `LogNamespace=jit` with `After=systemd-journald@jit.service` (#89: `LogNamespace=` alone orders only after the namespace sockets, so on a host reboot the namespace journald could stop before the graceful-stop summary `{"stopped":…,"fencedJobs":…}` was written; with the ordering, shutdown stops `jit.service` first and the summary reaches `journalctl --namespace=jit -b -1`), `WantedBy=multi-user.target`. With `runPort: "schway"` (#81), Schway's native credential store needs the service identity's own Secret Service, so the unit also orders `After=`/`Wants=user@<uid>.service` (the identity's lingering user manager, which unlocks its keyring at session start), replaces `ProtectHome=true` with `ProtectHome=tmpfs` plus `BindPaths=/run/user/<uid>/bus` (only that socket), and sets `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`. `ProtectHome=true` hides `/run/user`, so every route would otherwise read `store-unavailable`. Since 2026-10-30 (#222), `ReadWritePaths` also carries `-<home>/.schway`. Schway takes its cross-process credential-store lock there, and with a read-only home every Web sign-in and token refresh fails as `store-error`/`cleanup-required`. The installer creates the directory as the service identity (0700). Hosts prepared by hand create it the same way. Scripted mode renders unchanged. |
| `renderJournaldConfig(config)` + `systemd/journald@jit.conf` | Persistent journald namespace bounded by `SystemMaxUse=<logBytes>` and `MaxRetentionSec=<retentionDays>day`. |
| `assertNoSecretValues(text)` | Rejects rendered text carrying token, bearer, private-key, password or API-key shaped values. |

OPS08 (#206, ADR 0042) enforces privileged path trust for **every** root-run
`service` command. Before application imports, the dependency-free `src/main.ts`
bootstrap recovers the original Linux script path from `/proc/self/cmdline`
(Bun realpaths `argv[1]`), then checks that invocation path, running release (all code,
metadata and dependencies), Bun and ancestor dependency/config lookup paths.
`runServiceCommand` also checks the selected `--bun`, any explicit `--artifact`
(even for a command that does not consume it), source/installed config and all
ancestors before reading. After parsing config it checks unit/drop-ins,
journald, config/release directories and the active release. Every entry must
be root-owned, regular file/directory and without group/other write, with no
symlink in its path. The sole managed exception is the root-owned active-release
link: its parent is protected before reading the link and its direct target's
whole tree is checked without following another link. Root CLI invocation via
that link is accepted only at `/opt/jit/current/src/main.ts`, when the checked
direct target equals the running release (OPS09, 2026-10-29); other symlink
invocations remain refused.

Root-protected ancestors and complete trees keep validation and use on the same
non-service-writable inodes. Staging rechecks source and existing destination
before reading/copying, checks the new copy before content validation, and uses
that protected destination for upgrade execution. Privileged subprocesses use a
fixed system PATH and protected default cwd. The schema upgrade still runs as
the service identity with the owner's password on stdin. Fence, quiesce,
recovery-point, activation and compatible rollback semantics are unchanged.

Refusal is CLI-only English JSON, exit 2: `error: unsafe_root_path`, `path` and
`nextAction` naming the protected-copy procedure and its exact command:
`sudo cp -R --no-dereference -- "$newDir" "$snapshot/artifact"`.
The full [runbook procedure](../runbooks/ops-service.md#trusted-operator-built-root-owned-snapshot-ops08)
builds as `jit` or another unprivileged operator, copies to new inodes beneath a
fresh private root-owned parent, rejects links/special files, sets protected
ownership/modes, validates hashes and only then grants read/traverse access.
Ownership does not authenticate build provenance; the operator must select
trusted bootstrap code, Bun and release inputs before execution.

Non-root CLI calls retain their existing behavior. `ServiceCliDeps.uid`,
`rootPathPolicy` (`RootPathPolicy`: boundary/uid/metadata) and `runtimeDir` are
trusted test seams, never flags or environment overrides. The dependency-free
shared checks live in `ops/package/trusted-paths.ts`; the installer re-exports
its previous imports and continues to use its existing protected snapshot/API.

## Operator commands

```sh
bun src/main.ts service plan      --config .local/service-config.json --artifact <dir> [--bun <path>]
bun src/main.ts service install   --config .local/service-config.json --artifact <dir> [--bun <path>]
bun src/main.ts service start|stop|restart|status|disable|uninstall [--config <installed>]
bun src/main.ts service upgrade   --artifact <dir> --password-stdin
# host layout overrides (tests, staging): --unit-dir --journald-dir --config-dir
```

| Public entry (`src/ops/service-package.ts`, `src/ops/service-cli.ts`, `src/ops/supervisor.ts`) | Behavior |
| --- | --- |
| `runServiceCommand(args, deps)` | Bounded command boundary; JSON output with fixed fields, sanitized by `assertNoSecretValues` (a violation prints `service-output-redacted`). |
| `CommandRunner` / `spawnRunner` / `SystemdSupervisor` | Every external program (`systemctl`, `getent`, `ip`, `bun`, the new build's `upgrade`) runs through one injectable runner with fixed argv vectors (no shell). `spawnRunner` starts each child in its own process group, streams and caps stdout while reading, and enforces a wall-clock timeout: SIGTERM to the whole group, SIGKILL after a 1 s grace, then returns without waiting on descendants that still hold the pipe. Tests inject a fake supervisor and never call systemctl. |
| `planInstall` (`plan`) | Read-only checks with safe next actions: artifact (runtime-validated), identity (`getent passwd`: exists, non-root UID, non-root primary GID that resolves through `getent group`, non-login shell, not under `/home`), access as the service identity (`runuser -u <user> -- test -r|-w|-x <path>`, fixed argv through the runner: state and backup rwx, ledger directory wx, working directory rx, release parent x, existing config directory x, existing ledger rw, credential files r), an existing ledger checkpoint is a regular non-symlink `<uid>`-owned 0600 file, an existing config directory is a real directory not writable by group/other, runtime (`bun --version` equals the pin), state/backup directories owned by the identity and 0700-class, working/ledger directories, every secret reference (credential files owner-only and owned by the identity; keyring/environment stores are `verify-secret-store`), private bind on the named interface (`ip -o addr show dev`), in `schway` mode the identity's session bus socket (`runuser -u <user> -- test -S /run/user/<uid>/bus`, else `enable-service-user-session-bus`; the store is never read and an existing bus proves neither an unlocked keyring nor route readiness), active-release path managed, duplicate instance (installed unit not active). Prints the exact unit and journald texts, file paths/modes/digests and the commands install runs. Writes nothing. |
| `installService` (`install`) | After a passing plan: stages the release copy (re-validated), seeds the ledger checkpoint placeholder `{ledger, revision: 1}` only when absent (never overwrites; the first boot replaces it with the real OPS02 checkpoint, and a seed is never accepted again after establishment) as `<uid>:<gid>` 0600, creates/verifies the config directory as `root:<gid>` 0750 and writes config as `root:<gid>` 0640, unit 0644 and journald 0644 atomically, points the active-release symlink, `daemon-reload`, `enable`. Ownership goes through `OperatorHost.chown` (default `chownSync` plus stat verification); any failure fails install before the release is switched or the unit enabled, and a newly seeded ledger whose ownership could not be assigned is removed so a retry never inherits it. Before activating, install re-checks as the service identity that it can read the config, read/write the ledger and read every entry of the staged release (`releaseReadableByService`: fixed-argv `runuser -u <user> -- find <release> ( ! -readable -o -type d ! -executable ) -print -quit`); upgrade runs the same release check before stopping the unit. With `OperatorHost.skipLedgerSeed: true` (installer), a missing seed fails with `prepare-service-ledger-as-service-user`; install performs no ledger write, chmod or chown. The seed must already exist from the service-identity helper. It does not start the service. |
| `start` / `stop` / `restart` / `status` | Drive the unit; `status` combines `systemctl show` with `gatherServiceStatus`. |
| `disableService` (`disable`, `uninstall`) | `disable --now`; `uninstall` also removes only the unit and journald files. Config, releases, state, backups, ledger and secret references are preserved; deleting managed data is a distinct authorized operation. |
| `upgradePackage` (`upgrade`) | See *Upgrade*. |

## Start: one path for `serve` and the unit

`bun src/main.ts serve [--service-config <path>]` calls `startFullApp` then `serveFullApp`; the packaged unit runs exactly this with the installed configuration. Without `--service-config` the development profile runs the same path without installation-only gates (config, secrets, artifact) and with the development ledger profile.

| Public entry (`src/ops/lifecycle.ts`) | Behavior |
| --- | --- |
| `preflightService(input)` | Read-only gates: `config` (directories present; state directory owned by the running uid — or, for a root-run `service status`, by the configured identity's uid resolved through `getent passwd`, unresolvable identities staying blocked (#83) — and not group/other-writable; backup directory 0700-class with the same owner), `schema` (older → `run-owner-upgrade`, never migrated in place), `engine`, `quarantine` (ledger gate, `inspect` mode), `scheduler` and `deliveries` (one live owner), `channels` (opt-in Telegram: token reference readable with owner-only mode and a supported transport registered), `secrets`, `artifact` (when running from the configured release: content, lock, schema and dependency pins; an unpackaged checkout reports `ready` with that detail). |
| `serviceAppConfig(config, service)` | The installation's database, bind, origin, run port and bot-token reference come from the service configuration. |
| `startFullApp(input)` | Preflight → concrete bridge verification in `schway` mode → pre-listen state preparation (unless fenced) → one `ManagedService` composition (same workers as Web, Telegram, PR, schedule and recovery paths; no probe runner; PR cache under state) → `Application` → ledger gate in `boot` mode → `app.boot()` (session and deletion reconciliation, upgrade completion) → opt-in `ServiceChannels` last. Returns gates instead of enabling anything when blocked. |
| `LedgerGate` / `defaultLedgerGate` | Seam for the installation deletion/suppression ledger (`{store, ledgerPath, now, mode}` → `trusted` or `{reason, nextAction}`). The default is OPS02's `syncLedgerCheckpoint` (app.deletion_ledger/v1) against the configured `ledgerPath` (development profile: `<db>.lifecycle-ledger.json`), writing only in `boot` mode; `startFullApp` also passes `ledgerPath` to the Application so lifecycle commits refresh the same file. The install seed `{ledger, revision}` (or a fresh installation) establishes the checkpoint once on first boot. Afterwards a missing, seed, tampered, diverged or stale file, or a different `ledgerPath` without a verified copy of the established checkpoint, keeps activation quarantined with #33's next actions. Configure one `ledgerPath` per installation and never hand-edit it. |
| `inspectBotTokenFile` / `readBotToken` (`src/telegram/secrets.ts`) | Preflight and status inspect the token file by metadata only (lstat: regular, non-symlink, owner-only, 1–512 bytes); FIFOs, devices, symlinks and oversized files are blocked (`replace-telegram-token-with-regular-file`, `restrict-telegram-token-file`, `verify-telegram-token-file`) without opening them. The start-time read opens with `O_NOFOLLOW | O_NONBLOCK`, re-checks the same inode with fstat and reads at most 513 bytes. |
| `ServiceChannels` / `ChannelTransportFactory` (`src/ops/service-channels.ts`) | One delivery worker (claims `delivery_worker`; reconciles interrupted attempts to `unknown`) and one Telegram poller that persists updates before acknowledging the offset; nothing sends or polls under an upgrade/restore fence. The bot token reaches only the transport factory. This build registers no live Bot API transport, so `channels.telegram: enabled` fails closed (`install-supported-telegram-transport`) outside tests. Inbound project commands are not executed by the service: they require an owner session, and the service never derives owner authority from process identity, network address or a health request. |
| `serveFullApp(handle)` | Listens on the configured private bind (owner authentication unchanged), pumps queue, schedules and channels; `stop()` stops listening, then drains. |
| `stopDrain(handle, {timeoutMs})` | Stops channels, fences admission and in-flight attempts (`JobQueue.close()` returns the job IDs it actually interrupted; only those make the outcome `interrupted`, never historical waiting/blocked/failed jobs), waits at most `timeoutMs`. Timeout reports `unknown` and `terminate-supervised-process-and-reconcile`; remote work/delivery is never recorded as stopped, sent or completed without evidence. Restart reconciles before new work. |
| `gatherServiceStatus(config, service)` (`src/ops/status.ts`) | Read-only SQLite connection (`openReadOnlyStore`, `src/ops/readonly-store.ts`: when neither `-wal` nor `-shm` exists, a consistent in-memory snapshot via `Database.deserialize` (WAL header bytes rewritten in the copy only; discarded as `store_changed_during_read` if the file or sidecars change while reading; above 512 MiB `store_too_large_for_snapshot`); when both exist, the live WAL set is never opened (a read-only SQLite connection still writes reader marks into `-shm`): the main file and `-wal` are copied into a private temporary directory under the same 512 MiB bound, the originals' size/mtime/inode must be unchanged across the copy (at most 3 attempts, then `store_changed_during_read`), and the copy is queried and removed; every query fails `store_sidecars_incomplete` when only one exists). No SQLite URI is used: Bun on macOS links the system SQLite (3.54.0 observed, compiled with `SQLITE_USE_URI`, so `file:...?immutable=1` works), while Bun on Linux uses its bundled SQLite, which takes such a URI as a literal file name; a plain read-only open of a WAL-mode file without `-shm` fails on both., so status, `preflight` and `diagnose` never create, migrate, journal or chmod the installation; a missing database is the blocked `schema` gate (diagnose: queue unavailable). `running` / `blocked` / `observed-ready` (only with explicit live evidence) plus scheduler and worker ownership (`service` when the scheduler's process sends), quarantine, `channels` (`disabled`/`ready`/`blocked`), `routes` (`total`, `configured`, `verified: 0`) and non-ownership blocked gates. Reads no secrets. |

## Upgrade

`upgradePackage` (`service upgrade`), run from the new build:

1. Validate the staged artifact for this host (content, lock, schema, dependencies, engine). Block without stopping when it is older than the installation state, already active, or the ledger gate is not trusted (newer deletion/suppression state is never ignored).
2. Stage the release copy; `systemctl stop` (cooperative drain, bounded by `TimeoutStopSec`); require `inactive`/`failed` and no live scheduler/delivery owner, else `blocked` / `terminate-supervised-process-and-reconcile`.
3. Run the new build's `upgrade --service-config <installed> --password-stdin` (ops.schema_migrations/v1: fence, verified recovery point in the configured backup directory, staged migration, validation, atomic activation), as the service identity when invoked as root. The owner password goes only to its stdin.
4. Upgrade did not activate → `upgrade-failed`: the release is not switched and the prior release restarts when the state still matches it.
5. Switch the active-release symlink atomically, `systemctl start` (boot reconciles before admission), health-check (supervisor active and `GET /login` on the private bind, finite deadline; a health request is never an owner command).
6. Unhealthy → stop; roll back to the prior release only when the state schema still equals the prior manifest's (`rolled-back`); otherwise `activation-unhealthy`, the service stays stopped on the new release and `recoveryBackupId` names the recovery point for an OPS02 quarantined restore. Native Schway format and the ledger are never rewritten.

Result: `jit.ops.package-upgrade/v1` with outcome, previous/new/active artifact ids, schemas, recovery backup id, upgrade id, supervisor state and next action.

## Verification

Deterministic (`bun test tests/ops-service-package.test.ts tests/ops-service.test.ts`, `bun test`, `bun run typecheck`, also with `TMPDIR` inside the worktree): disposable directories, a fake supervisor that takes the rendered unit's `ExecStart`/`Environment` and boots that release's own `startFullApp` in-process (real OPS02 ledger gate), with owner HTTP driven through the release's `createWebHandler` — no listener or socket; a duplicate writer is a real child process running the release's `main.ts serve`; simulated `getent`/`ip`/dependency install/ownership and simulated `upgrade` outcomes; real artifact build, plan/install writes, release symlink, full-app boot, HTTP owner login and persisted state. No systemctl, registry, network accounts, VPN or reboot.

Opt-in, not in `bun test`: `JIT_OPS_SMOKE=1 bun run ops:smoke` on Linux arm64 builds, installs and seals dependencies, runs the release's read-only `preflight --service-config` (artifact gate must be ready), launches the release's installed-profile `serve --service-config` against disposable state (the seed establishes the ledger checkpoint) and prints a sanitized summary; it refuses elsewhere. Real systemd install, unattended boot, reboot, Secret Service/credential access and VPN reachability on the Pi are OPS05 (#36) evidence.
