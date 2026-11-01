# Runbook: install, operate and upgrade the Jit service (OPS07)

Owner-executable checklist for the packaged service (`ops.service_package/v1`, docs/contracts/ops-service-package-v1.md). Build and plan run anywhere; install/enable/start/stop/upgrade on the host happen only in an owner-approved change window. Never paste tokens, addresses or raw diagnostics into issues; attach only sanitized summaries. Every command below has finite timeouts and never downloads packages or requests accounts, except the explicit dependency step in §1.

## 0. Host prerequisites (owner, not automated)

### Default S14 service beside explicit legacy (CUT14-01)

Bare installation now selects the existing independent S14 layout. #256 closed
after PR #304 merged at `143ca06`; its evidence is scoped to recorded builds,
architectures and routes. The [owner-Pi cutover record](../evidence/s14-owner-pi-cutover.md)
records installation/first reply, complete byte-preservation windows and actual
prior-release rollback, including complete post-reply R4 equality. Reviewed #267
closeout remains pending. Follow [the cutover runbook](s14-default-cutover.md) for
a separate authorized change window; use a disposable systemd host for a separate
authorized evidence round. Use an operator terminal: S14 setup capabilities go to
`/dev/tty` only, never redirected stdout/stderr or journald.

From a reviewed checkout at the tested SHA with Bun 1.4.2:

```sh
bun install --frozen-lockfile
bun ops/package/installer/release.ts "$PWD" "$PWD/.local/s14-release" s14-evidence
tar -xzf .local/s14-release/jit-install.tar.gz -C .local/s14-release
# Transfer the release assets to the disposable host through the operator's trusted path.
# In the extracted release directory on that host, as the operator:
./install.sh
```

Alternatively, once that **tested release** has been published, fetch its
tag-pinned `install.sh` from the release and run `sh install.sh` (`--s14` remains an alias). Do not
assume `latest` contains this change. `--yes` skips plan confirmation but still
requires a controlling terminal for link delivery. The terminal is opened before
stopping an existing unit; a headless run stops at `owner-terminal` without
issuing a capability. Capture happens while the unit is stopped, and the link is
displayed only after start and health succeed. Re-run in a terminal. No password,
provider login, image digest or scratch configuration is required in the shell.
Open the link once in Web, create the owner password, then follow the existing
S14 Web setup/provider device sign-in. Account readiness and first inference
remain separate live evidence.
S14 `service status` reports supervisor/configuration only. Its fixed `computerReason: computer_local_podman_required` names a requirement; it is not proof of computer failure or readiness. Use the existing authorized probes/evidence for actual checks.
Installer and upgrade health probe `/s14/login` with manual redirects. Existing
owners enter there too; legacy's `/login` response cannot satisfy S14 health.

| Item | Explicit `--legacy` | S14 default (`--s14` alias) |
| --- | --- | --- |
| Identity/home | `jit`, `/var/lib/jit` | `jit-s14`, `/var/lib/jit-s14` |
| Unit/journal namespace | `jit.service`, `jit` | `jit-s14.service`, `jit-s14` |
| Bun/current/releases | `/opt/jit/` | `/opt/jit-s14/` |
| Config | `/etc/jit/service-config.json` | `/etc/jit-s14/service-config.json` |
| Application database | `/var/lib/jit/state/app.sqlite` | `/var/lib/jit-s14/state/application.sqlite` |
| Listener | `127.0.0.1:3000` | `127.0.0.1:3001` |

Run the same bare `./install.sh` on a host with legacy already installed to
add the separate installation. It preserves legacy database/boxes/backups,
activation link, Bun, config, unit and keyring; only shared OS packages and
append-only subordinate-ID allocation are host-wide. Never point S14 at legacy
state. Each identity has its own linger/user manager, Secret Service, unlock
file, Podman socket and `.schway` lock directory. S14 state includes its own
independent `application.sqlite.lifecycle.sqlite` and `.ops` maintenance tree;
no legacy JSON ledger is seeded or interpreted for it.

