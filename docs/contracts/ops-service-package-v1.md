# OPS service package contract, v1

Owner: Jit #35. `ops.service_package/v1` is implemented on the `jit/35-service-package` branch, based on OPS04 (`jit/34-load-drill`) plus MVP merge `52c1736`. Downstream eligibility requires this reviewed artifact in the integration base. It performs no provisioning, VPN setup, login or reboot; those are OPS05 human gates.

## Build a versioned artifact (dev machine)

```sh
bun ops/package/bun-build.ts <srcDir> <outDir> jit.schway.bridge/v1 [engineRevision]
```

| Public entry | Behavior |
| --- | --- |
| `buildPackage(options)` in `ops/package/bun-build.ts` | Copies `package.json`, `bun.lock` and `src/` into a fresh output directory and writes `manifest.json` pinning app version, exact Bun version, lockfile SHA-256, schema `user_version`, engine contract/revision and build arch. `piValidation` is fixed to `pending`. All inputs are explicit absolute paths; the developer cwd never leaks in. |
| `readManifest(outDir)` / `validateArtifact(outDir)` | Reads and checks the manifest, required files, lockfile pin match and schema pin match. Never executes the artifact. |
| `artifactPiStatus(manifest)` | `not-run` for any non-arm64 build; `pending` for arm64 until OPS05 collects host evidence. Desktop packaging never certifies ARM64. |

## Configure a trusted installation (operator)

`.local/service-config.json` (ignored) carries exactly: `serviceUser` (never root), absolute `executablePath`/`workingDirectory`/`stateDirectory`/`ledgerPath`/`backupDirectory` (managed state outside releases), `routes` (non-secret selection), `secretRefs` (opaque `{name,store,key}` references, never values), `network` (`bindHost` loopback or explicit VPN/private IP plus port; `0.0.0.0`/`::`/hostnames rejected), and `resources` (finite memory/restart/log/retention ceilings).

| Public entry | Behavior |
| --- | --- |
| `parseServiceConfig(raw)` in `ops/package/service-config.ts` | Strict validation of the trusted shape above. |
| `planServiceConfig(current, desired)` | Prints only allowlisted non-secret diffs; secret references appear as counts plus a changed flag, never values. |
| `renderServiceUnit(config, exec)` in `ops/package/service-config.ts` + `ops/package/systemd/jit.service` | Renders the supervised unit (`User=`, bounded restart, `MemoryMax`, `NoNewPrivileges`, loopback/VPN bind) from the checked-in template. `assertNoSecretValues` scans rendered text for secret-shaped values. |

## Operate the service

```sh
bun src/main.ts preflight [--contract jit.schway.bridge/v1]
bun src/main.ts status
```

| Public entry | Behavior |
| --- | --- |
| `preflightService(input)` in `src/ops/lifecycle.ts` | Gates activation on config, schema, engine, quarantine (deletion ledger present), scheduler, delivery worker, secret files and artifact pins. Read-only status stays available when blocked. |
| `startFullApp(input)` | Async. After preflight, boots the composed full application with exactly the Web worker registrations (no probe runner) and awaits `queue.reconcile(teamPort)` (session plus pending-deletion reconciliation, [data-lifecycle-v1](data-lifecycle-v1.md)) before returning an active handle. A missing ledger refuses with a quarantine gate. |
| `stopDrain(handle, {timeoutMs})` | Bounded cooperative cancellation. Timeout reports `unknown` for unsettled work and never marks remote delivery stopped or sent. |
| `upgradeStaged(input)` | Validates the staged artifact, backs up state plus the artifact pair, applies, and runs the injected health check. Failure restores the backup pair; the ledger is never rewritten. Migration semantics belong to the open OPS06 (#32) path. |
| `serviceStatus(input)` / `gatherServiceStatus(config, service)` in `src/ops/status.ts` | `running`/`blocked`/`observed-ready` without reading secrets. `observed-ready` requires explicit live evidence; only OPS05 may set it. |

`JIT_HOST` rejects wildcard binds (`0.0.0.0`, `::`) by default; Web binds loopback or an explicitly configured private interface behind private ingress.

Deterministic checks: `bun test tests/ops-service.test.ts`, `bun test`, `bun run typecheck`. Tests use disposable directories, a fake supervisor path and scripted ports: no provisioning, VPN changes, login or reboot.
