---
status: implemented for TEAM16-01 (#411) and FILE16-01C (#433); deterministic and real-bundle browser evidence; live host evidence separate (#431)
date: 2026-11-07
scope: TEAM16-01 (#411), FILE16-01C (#433); S16-AC01/03/04/05; FR-01/02/04/07/14/15/16/17/18/20/21/22/31/35/36/38/40/42; NFR-01/05/06/07/08/10/12/14
---

# Shared and private working computers, idle release, and file processing on the computer

## Context

S16-AC05 asks for useful shared and private computers: team work shares approved resources without per-Bot setup, explicit private work stays isolated, computers start when needed, release idle resources, keep their state and recover with evidence, and concurrent work has independent workspace ownership. S16-AC03/04 ask for attached files to be used by bounded work on the working computer, with a collected result that keeps precise ancestry.

The S15 baseline had one team working-computer resource served by a pool of VMs (POOL15-01). Three gaps blocked the S16 outcome:

1. The TEAM lease for a working-VM session was partitioned per pool member, so two works on the same member could not run together (`resource_busy`), although each work already had its own directory and the VM admitted two sessions. Concurrent conversations (ADR 0086) made this visible.
2. Every member was shared. There was no way to give one Bot a computer no other Bot's work can reach.
3. A VM ran until the owner stopped it, and an owner-stopped VM never restarted by itself.

File work (S16 files) ran without a computer: it had only the bounded text tools and `file_create`.

The owner decided on 2026-11-07, before this work: one PR for #411 and #433; new Bots use the shared computer by default and a private computer is an explicit owner choice per Bot; a private computer is a separate VM started on demand, because the agent has root inside the working VM (RT15-01 option B) so a second workspace in the same VM is not private; an idle computer is stopped after 30 minutes and keeps its disk.

## Decision

1. **Explicit opt-in.** `s15-runtime/v1` gains `computers: true` (composition `computers: { idleStopMs }`), which the generated installer config sets. Without it every S15 behavior in this ADR is unchanged: per-member leases, all-shared members and no automatic stop or start.
2. **Per-work workspace leases.** With computers enabled, `coordinateWorkingVm` partitions the TEAM write lease by member *and* work (`w` + 40 hex of SHA-256 of member and work id). Different works run concurrently up to the member's session capacity; attempts of one work stay serialized; system administration stays exclusive through the VM service's own admission. Stop proof and restart reconciliation are unchanged.
3. **Computer scopes** (`s16-computer-scope/v1`, `vm_scope` in the protected VM journal). A member with no row is shared. The owner's command writes one row naming one Bot for a member that has never held work or a session (normally one Jit is about to create). The default member stays shared. Triggers make the row's Bot immutable and the row undeletable, so a private computer never becomes shared or another Bot's (no silent promotion of its disk). Retiring only stops new placement there. Placement (`VmPool.place(work, bot)`) uses only a Bot's current private member when it has one, waits with `vm_private_preparing` while that member is being set up, never places other Bots' work on a private member, and refuses `outside_scope` if a work bound to a private member is attempted by another Bot. A work's workspace never moves. The Bot comes from the current POLICY work authority, never from a model or guest.
4. **Private computers on a KVM controller.** `create_private` assigns the scope row and starts a `LocalVmProvisioning` job for a new member id with its own local QEMU manager (`VmManagers.ensureLocalFor`, recorded with `forVm`, own name/MAC/port/disk). Sizing is about half the default working VM with a 40 GiB sparse disk (`privateLocalVmResources`; 10 vCPU / 20 GiB host: 2 vCPU / 4.5 GiB). Interrupted setup resumes at the next boot; a failed setup waits for the owner's Try again. Owner-supplied members (Lima/Proxmox) can be scoped by the same rows; there is no owner form for that yet.
5. **Idle release and on-demand start.** `WorkingVmService` records the time of every protected session open and close (`vm_activity`). A protected sweep (every 60 s) stops a ready, hypervisor-managed VM whose manager can start it again, which has no open, stopping or unknown session and whose last session ended `idleStopMs` ago: new generation, `uncertain/vm_idle_stopping`, hypervisor stop with stop read-back, then `stopped/vm_idle`. A failed stop fences the VM `uncertain/vm_stop_unconfirmed`. Placement treats `vm_idle` members as placeable (after running ones); `openAttempt` starts such a VM under a new generation with the same identity, NIC, pinned SSH guest and direct-egress re-verification as an owner start, then admits the session. Concurrent placements share one start. An owner-stopped VM (`recover`) is never started by work, and controller-boot re-attachment leaves `vm_idle` VMs asleep. The owner can also "Sleep now" a VM with no open session.
6. **Owner surface.** `GET /api/s16/client/computers` (`s16-client-computers/v1`) projects every member's scope, observed state (`running`, `sleeping`, `starting`, `stopping`, `stopped`, `setting_up`, `setup_failed`, `attention`), sessions, held works, drain and `sleepsAt`, each standing-policy Bot's computer and whether a private computer can be created here. `POST /api/s16/client/computers/commands` takes exact `s16-computer-command/v1` commands (`create_private`, `retry_private`, `retire_private`, `sleep`), idempotent per `requestId`, authenticated with CSRF rechecked after the body. The React client adds a Computers page (rail entry, `/s16/computers`) in English and Thai.
7. **Files on the computer (FILE16-01C).** With computers enabled, file work that may change things also opens its VM attempt. The model gets the public core VM tools plus two host-composed tools: `computer_file_put` copies one selected input's exact original bytes to a service-chosen `inputs/<file id>/<safe name>` path in the work root, and `computer_file_collect` reads one regular file (no symlink in any component, inside the work root, relative or absolute path) and creates an immutable artifact through the existing `s16_files` POLICY adapter (`s16-file-collect/v1` payload: name, SHA-256, size). Each transfer is one separately claimed VM write or read under the session, TEAM lease and POLICY guards. The bytes read are held only in this process between the single read and the adapter commit, so the committed artifact is exactly what was read; after a restart the commit refuses (`collection_expired`) rather than re-reading. Every selected input, and its ancestry, is recorded as an input of the artifact whether or not it is cited. Staging a file counts as using it in full for the file-coverage check. Escaping, linked, missing, non-text or oversized output returns a correctable tool error and collects nothing; authority, lineage and VM transport failures stop the work as before.

## Consequences

- Two works of different Bots (or two conversations of one Bot) now run concurrently on one shared computer. They share the guest kernel and root; workspace leases coordinate cooperative work, they do not isolate root-level changes. Isolation between Bots is the private computer.
- A private computer uses host CPU and memory while running. Jit does not refuse to start one when the host is short of memory; idle release limits how long both run.
- Idle time is measured from protected session open/close, not guest processes. Session cleanup already ends a session's processes; work that needs a long-running guest service keeps its session open.
- Waking adds a VM boot (about 25–35 s on the reference host) to the first work after a sleep.
- Collected outputs are UTF-8 text artifacts (`.txt`, `.md`, `.csv`, static `.html`) within the file limit. Binary outputs (images, PDF) stay unsupported until the artifact preview/download contract covers them. If a policy ever holds an `artifact_create` from a collection, the held action cannot complete later (`collection_expired`); the default policy allows it.
- In the generated installation the standing policy has one Bot. Scopes are keyed by Bot identity and apply to every Bot in the policy; creating more persistent Bots is BOT16-01 (#412).
- Live host evidence (actual nested VM stop/start on jit-vm, a second local VM beside the first, real guest file round trip) belongs to LIVE16-01 (#431).

## Alternatives considered

- *A second workspace user inside the shared VM as the "private computer"*: cheap, but root inside the VM can read it; the owner rejected it.
- *Keep per-member leases and add members for concurrency*: wastes a whole VM per concurrent work and still blocks two conversations on a one-VM host.
- *Suspend (QMP pause or save-to-disk) instead of stop*: faster wake, but RAM stays allocated (pause) or the memory image holds guest secrets outside the VM's own disk (save); a stop keeps the existing settlement proof.
- *Collect by re-reading the file inside the adapter commit*: binds the artifact to the VM state at commit time, which can change after the model's check; one read with a hash-bound payload is simpler and exact.