S14 uses the same `ProtectSystem=strict`, empty protected home trees, socket/bus
binds, inaccessible container storage, non-root identity, root-owned immutable
release and bounded journald as legacy. Its extra writable paths are only S14
state/native/maintenance, vault and computer roots plus Schway's lock directory.
The unit provisions a **private, disposable 128 MiB tmpfs** at
`/run/jit-s14-git`, mode 0700 and owned by the resolved service UID/GID through
`TemporaryFileSystem=`. `JIT_S14_GIT_SCRATCH` matches it. It exists in the service
mount namespace, disappears on stop and is never a box mount or backup. Host Git
still independently verifies tmpfs capacity/ownership and util-linux `prlimit`;
missing enforcement returns `git_resource_limits_required`, never unlimited Git.

The release includes `ops/box/Containerfile`, runner, sanitizer and CDP relay.
The installer builds both targets through the identity's rootless Podman API,
captures each actual manifest digest, verifies `image exists name@digest` and
writes the pins plus `JIT_S14_COMPUTER_ROOT` into the service environment.
Builds may need package/registry access and take up to ten minutes per target.
Missing Podman, subordinate mappings, socket or image build access leaves chat
available with a concrete feature-off reason; retrying repairs provisioning.

An S14 installer re-run opens the operator terminal and stops only `jit-s14.service` before image mapping preparation. The prior config is retained as `/etc/jit-s14/installer-previous-config.json`. An unavailable image pair still completes as chat-only through start and health. A fatal failure before activation restores that config and resumes a previously active unit when image preparation succeeded. If cleanup is unconfirmed, follow the named cleanup/restore/start-or-rerun action; the prior unit/release stay selected. Failures after activation keep the existing explicit installer recovery procedure.

The root installer provisions eight dedicated workspace/profile ext4 pairs under the S14 computer root: 16 finite 1 GiB sparse images, loop-mounted at boot with nodev/nosuid. Full remaining growth of existing images, new images and the normal reserve must fit available host capacity; otherwise `s14-disk-pool` refuses with `computer_disk_pool_overcommit` and requires freeing space or enlarging the host disk. Loop devices, e2fsprogs and systemd mount support are required; an unprivileged LXC without loop devices cannot provision this backend.

Re-run `./install.sh --s14 --computer-slots 12` to extend to twelve slots (8..1024). Re-runs preserve all image/slot contents and never shrink/reformat. The S14 home/pool parents and inventory become root-owned; mutable service directories and mounted filesystem roots retain their service ownership. Uninstall preserves images and boot mount units so data remains available for repair/reinstall.

Bots claim a free slot transactionally on first use. Idle stop/restart retains it; reset wipes both mounted contents, and delete returns it after successful wipe. Exhaustion returns `computer_disk_pool_full_rerun_installer_to_extend`. There is no directory fallback. The hardened service's own protected Unix API is verified as local; TCP/SSH/foreign sockets still refuse. Missing disk/cgroup/namespace proof remains fail-closed; see [s14-bot-computer.md](s14-bot-computer.md).

For same-device access use the loopback link. A remote operator can use an
explicit SSH tunnel forwarding local port 3001 to host loopback 3001, then open
the printed loopback origin locally. For existing private HTTPS ingress, edit
only S14 `network.origin` in its root-owned config and re-run `--s14`; the local
listener stays `127.0.0.1:3001`. Never reuse legacy's ingress route accidentally.

Service lifecycle (these commands intentionally select S14 **by config**, with
no runtime selector on the config-selected service CLI):

```sh
sudo /opt/jit-s14/bin/bun /opt/jit-s14/current/src/main.ts service status --config /etc/jit-s14/service-config.json
sudo /opt/jit-s14/bin/bun /opt/jit-s14/current/src/main.ts service stop --config /etc/jit-s14/service-config.json
sudo /opt/jit-s14/bin/bun /opt/jit-s14/current/src/main.ts service start --config /etc/jit-s14/service-config.json
journalctl --namespace=jit-s14 -u jit-s14.service
# Remove only S14's units; retain all S14 and legacy data/keyrings/releases:
./install.sh --uninstall
```

Re-run the bare installer (or retained `--s14`) for compatible-code repair/update. Legacy repair/uninstall requires `--legacy`; bare uninstall never removes legacy units. Existing configs without `runtime` remain legacy and are never converted. For an upgrade with automatic
compatible-code health rollback, prepare the new artifact and a protected
root-owned snapshot using section 1 below, substituting `/opt/jit-s14` for
`/opt/jit`. Keep that snapshot outside both service homes. Then:

