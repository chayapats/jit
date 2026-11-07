# s16-computers/v1

TEAM16-01 (#411) and FILE16-01C (#433). Decision record: [ADR 0087](../adr/0087-s16-shared-private-computers-and-file-processing.md). Exported TSDoc in `src/s16/computers/`, `src/s15/vm/pool.ts`, `src/s15/vm/service.ts`, `src/s15/team/vm.ts` and `src/s16/files/workflow.ts` is the executable contract; this page summarizes it.

## Selection

- Runtime config `s15-runtime/v1` field `computers: boolean` (absent: off). The generated S15 installer config sets `true`.
- Composition option `computers: { idleStopMs: number; sweepMs?: number }`. `main.ts` uses `idleStopMs = 1 800 000` (30 minutes, owner decision 2026-11-07). `sweepMs` defaults to 60 000; `0` disables the timer (tests call `WorkingVmService.sleepIdle()`).
- Off means: per-member TEAM leases, all members shared, no automatic stop/start, no computer tools in file work, and `capabilities.computers = { available: false, code: "computers_unavailable" }`.

## Protected state (VM journal `vm.sqlite`)

| Table | Meaning |
| --- | --- |
| `vm_scope(vm_id PK, bot_id, created_at, retired_at)` | One row per private member. No row: shared. Update/delete triggers refuse any change except setting `retired_at` once (`computer_scope_immutable`). |
| `vm_activity(vm_id PK, at)` | Time of the last protected session open/close (composed clock). |
| `s16_computer_commands(id PK, hash, vm_id)` | Owner command idempotency. |
| `vm_events` kinds `idle_stop`, `idle_start` | Appended with the generation they ran under. |
| `vm_managers.data.forVm` | Present on a local QEMU manager created for a private member. |

`assignPrivate(vm, bot)` refuses the default member (`computer_default_shared`), an existing row (`computer_scope_immutable`), a second current private member for the Bot (`computer_private_exists`) and a member with any affinity or session row (`private_promotion_requires_migration`).

## Placement and leases

- `VmPool.place(workId, botId)` with scopes: a bound work returns to its member (refusing `outside_scope` if that member is private to another Bot); a Bot with current private members uses only those (`vm_private_preparing`, 423, while none is enrolled); other Bots use only shared members. Running members are preferred over `vm_idle` members, then the lowest load ratio, then the default member.
- `coordinateWorkingVm(..., { partition: "workspace" })`: TEAM lease key `<coordinationKey>#w<40 hex of sha256(member \0 work)>` for work sessions; system sessions keep the member key.

## Registry states written by idle release

| Transition | State / reason |
| --- | --- |
| sweep picks an idle VM | generation +1, `uncertain` / `vm_idle_stopping` |
| stop read back `stopped` | `stopped` / `vm_idle`, `boot=null`, `networkIsolated=false` |
| stop not confirmed | `uncertain` / `vm_stop_unconfirmed` (fenced) |
| work placed on `vm_idle` | generation +1, `uncertain` / `vm_waking`, then `ready` after identity/NIC/SSH/egress checks; failures fence with the check's code |

Owner recovery still writes `stopped` / `null` and is never started by work. `VmPolicyIntegration.assertCurrent` admits authority for a `vm_idle` VM so the service can start it; every claim and the post-start assertion still require `ready`.

## Owner API

`GET /api/s16/client/computers` → `s16-client-computers/v1`:

```ts
{ contract; idleStopMs: number | null;
  computers: { id; isDefault; scope: { kind: "shared" } | { kind: "private"; botId }; retired; local;
    state: "running" | "sleeping" | "starting" | "stopping" | "stopped" | "setting_up" | "setup_failed" | "attention";
    reason: string | null; activeSessions; capacity; works; drained; sleepsAt: number | null;
    setup: { step; error; active } | null }[];
  bots: { id; main; computer: { kind: "shared" } | { kind: "private"; vmId } }[];
  privateCreation: { available: true } | { available: false; code } }
```

`POST /api/s16/client/computers/commands` with `s16-computer-command/v1`:

| `kind` | Fields | Effect |
| --- | --- | --- |
| `create_private` | `botId` (a standing-policy Bot) | Assign a new member id to the Bot and start its local setup job. Refuses with the host code when this controller cannot create one (`computer_local_unavailable`, `vm_kvm_unavailable`, `vm_host_too_small`, `vm_disk_insufficient`, ...). |
| `retry_private` | `vmId` | Re-run a failed setup job of a current private member. |
| `retire_private` | `vmId` | Stop new placement for its Bot there. |
| `sleep` | `vmId` | Idle-stop now; refuses while a session is open. |

The same `requestId` with the same body returns the first result (`s16-computer-command-result/v1` with a fresh view); a different body is `request_id_conflict`. The bootstrap capability is `computers: { available: true, contract: "s16-client-computers/v1", idleStopMs, files }`.

## File tools (FILE16-01C)

Offered with the VM core tools in file work whose intent may change things and whose resources include the working computer:

| Tool | Input | Output |
| --- | --- | --- |
| `computer_file_put` | `{ id }` of a selected input | `{ id, sha256, bytes, path }`; writes exact original bytes to `<work root>/inputs/<id>/<safe name>` |
| `computer_file_collect` | `{ path, name }` (relative to or inside the work root) | `{ action, status, name, sha256, bytes }`, or a tool error `{ error }` for `vm_path_denied`, `artifact_content_refused`, `invalid_number` (size), `vm_output_limit` and guest `ENOENT`/`ENOTDIR`/`EISDIR`/`EACCES`/`EPERM`/`EFBIG`/`ELOOP` |

`s16_files` adapter payload for a collection: `{ contract: "s16-file-collect/v1", name, sha256, bytes }`, operation `artifact_create`, class `ordinary_edit`, with every selected input's lineage fence. The artifact's inputs are all selected files. A `computer_file_put` evidence row for a file satisfies that file's read coverage.

## Limits

Staged input ≤ VM `fileBytes` (1 MiB default) and the file limits; collected output ≤ file `fileBytes` (64 KiB default), UTF-8 text types only; at most 32 collections held in process at once, each for 10 minutes. Private local VM sizing: `privateLocalVmResources`.
