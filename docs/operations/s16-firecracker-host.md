# Prepared Firecracker host

COMPUTER16-01 uses the selected offline Linux/KVM profile in
[ADR 0102](../adr/0102-s16-computer-backends-and-portable-state.md) and the
[versioned computer contract](../contracts/s16-computer-backends-v1.md).
This is installation guidance, not a native acceptance receipt or authorization
to alter an owner host. Real host/image/device proof remains LIVE16-01 #431;
owner-host activation remains CUT16-01 #432.

The helper runs separately as root on a trusted glibc Linux x86_64/aarch64 host
with KVM, cgroup v2 and systemd private bind mounts. The initial native ABI uses
the Debian/Ubuntu multiarch libc paths on x86_64/aarch64. Before admitting any VM,
startup resolves the pidfd/poll/signal ABI against its own process and opens the
exact KVM character device; it sends no probe signal and creates no KVM VM.
Jit runs as its separate
nonroot controller identity, whose actual UID/GID must match the helper's
authenticated declaration. The working microVM has its own dedicated UID/GID,
no NIC or shared host mount, and no Jit, provider, vault, helper credential or
protected state. The controller reaches guest SSH through the helper's fixed
loopback/vsock forwarder, with a VM-only private key and pinned guest host key.
Guest-root/systemd/SSH/Python prerequisites remain ordinary enrollment checks.
The guest image must contain the reviewed public management key; a public key
or guest echo does not certify host isolation.

An authorized administrator prepares these inputs before starting the helper:

- Matching pinned static musl Firecracker/jailer v1.18.0, kernel and optional
  initrd, with exact byte counts/hashes and retained upstream licenses/provenance.
  The repository neither downloads nor redistributes those external payloads.
- Exact closed launch profile, dedicated VMM/controller identities and private
  raw `rootfs.ext4` with its original device/inode/size/seed hash. The installer
  records custody; model/guest output cannot provide it. Root-owned kernel,
  config and optional initrd remain guest-readable after the jailer's UID drop.
- Prepared private jail/run directories and the unmodified jailer's reviewed
  devices. Initial directories may be root-owned until jailer changes them.
  The empty root-owned `<jailerBase>/.jit-proc-misc` file is bound read-only over
  `/proc/misc` only inside the launch unit. The host inventory is unchanged.
- Root-owned mode-0700 `<jailerBase>/.jit-recovery/<instanceId>` on the same local
  filesystem as the jail. Cold copies need space for immutable snapshots and a
  full temporary restore file; there is no automatic root-data cleanup.
- A separate root-owned mode-0700 state directory, private configuration and
  private 32–256-character relay credential file. Keep both state and credential
  outside the jailer/guest recovery tree. Retain the controller's copy only in
  its protected vault. Bind both management and SSH to fixed distinct loopback
  ports; do not expose the management listener to a working/public network.

`FirecrackerDaemonConfig` in
[`daemon.ts`](../../src/s15/vm/firecracker/daemon.ts) is the closed
`s16-firecracker-host/v1` schema. It carries installation ID, state directory,
credential file, management/SSH/guest ports and the protected profile/host/pins/
disk selection. It accepts no shell, installer command, download URL or working
input. Keep installation-specific addresses, hashes and receipts in ignored
`.local` records, not this guide. Config/credential changes fence the running
helper; review and restart it with retained state instead of silently retargeting
an admitted original operation.

Build the standalone helper with the repository's pinned Bun toolchain. Set
`JIT_FIRECRACKER_DIST` and `JIT_FIRECRACKER_CONFIG` to the approved installation's
distribution directory and private configuration file in the operator shell:

```sh
bun build --target=bun --outfile="$JIT_FIRECRACKER_DIST/jit-firecracker-host.js" src/firecracker-cli.ts
```

Run only the reviewed artifact after the real host changes received their own
required authorization. Initial state creation is explicit and refuses an
existing database; normal serving refuses a missing database:

```sh
bun "$JIT_FIRECRACKER_DIST/jit-firecracker-host.js" initialize --config "$JIT_FIRECRACKER_CONFIG"
bun "$JIT_FIRECRACKER_DIST/jit-firecracker-host.js" serve --config "$JIT_FIRECRACKER_CONFIG"
```

Each command serves until terminated; `initialize` does not create an account,
install payloads, generate a credential or launch a microVM automatically.
Successful startup prints only `s16-firecracker-host-ready/v1`, computer ID and
selection digest. Failures print a fixed safe code. Ports, credentials and
native diagnostics are absent from ordinary output.

The helper holds its OS singleton across recovery and serving. Shutdown fences
new calls, closes API/SSH transports and drains original drivers before releasing
the journal/lock. It does not stop the systemd-owned microVM. An interrupted
driver remains an original unknown; reopening never replays it. Missing used
custody, wrong pins, occupied ports and incomplete disk settlement hold the
computer instead of selecting a replacement. Do not remove the journal, copy
it from a guest snapshot, recycle tags or delete partial recovery stages to
force admission.

Controller enrollment and capability views must distinguish the offline
profile from local QEMU's network/browser/desktop support. Protocol fixtures,
bundle compilation and a refusal on a Mac are implementation evidence only.
They are not the separate Linux/KVM stop/isolation or live-image acceptance.