```sh
sudo /opt/jit-s14/bin/bun "$snapshot/artifact/src/main.ts" service upgrade \
  --config /etc/jit-s14/service-config.json --artifact "$snapshot/artifact" \
  --bun /opt/jit-s14/bin/bun
```

No password is read for same-schema code activation. The service stops before
the new protected build inspects state/fences/lifecycle availability under the
service identity and exclusive S14 runtime lock. Only a matching S14 schema
activates. Health failure stops the new process, rechecks through the previous
build, and restores the prior unit/release only when compatible. To roll back
deliberately, run the same command from the trusted retained release with its
`--artifact /opt/jit-s14/releases/<prior-artifact-id>`. Do not switch symlinks by
hand. Schema changes stay blocked: use owner-authenticated S14 OPS14 staged
maintenance/reconciliation first; the legacy `upgrade --password-stdin` and
legacy backups are never applied to S14. The installer itself retains its
existing stop-on-health-failure policy and immutable previous releases.

Later opt-in service observations, **not run by the implementation agent**:

```sh
(cd / && sudo env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin JIT_S14_SERVICE_EVIDENCE=1 \
  /opt/jit-s14/bin/bun --no-env-file /opt/jit-s14/current/ops/package/s14-service-evidence.ts)
```

The command is read-only: it probes the installed systemd unit, identity,
release pins, private state metadata, the **actual service-namespace** scratch
tmpfs, Secret Service unlock, socket and image availability. It starts no
container or provider call and prints only `ops.s14-service-evidence/v1`
booleans, artifact ID/schema and fixed pending reasons. Keep the summary and
tested Git SHA in ignored `.local` records. No raw journals, config, origin,
capability or credentials enter the summary. Reboot, route inference, computer
isolation, real research coverage/usefulness and backup/restore/lifecycle proof
still require the full #256 procedure on each architecture. A passing
observation or deterministic fixture never closes that gate.

### Explicit legacy one-command installation (retained INST01 reference)

For the retained legacy layout, explicitly select `--legacy`. The S14 default is described above. [ops.installer/v1](../contracts/ops-installer-v1.md)
automates these prerequisites after showing the complete plan and asking once:

```sh
curl -fsSL https://github.com/chayapats/jit/releases/latest/download/install.sh | sh -s -- --legacy
# Or, from an extracted release:
./install.sh --legacy        # --yes skips the one plan confirmation
./install.sh --legacy --uninstall # legacy units only; preserves both installations' data
```

The bootstrap distributed in a release pins its archive URL to that release's
tag. Release owners prepare the three assets with
`bun ops/package/installer/release.ts <checkout> <fresh-output> <release-tag>`
and publish them together; building them does not publish a release.

The service binds only `127.0.0.1:3000`. It prints a single-use setup link; open
it on the host, create the owner password in Web, then continue to ตั้งจิต.
For a remote host, use already configured private HTTPS ingress; an optional
owner-run VPN one-liner is `sudo tailscale serve --bg http://127.0.0.1:3000`
(VPN installation/enrollment is separate). Configure the service's HTTPS origin
using the existing private-ingress contract before using that address, because
Host/Origin checks remain enforced. Installer health uses HTTP on the configured
local/private listener with the HTTPS origin's Host header; ingress DNS/routing
is not needed on the server for installation. No public port is opened by the installer.
Never save the printed link, cookies, passwords or unlock value in evidence.
Provider Web sign-in is SIGN01 #175; INST01 acceptance ends at the setup link.

The installer checks root-owned non-symlink Bun/config/system/release parents
without group/other write. Local `--source` inputs must be protected from `jit`
(including all ancestors); shared writable directories are refused. It snapshots
trusted bootstrap code as root, installs/seals dependencies as `jit`, then copies
staging to new root-owned inodes and validates the original content pin and
runtime hashes there. The installed release and every parent are root-owned;
`jit` only reads/traverses code. Root lifecycle uses the bootstrap's dependency-free
service-package API, so service-built imports are never run as root. Keyring,
user-unit, schema and ledger-seed operations run only as `jit`. An unsafe existing
layout stops with a named next action; use trusted operator recovery rather than
chowning an attacker-writable tree in place.

