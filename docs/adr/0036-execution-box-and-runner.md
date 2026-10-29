---
status: accepted
scope: S11 execution engineering choices; implements decision record C18; extends ADR 0023
---

# Execution box on rootless Podman, a box runner, and a Schway execution backend

S11-D01, D04 and D05 require execution in a boundary separate from the Jit service, one box per project, with Schway's core tools running inside it. Schway's host contract today runs supplied tools as trusted code in the host process. It has no sandbox. [schway#429](https://github.com/chayapats/schway/issues/429) proposes `schway.host.core-tools/v1`: the core tools take a host-supplied `ExecutionBackend`.

## Selected implementation

- **Runtime adapter.** `src/exec/box-runtime.ts` defines `BoxRuntime`: `ensure(projectId, mode)`, `exec(handle, request)`, `stop(handle)`, `reset(handle, { wipeWorkspace })`, `status(projectId)` and `list()`. There are two implementations:
  - `PodmanBoxRuntime` runs the `podman` CLI as the Jit service user. Installed services explicitly use the identity's rootless user API socket; local CLI mode remains available for development (OPS09 note below).
  - `FakeBoxRuntime` is an in-memory implementation for every deterministic test.
- **Box identity and mounts.** A box is named `jit-box-<projectId>`. It mounts exactly one volume, `<execution.directory>/<projectId>/workspace` at `/workspace`. Browser-capable boxes may also mount `<execution.directory>/<projectId>/profile` (ADR 0039).
  - `execution.directory` is operator configuration. It must not lie inside or contain the state directory, backup directory, ledger or releases, and the same collision checks as `managedCollision` apply.
  - Nothing else from the host is mounted: no state directory, secrets, sockets or Podman socket.
- **Hardening flags.** Containers start with:
  - `--cap-drop=ALL`, `--security-opt=no-new-privileges` and `--read-only`.
  - A `tmpfs` for `/tmp` and `/run`.
  - `--pids-limit`, `--memory` and `--cpus` from operator config.
  - `--userns=keep-id:uid=1000,gid=1000` (the service uid maps onto the image's `box` user, so the workspace it owns is usable whatever that uid is; #163) and no `--privileged`.
  - No environment from the Jit service. Only a fixed allowlist (`HOME`, `PATH`, `LANG`, `TZ`) plus explicit per-call variables reaches the box.
- **Network per access level.**
  - `read` never creates a box.
  - `workspace` attaches to an internal Podman network with no default route. The only egress is a Jit-owned HTTP(S) proxy that allows the operator-configured registry hosts. Its default list is `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `proxy.golang.org` and `crates.io`. Local rootless mode uses the namespace child from #163. Remote mode uses a separate mount-free proxy container on internal and egress bridges, with forwarding disabled (OPS09 below). Neither carries Jit state or credentials.
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

## 2026-10-29 — OPS09 (#224): rootless API outside the hardened system unit

Confirmed decision: keep `NoNewPrivileges=true`, `ProtectSystem=strict`,
`RestrictSUIDSGID=true` and every other unit sandbox directive. The identity's
lingering systemd user manager owns `podman.socket`; the system service connects
only to `unix:///run/user/<uid>/podman/podman.sock`. `JIT_PODMAN_MODE=remote`
selects this explicitly; local development defaults to `--remote=false`. Failed
remote calls never fall back to local execution. No socket is mounted in a box.

Engineering selection: `ContainerRegistryProxy` replaces local-only
`podman unshare --rootless-netns` in remote mode. It uses the already pinned base
image (Node is already installed), no host mount, no port publication, non-root
user, read-only root, dropped capabilities, no-new-privileges and resource caps.
It joins `jit-box-internal` and the separate `jit-registry-egress` bridge. IPv4
and IPv6 forwarding are disabled and verified; Workspace boxes join only the
internal network. The existing CONNECT/443 host allowlist implementation is
bundled for Node and sent through remote `exec -i`; no rebuild/image digest is
invented. Readiness is bounded and fail-closed. A crashed proxy is recreated;
its current internal IP enters the box environment digest so stale boxes are
replaced. Shutdown closes the stream and removes the proxy; a later start fences
an orphan before reuse. This adds a 128 MiB proxy budget outside box capacity.

`run/create/start/inspect/rm/pull`, `cp`, `exec -i` and detached exec use the
remote client. Bind mounts refer to host paths visible to the API server; tmpfs,
`--network none` and `--userns=keep-id:uid=…,gid=…` retain their isolation.
`--env NAME` resolves explicit sidecar secrets in the client (off argv); no
service environment is inherited. `--http-proxy=false` additionally prevents
the API server's proxy environment from entering any container. Box layout v3
recreates pre-OPS09 containers so that this flag also applies after upgrade,
preserving their workspace/profile. See the
[Podman 4.9 exec implementation](https://github.com/containers/podman/blob/v4.9.3/cmd/podman/containers/exec.go),
[run options](https://docs.podman.io/en/v4.9.3/markdown/podman-run.1.html),
[cp](https://docs.podman.io/en/v4.9.3/markdown/podman-cp.1.html) and
[unshare limitation](https://docs.podman.io/en/v4.9.3/markdown/podman-unshare.1.html).

The readiness contract distinguishes missing executable, unreachable API,
rootless/cgroup prerequisites and image/configuration failures. Web explains
the repair in `th` and `en`; host provisioning/rebinding requires an operator
command. Deterministic fixtures prove argv and rendered sandbox preservation;
the opt-in check in the execution runbook is the live acceptance gate.

### OPS09 fix round — nonblocking readiness projections

Engineering choice (2026-10-29, #224 / PR #228): topic, Web search settings and access/box status readers use an in-memory cache per runtime instance. Cold readers return `checking`; expired readers return the last result and trigger one background refresh. Ready results live for 30 seconds, unavailable results for 5 seconds, measured from probe completion. Rejected probes become a sanitized runtime-unavailable result. There is no polling timer or container startup from a page render.

Real command failures invalidate the corresponding runtime cache (including sanitizer availability failures and managed search failures). Invalidation fences an in-flight probe's publication, while retaining single-flight until it settles. Explicit owner search tests and real operations retain their independent readiness checks; this projection grants no execution authority.
