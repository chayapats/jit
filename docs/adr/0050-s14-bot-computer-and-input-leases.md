---
status: accepted
scope: BOX14-01 logic delivery; implements the isolation/lease portion of ADR 0046 for the opt-in S14 root
---

# Separate Bot workspace/browser processes with finite fail-closed boundaries

Confirmed product direction remains S14-D02/D03/D10/D13, FR-35/36/38/40 and NFR-04/06/07/14. Owner orchestration for #248 fixes rootless Podman, lazy computers, ordinary Jit authority, the existing script-free takeover transport and Phase A public-read/report scope. These are engineering choices, not a redesign or a claim that all S14 capabilities shipped.

The BotComputer adapter reuses the runner/backend and protected CDP stream without legacy Project authorization or combined workspace/profile mounts. Two rootless containers have distinct mounts and PID/IPC/UTS/network namespaces. Both use no network. Only the workspace has a runner gateway; only the protected browser has a CDP pipe. No cookie/profile/JS/CDP/MCP tool is advertised to a model. Public reads use the separately granted service-owned Parallel gateway (#249/#250); browser website reads and login remain unavailable; unknown effects cannot escape through shell/network. Owner text is transient protected CDP input, never a shell command.

Finite persistent disk enforcement is a release gate. ADR 0046's confirmed install-time pool supersedes the original operator-provisioned per-Bot mounts: root prepares bounded loop/ext4 pairs and the service transaction claims them, without privileged runtime provisioning. Missing mounts or unproven capacity fail closed. See the pool contract and ADR 0046 for wipe/reuse and sparse-overcommit rules.

Unconfirmed stop retains its capacity slot until an exact stop verifies settlement. Initial safety ceilings are two live computers and, per component, 0.5 CPU/512 MiB/128 PIDs/1 GiB persistent disk, bounded transient filesystems and no swap. Startup is 30 seconds; idle is five minutes. These are not hardware sizing evidence. Actual kernel cgroups and exact isolation are verified before tool access; ambiguous inspect/kernel formats refuse. Local rootless Podman and the service identity's verified same-host Unix API socket are supported; truly remote clients refuse without fallback.

Persistent browser restart uses stable component hostnames and removes only Chromium singleton symlinks after verified process stop; it does not erase profile/session data or follow the links. Podman 4.9’s exact `CgroupMode=private` field and systemd’s identical same-target mount layers are verified alongside the existing kernel checks; aliases, conflicting layers and child mounts still refuse. Remote client bookkeeping uses only the bound service-owned API directory, avoiding Podman 4.9’s concurrent fallback-directory race.

Lifecycle commands commit revisioned operations before runtime mutation. Generations fence startup, input, runner access and publication. Boot stops old processes and never replays startup, input or destructive operations. An immutable attempt/computer-generation binding prevents late reports after reset. Takeover changes durable ownership immediately; a per-computer barrier waits for old dispatched input to settle before new input. Returning control never approves effects. Agent scroll on the offline surface is the only reviewed input class.

Transient owner text uses a separate endpoint consuming an input ID with a process-keyed HMAC and safe outcome. Text stays in memory/the protected pipe. Lost responses/crashes are unknown and never replayed. Images are owner-only, bounded and no-store; state/SSE contain no website material, and SSE is one bounded event per connection. Rendering remains the designated Opus slice.

Schema 6 combines the foundation result-state table with the computer, memory and Parallel tables. Earlier unreleased schemas 1–5 and unknown/legacy formats refuse with fresh-state before writable open; no automatic upgrade is supported. This is a narrow schema addition, not backup/restore/native recovery completion (#254/#263). Fixtures establish contracts/barriers; x86_64 LXC and arm64 Lima kernel/resource/persistence/reboot evidence remains pending in the runbook.