A re-run preserves existing config/keyring/data and repairs compatible releases.
A schema change reports `schema-upgrade`; use the owner-authorized staged
upgrade below before retrying. No owner password is requested by the installer.
Missing Podman/images produce an explicit chat-only result. Optional pre-pulls
use only published digest entries, initially none (WEB02/ATT02 follow-ups).

Opt-in live acceptance is **not run by the implementation agent**:

1. Owner authorizes a fresh Ubuntu 24.04 x64 VM and an arm64 Pi 5, both with
   systemd; use a local console/private browser, never public ingress. Record
   commit SHA, release asset SHA-256, OS/arch and detected RAM/CPU/disk in ignored
   `.local` evidence. Do not record installation addresses or raw output publicly.
2. Build/publish the tested release assets, run the one command, inspect its
   plan, approve once, and record only step outcomes. Verify service UID is
   non-root and the listener is loopback-only; inspect permissions with
   `stat -c '%a %U' /var/lib/jit/state/attachments /var/lib/jit/keyring-unlock`
   (0700/0600), without reading either file's contents.
3. Open the printed link privately, choose the password only in Web, verify
   redirect to `/setup`, then verify the same link is refused. On a disposable
   fresh installation, let a separate link expire for 15 minutes and verify
   refusal/re-run rotation. Never attach token-bearing screenshots or URLs.
4. Re-run and verify the same database/config/keyring survive; the existing
   owner receives `/login`. Reboot within the owner's window and verify Jit,
   the user bus and unlocked login collection return without terminal unlock.
5. On disposable installations, exercise missing Podman, a forced optional
   image failure, insufficient reserve, retry after a named failure and
   `--uninstall`; verify data/backups/attachments/keyring/config remain. Record
   sanitized pass/blocked + next action per architecture, never raw journals.
6. Leave “chat after Web sign-in” blocked on SIGN01 #175. Do not perform login
   or inference as evidence for INST01 or mark either host accepted until the
   owner supplies this evidence. This procedure does not authorize SSH or a live run.

- A dedicated non-root, non-login service identity (for example `jit`, shell `/usr/sbin/nologin`, home outside `/home`). The package never creates users.
- Service-owned directories, mode 0700: state (for example `/var/lib/jit/state`), backups (`/var/lib/jit/backups`) and working directory (`/var/lib/jit/work`).
- A root-owned releases parent (`/opt/jit`, 0755, no service write).
- All privileged CLI code, dependencies, Bun and their ancestors must be root-owned
  and not writable by group/other. An artifact content/dependency hash alone does
  not establish this. Builds/dependency installs may run as `jit` or another
  unprivileged operator; root executes only the protected snapshot below. The
  operator must trust and review the build inputs and resulting release.
- The pinned Bun at an absolute path (`bun --version` must equal the manifest pin).
- Private access: bind loopback behind configured private ingress (for example a VPN `serve`/reverse proxy terminating HTTPS), or an address on the VPN interface with an explicit HTTPS `network.origin` (required for any non-loopback bind). No public ingress is installed or exposed by the package.
- Credentials: the Telegram bot token, when used, is a 0600 file owned by the identity. Keyring-backed references stay `verify-secret-store` until OPS05 proves service-context access.
- `runPort: "schway"`: Schway reads Grok/Codex logins from the identity's own Secret Service. The identity needs a lingering user manager (`loginctl enable-linger <identity>`), a Secret Service on its session bus (for example a `gnome-keyring-daemon` user service), a collection unlocked at user-session start, and its own `/login` per route (Pi runbook Round B). The unit then binds only `/run/user/<uid>/bus` and starts after `user@<uid>.service`; plan blocks with `enable-service-user-session-bus` while that socket is missing. Never copy another user's keyring or CLI credentials.

## 1. Build and prepare the artifact

```sh
bun ops/package/bun-build.ts <checkout> <outDir> jit.schway.bridge/v1
bun ops/package/bun-build.ts install-deps <outDir>   # on the target host/arch; needs registry or Bun cache access
```

- Review `manifest.json`: app, Bun, lockfile, schema, engine contract, build arch and content hash must match the tested revision. `piValidation` stays `pending`; a desktop build never proves ARM64.
- `install-deps` is the only step that may fetch packages, and only when the owner runs it. Run it on the target host/arch as `jit` or another unprivileged builder. Do not execute the build output with sudo.

### Trusted operator-built, root-owned snapshot (OPS08)

