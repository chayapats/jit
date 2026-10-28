---
status: accepted
scope: S11 execution engineering choices; implements decision record C18; extends ADR 0023
---

# Execution box on rootless Podman, a box runner, and a Schway execution backend

S11-D01, D04 and D05 require execution in a boundary separate from the Jit service, one box per project, with Schway's core tools running inside it. Schway's host contract today runs supplied tools as trusted code in the host process. It has no sandbox. [schway#429](https://github.com/chayapats/schway/issues/429) proposes `schway.host.core-tools/v1`: the core tools take a host-supplied `ExecutionBackend`.

## Selected implementation

- **Runtime adapter.** `src/exec/box-runtime.ts` defines `BoxRuntime`: `ensure(projectId, mode)`, `exec(handle, request)`, `stop(handle)`, `reset(handle, { wipeWorkspace })`, `status(projectId)` and `list()`. There are two implementations:
  - `PodmanBoxRuntime` runs the `podman` CLI as the Jit service user. It is rootless, uses no Podman socket and makes no daemon API calls.
  - `FakeBoxRuntime` is an in-memory implementation for every deterministic test.
- **Box identity and mounts.** A box is named `jit-box-<projectId>`. It mounts exactly one volume, `<execution.directory>/<projectId>/workspace` at `/workspace`. Browser-capable boxes may also mount `<execution.directory>/<projectId>/profile` (ADR 0039).
  - `execution.directory` is operator configuration. It must not lie inside or contain the state directory, backup directory, ledger or releases, and the same collision checks as `managedCollision` apply.
  - Nothing else from the host is mounted: no state directory, secrets, sockets or Podman socket.
- **Hardening flags.** Containers start with:
  - `--cap-drop=ALL`, `--security-opt=no-new-privileges` and `--read-only`.
  - A `tmpfs` for `/tmp` and `/run`.
  - `--pids-limit`, `--memory` and `--cpus` from operator config.
  - `--userns=keep-id` and no `--privileged`.
  - No environment from the Jit service. Only a fixed allowlist (`HOME`, `PATH`, `LANG`, `TZ`) plus explicit per-call variables reaches the box.
- **Network per access level.**
  - `read` never creates a box.
  - `workspace` attaches to an internal Podman network with no default route. The only egress is a Jit-owned HTTP(S) proxy that allows the operator-configured registry hosts. Its default list is `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `proxy.golang.org` and `crates.io`. On rootless Podman the proxy process runs inside Podman's rootless network namespace, where the internal gateway exists (#163). It is a child of the service with a fixed port and is restarted when that namespace is recreated. It still holds no Jit state or credential.
  - `full` uses the rootless default network (pasta/slirp4netns).
  - A level change applies when the box is next ensured. A running box is restarted on a level change.
- **Runner protocol `jit.box.runner/v1`.** The image contains `/opt/jit/runner`, a small static script with no model and no network. It reads one JSON request on stdin and writes one JSON response on stdout through `podman exec -i`. The operations are `spawn`, `readFile`, `writeFileAtomically`, `stat`, `list`, `glob` and `search`. Every operation has fixed byte and time limits, and paths are confined to `/workspace`.
  - `src/exec/box-backend.ts` adapts the runner to Schway's `ExecutionBackend`, so Schway keeps output bounds, truncation and path canonicalization.
- **Images.** `ops/box/Containerfile` has two targets, `base` and `browser`. Operator config pins each by digest. Jit never pulls an unpinned tag at run time.
- **Lifecycle and capacity.**
  - The admission budget allows at most `execution.maxBoxes` running boxes (default 2). A run that needs another box waits as `box_capacity` with a next action.
  - A sweep stops boxes idle for `execution.idleMinutes` (default 30). The workspace persists.
  - `reset` is an owner command. It removes the container and its writable layer. With `wipeWorkspace` it also deletes the workspace volume.
- **Audit.** Every tool call is recorded as a bounded audit row: tool, run, box, duration, exit status and the first 2 KiB of the command or path. Output is not stored beyond Schway's own session.

## Alternatives and consequences

- **Rejected:** bubblewrap with a separate Unix user (weak network control and messy resets) and microVMs (too heavy for an 8 GB Pi). Kata stays a drop-in runtime later because the OCI images are unchanged.
- **Rejected:** a long-running runner daemon. One `podman exec` per call costs roughly 50–150 ms on the Pi, which EXE06 measures. In exchange it keeps no listening socket and no state in the box.
- Residual risk: in `full`, anything inside the box can reach the internet anonymously. External effects that need the owner's identity still go through approval cards, because no credential is in the box (ADR 0037).
