# EXE03 execution box runtime and backend, v1

Owner: Jit #127 (S11 EXE03). Status: implemented on the issue branch. Decision: [ADR 0036](../adr/0036-execution-box-and-runner.md). Spec: [S11](../specs/S11-execution-access-and-tools.md) (S11-D01, D04, D05, S11-AC01, S11-AC02, S11-AC04). Requirements: FR-36, FR-35, NFR-14, NFR-06, NFR-07, NFR-10.

Uses `schway.host.core-tools/v1` (Schway [#429](https://github.com/chayapats/schway/issues/429), pinned artifact `ac63557`, `schway.host.release/v2`; see [schway-bridge-v1](schway-bridge-v1.md)), `app.access_level/v1`, `ops.execution_config/v1`, `ops.box_image/v1` and `jobs.queue_admission/v1`. Delivers `exec.box_runtime/v1`, [`jit.box.runner/v1`](box-runner-v1.md) and `exec.box_backend/v1`. No work definition uses a box yet; wiring tools into model runs is EXE05.

## `exec.box_runtime/v1`

`src/exec/box-runtime.ts` (interface), `src/exec/podman-runtime.ts` (`PodmanBoxRuntime`), `src/exec/fake-box-runtime.ts` (`FakeBoxRuntime`).

```ts
type BoxMode = "workspace" | "full";
interface BoxRuntime {
  ensure(projectId, mode, options?: { profile?: boolean }): Promise<BoxHandle>;  // { projectId, name, mode, profile, workspaceRoot: "/workspace", temporaryDirectory: "/tmp" }
  exec(handle, { input, timeoutMs, signal? }): Promise<{ exitCode, stdout, stderr }>; // runs /opt/jit/runner only
  stop({ projectId }): Promise<void>;
  reset({ projectId }, { wipeWorkspace }): Promise<void>;
  status(projectId): Promise<BoxStatus>;   // absent | running | stopped, with mode and profile
  list(): Promise<BoxStatus[]>;
}
```

- **Identity.** `jit-box-<projectId>`, labels `jit.box=1`, `jit.box.project`, `jit.box.mode`, `jit.box.profile` and `jit.box.env` (a digest of the environment, which names the proxy URL).
- **Mounts.** Exactly `<execution.directory>/<projectId>/workspace` at `/workspace`, plus `<…>/profile` at `/profile` only with `profile: true` (ADR 0039). The directories are created 0700 and must be real directories owned by the service uid (`box_directory_unsafe` otherwise). Nothing else is mounted: no state, backup, ledger, secrets, socket or Podman socket.
- **Hardening** (`podman create`): `--pull=never`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--read-only`, tmpfs `/tmp` (1 GiB) and `/run` (128 MiB, the runner's scratch space: a full request plus both capped streams fit) with `nosuid,nodev`, `--pids-limit`, `--memory`, `--cpus` from `ops.execution_config/v1`, `--userns=keep-id`, `--log-driver=none`; never `--privileged`, `--env-host`, `--init` or `--volume`. The command is `sleep infinity`.
- **Environment.** Only `HOME=/tmp`, `PATH`, `LANG=C.UTF-8`, `TZ=UTC`, plus `HTTP(S)_PROXY`/`http(s)_proxy`/`NO_PROXY` in `workspace`. The `podman` client itself runs with `PATH`, `HOME`, `XDG_*`, `DBUS_SESSION_BUS_ADDRESS` and `LANG` only.
- **Network.** `workspace` boxes join `jit-box-internal` (created once with `--internal`, no default route); their only egress is the registry proxy on that network's gateway. `full` boxes use the rootless default network. A box ensured in another mode, profile, image or environment is removed and recreated (the workspace persists); the proxy of the current process is started before an existing box is reused, so a box left by an earlier process with another proxy port is recreated.
- **Verification.** After creation and before every reuse, `podman container inspect` must show exactly the expected bind mounts (`box_mount_mismatch`) and `Privileged: false`, `ReadonlyRootfs: true`, no `CapAdd` and the mode's network (`box_hardening_mismatch`). A box that differs is removed and refused.
- **Reset.** `podman rm --force`; with `wipeWorkspace` the workspace and profile directories are deleted (a symlink there is refused).

`FakeBoxRuntime` records every call and models the same lifecycle, environment and mounts in memory; `exec` delegates to an injected handler (tests run the real runner script on the host).

## Registry allowlist proxy

`src/exec/registry-proxy.ts` `startRegistryProxy({ hostname, port, hosts, log?, connectUpstream? })`: HTTP `CONNECT` only, tunnelled only to a host in `config.execution.registryHosts` on port 443. Another host, port or IP literal is `403`, a plain-HTTP method `405`, a malformed head `400`. Each refusal logs one line with the host name (or the method) only — never a path, query or header. The service starts it lazily on the internal network gateway with the first `workspace` box (`src/exec/box-service.ts`).

## `exec.box_backend/v1`

`createBoxBackend(runtime, handle, { redact?, callMs? }): ExecutionBackend` (`src/exec/box-backend.ts`). Each member is one runner request. Schway keeps path confinement, output bounds, truncation and spill files, so `coreToolDefinitions(createBoxBackend(…))` reproduces the SCH01 golden byte for byte. `readFile` streams 1 MiB chunks; `observeFile`/`writeFileAtomically` use opaque runner tokens (`ECHANGED` on change, `TypeError` for an observation this backend did not issue); `glob` lists files under the pattern's literal base directory in the box, filtered there by a superset regular expression of the pattern before the cap, and matches exactly with `Bun.Glob` on the host; a listing the runner cut (50,000 files, 10,000 entries) rejects `EFBIG` and one it stopped at 60 s rejects `ETIMEDOUT`, so an incomplete result never looks complete; a stream the box cut at 8 MiB ends with a notice of the kept and total bytes; `spawn` cancellation sends a runner `kill` for the command's process group, then rejects `AbortError`, and a late result is never returned. Spawn output and search lines pass `redact` before Schway sees them.

## Lifecycle and capacity

`src/exec/box-manager.ts` `BoxManager(store, config, runtime, { now, onCapacity, backend })`:

- `open(projectId, roleId)` reads `assertExecutionAllowed(…, "workspace")` in its own transaction: `read` never reaches the runtime (`access_level_insufficient`), a halted project is `execution_halted`, and the mode is the effective level. Every access command bumps the project's access generation; the level is checked again once the box is ensured (and the open starts over when the generation moved) and before every runner call of the session, so a narrowing or halt that commits meanwhile refuses further commands (only `kill` passes). It returns `{ handle, backend, release() }`.
- `hasCapacity(tx, projectId)` is the queue's admission check for `execution: true` work (`SchedulerOptions.boxes`). Holders are projects with a running or opening box plus projects with an admitted execution job; at most `execution.maxBoxes`. Without a slot the job stays `queued` with reason `box_capacity` and next action `wait_for_box_capacity`, rewritten only when the reason changes. A box stop calls `onCapacity`, which pumps the queue.
- `sweep(now)` runs on the service scheduler tick and stops boxes unused for `execution.idleMinutes`; a box in use is never stopped. A slot keeps its capacity until the runtime confirms the stop; a failed stop is retried by the next sweep. `reconcile()` counts boxes left running by a previous process.
- `stop(projectId)` runs after `execution.halt` commits; `accessChanged(projectId)` after any other access command stops a box running wider than the new effective level (or at `read`). Widening applies on the next open, which restarts the box.

## `execution.box.reset`

`{ kind: "execution.box.reset", requestId, projectId, expectedRevision, payload: { wipeWorkspace } }` → `{ box: BoxView }`, where `BoxView = { projectId, revision, lastReset, holding, busy }`. Schema 33 `execution_box_resets(project_id, revision, wipe_workspace, channel, created_at)` is append-only; `expectedRevision` is the box reset revision (0 before any).

- Web only: the Telegram channel and the local API (`local-api`) are `box_reset_requires_web` (403).
- `stale_revision` (409) when the revision moved; `box_busy` (409) while an execution job of the project is admitted or the box is in use; `box_not_configured` (503) without execution configuration; `invalid_box_command` for another shape.
- From the start of the reset until its receipt commits, the project admits no execution job (`hasCapacity` is false) and opens are `box_busy`. The runtime reset runs first; the revision, receipt and audit row commit only after it succeeded, so a failed reset can be retried with the same request id. A replay returns the first receipt; another payload under the id is `request_id_conflict`.

HTTP (JSON; the Web page is EXE04): `GET /api/projects/:project/execution/box` → `{ box }`; `POST /api/projects/:project/execution/box/reset` `{ requestId, expectedRevision, wipeWorkspace }` with the usual session, Origin and CSRF rules.

## Tests

`tests/box-runtime.test.ts` (Podman flags per level over a scripted `podman`, mount and hardening verification, level-change restart, reset, `read` and halt never reaching the runtime, no Jit variable or path in any box, capacity wait and release with the fake clock, idle sweep, reset rules, the JSON API, the proxy, migration 32 → 33 and dictionaries), `tests/box-runner-protocol.test.ts`, `tests/box-backend.test.ts` (SCH01 golden, cancel, late result) and the opt-in `tests/box-podman.live.test.ts` (`JIT_LIVE_PODMAN=1`).

## Not in v1

- `spawn` output reaches `onOutput` when the command ends, not while it runs.
- An execution job that never opens its box keeps the project counted as a holder only while it is admitted.
- On rootless Podman the internal network's gateway lives in the rootless network namespace; whether the host-side proxy can bind it depends on the network backend. The live test is the evidence; EXE06 records it on the Pi.