The operator must trust the source and dependencies: ownership checks do not
certify their provenance. Before the copy, verify `/`, `/opt`, `/opt/jit` and
`/opt/jit/bin/bun` are root-owned, non-symlink and without group/other write.
Use the pinned Bun version. Never repair an attacker-writable source by chowning
it in place: retained descriptors and hardlinks can still change those inodes.

After building, run this copy-and-validate procedure. `newDir` is the absolute
build output, including sealed host dependencies. `mktemp` creates a fresh 0700
root-owned parent; keep it private until every check succeeds. Stop on any
failure and discard that snapshot; do not resume with a partly checked tree.

```sh
set -eu
newDir=/absolute/path/to/newDir
snapshot="$(sudo mktemp -d /opt/jit/operator-release.XXXXXXXX)"
sudo cp -R --no-dereference -- "$newDir" "$snapshot/artifact"
# A private copy has new inodes; no source descriptor can modify it.
sudo find "$snapshot/artifact" ! -type f ! -type d -print -exec false {} +
sudo chown -hR root:root "$snapshot/artifact"
sudo find "$snapshot/artifact" -type d -exec chmod 0755 {} +
sudo find "$snapshot/artifact" -type f -perm /111 -exec chmod 0755 {} +
sudo find "$snapshot/artifact" -type f ! -perm /111 -exec chmod 0644 {} +
(cd / && sudo env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /opt/jit/bin/bun --no-env-file -e '
  const dir = process.argv[1];
  const { assertRootTree } = await import(`${dir}/ops/package/trusted-paths.ts`);
  assertRootTree(dir);
  const { validateArtifact } = await import(`${dir}/ops/package/bun-build.ts`);
  if (!validateArtifact(dir, { runtime: true }).ok) throw new Error("invalid_release_snapshot");
' "$snapshot/artifact")
sudo chmod 0755 "$snapshot"
```

Use `$snapshot/artifact` as `<root-owned artifact>` below. Every root-run
`service` command, including `plan`, `status`, `stop` and `uninstall`, checks the
running release/imports, an explicit `--artifact`, Bun, source/installed config,
unit/drop-ins, journald and release paths before use. Symlinks, foreign ownership
or group/other write fail with `unsafe_root_path`, the exact failing path and
`sudo cp -R --no-dereference -- "$newDir" "$snapshot/artifact"` as the next copy
command. Config/unit path errors also require replacing those inputs with
protected files. The managed root-owned `current` link is checked separately
and only its checked, direct target is read. OPS09 (2026-10-29) accepts the exact
managed CLI entry `/opt/jit/current/src/main.ts` when it resolves to the running
protected release. Use it for installed lifecycle/status commands; upgrades
still invoke the new snapshot directly. Arbitrary aliases remain refused. Development/non-root commands retain
their existing behavior. The dependency-free bootstrap checks the release before
loading application imports and recovers the original Linux invocation path
from `/proc/self/cmdline` because Bun resolves `argv[1]` through symlinks. Use
the direct invocation shown here; unsupported wrappers fail closed. The operator
must still choose trusted bootstrap code and Bun before invocation.

For a first install, copy the reviewed, secret-free configuration into protected
storage too:

```sh
sudo install -o root -g root -m 0600 .local/service-config.json "$snapshot/service-config.json"
```

Use that absolute file as `<root-owned config>` for plan/install; `.local` is not
a privileged config input.

## 2. Write and plan trusted configuration

Create ignored `.local/service-config.json` (fields in the contract), review it and copy it into the protected snapshot as in §1. Configure exactly one `ledgerPath` for the installation and never hand-edit that file after the service has established it. Then:

```sh
sudo <abs root-owned bun> <root-owned artifact>/src/main.ts service plan --config <root-owned config> --artifact <root-owned artifact> --bun <abs root-owned bun>
```

- Run as root: access is checked as the service identity with `runuser -u <identity> -- test ...` (state, backups, ledger, working directory, release parent, config directory, credential files).
- Exit 0 only when every check passes; each blocked check names its next action (create identity, restrict directory, provision credential file, install pinned Bun, rebuild artifact, bring up private interface, stop running unit).
- The plan prints the exact unit and journald texts, file paths/modes/digests and commands; secret references appear by name only. Nothing is written.

## 3. Install

