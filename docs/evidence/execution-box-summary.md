# Execution box evidence (EXE06, `ops.execution_evidence/v1`)

Sanitized summary of the Pi measurement that `execution.fullAllowed` depends on (#132). It contains no addresses, hostnames or tokens. The unsanitized record lives in the installation's ignored `.local` evidence.

## Run

- Date: 2026-10-28. Installation label `pi-lab-1`.
- Hardware/OS: Raspberry Pi 5 Model B Rev 1.0 · Ubuntu 24.04.5 LTS · kernel 6.8.0-1065-raspi · aarch64 · 7.8 GiB RAM · NVMe · Podman 4.9.3 (rootless, netavark + slirp4netns, cgroup v2 with cpu/memory/pids).
- Build: branch of #163 at `eee5be1` (registry proxy in the rootless network namespace, Podman 4.x network check, service uid mapped onto `box`). Image `jit-box-base:2026-10-28`, pinned by digest.
- `jit ops box-doctor`: all 10 checks ok. `tests/box-podman.live.test.ts` passed: only the workspace is mounted, CapEff is 0, no Jit environment or paths reach the box, the root is read-only, direct egress fails, `example.com` gets 403 from the proxy and `registry.npmjs.org` gets 200.
- Command: `bun run ops:drill drill --scenario boxes --label pi-lab-1`, run with the unit's execution environment and the defaults below.

## Defaults under test

| maxBoxes | memoryMb | cpus | pidsLimit | idleMinutes |
| --- | --- | --- | --- | --- |
| 2 | 2048 | 2 | 512 | 30 |

## Measurements

Each box ran 50 runner calls (write/read/stat in turn) through `podman exec`, at the `workspace` level.

| Box | p50 | p95 | max | failures | RSS after calls |
| --- | --- | --- | --- | --- | --- |
| 1 | 461 ms | 693 ms | 759 ms | 0 | 98 kB |
| 2 | 460 ms | 683 ms | 735 ms | 0 | 102 kB |

- Available memory: 6.04 GB before the boxes, 6.09 GB with both boxes running.
- Disk: 670.5 MB for images. Workspaces are negligible (the drill's files are a few bytes).
- Capacity wait: a third box was refused `box_capacity` while two were held. **Observed.**
- Idle stop: sweeping past `idleMinutes` stopped both boxes. **Observed.**

Interpretation: an idle box holds only `sleep infinity`, so its resident memory is tiny. The `memoryMb` ceiling (2 × 2048 MB) fits within the 6 GB available. The cost per tool call is the `podman exec` round trip, about 0.5 s on this Pi.

## Decision

**fullAllowed may be set.** The operator may set `execution.fullAllowed: true` once the execution block is configured in the installation's service config. The owner still widens each project to `full` in Web.

## Host prerequisites found on this run

- Create `/var/lib/cni` when the service home is under `/var/lib` (see `docs/runbooks/execution-box.md`).
- Add subuid/subgid for the service identity and enable lingering.
