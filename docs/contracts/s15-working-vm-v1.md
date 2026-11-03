# s15-working-vm/v1

Status: **implemented opt-in server contract**, revision **4**, 2026-11-03, for [VM15-01 #321](https://github.com/chayapats/jit/issues/321) and [VM15-02 #366](https://github.com/chayapats/jit/issues/366) (Jit-managed local working VM). Requirements: **FR-14/15/17/18/35/36/38; NFR-01/04/06/07/14; S15-AC03**. Related FR/NFR/acceptance identifiers are unchanged. The implemented section below supersedes conflicting revision-1 preparation choices; historical proposal schemas/fixtures are not a runtime conformance claim. Full S15 activation, x64 live evidence, browser/effect enforcement and host cutover remain separate.

The [proposed ADR 0067](../adr/0067-s15-working-vm-operation-and-settlement.md), [closed documentation schemas](fixtures/s15-working-vm-v1.schema.json), [complete synthetic fixture data](fixtures/s15-working-vm-v1.json), [fixture interpretation](fixtures/s15-working-vm-v1.md) and [admission/evidence record](../evidence/s15-vm-contract-preparation.md) form this proposal. Those revision-1 preparation artifacts added no runtime code or activation; the implemented revision-3 server contract is described below. Fixtures are **unexecuted documentation**, not passing tests. S14 remains default, including its grant intersections, private Bot computers, rootless/no-network boundaries and exact-effect contracts.

## Implemented server contract (2026-11-03)

The owner ended documentation-only preparation and accepted RT15-01 option B. The executable contract is [`src/s15/vm/index.ts`](../../src/s15/vm/index.ts) and its exported TSDoc/types. The proposal/fixtures below are historical and do not claim runtime conformance merely by matching synthetic data. This implementation deliberately uses a smaller protected journal and public Schway backend seam; no world catalogs/hash inventories are introduced.

`WorkingVmPort.openAttempt(actor, {vmId, workId, attemptId, signal?, mode?:'work'|'system', access?:'inspect'|'execute'})` returns `VmSession {id, backend, definitions, evidence(), cancel(), close()}`. The actor is verified by the real protected policy consumer, never serialized into a guest request. Each operation obtains one current durable policy claim with exact credential-free payload/hash, finite bounds and final dispatch/publication callbacks. Private ephemeral registry-proxy authentication is injected by trusted transport after policy preparation; it is not an upstream account credential or owner authority. Models never receive SSH/management handles or endpoints. `setup` is a fixed work-root-only infrastructure operation, separately charged and permitted to an inspect authority; it is not arbitrary write/shell permission.

The implemented POLICY15 binding is `VmPolicyIntegration`: register its read handlers/action adapter and protected VM/snapshot catalog wrapper with `openPolicyService`, then bind the real service. Resource, current-attempt, finite cost and new-recipient resolution are protected owning-service dependencies. Reads/setup use `reserveRead`, single-use `guardRead`, `settleRead` and `publishRead`; mutations use durable exact action claims and `DispatchContext.commit`. Fixed content search dispatches `rg` argv directly, never an arbitrary shell marked read-only. Snapshot preparation is local administration; system shell dispatch additionally requires the exact current protected snapshot lineage fence. New artifact destinations are held before HTTP or guest writes. Large guest-local writes bind all original live request bytes by hash/count without expanding POLICY's command limit; a serialized hash/slip cannot recreate the lost dispatch callback. Policy's transport observation does not attest guest command truth. Tests and opt-in arm64 checks exercise this real binding; fakes remain only lower-level test seams.

Direct tools refuse traversal, special files, symlink escapes, credential-like inputs/outputs and foreign/copied file observations. Atomic replacement replaces the entry itself and reports `ECHANGED` on observed drift; it is cooperative guest filesystem concurrency, not a root-proof transaction. Bounded shell execution supports sudo, ordinary services, dependencies and guest Docker. Output remains guest-reported/adversarial. Exit, timeout, hash or stdout cannot certify actual effects or protected authority. Transport failure cannot select a host shell.

One VM admits two active work sessions by default (editable), each with its own work/attempt directory and systemd slice. Inspect sessions expose only exact read/grep/find/ls names and reject direct backend writes/bash. System mode takes an exclusive VM lease and an automatic protected snapshot before administration; no management/recovery holds it. Unrestricted root can still alter another guest directory, cgroup, Docker daemon or service: this is accepted expendable-guest administration, not malicious-root multi-tenancy. Waiting work closes its session.

Stop/revoke immediately fences further calls and late publication. Host SSH closure settles transport only. Host-initiated unit stop plus cgroup read-back is **guest-reported/cooperative settlement**, the explicitly accepted scoped support; root can forge/escape it. Protected Lima/Proxmox hypervisor stop plus read-back is **strong settlement**. Inconsistent/failed cleanup marks the shared VM uncertain and retains sessions/capacity. Recovery is explicit owner authority; no autonomous restore. Restore advances protected VM fences and preserves claims, outcomes and policy/accounting facts outside the guest. Process restart never recreates a mutation context or replays an old command. These statements supersede the earlier universal root-proof per-operation settlement requirement in the preparation below.

The external guest network allows only a protected HTTP/CONNECT registry proxy. Its default exact hosts are exported as `defaultVmRegistryHosts`; owner settings can narrow/replace them at a fresh proxy incarnation. Public DNS answers are checked and the actual socket pins the checked address; private/control/metadata/IP-literal destinations are refused. Connections/bytes/time are finite, lease revocation closes active connections, and logs contain only session/host/byte metadata. **This is destination control, not content-level disclosure prevention.** Approved registries see request metadata and may receive workspace content; TLS cannot verify release-only/read-only semantics or block every publication at an allowed domain. Proxy attribution is cooperative against shared guest root. New destinations require policy; the exact HTTPS+SHA-256 bounded artifact path injects no credential and follows no redirect.

Proxmox setup registers a VM-scoped API token (VM.Audit/PowerMgmt/Snapshot/Snapshot.Rollback), with read-only Sys.Audit at `/` and `/nodes/<node>`. The protected verifier reads all firewall enable levels, NIC/rules and direct guest egress probes. Missing audit or disabled/unproven controls refuses the `network-isolated` capability. Lima/QEMU verifies the actual protected process/config: plain mode, no shared mounts/guest agent/additional NIC, `restrict=on`, IPv6 disabled and only the fixed proxy guest-forward. Guest firewall settings are diagnostic only. Since revision 4 the default x64/arm64 working VM is the Jit-managed local VM below; Lima/Proxmox are the optional owner-supplied path.

The module's separate protected SQLite journal uses application ID `0x4a495456`, version 1. It refuses foreign headers before opening writable SQLite; it is neither the S15 application store nor an S14 migration. SSH keys and VM management tokens stay outside it in protected key files/vault. Native Schway state is unchanged and remains protected. This slice does not activate a complete S15 runtime, implement a new agent loop, adopt legacy data or claim universal browser/effect gates. S14 remains default.

JSON API routes are exported by `createVmApi`: setup, check, enroll, management, settings, status and explicit recovery. Authentication/Host/Origin/CSRF belongs to the trusted ingress callback; there is no public unauthenticated listener. Setup binds the actual typed address, observed host-key fingerprint and `ssh-sudo-systemd/v1` transport profile. Capability rows are `proven | unproven | unavailable`; adapters alone do not establish real snapshot/stop evidence. No visual UX is authored.

Enrollment must bind the pinned SSH guest to the protected hypervisor NIC identity. Lima additionally pins its protected loopback SSH forward. A mismatch or missing binding leaves isolation unproven and recovery unavailable; an adapter's independent firewall evidence cannot be attached to another SSH target. Health/start recheck that binding, while strong recovery checks the previously bound management identity without requiring a wrecked guest to answer.

Recovery retires live objects, timers, queued work and cleanup transports. Old-generation callbacks cannot change current VM/session state, and a late result cannot downgrade strong settlement evidence. Protected snapshot retention keeps the latest three points by default; automatic exact retirement is separately policy-claimed. Owner `POST /s15/vm/snapshots/retire` retires an exact unpinned point. Active or uncertain system-session fences prohibit retirement. Directory listing/search walk no-follow directory descriptors; search uses pinned descriptors plus `rg --no-follow`. Artifact downloads share the finite session queue/call ceiling and one 30-second deadline including cancellable DNS. Proxy slots are reserved before DNS, and ephemeral policy invocation data is released on every terminal path without changing durable claims.

### Jit-managed local working VM (revision 4, VM15-02)

Owner decision 2026-11-03: the default topology is one host running the controller and a nested KVM working VM that Jit creates and manages. Implemented by `QemuVmManagement` (`src/s15/vm/qemu.ts`), the host/sizing/image helpers (`src/s15/vm/local.ts`) and `startLocalVmControl` (`src/s15/vm/local-control.ts`), all exported from `src/s15/vm/index.ts` with TSDoc. Existing exported APIs keep their names and signatures; additions are optional members.

- **Manager kind.** `VmManagers.register(owner, {kind:'qemu'})` (also `POST /s15/vm/management {"kind":"qemu"}`) needs trusted composition `local` host options and a KVM-capable host (`detectLocalVmHost`: Linux, x86_64/aarch64, accessible `/dev/kvm`, the QEMU/seed/`nc` tools; aarch64 also needs `qemu-efi-aarch64`). It persists only `{kind, name: jit-work-<12 hex>, architecture, mac: 52:54:00:xx:xx:xx, sshPort, resources}`; no key, token or address beyond the loopback port. One local VM per controller until POOL15-01. Errors: `vm_host_unsupported`, `vm_host_too_small`, `vm_disk_insufficient`, `vm_port_unavailable`, `vm_already_enrolled`.
- **Local enrollment.** `VmEnrollment.enrollLocal(owner, {id, managerId, maxSessions?, signal?})` provisions the guest (no pasted bootstrap line), then runs the same inventory, sudo/systemd readiness, `vmIdentityMatches` (controller-chosen MAC and loopback SSH forward) and direct-egress probes as `complete`, and returns the ordinary `VmStatus`. Network isolation is proven only with `network: 'proxy-only'` from the hypervisor plus a refused direct-egress probe; `snapshot-recovery` and `hypervisor-stop` stay `unproven` until an observed protected restore/stop. The asynchronous owner setup route and its UI belong to SETUP15-01.
- **Image.** `localVmImages` pins Ubuntu 26.04 LTS `release-20261016` (`https://cloud-images.ubuntu.com/releases/resolute/release-20261016/…-{amd64,arm64}.img`) with SHA-256 `5645d0318ad21f643ebb1ac4567514620e9893380b07b0201fda163baa5b7eb5` (amd64, not `amd64v3`, because reference hosts may lack AVX2) and `8eb876c2ccc4b6ff89e4a65d511815923b285e04503ba465809bf587f763da24` (arm64), taken from the release's GPG-verified `SHA256SUMS`. Download is HTTPS without redirects or credentials, size-bounded, then hashed; a mismatch is `vm_image_unverified`, unreachable downloads `vm_image_unavailable`. The verified base is mode 0400; each VM uses a qcow2 overlay.
- **Keys and seed.** The controller generates an Ed25519 client key and the guest's Ed25519 host key, writes `known_hosts` before first boot and seeds both through NoCloud (`jit` user, key-only with `restrict`, passwordless sudo, no password/root login, sshd forwarding off, no generated extra host keys). The seed also keeps proxy variables through sudo, disables apt pipelining and marks the NIC optional with no DHCP DNS/NTP. A changed host key fails closed (`vm_host_key_changed`).
- **QEMU argv (`qemuArgv`).** KVM, `-cpu host`, `-nodefaults`, `-no-user-config`, no display/monitor, seccomp `-sandbox on,obsolete=deny,resourcecontrol=deny`, a 1 MiB console ring buffer (diagnostics only), a controller-only QMP Unix socket, one virtio disk (overlay, `cache=none`), one read-only virtio seed, and exactly `-netdev user,id=net0,restrict=on,ipv6=off,net=192.168.5.0/24,host=192.168.5.2,hostfwd=tcp:127.0.0.1:<port>-:22,guestfwd=tcp:192.168.5.100:3128-cmd:/usr/bin/nc -U <state>/proxy.sock` with one `virtio-net-pci` NIC. `qemuArgvFacts` parses `/proc/<pid>/cmdline`; `inspect()` reports `proxy-only` only for a byte-for-byte rebuild of this profile with the persisted MAC and port, otherwise `unproven`; a foreign process behind the unit is `vm_boundary_unproven`.
- **Lifecycle.** `systemd-run --user --collect --unit=<name>.service --property=Type=exec --property=TimeoutStopSec=15 -- <argv>` in the service user's lingering user manager. `start()` waits for QMP, the pinned host key and an admitted SSH login. `stop()` sends QMP `quit` (then unit stop/kill) and requires the unit inactive, the QEMU PIDs gone and the overlay write lock released, else `vm_stop_unconfirmed`. Optional `VmManagement.resume?()` and `WorkingVmService.reattach()` re-verify a surviving VM after a controller restart and restart a VM that was running before a host restart (new generation, re-verified before `ready`); stopped or restored VMs stay stopped.
- **Snapshots.** Exact `^jit-[a-f0-9]{32}$` qcow2 internal snapshots: live via QMP `blockdev-snapshot-internal-sync` (crash-consistent, siblings keep running) or `qemu-img snapshot -c` when stopped; restore = proven stop plus `qemu-img snapshot -a`, leaving the VM stopped (`vm_snapshot_unknown` for a missing tag); retire deletes only the exact tag. Policy claims, usage, generations and the journal are outside the guest.
- **Sizing.** `defaultLocalVmResources`: vCPU = min(⌊CPUs/2⌋, CPUs−2); memory = min(round(0.45 × RAM to whole GiB), ⌊(RAM − 6 GiB)/256 MiB⌋ × 256 MiB); at least 1 vCPU and 2 GiB, otherwise `vm_host_too_small`; disk 60 GiB sparse, refused (`vm_disk_insufficient`) unless free space minus the installer reserve (`localVmDiskReserve`, the `install.sh` rule) holds it. 10 vCPU / 20 GiB gives 5 / 9 GiB; 4 vCPU / 8 GiB gives 2 / 2 GiB. `GET /s15/vm/resources?managerId=` shows current values, defaults and host facts; `POST /s15/vm/resources {managerId,cpus,memoryMiB,diskGiB}` edits them (memory in 256 MiB steps leaving the controller 2 GiB, disks only grow); they apply at the next start.
- **Registry defaults.** `defaultVmRegistryHosts` adds `production.cloudfront.docker.com`: live x64 evidence showed Docker Hub serving blobs from it, so Docker pulls failed with only the Cloudflare host listed. The owner list remains editable.
- **Composition.** `composeS15({vm:{…, managementVault, local:{}}})` starts the registry proxy on `<runtime>/vm-local/proxy.sock` (guest URL `192.168.5.100:3128`; the owner's persisted registry list applies), gives work sessions and provisioning their leases, wires `setRegistryHosts`, exposes `vmManagers` and re-attaches local VMs in the background. The state directory must stay within 64 characters (`vm_state_path_too_long`) because QMP/proxy Unix socket paths are bounded. `S15RuntimeConfig.vm.local: true` opts a runtime in. New error codes need product copy at SETUP15-01.

## Exact inputs and ownership

| Input | Revision / admission meaning |
| --- | --- |
| Inspected integration main | `64f3a94726fdbce2283aec0944884ca7406d9934`; #317 / PR #343 and #319 / PR #344 merged |
| Main transition evidence | [s15-state-transition/v1](s15-state-transition-v1.md) blob `5e6ba001820e1f41728c8a124ed361414187e4fb`; [ADR 0065](../adr/0065-s15-state-preservation-and-policy-adoption.md) blob `fb451e10fdb67064f484d02029a18cc18672c62b`: proposed audit contracts, not implemented S15 |
| Main authority boundary | [ADR 0064](../adr/0064-conversational-authority-and-protected-control-plane.md), blob `03593d4622f55aa220b62718fd0da18cb64d8154` |
| Unmerged #318 | [PR #345](https://github.com/chayapats/jit/pull/345), head `c79aab9d098c902db0cdff7f3d649ca389fff08c`; [feasibility proposal](https://github.com/chayapats/jit/blob/c79aab9d098c902db0cdff7f3d649ca389fff08c/docs/contracts/s15-runtime-feasibility-v1.md) blob `f7237a3aa7843da00d55493a127a7107263b0824`; [ADR 0064 proposal](https://github.com/chayapats/jit/blob/c79aab9d098c902db0cdff7f3d649ca389fff08c/docs/adr/0064-conversational-authority-and-protected-control-plane.md) blob `08099feea574c717684099b1070a2d5fe13e1a18` |
| Unmerged #320 | [PR #346](https://github.com/chayapats/jit/pull/346), head `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919`; [standing-policy proposal](https://github.com/chayapats/jit/blob/de2a4b08f9653d01dc0766e5cefa65ac6e2b9919/docs/contracts/s15-standing-policy-v1.md) blob `3c1d5596cc3433eca4aaa5507a02256d3d196462`; ADR 0066 blob `ca62a24e81f7601a9b6778997f7cb6b55b24b4a8` |
| #320 fixture/evidence inputs | JSON `63c0f0a756f19fc8c4ceb695cfd9cfa7bf143a7d`, interpretation `8455f6e2b400e3c98cffd622d1259d7547bebc87`, preparation record `28325572b048682a73b1e5880fd20a63eca5f165`; 42 documentation scenarios, not executed tests |
| Current prerequisite | #321 OPEN / enhancement / needs-triage, native blocker #320 OPEN; #320 native blockers #318 OPEN and #319 CLOSED. No label, native edge or implementation criterion advances. #318 is assigned to chayapats. |

Both input PRs remain OPEN and reviewed at those exact heads. Neither is branched from, merged, cherry-picked or copied wholesale here. Every new actor/transport/action/schema/adapter assumption is **pending reconciliation with the actual merged reviewed #318/#320 revisions and implementation evidence**. Green review or issue closure is not runtime admission. ADR 0066 is already occupied by unmerged #346; 0067 was collision-checked against main and both active PR trees. Recheck concurrent additions before integration.

## Confirmed outcome and trust domains

S15-D02/03 require a dedicated working VM with shell/sudo, programs/dependencies, Docker, environment and ordinary services. S15-D10/11/12 require general browser work, shared approved team resources and real protected human gates. These are requirements, not evidence that an unrestricted-root implementation satisfies them. This proposal selects no live hypervisor, SSH/vsock endpoint, network product or numeric allowance. RT15-01 and RF15-G01–G08 remain unproven.

Three domains remain distinct:

- **Protected Jit/Schway domain:** authenticated owner ingress, standing policy/catalogs, current work/effect/approval/request/continuity ledgers, reservations, publication, vault/provider/channel credentials, native sessions/home/correlation workspaces, VM-management credentials, original checkpoints and old/new runtime boot fence. None is a guest disk, environment variable, socket, prompt, ordinary export or input to the guest runner.
- **Administrable working guest:** selected work files, programs, guest Docker, environment/services and untrusted utility MCP. Treat guest root, runner and all returned bytes as adversarial. Root can replace/kill the runner, forge output, fork away, reboot and erase guest disks. An echoed identity, JSON hash or successful command does not attest protected state or policy compliance.
- **Separately protected browser/effect components:** sensitive website sessions/cookies, login/2FA and actual effect/disclosure mediation. No guest profile mount, unrestricted CDP/JS handle, reusable account/session capability or raw cookie/token export. General browsing, real brokers and their alternate-path proofs belong to later slices, including BROW15/DATA15/GIT15/SEND15/PAY15.

All management connections are **host-initiated** through a registered protected adapter. A guest may receive an unprivileged request channel; it receives no management/owner credential. The protected endpoint catalog binds VM identity independently of guest output. A guest-suggested URL, hostname, path, device, socket or redirection cannot select a management target. No local protected-host shell or `localExecutionBackend` fallback exists, including on connection, parse, timeout or reconnect failure.

An external enforcement design must cover guest-root changes to routes/firewalls, IPv4/IPv6, DNS, UDP/QUIC, proxies/CONNECT/tunnels, metadata/control networks and nested Docker. A guest firewall, sibling service, host allowlist, TLS pass-through, GET, `readOnlyHint` or model label proves neither actual effect nor disclosure safety. No unrestricted guest internet is admitted here. Approved dependency acquisition needs a separately bounded destination/payload contract; S14 registry scope can disclose workspace data and is not inherited S15 authority.

## Public host audit and reusable seams

Pin: [package.json](../../package.json), [vendor artifact](../../vendor/schway-1.0.0-rc.2-0a10abe.tgz), `schway@1.0.0-rc.2`, upstream `0a10abedcd72aae7c92371fee277af7d90d4e52c`, SHA-256 `fe219842340f850015dda54ffebd989b52ef4bf3a9da6badfba48dc6a4efbf94` (re-vendored by MODEL15-02 from `697bf40`, at which the declarations below were read; capabilities retained). Static public declarations were read from this tarball, without invoking the engine, a model or runner. Only `schway/host` imports are proposed. Reading a public re-export's declaration does not authorize importing its internal path.

| Existing source / public seam | Valid reuse and limit |
| --- | --- |
| [computer-types.ts](../../src/s14/computer-types.ts), [computer.ts](../../src/s14/computer.ts) | Opaque instance-registered handles; immutable attempt/computer binding; intent before mutation; current guard after queue/wait; late-result fences; uncertain capacity retained. Existing Bot/private/grant semantics and S14 limits remain unchanged. S15 workspace leases below are separate from browser input leases. |
| [computer-work.ts](../../src/s14/computer-work.ts), [research.ts](../../src/s14/research.ts) | `runComputerWork` asserts existing S14 computer authority; research composes `createHost`/`coreToolDefinitions` with a backend. It does not turn `message.post` or task acceptance into S15 authority. |
| [computer-podman.ts](../../src/s14/computer-podman.ts) | WeakMap handle identity, protected-path collision checks, exact mounts/namespaces/resource verification, no host fallback, guard at dispatch and stop before destructive cleanup. It explicitly refuses foreign SSH/TCP hosts; its rootless read-only/no-network S14 containers are not an administrable S15 VM. |
| [box-backend.ts](../../src/exec/box-backend.ts), [box-runtime.ts](../../src/exec/box-runtime.ts), [runner contract](box-runner-v1.md), [runner source](../../ops/box/runner) | Backend observations retained by object identity, ECHANGED, atomic own-entry replacement, exact explicit env, bounded output/error mapping, cooperative group kill. Reuse these concepts, not the legacy project identity, lax result casts, old numeric limits or an inference that `kill`/client abort proves hostile guest descendants stopped. |
| Public `ExecutionBackend` | Exact `realpath`, `stat`, streaming `readFile`, `observeFile`, `writeFileAtomically`, `writePrivateFile`, `list`, `glob`, `search`, `spawn`. `coreToolDefinitions(backend, options?)` returns admitted tool definitions. Backend is trusted host code, **not a sandbox**. Cwd/path checks do not constrain arbitrary shell effects. |
| Public `ExecutionSpawnRequest/Result` | Request `{command,cwd,env?,timeoutMs?,signal?,onOutput?}`; result `{stdout,stderr,exitCode:number|null,timedOut:boolean}`. Positive finite time, nonzero exit as data, `AbortError` on cancellation. Jit retains richer private settlement state; the result alone is not stop evidence. |
| Public host/session APIs | `createHost`, exact tool registry/hosted lookup off, bounded `HostRunOptions`, `cancel/close`, metadata inventory/retire/delete and opaque snapshots. Keep Schway's loop/providers/retries/compaction/native storage. VM management and external enforcement are Jit adapter obligations. No specific missing public behavior is demonstrated, so no Schway blocker/proposal is created. |

Source-read evidence includes [computer tests](../../tests/s14-computer.test.ts), [Podman tests](../../tests/s14-computer-podman.test.ts), [runner path tests](../../tests/s14-computer-runner.test.ts), [backend tests](../../tests/box-backend.test.ts), [runner protocol tests](../../tests/box-runner-protocol.test.ts), [authority tests](../../tests/s14-authority.test.ts) and [recovery tests](../../tests/s14-recovery.test.ts). They cover copied handles, path/socket/profile denial, startup/takeover/revoke races, actual-settlement capacity, changed observations, exact env, stale output, unknown effects and usage. None was run for this preparation; none supplies fresh S15 platform proof.

## Closed records, canonical bytes and proposed paths

The linked JSON Schema's `$defs` are the exact **documentation data types**, including every required property, literal union and additional-property refusal. They describe proposed `VmRegistrationV1`, `BindingV1`, `PolicyBindingV1`, `OperationV1`, `RunnerScopeV1`, `RunnerRequestV1`, `RunnerResultV1`, `RunnerResponseV1`, `ClaimV1`, `ReceiptV1`, `EvidenceV1` and `ManagementCommandV1`. They are not installed APIs or a complete runtime/DDL. The fixture document has its own closed type, not an owner command endpoint.

Proposed implementation locations, **not added by this PR**:

| Path | Contract ownership |
| --- | --- |
| `src/s15/vm-types.ts`, `vm-validation.ts` | Closed record types/validators; canonical/hash domains; byte/time/path/env bounds; exported TSDoc |
| `src/s15/vm-operations.ts`, `vm-policy-port.ts` | Protected actor/slot admission, receipts/claims/current guards/reservations; #320 adapter binding |
| `src/s15/vm-management.ts`, `vm-transport.ts` | Instance-registered management/operation handles; trusted VM identity/fences; one-shot framed channel; external settlement |
| `src/s15/vm-backend.ts` | Public Schway `ExecutionBackend`, private observation registry and cancellation/output adaptation |
| `src/s15/vm-recovery.ts` | Metadata-only reconciliation of exact old claims, current continuity and management proof; no command replay |
| `tests/s15-vm-{validation,operations,transport,backend,recovery}.test.ts` | Eventual Bun/TypeScript scripted ports/fake clocks/barriers; fixtures converted to tests only after admission |

`Id`, `Hash`, `RefV1`, `BlobV1`, `AdapterV1`, `VectorV1`, `UsageV1` follow the exact #320 proposal: ASCII IDs `[A-Za-z0-9_-]{1,128}`, lowercase SHA-256, positive safe revision/generation, finite nonnegative safe counters/times, canonical decimal `spendMinor`. Reject `-0`, overflow, fractional/nonfinite values, invalid Unicode/NUL, duplicate JSON keys, accessors/prototypes/cycles/sparse arrays. No trimming, Unicode normalization, newline conversion, environment expansion or redaction before exact hash validation. The schema's string lengths count characters; the stricter UTF-8 **byte** limits below also apply. Reference arrays are bounded, sorted canonical UTF-8, unique by catalog ID, never empty-means-all.

`C(x)` is compact JSON, ASCII object keys sorted by UTF-16 code units, arrays in declared order, JSON string escaping/finite integer spelling, no BOM/LF. `H(domain,x) = SHA256(UTF8(domain + "\n" + C(x)))`. Domains: `s15.vm.registration.v1`, `s15.vm.operation.v1`, `s15.vm.claim.v1`, `s15.vm.receipt.v1`, `s15.vm.management.v1`. Exclude only the containing record's own `hash`; all other hashes remain included. Raw file/output/frame/proof bytes use SHA-256 without a domain prefix. `BytesV1` carries canonical padded RFC 4648 base64, exact decoded length and hash; reject mismatches/noncanonical encodings. Hashes bind observed bytes, not truth or authority. The bounded [S14 canonical helper](../../src/s14/validation.ts) informs the algorithm, but whole fixture documents are not ordinary 128 KiB commands.

`PolicyBindingV1` is a protected immutable reference snapshot, **never sent wholesale to the guest**. It resolves live work authority, policy/hash, owner/Bot, resource/lineage, exact budget continuity/upper bound/cost basis and an optional exact prepared action. It does not copy the protected ledger. A mutation (`write`, private spill creation, shell/admin or mutating management) requires a #320 prepared action and trusted VM adapter semantics. Ordinary reads use a separately authorized bounded read slot; an inspect request cannot admit a mutation. `cancel` uses a narrowly registered cleanup right to the original execution, not a new action permission. A structural policy/action ref cannot create a policy verdict or a callable actor. Full catalog resolver/selection/account/recipient checks remain #320 obligations; this record narrows, never replaces them.

The #320 prepared payload must not contain its own future action hash. Use the exact closed **`VmActionPayloadV1`** projection: copy all `OperationV1` fields except its own `hash`, replace `contract` with `s15-working-vm-action-payload/v1`, and set `policy.action` to explicit `null`. Prepare the immutable canonical credential-free payload and its raw SHA-256 first; #320 then creates its PreparedAction/actionHash. Attach that exact action ref/hash to `OperationV1.policy.action` and compute the final operation hash. For management use **`VmManagementActionPayloadV1`**: copy all command fields except `hash`, replace contract with `s15-working-vm-management-action-payload/v1`, and set `actionHash` and `cleanupClaimId` to null. Attach the resulting exact action hash only after preparation. These projections are schemas and complete byte fixtures, not a self-referential hash definition. Cleanup-only stop uses its original claim context, not this action preparation path.

At #320 `authorizeDispatch`, `FinalDispatchV1.payloadBytes` are the exact canonical projected payload pinned by PreparedAction, with details/target/version matching the trusted adapter schema. The adapter also verifies the final runner/management request is the **only deterministic derivation** of that payload plus the pinned action/claim identity and trusted invocation/nonce/fences. Claim metadata cannot alter operation arguments, endpoint, lifetime or env. Transport framing/nonces are not additional unapproved action content, and cannot be supplied by guest/model code after the guard. Freeze/prove this serializer and linearization under VM15-FZ03; a signature alone cannot establish it.

`OperationV1` hashes immutable registration/binding/policy/adapter/body/time facts. Protected invocation slots assign IDs and request keys; models cannot choose a new identity to replay an uncertain shell effect. Revising any byte requires new preparation before claim; the original claimed logical slot remains closed. #320 `action.decide` appends a separate Approval without changing prepared-action revision/hash. This proposal does not change that distinction or advance action revision when claiming, cancelling or recording evidence.

## Identity, generations and actual dispatch

| Fence | Meaning and advance rule |
| --- | --- |
| Registration/ref/hash | Protected installation catalog pins manager, endpoint, guest disk identity, allowed capabilities/profile/network/asset manifest and finite limits. Reconfiguration replaces the immutable registration and advances its revision/generation. No raw host path/address/credential in the record, guest request or model output. |
| `binding.vm` | Logical VM ref; withdrawal, reset/restore/rebind advance its current generation. No ID/generation reuse or clearing from a guest/snapshot. S14 computer IDs are not silently converted. |
| `bootGeneration` | Protected management monotonic boot/incarnation counter; start/reboot/restore and observed unexpected reboot invalidate old boot bindings. A guest boot ID may inform diagnostics but cannot set this counter. |
| Work/attempt refs | Exact admitted current purpose/attempt under #320; stop/revoke/generation drift fences new dispatch and publication. Historical claims remain facts. |
| Workspace lease | Exclusive operation/mutable-workspace lease, issued by protected scheduler at exact ref/generation. Shared team access does not permit concurrent unsynchronized edits. Browser input has its own later-slice lease; this is no browser authority. |
| Controller/executor epochs | Process-local incarnation IDs registered outside the guest. Process loss discards handles/dispatch contexts; a recovered claim never reconstructs a mutation context. A replacement management process must reconcile prior scopes before issuing new ones. |
| `executionId` / invocation / channel nonce | Service-issued operation-local execution identity plus per-claim invocation and unpredictable channel nonce. Bind every response/cancel/observation to them; never target a guest-supplied PID/path or reuse a process-group number after reboot. Nonces correlate bytes, not authenticate the guest as owner/manager. |

Trusted guards run under the owning current-identity/continuity serialization boundary at accept, claim, after every queue/wait, immediately at actual channel/management I/O, and separately at publication. The adapter must control final target and immutable bytes after the check. A callback without a protected manager fence or conditional/serialized I/O cannot prove revoke-before-dispatch ordering; that adapter remains unsupported. Revoke before that linearization point prevents dispatch; after it, no system can recall a command already delivered. Record facts and fence future actions/results honestly.

`OperationV1` acceptance commits a deduplicated intent/receipt; **no dispatch or charge is implied**. Claim precedes any runner I/O, atomically reserving all relevant upper bounds/capacity and retaining uncertainty in the current protected continuity journal. A mutating operation shares the exact #320 action claim/reservation, rather than creating a second independently usable effect claim or charging the same reservation twice. The implementing journal must atomically bind policy claim, VM claim and reservation identity before either adapter can dispatch; incomplete cross-store binding refuses I/O. Freeze this mapping under VM15-FZ02/03.

A new `dispatch` rejects any existing operation/logical effect claim. The **original privately registered unconsumed context** can continue that exact invocation/reservation through current final guards, even when remaining allowance is zero because it was already charged. It cannot send again after consumption, be serialized, migrate to a new process or be reconstructed from IDs. Publication expects the producing claim and checks its own authority/lineage; it neither rejects solely because that claim exists nor requests a second approval/reservation for the same operation. Additional reads/delivery have their own scoped budget.

## Transport and parser profile

`jit.vm.runner/v1` is a new proposal, not a reinterpretation of `jit.box.runner/v1`. A registered host adapter opens **one bounded host-initiated channel per claimed request**, sends one frame and receives one response frame, then closes. No guest listening owner API, runner reconnect session, interactive PTY, unsolicited push, executable attachment, compression, concatenated JSON, multiplexing or protocol downgrade. Hypervisor/SSH/vsock mapping and peer verification are unfrozen; structural messages cannot supply them.

A frame is exactly a four-byte unsigned **big-endian** UTF-8 JSON payload length, followed by exactly `C(record)` bytes. Length must be nonzero and within the directional cap **before allocation**. Reject short EOF, trailing bytes/second frame, BOM, invalid UTF-8, duplicate keys, unknown fields/version/op, noncanonical JSON or schema/hash/correlation mismatch. Do not parse guest stderr as another response. Bad framing before I/O means no dispatch; bad response after dispatch means unknown, never proof that nothing happened.

| Bound | Proposed hard parser ceiling; configured profile may only lower it |
| --- | --- |
| Request / response payload | 2 MiB / 4 MiB, excluding four-byte header; depth <=16; <=128 object properties; <=4096 array entries; byte limits apply even when fewer characters |
| Individual decoded file write/observe / read chunk | 1 MiB / 256 KiB; read offset/length addition must be safe and bounded; whole read <= configured file/operation budget |
| Stdout / stderr retained prefix | 256 KiB each; count total bytes with bounded safe counters; unknown/unreliable totals are `null`, never zero; discard excess while enforcing time/resources |
| Runner transport diagnostic / search failure | 16 KiB; bounded and sanitized; never raw protected logs/host paths/credentials in ordinary results |
| Path / shell command / search pattern | 4096 / 65536 / 65536 UTF-8 bytes; no NUL; path controls refused; shell content LF/TAB allowed |
| Env | <=64 entries, name `[A-Za-z_][A-Za-z0-9_]{0,63}`, each value <=16384 bytes, <=65536 bytes total canonical env; no NUL, credentials or service env inheritance |
| List / glob / search | 4096 entries/files / 1024 matches; each match text <=8192 bytes; whole frame/retention cap still dominates |
| Connect / inter-frame idle | <=10000 / 5000 ms; finite independent bounds; idle byte trickling cannot extend absolute operation deadline |
| File / spawn / cancel dispatch | <=60000 / 3600000 / 10000 ms; absolute host monotonic deadline starts at admitted slot/claim as specified by the handler, never reset by queue/guest reply/reconnect; requested shell timeout cannot exceed remaining allowance |
| Settlement observation window | <=30000 ms per admitted observation; expiry records unknown/held capacity, not a proven stop; further observation requires a new finite read authorization |
| Queue / concurrent runner calls | <=16 queued per VM; <=2 active calls per profile; actual operations also require exclusive applicable lease and finite global capacity |
| CPU/memory/PIDs/disk | Every value positive finite safe integer in registered profile; enforce externally, account for nested Docker, disk sparse commitments/snapshots/tmp/output and management overhead. No sizing, budget or availability is selected by fixture numbers. Missing enforceable ceiling refuses admission. |

These are proposed protocol/safety ceilings, not an authorized operating allocation or performance evidence. Management inspection must prove the configured stricter limits; guest cgroup/resource text cannot attest them. Current S14 defaults are not inherited. A guest flooding stderr/frames has bounded transport/time/retention; closing it does not release uncertain execution capacity.

## Runner operations and public backend mapping

All request and result union arms are closed in the schema. Every field is required; `null` is explicit. `RunnerRequestV1` carries only contract, operation/hash, invocation/nonce, reduced `RunnerScopeV1` fences and the final guest operation. No owner/policy/effect ledger, route/account/credential or raw management location is included. `RunnerResponseV1` echoes those correlation fields and returns exactly `{kind:'ok',result:<matching arm>}` or `{kind:'error',code:<closed errno>}`. A response for another op/attempt/nonce is unusable even if otherwise valid.

| Request `operation.kind` | Exact body fields after `kind` | Result fields after matching `kind` |
| --- | --- | --- |
| `realpath` | `path` | `path` |
| `stat` | `path` | `type:'file'|'directory'|'other'` |
| `read` | `path,offset,length` | `data:BytesV1,eof` |
| `observe` | `path,content` | `entry:null|{targetExists,token,data:BytesV1|null}` |
| `write` | `path,data:BytesV1,createParents,observed:{kind:'unchecked'}|{kind:'absent'}|{kind:'token',token}` | No extra fields |
| `write_private` | `path,data:BytesV1` | No extra fields |
| `list` | `path` | `entries:[{name,type}],truncated` |
| `glob` | `cwd,pattern,dot` | `files:[absolute canonical guest path],truncated` |
| `search` | `cwd,path,pattern,glob:string|null,ignoreCase,limit` | `matches:[{path,line,text}],truncated,failure:string|null` |
| `spawn` | `executionId,command,cwd,env,timeoutMs,lifetime:'command'|'vm_service',serviceAllocation:RefV1|null` | `executionId,stdout:BytesV1,stderr:BytesV1,stdoutTotal:number|null,stderrTotal:number|null,exitCode:number|null,timedOut` |
| `cancel` | `targetOperationId,targetOperationHash,executionId` | `executionId,signalRequested` |

Direct file-tool paths are canonical absolute guest paths under `/workspace`, with no empty/`.`/`..` segments, repeated slash or trailing slash (except the root itself), controls or outside symlink/parent resolution. Never treat guest paths as host paths. Read/observe/list/search/glob refuse sockets/devices/FIFOs and other special files; `stat` may identify `other`, but never opens it. Read/observe reject symlinks escaping the work root. `realpath` reports actual guest resolution; Schway then refuses outside-workspace resolution without further read. Root may manipulate its guest filesystem; this is best-effort direct-tool correctness, not isolation or prevention from malicious root. Only externally held assets can rely on the protected boundary.

An observation is registered by **host object identity** to its backend instance, operation binding, canonical path and guest token. Never accept copied/cross-path/cross-backend/stale-boot tokens from a caller. Absent means the directory entry itself must still be absent; a dangling final symlink is an existing entry with `targetExists:false`. The runner token binds parent/entry identities, own symlink bytes, target identity/content/mode and the observed generation. Verify unchanged before and after acquiring content; drift returns ECHANGED. `write` stages bounded bytes in the same directory, checks the observation/parent identity inside its serialization scope, then atomically replaces the **own entry** with rename; a final symlink is replaced, never followed. Preserve regular-file mode or use `0666 & ~umask`; private spill files use 0600. Clean up exact temporary entries on known failure. No “write succeeded” from a partial/malformed response.

A pathname check followed by rename is not a universal compare-and-swap against guest root. The reviewed implementation must freeze a descriptor-relative traversal/no-escape algorithm and cooperative writer serialization; concurrent uncooperative root may defeat it or forge success. Do not claim CAS, malicious-root prevention, crash durability or protected evidence integrity from two checks. Atomic rename is a guest filesystem property; durability needs explicit fsync/error proof. A broken runner/observation contract makes that adapter unavailable, not grounds for a host file fallback. Direct file operations need actual implementation evidence before advertised support.

`readFile` iterates chunks, validates decoded sizes/hashes/monotonic offsets, and releases its channel when iteration ends. Zero decoded bytes with `eof:false` is EPROTO, not a silent empty EOF; changed chunk observations cannot imply a stable full-file snapshot. List/glob do not follow symlinks; validate every returned path/name (one component for a list entry, no slash/controls/dot aliases). Glob maps validated absolute results to relative `cwd` paths and applies exact Bun-compatible matching. Truncated list/glob becomes EFBIG; timed-out walks ETIMEDOUT. Search may return explicitly partial matches/failure, never a complete claim. Missing search program is ENOENT. Filtered/omitted entries must set truncation/coverage, not disappear silently.

`writePrivateFile` permits only `/tmp/schway-bash-<canonical-lowercase-UUID>.log` in that backend's private spill namespace; only realpath/stat/read/private-write access to that exception. Spill data is guest working output, **not** protected provider/native/session storage. No arbitrary `/tmp` or host path. The schema admits lexical strings; these additional semantic restrictions are mandatory.

`spawn` is guest `/bin/bash -c <exact command>` with stdin `/dev/null`, bounded output, cwd under `/workspace` and a new execution identity. Shell may administer other **guest** paths, including sudo, program installation, guest Docker, environment and services. That is the required target, not proof of destructive/effect enforcement. The adapter serializes `env` as an **exact replacement**, never an overlay: missing public `ExecutionSpawnRequest.env` selects the immutable registration default; explicit env keeps only string-valued entries from the pinned public `string|undefined` type and then validates them, without injecting defaults. No ambient host/service/proxy/credential env, `BASH_ENV`/`ENV` autoload or inherited fds. Block credential-bearing or unreviewed interpreter-autoload configuration before dispatch; a mutable guest interpreter remains adversarial.

No implicit command retries, package installation by the host, host Docker socket, protected shell or arbitrary management command. `lifetime:'command'` forbids unaccounted surviving descendants. `vm_service` requires a pre-admitted exact persistent service allocation and current impact authority; it does not quietly classify the service as expendable. Service lifetime/transfer proof is an unresolved VM15-FZ04 obligation below. Program/package acquisition and network disclosure need separate current policy and proof. `sudo` text or a successful exit is neither major-change authority nor supported safe administration.

## Output, errors, cancellation and settlement

All guest results are untrusted observations. Hash and size verify what arrived; they do not verify a test passed, that a command ran, policy compliance or protected state. UTF-8 output uses a fixed decoder with replacement only for displaying validated raw bytes; retain raw versus sanitized/display hashes separately. Never present redacted bytes under the raw hash. Control sequences/HTML are rendered inert by the owning output port; exact sanitizer/redactor and export lineage must be frozen before runtime admission. Credential detection withholds/quarantines payload under protected custody rather than persisting a secret in ordinary logs/prompts/artifacts; no detector promises to recognize every arbitrary secret. Protected secrets should never be guest inputs in the first place.

Runner `exitCode` is 0..255 or null after a signal; a nonzero **shell** exit is result data, not a transport exception. `timedOut:true` requires null exit; totals cannot be smaller than retained byte lengths, and a known larger total requires an explicit truncation notice. Unknown totals remain null with incomplete-output disclosure. Response result kind and execution ID must match the request exactly. Do not pass unchecked object casts into Schway. Node-style errors are exactly ENOENT/ENOTDIR/EISDIR/EACCES/EPERM/ECHANGED/EINVAL/EFBIG/E2BIG/ETIMEDOUT/EPROTO/EIO; out-of-schema guest codes cause EPROTO without raw diagnostics. Unexpected trusted adapter failures map to safe EIO. Schema/framing/hash/correlation failure is EPROTO at this port, mapped to safe tool error; after possible dispatch it also records unknown. A guest errno is an untrusted claim of rejection, not external proof of no effect.

Three resource facts are independent:

1. **Transport capacity** remains held until the exact channel and all bounded transport tasks/reads close, independently verified by the host adapter. A valid response plus confirmed channel closure can settle transport only.
2. **Operation execution capacity** remains held until registered external management proves the exact execution scope is empty, or proves a permitted transfer to a pre-admitted persistent service allocation. Process group kill inside the guest, a runner cancel response, shell exit, timeout text, `AbortError`, native completion or disconnected socket cannot do this. Root can fork/reparent/forge the guest supervisor. If a scoped descendant fence is not independently enforceable, it is unsupported; retain capacity pending an authorized externally observed VM stop.
3. **VM/service capacity** remains held while that VM/persistent service allocation runs. A proven service transfer moves accounting ownership without refunding charges; it does not prove the service's safety or stop the VM. Only exact external stop/removal evidence can release it. An unsettled service blocks reset/rebind/reuse; no double allocation or invisible daemon adoption.

Cancelling work immediately fences future admission and late publication. Send at most one bounded cooperative `cancel` for the exact original execution through a separately registered cleanup context; release/abort the transport only after its bounded cleanup attempt. `cancel` carries no arbitrary PID, shell text or new management authority. The original conservative reservation must include finite cleanup overhead; no double charge at callback. A later observation is a new authorized finite read, not a retry of the shell command.

Escalating a single-work cancel to a whole shared-VM stop can affect unrelated work/services. It requires current protected authority for that full impact; do not silently stop siblings. If only whole-VM stop can be externally proved and that authority is unavailable, report stopping/unknown, retain capacity and name the limitation. Timeout/unknown operation outcome never means blind retry. `spawn` on cancellation rejects `AbortError` to satisfy the public API while the private ledger remains unsettled. A normal `ExecutionSpawnResult` is returned only after required command-scope settlement/approved service-transfer proof, current publication guard and valid response; until then an unavailable/timeout result cannot claim complete execution. This may limit usable adapters until real scoped proof exists, but does not replace the required administration outcome with read-only support.

`EvidenceV1` is **data**, not a management attestation. `proofHash` resolves an immutable record owned by the protected manager verifier; the receipt must be delivered with its privately registered handle/callback, authenticated manager ref/epoch, exact VM/boot/execution identity, capture time and verified scope/transport state. Guest/copy/owner-statement JSON has no issuer authority. A `vm_stopped` proof may settle all old scopes of that exact boot even after policy revocation; it does not determine whether a shell/remote action already happened. Evidence handling is monotonic: rejecting an untrusted/mismatched proof changes only its decision/code, preserving any already captured response, known channel closure, usage and settled resource facts. Valid stop evidence changes only the exact scopes it proves; it cannot erase captured-response status or re-open a settled channel. A prior unknown historical outcome stays unknown, while a prior guest-reported response remains guest-reported and untrusted. `scope_empty` requires all descendants including guest-root escape paths, not just a PID 1 or killpg response. `service_transferred` requires the exact running service allocation/current lease, effective external resource ownership and no unowned descendants. The physical implementation/proof is deliberately unselected and remains unproven.

Recording sanitized facts under an old trusted claim is allowed after stop/revoke so recovery retains knowledge. Publication separately verifies current owner/policy/work/Bot/VM/boot/attempt/lease/source/access/withdrawal generations, committed producing evidence and delivery dedupe. Do not reserve the same charged action again, require a new unclaimed key or publish late output through another report/export route. Outcome can remain unknown after all processes stop: stop proves cessation, not historical non-occurrence or rollback of external effects.

## Trusted ports and management lifecycle

The following exact proposed signatures use types defined by the schema and the #320 proposal. They are **documentation signatures** for the paths above, not exported code. Private unique-symbol brands explain opacity but cannot authenticate on their own. Constructors/registries stay private to the protected composition root; every writer/I/O boundary checks registry identity/current generation after lock acquisition. Models/guest tools see only narrowed proposals/results, never these ports or handles.

```ts
import type { ExecutionBackend } from 'schway/host';
// Data names below are the exact same named $defs in the documentation schema.
// OwnerActorV1/WorkActorV1/PreparedActionV1 refer to the pinned #320 proposal.
declare const vmHandleBrand: unique symbol, dispatchBrand: unique symbol;
declare const cleanupBrand: unique symbol, managementBrand: unique symbol;
interface VmHandleV1 { readonly [vmHandleBrand]: true }
interface VmDispatchContextV1 { readonly [dispatchBrand]: true }
interface VmCleanupContextV1 { readonly [cleanupBrand]: true }
interface VmManagementActorV1 { readonly [managementBrand]: true }
interface VmMutationPortV1 {
  /** Allocate the trusted invocation slot and resolve current catalogs,
   * bounds and exact action payload. Body input is a narrowing proposal,
   * never an actor/permission; cancel bodies use the cleanup port instead. */
  prepare(actor: WorkActorV1, binding: BindingV1,
    body: RunnerOperationV1): Promise<OperationV1>;
  /** Resolve trusted current policy/catalogs and immutable invocation slot;
   * commit one intent/receipt. No runner or management mutation. */
  accept(actor: WorkActorV1, operation: OperationV1): Promise<ReceiptV1>;
  /** Atomically bind the exact policy claim/reservation and VM claim before
   * I/O. New calls reject existing claims; no reusable permit is returned. */
  dispatch(actor: WorkActorV1, operationId: string,
    operationHash: string, signal?: AbortSignal): Promise<VmOperationObservationV1>;
  /** Read only the exact retained response owned by this registered work/slot.
   * Current scope/hash/lineage and required settlement guard payload access.
   * No transport resend, new effect claim or duplicate reservation. */
  readResult(actor: WorkActorV1, operationId: string,
    operationHash: string): Promise<VmResultReadV1>;
  /** Recheck current publication and retained response hash synchronously,
   * then invoke only the trusted backend callback without an intervening wait. */
  publishResult(actor: WorkActorV1, operationId: string,
    operationHash: string, responseHash: string,
    consume: (response: RunnerResponseV1) => void): void;
  /** Resolve only the original privately retained cleanup context. Registered
   * original ownership can clean up after revoke; it gains no new work power. */
  cancel(actor: WorkActorV1, operationId: string,
    operationHash: string): Promise<VmCancelObservationV1>;
  /** Read-only reconciliation with its own current finite authorization.
   * No new mutation context, shell resend or synthetic stop proof. */
  reconcile(actor: VmManagementActorV1,
    claimId: string): Promise<VmOperationObservationV1>;
}
interface VmOperationObservationV1 {
  operationId: string; operationHash: string;
  outcome: 'not_dispatched' | 'guest_reported' | 'unknown';
  responseHash: string | null;
  transport: 'not_started' | 'unsettled' | 'settled';
  execution: 'not_started' | 'unsettled' | 'stopped' | 'transferred';
  evidenceIds: readonly string[]; actual: UsageV1;
}
type VmResultReadV1 =
  | { operationId: string; operationHash: string; state: 'available';
      code: null; observation: VmOperationObservationV1;
      response: RunnerResponseV1 }
  | { operationId: string; operationHash: string; state: 'pending' | 'withheld';
      code: string; observation: VmOperationObservationV1; response: null };
interface VmCancelObservationV1 {
  operationId: string; operationHash: string;
  state: 'not_requested' | 'requested' | 'unknown';
  signalRequested: boolean | null; observation: VmOperationObservationV1;
}
interface VmTransportPortV1 {
  /** Registered handle/dispatch context must agree with request/hash,
   * endpoint, scope, original reservation and unconsumed process fence. */
  invoke(handle: VmHandleV1, context: VmDispatchContextV1,
    request: RunnerRequestV1): Promise<RunnerResponseV1>;
  /** Cleanup context targets only its original claimed execution. A return
   * reports a guest signal request, never external process settlement. */
  cancel(handle: VmHandleV1, context: VmCleanupContextV1,
    request: RunnerRequestV1): Promise<RunnerResponseV1>;
}
interface VmManagementPortV1 {
  /** Attach/status never provision/start. Actor is privately issued from a
   * current owner-approved lifecycle intent or exact bounded cleanup. */
  apply(actor: VmManagementActorV1,
    command: ManagementCommandV1): Promise<VmManagementObservationV1>;
  /** Independent host-side verification; the object itself is not proof. */
  observe(actor: VmManagementActorV1,
    vm: RefV1, bootGeneration: number): Promise<EvidenceV1>;
}
interface VmManagementObservationV1 {
  commandId: string; commandHash: string;
  state: 'not_dispatched' | 'unknown' | 'observed';
  vm: RefV1; bootGeneration: number; evidenceIds: readonly string[];
}
interface VmPolicyPortV1 {
  /** Read slots need current work/read ceilings; mutation also binds exact
   * prepared action/schema/final bytes and all applicable human gates. */
  check(operation: OperationV1,
    stage: 'accept' | 'claim' | 'final_dispatch'): VmPolicyDecisionV1;
  /** Existing original context/reservation; no incremental re-reservation. */
  continueOriginal(context: VmDispatchContextV1,
    operation: OperationV1, finalBytes: Uint8Array): void;
  /** Publication is separate from new-claim admission and final dispatch. */
  publish(operation: OperationV1, observation: VmOperationObservationV1): void;
}
type VmPolicyDecisionV1 = { state: 'allow' }
  | { state: 'hold' | 'deny' | 'unsupported'; code: string };
/** Only registered protected composition can construct this backend. */
declare function createWorkingVmBackend(handle: VmHandleV1,
  binding: BindingV1, actor: WorkActorV1,
  operations: VmMutationPortV1): ExecutionBackend;
```

The backend has an explicit response/cancellation path: `prepare` → `accept` → `dispatch(actor,id,hash,request.signal)` → `readResult` → synchronous `publishResult` → map the matching `RunnerResponseV1` result to the public method. Protected construction pins the registered handle, immutable default environment/profile and exact actor/binding; no raw registration/endpoint access is needed by a model. File bytes, observation tokens, list/glob/search entries and stdout/stderr come only from that guarded retained response, never an undocumented side channel or a second `invoke`. `readResult` returns `pending` with no payload until required transport/scope settlement, and `withheld` with no payload on current scope/hash/lineage denial. A latched operation cancellation/abort withholds payload with `aborted` even when work policy remains live and a late response/scope proof has arrived. An available result requires nonnull `observation.responseHash = SHA256(C(response))`, settled transport and stopped/transferred execution; the schema encodes those refinements. This is the hash of validated captured JSON payload bytes, excluding the four-byte frame header. A retained response is immutable; redacted/display output has a separate hash as specified above.

`readResult` checks registered actor/slot ownership and current read/publication authority after waits; the expected producing claim is not a duplicate admission. Reading already captured bounded bytes does not claim/reserve/dispatch again. Any additional I/O uses its own current finite read reservation. Before returning core-tool data or calling `onOutput`, the trusted backend calls `publishResult` with the retained response hash. The port repeats current access/lineage/generation/hash/settlement checks, then supplies that exact response to the synchronous trusted callback with no wait between guard and use. The callback validates the matching result arm, registers observation identity or maps file bytes/entries/output, applies the specified secret/output controls and returns/raises the appropriate public result/error. No raw response or callback capability is exposed to the guest/model. Publication cannot reenter mutation dispatch.

An already-aborted dispatch signal refuses before a new claim/send. Register cancellation before the first wait and recheck after claim acquisition. An abort after claim durably fences delivery, runs the same memoized `cancel` path and rejects `AbortError` to the public backend; private response/settlement capture continues under its original bounded context without publishing late bytes. `cancel` looks up the original cleanup context by registered actor/slot and exact operation hash, invokes `VmTransportPortV1.cancel` at most once and records `VmCancelObservationV1`. Repeated signal/explicit cancel requests reuse that result, do not send or charge twice and cannot stop a foreign/sibling scope. Its authority is narrowly retained cleanup, independent of expired/revoked work execution authority; copied actors refuse, and process loss uses separately authorized management reconciliation rather than reconstructing the original context. `signalRequested:true` is still guest-reported cooperative cleanup, not process-stop evidence. The existing transport-close-after-bounded-cleanup rule and all held capacities remain unchanged.

`VmPolicyPortV1` is an internal trusted dependency, not a public allow oracle or guest-supplied verdict. The #320 action adapter pins canonical `OperationV1` payload semantics and final runner/management serialization. Final guard must compare validated payload/target/hash before consuming the **same** original dispatch context. This proposal does not implement/claim a full PreparedAction/Approval/catalog/adapter schema; it names exact integration and freeze obligations. Synthetic policy-port verdicts in the fixtures supply only those declared fake facts. No opaque handle/context/actor is serialized into fixture JSON; labels there are fixture-harness setup, never production authentication.

`ManagementCommandV1` has exact immutable command/request/installation IDs, registration/hash, expected VM/boot/epoch, optional actionHash or original cleanupClaimId, closed operation, expiry/hash. At most one of actionHash/cleanupClaimId is nonnull. Attach/status are reads; lifecycle mutations require current exact action authority, except narrowly authorized **stop of the original scope** through cleanup. A copied management actor, actionHash alone or guest request cannot install/reset/provision a VM. Keep trusted credential resolution and raw endpoints out of command data.

| Management kind | Support/replay contract; all actual adapters unproven |
| --- | --- |
| `attach` / `status` | Resolve only an already owner-registered VM/endpoint; verify external identity/profile/current boot/epoch, no start/provision. Read observations require current finite authorization. Reconnect is metadata-only; cannot resend a runner operation. |
| `start` | Existing VM only, exact live approved lifecycle intent and finite reservation; refuse if old scopes/boot are unsettled. Record new boot generation before issuing a handle. No automatic start from query or restore. |
| `stop` | Exact execution or VM scope. Guest-only kill is cooperative; external stop proof determines settlement. Cleanup context cannot widen to sibling work/service destruction. Reissuing exact physical stop is permitted only as a fresh current authorized cleanup of the same identity after read-back, with finite bounds and no start/reset side effect. No automatic retry from timeout. |
| `reboot` | Destructive/disruptive lifecycle action with current impact authority. Fence all affected leases/publication before I/O; retain old scopes until external stop evidence, then new boot generation. Do not replay after lost response; observe exact prior/current state. |
| `snapshot` | Authorized quiesced capture of named guest disks only; bounded consistency/manifest/hash and storage reservation. No protected-ledger/native/browser snapshot or prevention claim. Unknown capture reconciles; cannot mark partial image complete. |
| `restore` | Exact registered snapshot/hash, current owner impact authority, prior scopes settled and VM fenced; new VM/boot generations and current continuity reconciliation before use. No automatic worker/command release or old authority restore. |
| `reset` / `delete` | Exact current asset inventory/hash, current impact authority, externally observed stop, no foreign/protected paths; durable tombstone/withdrawal before cleanup. Interrupted operation reconciles only, never replayed destructive cleanup without current exact authority. Preserve required history/current ledgers; no S14-private disk or browser-profile promotion/wipe. |

Management receipts/observations and operation receipts occupy the same installation-wide protected request continuity namespace with domain-specific payload hashes; same request with different kind/hash conflicts. Repeated exact request returns original receipt/observation, not fresh authority or repeated I/O. Full management result schema and private observation data are defined in the signatures; implementation must freeze their persistence/receipt mapping and crash ordering, not infer an exactly-once hypervisor effect. Failed attach does not imply start, wrong target does not fall back, and a guest “running” status cannot certify the selected VM.

## Recovery, replay and policy-only boundaries

Claimed runner invocations, shell/admin operations and management mutations are **never automatically replayed**, including a claim crash before known dispatch. Safe metadata queries may be repeated only as separately admitted current bounded reads. Operation/transport IDs, request dedupe, claims, charges, process/VM high-water marks, owner/policy revocations, withdrawals and stop evidence stay in the single **current protected continuity authority**, outside guest/native snapshots and ordinary images. Missing/mismatched prefix/identity/current ledger refuses admission; do not bootstrap an empty ledger.

| Interrupted boundary | Required outcome |
| --- | --- |
| Before accepted intent commit | No receipt/queue/claim; no I/O. Retrying authenticated request can commit once. |
| After acceptance, before claim | Historical receipt stays; reconciliation rechecks all current inputs. No boot replay of queued shell/lifecycle work. A new current live caller may claim the still-unclaimed intent only under frozen admission rules. |
| After claim, before/after unknown send | Unknown/reconcile-only, charged bound retained, context lost on process death. A “not started” guest/local flag cannot reconstruct mutation authority. |
| Guest returns valid output but scope/transport unsettled | Record guest observation separately; hold corresponding capacity; no normal complete result or late artifact publication until required proof/current guards. |
| Stop/revoke while I/O is in flight | Fence admissions/publication immediately; retain observed facts and charges. Exact old-scope external proof may settle resources without renewing work authority. |
| Unexpected reboot / restore / manager restart | Fence all old bindings, reconcile externally selected VM/boot/scopes, current ledger and endpoint; no runner resend or new handle until ambiguity resolves. Unattributable generations remain unknown. |
| Owner says “did not run” | Retain statement basis if an owning later port supports it; never management proof, verified non-occurrence, claim clearing or automatic retry authority. |
| Snapshot/old app rollback | Current claims/usage/withdrawals/request/policy revocations and VM generations win; no restored queue/grant/approval/routine becomes dispatchable. Unrepresentable current facts or unsettled scopes fence both runtimes. |

#320 proposes conservative nonrefundable charged upper bounds, with actual measured/partial/unknown usage separate. This proposal preserves that: unknown is not zero; scope/transport settlement can release concurrent capacity but cannot refund charged work. No numeric allowance, budget period, account/route/model readiness or new provider/billing is inherited from examples or S14. Captured usage that guest root may forge is labelled guest-reported, not protected billing evidence.

Adoption/rollback preserve [ADR 0065](../adr/0065-s15-state-preservation-and-policy-adoption.md) and the [state-transition contract](s15-state-transition-v1.md): one current continuity authority, old/new service boot fence, request identity and all newer facts, original S14/legacy bytes/private account/source/share/computer restrictions. Historical grants/approvals/routines stay nondispatchable. No raw native relocation/copy/profile merge/private-data promotion. Native storage stays opaque at its fixed protected Schway workspace; public inventory/retire/delete/snapshot support is not VM relocation permission. MIG15 owns complete target schemas/materializers, maintenance actors/ports and prior-build reverse compatibility. None is supplied by a guest snapshot or this protocol.

Product-default push/PR/update/replies still hold; personal GitHub publication requires a separately installed bounded rule, merge requires separate authority, and production holds even when triggered by merge. A VM shell cannot acquire those effects through guest networking or credentials. General browser/effect/disclosure support remains in separately protected later slices; this contract does not declare universal enforcement. No permanent-Bot policy change or Jod integration is introduced.

## Protected assets and RT15-01 impact inventory

This is a **candidate classification for review**, not owner acceptance that any guest asset is expendable. An inventory's source/durable/service impact, allowed maintenance scope, recovery objectives and every published guarantee must be frozen per actual installation before activation. Do not inspect secret values to populate it. In guest-root rows, “cannot prevent” means RT15-01 remains unresolved even if protected originals survive.

| Asset class | Candidate custody / impact | Prevention candidate versus recovery; unresolved obligation |
| --- | --- | --- |
| A01 owner ingress, authentication, standing policy, approval/effect/request/current-continuity ledgers | Protected service only; compromise changes authority, can revive claims/budgets or erase withdrawals | Prevent with external custody, no guest mount/device/socket/route/control handle; externally adversarial proof G01/G05/G07. Restore of an old ledger is forbidden, not recovery. |
| A02 provider/Jit/channel/vault credentials, management credentials | Protected credential/broker domain only; disclosure can authorize independent effects | Prevent guest reads via separate custody plus all disclosure routes. No prompt/export/env/log copies. Rotation/revocation after exposure is response, not proof prevention. |
| A03 native sessions/home/correlation workspaces | Fixed protected Schway storage; privacy/history/lease identity impact | Prevent direct guest access; use public opaque lifecycle APIs. No raw copy/relocation/import. Snapshot supports declared recovery only; cannot authorize alternate native roots. |
| A04 website cookies/profile/2FA and sensitive browser control | Separately protected browser domain; sends/payments/private data impact | No guest profile/JS/CDP/token handle; prove supported actual effect/recipient paths in BROW15/DATA15. Session isolation alone is insufficient. |
| A05 immutable owner originals and delivered artifacts | Candidate protected versioned storage; deletion/disclosure changes durable owner data | Working copies only via exact authorized release/lineage; guarded promotion/withdrawal outside guest. Does not prevent deletion of a guest copy or accept that loss. Full promotion API is outside #321. |
| A06 mutable guest workspace, uncommitted edits, downloaded inputs | Inside administrable guest; may contain unique work or approved private copies | Unrestricted root can delete/corrupt them. Snapshots/versioned protected copies can recover captured bytes, not uncaptured edits or prevention. Need actual value/recovery expectations and owner tradeoff if guarantee changes; no expendable default. |
| A07 guest OS/programs/dependencies/environment | Inside guest; breakage can destroy availability or introduce scripts/effects | Arbitrary root can replace OS/runner, erase disk and bypass guest-local wrappers. Rebuild/snapshot recovers, not prevents. External isolation protects host; administration-versus-disruption requirement remains unresolved. |
| A08 guest Docker images/volumes/databases | Guest-only engine/devices; may hold unique business data and persistent effects | No host Docker socket; enforce external VM resources/egress. Root can erase guest volumes/database; backups recover selected consistent versions only. Do not classify valuable volumes as scratch by location. |
| A09 guest services and ongoing responsibilities | Guest service uptime/config/state may matter to other work or people | Whole-VM stop/reboot can disrupt siblings. Need exact impact authority and persistent allocation; snapshots do not preserve uptime or undo outside commitments. No silent single-work→whole-VM cancel. |
| A10 VM disks/snapshots/registration and management identity | Manager-owned handles/storage; guest disk corruption distinct from protected checkpoint deletion | Protect management/snapshot originals outside root and monotonic generations. Guest may corrupt its attached disk. Identity/hash comparison alone does not prevent guest loss. |
| A11 S14/legacy private files/accounts/history and sealed prior build/config | Preserve existing protected/private custody; importing/sharing/wiping changes rights and rollback | No guest conversion/mount/profile merge. Exact owner adoption and current-ledger reverse projection required under ADR 0065; recovery retains newer facts, never resets them. |
| A12 output/check logs/downloads/progress | Untrusted captured guest observations, often sensitive/forged | Bound, sanitize, hash and check lineage/recipient before publication. Root can fabricate “pass” or output; external verification is separate. Redaction/snapshot cannot prove original command truth. |

| Candidate design | What it could prevent | What it cannot prevent / decision status |
| --- | --- | --- |
| C1 external custody + exact promotion/release | Guest root cannot alter protected originals/ledgers/credentials if actual isolation holds | Does not prevent loss of unique guest work, guest OS/Docker volumes or service uptime. A concrete research candidate; **option B is not selected**, loss is not accepted. |
| C2 externally constrained privileged operation executor | Could prevent a finite proven destructive class if every path is mediated | May restrict sudo/root/Docker/services versus S15-D03; no silent restricted/read-only substitute. Requires exact supported operation/bypass proof and owner decision if capability narrows. |
| C3 full guest root + protected snapshots | Can retain recovery points and limit host impact under proven isolation | Cannot prevent unapproved guest destruction/disruption. No universal human-gate claim; weaker guarantee requires an explicit evidence-backed owner decision before activation. |

No command denylist, JSON effect label, guest sudo wrapper or VM firewall resolves this contradiction under arbitrary guest root. Concrete future evidence must show successful required administration **and** attempts at filesystem/block-device erasure, runner replacement, service disruption and nested-container escape, naming affected assets and externally observed outcome. RF15-G02/RT15-01 remain unproven until that design/proof or a required explicit owner tradeoff. No owner decision is necessary merely to prepare this reviewable inventory.

## Freeze/proof obligations and admission limitations

All entries remain **open**. These are obligations within existing slices, not new speculative issues or bypasses of #321's native blocker.

| Gate | Exact obligation |
| --- | --- |
| VM15-FZ01 prerequisite reconciliation | Actual merged reviewed #318/#320 contract/ADR/fixture blobs and #319 continuity inputs must be in the integration base; reconcile every drift in actor/action/placement/support/limits. Open #320 remains a native runtime blocker. |
| VM15-FZ02 schema and trusted ports | Review/freeze closed schema, semantic validator, hash domains, actor/handle/slot issuance, current catalog resolver, policy-only mapping, management observation/receipt persistence and all proposed signatures/TSDoc. No final freeze or implementation admission is delivered here. |
| VM15-FZ03 admission and final I/O | Prove atomic operation/action claim/reservation mapping, request dedupe, original-context continuation, revoke ordering after waits, final bytes/target binding and publication guards. Full target runtime/DDL remains respective POLICY15/MIG15/TEAM15/MEM15 work. |
| VM15-FZ04 management/transport/resources | Select reviewed physical adapter/peer authentication, external VM/boot/execution identity and scoped descendant/service-transfer proof, monotonic deadlines, strict parser/guest filesystem semantics, cleanup bounds and external CPU/memory/PID/disk/egress controls. Real protocol/platform/build proof is not supplied. Unsupported semantics refuse before advertised support. |
| VM15-FZ05 RT15-01 and alternate routes | Freeze actual asset/service value/impact inventory, prevention versus recovery guarantees, required administration and guest-root bypass results. Return concrete owner tradeoff only if confirmed capability/guarantee must change. Keep RF15-G01/G02/G04/G05/G06 unproven meanwhile; no universal firewall/allowlist claim. |
| VM15-FZ06 recovery/adoption | Freeze continuity/request/VM-generation journal, process-loss/old-scope settlement, S14-private nondispatchable adoption, old-build boot fence and supported prior-build rollback preserving all newer facts. Native fixed-workspace/opaque restrictions persist; RF15-G07 unproven. |
| VM15-FZ07 acceptance | EVID15/CUT15 exact artifact/build/contract/policy/host/VM/browser/network evidence on supported Linux x64/arm64 and explicit owner adoption. RT15-01 and RF15-G01–G08 are not proved by documentation/fixtures/review/issue closure. |

The eventual implementation must turn the synthetic scenarios into deterministic Bun/TypeScript tests with scripted ports/fake clocks and two-process claim/reservation barriers, frame/byte fuzz cases, expiry/revoke at every wait/final-I/O boundary, unknown/cancel/late publication, abrupt guest/manager/service restart and all current-continuity restore windows. Real independent VM/root/network/browser/resource proof is separate and opt-in. Full #321 acceptance still requires actual required administration, exact public Schway conformance and protected-boundary evidence; a read-only backend is not completion.

Required Claude UX authoring remains unavailable as recorded in [#337](https://github.com/chayapats/jit/issues/337#issuecomment-6572828439); no retry/provider/model/account/spending change or primary-authored S15 UI is included. This proposal leaves #321 **OPEN / blocked / needs-triage**, all implementation acceptance criteria unchecked, native #320 intact, and uses **Refs #321**. Local validation is document/link/schema/type/fixture/hash/requirement consistency and `git diff --check`; no runtime test/typecheck or executable/live probe is required or claimed.