```sh
sudo <abs root-owned bun> <root-owned artifact>/src/main.ts service install --config <root-owned config> --artifact <root-owned artifact> --bun <abs root-owned bun>
```

- Run as root. Creates `/etc/jit` as root:<service gid> 0750 and writes `/etc/jit/service-config.json` (root:<service gid>, 0640), `/etc/systemd/system/jit.service` (0644), `/etc/systemd/journald@jit.conf` (0644), stages `/opt/jit/releases/<artifactId>`, points the active-release symlink, seeds the ledger placeholder only if absent (owned by the service identity, 0600), `daemon-reload` and `enable`. It does not start the service.

## 4. Owner setup, start, status, stop

```sh
sudo -u <identity> JIT_DATABASE=<stateDirectory>/app.sqlite \
  <abs bun> /opt/jit/current/src/main.ts setup          # trusted local owner provisioning (once; interactive password)
sudo <abs root-owned bun> <root-owned artifact>/src/main.ts service start
sudo <abs root-owned bun> <root-owned artifact>/src/main.ts service status                     # or as a member of the service group: /etc/jit is root:<gid> 0750
sudo <abs root-owned bun> <root-owned artifact>/src/main.ts service stop
journalctl --namespace=jit -u jit.service                # bounded by journald@jit.conf
```

- The first start turns the install seed into the real OPS02 ledger checkpoint at `ledgerPath`. From then on, a missing, replaced, tampered or relocated checkpoint blocks activation (`Service blocked at quarantine: lifecycle ledger ...`). Restore the file from its configured location or copy the verified checkpoint to a new location; never hand-edit it or reseed it.
- Start runs `serve --service-config`: preflight, quarantine/ledger, schema/upgrade, engine and artifact gates, reconciliation, then listening. A blocked gate exits with `Service blocked at <gate>: ... (next: ...)`; resolve it, never bypass it. `bun src/main.ts preflight --service-config /etc/jit/service-config.json` shows all gates read-only.
- Status: `running` needs the scheduler owned by the supervised process; `observed-ready` appears only with explicit live evidence. `channels: blocked` means Telegram is enabled but its secret or transport is unavailable; `routes.verified` is always 0 here.
- Stop drains cooperatively within `stopTimeoutSeconds`; systemd kills after `TimeoutStopSec`. Interrupted work and uncertain sends are recorded as interrupted/`unknown` and reconciled on the next start; never treat them as stopped or sent.
- Telegram (`channels.telegram: enabled`) fails closed in this build: no live Bot API transport ships, so preflight reports `install-supported-telegram-transport`. Leave it `disabled` until a supported transport exists.
- Run-port: `runPort: "schway"` makes the unit set `JIT_RUN_PORT=schway`; the pinned bridge must verify before admission, without falling back to another route or billing path.

## 5. Upgrade and rollback

One procedure: build as `jit` or another unprivileged operator, copy into a fresh
root-owned snapshot, validate that copy, then run the new snapshot directly.
This complete block includes the §1 snapshot procedure. Do not run an
artifact beneath a service-owned home with sudo, even when its hashes pass.

```sh
set -eu
checkout=/absolute/path/to/new-checkout
newDir=/absolute/path/to/newDir
bun "$checkout/ops/package/bun-build.ts" "$checkout" "$newDir" jit.schway.bridge/v1
bun "$checkout/ops/package/bun-build.ts" install-deps "$newDir"
snapshot="$(sudo mktemp -d /opt/jit/operator-release.XXXXXXXX)"
sudo cp -R --no-dereference -- "$newDir" "$snapshot/artifact"
# A private copy has new inodes; no source descriptor can modify it.
sudo find "$snapshot/artifact" ! -type f ! -type d -print -exec false {} +
sudo chown -hR root:root "$snapshot/artifact"
sudo find "$snapshot/artifact" -type d -exec chmod 0755 {} +
sudo find "$snapshot/artifact" -type f -perm /111 -exec chmod 0755 {} +
sudo find "$snapshot/artifact" -type f ! -perm /111 -exec chmod 0644 {} +
(cd / && sudo env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /opt/jit/bin/bun --no-env-file -e '
  const dir = process.argv[1];
  const { assertRootTree } = await import(`${dir}/ops/package/trusted-paths.ts`);
  assertRootTree(dir);
  const { validateArtifact } = await import(`${dir}/ops/package/bun-build.ts`);
  if (!validateArtifact(dir, { runtime: true }).ok) throw new Error("invalid_release_snapshot");
' "$snapshot/artifact")
sudo chmod 0755 "$snapshot"
(cd / && sudo env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /opt/jit/bin/bun --no-env-file \
  "$snapshot/artifact/src/main.ts" service upgrade --artifact "$snapshot/artifact" \
  --bun /opt/jit/bin/bun --password-stdin)
```

