# S15 install, upgrade, rollback and uninstall

`install.sh --s15` installs the S15 runtime as its own installation, `jit-s15` ([CUT15-01 #341](https://github.com/chayapats/jit/issues/341)). S14 stays the default selection: bare `install.sh` and `--s14` install `jit-s14`, and `--legacy` installs `jit`. `--s15` cannot be combined with `--s14`, `--legacy` or `--computer-slots`. The S15 installer never reads, rewrites or removes the legacy or S14 installation's identity, config, state, units or releases, and those installers never touch S15. No data is migrated from another installation; S15 starts fresh.

After the installer finishes, the owner never edits a file or types a value the system can infer. Every failure prints `Failed at <step>. Next: <action>`.

## Requirements

- 64-bit Linux (x86_64 or aarch64) with systemd, run as root (or by a user with sudo; the bootstrap re-executes itself under sudo after you approve the plan).
- Debian or Ubuntu for the working computer's packages. The installer installs `sudo`, `openssh-client`, `qemu-system-x86` (x86_64) or `qemu-system-arm` and `qemu-efi-aarch64` (aarch64), `qemu-utils`, `cloud-image-utils` and `netcat-openbsd`, plus the core packages every runtime needs. On other distributions the controller still installs, and the Web offers enrolling your own VM instead.
- KVM: `/dev/kvm`. If this host is itself a VM, turn on nested virtualization in its hypervisor (Proxmox: CPU type `host`).
- Disk: the installer reserve plus 512 MiB to install; the working computer then needs about 60 GiB (sparse) plus a 0.6 GiB base image.
- An operator terminal (`ssh -t` over SSH). The first-owner link is shown only on `/dev/tty`, never in logs.

## Install

From an extracted release (or a checkout):

```sh
./install.sh --s15
```

The installer prints its plan, asks once for approval (`--yes` approves non-interactively; the owner link still needs a terminal), then:

1. Installs the packages above and SHA-256-pinned Bun 1.4.2 at `/opt/jit-s15/bin/bun`.
2. Creates the non-login identities `jit-s15` (the controller) and `jit-s15-vmm` (QEMU for the working computer, member of `kvm`), and the group `jit-s15-vm` that joins them. `jit-s15` is removed from `kvm`; `jit-s15-vmm` is never in `jit-s15`'s group. On a host without a `kvm` group (no QEMU/KVM packages or virtualization) only the controller is installed: no QEMU identity, launcher, sudoers rule or proxy socket, and the unit keeps `NoNewPrivileges=true`. The owner then enrolls their own VM in the Web. A later re-run after the QEMU/KVM packages are installed adds the Jit-managed VM in place; local VM support is never removed once installed.
3. Creates the directories in the layout table, enables linger for both identities, and installs `jit-s15`'s Secret Service (gnome-keyring with a random 0600 boot-unlock file, kept on re-runs) for Schway's credential store.
4. Installs the working-VM launcher `/opt/jit-s15/libexec/jit-s15-vmm` and the sudoers rule `/etc/sudoers.d/jit-s15-vmm`, which lets `jit-s15` run that launcher, as `jit-s15-vmm`, and nothing else. The rule is checked with `visudo -c` before it is installed, and the installer then proves the sudo path end to end.
5. Builds and seals the release under `/opt/jit-s15/releases/<artifact id>`.
6. Writes `/etc/jit-s15/s15-runtime.json` once (see Generated configuration) and runs `init --s15` for a fresh state directory.
7. Installs `jit-s15.service`, `jit-s15-vm-proxy.socket` and the journald namespace `jit-s15`, switches `/opt/jit-s15/current` to the release atomically, starts the controller and checks its sign-in page on the local listener.
8. Shows the first-owner link on the terminal as soon as the controller is healthy. The single-use link is valid for 15 minutes, so it is never held back behind the working computer's setup; re-run `install.sh --s15` for a new one if it expired.
9. Follows the automatic working computer and prints each step (check the host, download, verify the checksum, create the disk and keys, first boot, connect and finish setup, isolation checks, ready), then the owner's remaining steps.

### Layout

| Path | Owner and mode | Contents |
| --- | --- | --- |
| `/opt/jit-s15/{bin/bun,releases/,current,libexec/jit-s15-vmm}` | root, 0755 | Bun, immutable releases, active-release link, launcher |
| `/etc/jit-s15/s15-runtime.json` | root:jit-s15 0640 | generated config (credential-free) |
| `/etc/jit-s15/installer-state.json` | root:jit-s15 0640 | last installed release and host facts |
| `/var/lib/jit-s15` | jit-s15 0700 | controller home: Secret Service, Schway lock, `work/`, `state/` |
| `/var/lib/jit-s15/state` | jit-s15 0700 | S15 state from `init --s15`, including the connection vault and VM keys |
| `/var/lib/jit-s15-vm` | root:jit-s15-vm 0750 | shared working-VM root |
| `/var/lib/jit-s15-vm/control{,/images}` | jit-s15:jit-s15-vm 2750 | verified base images (0440), registry-proxy socket (0660) |
| `/var/lib/jit-s15-vm/machines` | jit-s15-vmm:jit-s15-vm 2750 | per-VM disk, seed and QMP socket |
| `/var/lib/jit-s15-vmm` | jit-s15-vmm 0700 | QEMU identity home (no secrets) |
| `/etc/sudoers.d/jit-s15-vmm` | root 0440 | the single launcher rule |
| `/etc/systemd/system/jit-s15.service`, `jit-s15-vm-proxy.socket`, `/etc/systemd/journald@jit-s15.conf` | root 0644 | units |

### Generated configuration

`s15-runtime/v1` with no owner input and no credential:

- a random `installationId` (`s15_<16 hex>`), `directory` `/var/lib/jit-s15/state`, `origin` `http://127.0.0.1:3002`;
- the approved Codex subscription route for one device login (`gpt-6.1-sol`, effort `high`, subscription charge). It is `available` once `jit-s15` holds a signed-in Codex credential, which Jit reads from the local credential store every 15 seconds (no network); before sign-in it is unavailable;
- `policy: null`, no budget, no personal GitHub rule, `github: null`, `google: null`, team concurrency 2 with memory off, and the empty disclosure configuration;
- `vm: { id: "working", resource: computer, local: true, vmm: { user: "jit-s15-vmm", uid, directory: "/var/lib/jit-s15-vm", launcher } }`, or `local: false` without `vmm` on a host without a `kvm` group;
- `browser: null`. The protected S15 browser needs owner-approved public origins and a disclosure route, and Playwright's Chromium download has no pinned hash Jit can verify, so the installer leaves it off and says so.

A re-run preserves the file byte for byte and changes only the installer-owned `vm.local`/`vm.vmm` in place: it refreshes `vmm` (for example if `jit-s15-vmm` was recreated with a new uid) and turns `local` on once the host has a `kvm` group. A file at that path that is not an `s15-runtime/v1` config for `/var/lib/jit-s15/state` (for example a legacy or S14 service config) is refused before any change. An existing HTTPS private-ingress `origin` is preserved; note that S15 then listens on `127.0.0.1:3001`, the same port as a default S14 installation on the same host.

### Owner steps

All in the Web UI; nothing is typed into a file:

1. Open the link the installer showed (on the host, or from your computer through `ssh -L 3002:127.0.0.1:3002 <host>`) and set the owner password. An existing owner signs in at `http://127.0.0.1:3002/s14/login`.
2. **Settings → Provider** (`/settings/provider`): sign in to Codex with the device code. The credential is stored for the `jit-s15` identity only, and the approved Codex route becomes available within 15 seconds.
3. **Manage → Telegram** (`/resources/telegram`): paste the new BotFather token, press **Check and save**, then bind your account with the one-time code ([s15-telegram.md](s15-telegram.md)).
4. Install your standing rules when you are ready. The installer installs no policy, budget or personal GitHub rule.

### Working computer outcomes

- `Ready`: the computer is enrolled. The installer exits 0.
- No `kvm` group: the controller was installed alone (see step 2). The installer says so and exits 0; enroll your own VM in **Resources → Computer**.
- Unavailable on this host (`vm_kvm_unavailable`, `vm_kvm_denied`, `vm_qemu_missing`, `vm_host_too_small`, `vm_disk_insufficient`, `vm_host_unsupported`): the installer prints the reason and the next step and exits 0. **Resources → Computer** offers enrolling your own VM.
- Failed (for example `vm_image_unavailable` at the download step): the installer prints the step, the reason and the next step and exits 1, but the controller stays installed and healthy, because it is where you press **Try again**.
- Still running after 90 minutes: setup continues in the background; follow it in **Resources → Computer**.

## Upgrade

Run the new release's `install.sh --s15`. The installer seals the new release beside the old ones, stops `jit-s15.service` (the working VM keeps running in `jit-s15-vmm`'s user manager), switches `/opt/jit-s15/current`, rewrites the units, starts and health-checks the controller. Existing state is never re-initialized or migrated. If the new controller does not start or its sign-in page does not answer within 30 seconds, the installer restores the previous release link, unit, socket unit and journald file, starts the previous controller again, checks it and reports `The previous release … is active again and healthy`.

## Rollback by hand

Releases are retained. To return to an earlier one:

```sh
ls /opt/jit-s15/releases
sudo systemctl stop jit-s15.service
sudo ln -sfn /opt/jit-s15/releases/<artifact id> /opt/jit-s15/current.next && sudo mv -T /opt/jit-s15/current.next /opt/jit-s15/current
sudo systemctl start jit-s15.service
```

Re-running the newer `install.sh --s15` moves forward again.

## Failure and recovery

| Failed step | What is left | Next |
| --- | --- | --- |
| `arguments` | nothing written | use one runtime flag; no `--computer-slots` with `--s15` |
| `preflight` | nothing changed | move the foreign file at `/etc/jit-s15/s15-runtime.json` aside |
| `disk-reserve` … `configuration` | identities, directories, launcher, rule or release only; no unit, no active link | fix the named cause and re-run; re-runs repair in place |
| `owner-terminal` | nothing stopped | re-run from a terminal (`ssh -t`) |
| `state-initialize` (fresh) | the state directory this run created is removed | re-run |
| `service-stop` … `health` (fresh) | the new unit, socket unit, journald file, release link and new state are removed | re-run after fixing the cause |
| `service-stop` … `health` (upgrade) | the previous release, units and state are active again | inspect `journalctl --namespace=jit-s15 -u jit-s15.service`, fix, re-run |
| `working-computer` | the controller is installed and healthy; the owner link was already shown | follow the printed reason; **Try again** in **Resources → Computer** |
| `uninstall` (VM still running) | controller stopped and disabled; no unit file removed | run the printed `systemctl --user stop` as `jit-s15-vmm`, then re-run `--uninstall` |

An interrupted `init --s15` (no `state/runtime/composition.json`) is moved aside to `state.interrupted-<time>`, never deleted, and initialization runs again.

## Uninstall

```sh
./install.sh --s15 --uninstall
```

It stops and disables `jit-s15.service` (its proxy socket stops with it) and stops the working VM units, then proves the stop: the stop command succeeded, `jit-s15-vmm`'s user manager lists no `jit-work-*` unit that is still active, and the kernel lists no `qemu-system-*` process owned by `jit-s15-vmm`. Only then does it remove the controller unit, socket unit, journald file and the Secret Service user unit. If a VM is still running, it fails with the exact stop command and removes nothing; re-run it afterwards. It keeps the identities, linger, packages, Bun, releases, launcher, sudoers rule, config, state, working-VM disks and snapshots, and the keyring and unlock file, so a later `install.sh --s15` re-attaches to the same state without re-initializing it. Legacy and S14 installations are not touched.

## Security notes

- QEMU runs as `jit-s15-vmm` ([VM15-03 #378](https://github.com/chayapats/jit/issues/378), [ADR 0067](../adr/0067-s15-working-vm-operation-and-settlement.md#separate-qemu-identity-vm15-03-2026-11-03)). A QEMU escape lands as that unprivileged identity, which cannot read `jit-s15`'s home, vault, state, keys or configuration and has no sudo rule.
- `jit-s15.service` runs with a private mount namespace (`ProtectSystem=strict`, `ProtectHome=tmpfs` with only the two identities' runtime directories bound in, `PrivateTmp`), `RestrictSUIDSGID`, `ProtectKernel*`/`ProtectControlGroups`, `UMask=0077` and bounded memory and tasks. It does not set `NoNewPrivileges`, because the controller reaches the QEMU identity through sudo; the sudoers rule allows one command.
- The registry-proxy socket is bound by `jit-s15-vm-proxy.socket` in the host's root mount namespace. Ubuntu's AppArmor profile for `nc.openbsd` (the guest-forward helper) refuses a socket bound inside the controller's private namespace.
- Logs: `journalctl --namespace=jit-s15 -u jit-s15.service`. The installer never prints the owner link, cookies, tokens or unlock values to a log.

## Dry run

`./install.sh --s15 --dry-run --root /absolute/disposable/root --source <checkout>` (with `host.json` in the root) writes the S15 files into that root only and runs no host command. Deterministic coverage: `bun test tests/s15-installer.test.ts tests/s15-vm-vmm.test.ts`.