The installed root-owned `/etc/jit/service-config.json` is used by default.
The owner password still goes through the existing terminal/stdin path, never
argv, environment or a recorded command. The installer already makes protected
snapshots and continues to use its dependency-free API.

- Run the upgrade from the protected new build: it validates the artifact, refuses an older-than-state artifact or a quarantined ledger, stops the unit, runs the new build's owner `upgrade` (ops.schema_migrations/v1: fence, verified recovery point in the configured backup directory, staged migration, validation, activation), switches the release, starts and health-checks.
- `upgrade-failed`: the prior release stays active; inspect the upgrade journal (Web `/upgrades`).
- `rolled-back`: health failed and the prior release was compatible with the state; it is active again.
- `activation-unhealthy`: health failed after a schema change; the service stays stopped. Return to the prior version only through an OPS02 quarantined restore of `recoveryBackupId`. Never point the symlink back by hand.
- After switching to a build with a newer schema (for example schema 23 from OPS02), `serve` refuses the installation until the owner `upgrade` has run; `service upgrade` performs that step.

## 6. Disable or remove

```sh
sudo <abs root-owned bun> <root-owned artifact>/src/main.ts service disable      # stop and disable boot start
sudo <abs root-owned bun> <root-owned artifact>/src/main.ts service uninstall    # also remove unit and journald files
```

- Configuration, releases, state, backups, the ledger and secret references are preserved. Deleting managed data requires a distinct authorized operation.

## 7. Evidence boundaries and the Pi live round

- Deterministic tests simulate systemd, `getent`, `ip`, dependency install and upgrade outcomes; they really build, install into disposable directories, boot the full app from the release, authenticate the owner over HTTP and persist state across stop/start.
- `JIT_OPS_SMOKE=1 bun run ops:smoke` (Linux arm64 only) builds, installs dependencies, validates and launches the release against disposable state. It is opt-in and not part of `bun test`; its summary still is not reboot evidence.
- Real unit install, unattended boot, restart/reboot, credential access and VPN reachability on the Pi belong to OPS05 (#36, `docs/runbooks/pi-live-round.md` Round D). Probe-only FEAS05 (#25) evidence does not substitute.

## 2026-10-29 — OPS09 container API in the hardened unit (#224)

Installer, `service install` and `service upgrade` enable the identity's
user `podman.socket` idempotently and preserve linger. Upgrade also replaces
the installed descriptor with the new rendered descriptor and reloads systemd.
`NoNewPrivileges`, strict filesystem protection, SUID/SGID restriction and the
other sandbox directives stay enabled. The system unit binds only the optional
`/run/user/<uid>/podman` directory and its existing Schway bus, and cannot access
default rootless storage below the identity's home. Never grant writable
access to the home or disable the sandbox to fix a container feature.

Read-only status now includes separate `podman.state` and `podman.nextAction`:

```sh
sudo /opt/jit/bin/bun --no-env-file /opt/jit/current/src/main.ts service status
```

`not-installed` means install Podman/rootless dependencies and re-run install
or upgrade. `socket-unavailable` means repair the user manager/socket (commands
in execution-box.md §2), then restart Jit. The optional bind permits chat-only
startup when Podman is absent; if its directory did not exist at service start,
a restart is required after repair. Web displays these states in `th`/`en` with
operator commands; provisioning/rebinding needs operator privileges, so Web does
not invoke a privileged repair. Existing provider-selection/test controls remain
available. A custom Podman graphroot needs an operator `InaccessiblePaths=`
exclusion too and must stay outside Jit managed/writable paths.

Use [execution-box.md OPS09 live verification](execution-box.md#ops09-live-verification-2026-10-29)
for the opt-in reference-host checks, including every sandbox directive, all
three container-backed features, unavailable-socket recovery and reboot.
