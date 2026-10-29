# Runbook: install, operate and upgrade the Jit service (OPS07)

Owner-executable checklist for the packaged service (`ops.service_package/v1`, docs/contracts/ops-service-package-v1.md). Build and plan run anywhere; install/enable/start/stop/upgrade on the host happen only in an owner-approved change window. Never paste tokens, addresses or raw diagnostics into issues; attach only sanitized summaries. Every command below has finite timeouts and never downloads packages or requests accounts, except the explicit dependency step in §1.

## 0. Host prerequisites (owner, not automated)

### One-command installation (INST01)

For a fresh default-layout installation, [ops.installer/v1](../contracts/ops-installer-v1.md)
automates these prerequisites after showing the complete plan and asking once:

```sh
curl -fsSL https://github.com/chayapats/jit/releases/latest/download/install.sh | sh
# Or, from an extracted release:
./install.sh                 # --yes skips the one plan confirmation
./install.sh --uninstall     # preserves all data, credentials and releases
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
  not establish this. Run manual builds/dependency installs as a trusted operator,
  never the `jit` identity that the service runs under.
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
- `install-deps` is the only step that may fetch packages, and only when the owner runs it. Run it on the host that will execute the artifact, as a trusted unprivileged operator whose source/output trees and ancestors are not writable by `jit`.
- Before any sudo command, copy the complete artifact (including dependencies)
  into a fresh root-only directory under a verified root-owned `/opt/jit`, using
  a copy that does not dereference symlinks. While that parent is still 0700,
  reject every symlink/special file, assign root:root throughout, remove all
  group/other write bits, validate content/dependency hashes from the protected
  copy and verify root-owned/non-writable ancestors up to `/`. Only then grant
  read/traverse access (0755 directories, 0644/0755 files). Use this protected
  snapshot as `<root-owned artifact>` below, and a pinned root-owned Bun binary.
  Do not rename/chown a service-writable tree in place: open descriptors survive.

## 2. Write and plan trusted configuration

Create ignored `.local/service-config.json` (fields in the contract). Configure exactly one `ledgerPath` for the installation and never hand-edit that file after the service has established it. Then:

```sh
sudo <abs root-owned bun> <root-owned artifact>/src/main.ts service plan --config .local/service-config.json --artifact <root-owned artifact> --bun <abs root-owned bun>
```

- Run as root: access is checked as the service identity with `runuser -u <identity> -- test ...` (state, backups, ledger, working directory, release parent, config directory, credential files).
- Exit 0 only when every check passes; each blocked check names its next action (create identity, restrict directory, provision credential file, install pinned Bun, rebuild artifact, bring up private interface, stop running unit).
- The plan prints the exact unit and journald texts, file paths/modes/digests and commands; secret references appear by name only. Nothing is written.

## 3. Install

```sh
sudo <abs root-owned bun> <root-owned artifact>/src/main.ts service install --config .local/service-config.json --artifact <root-owned artifact> --bun <abs root-owned bun>
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

```sh
bun ops/package/bun-build.ts <new checkout> <newDir> jit.schway.bridge/v1
bun ops/package/bun-build.ts install-deps <newDir>
# Build/install dependencies as the trusted operator, then snapshot/seal as in §1.
sudo <abs root-owned bun> <root-owned new artifact>/src/main.ts service upgrade --artifact <root-owned new artifact> --password-stdin
```

- The earlier manual pattern of building as `jit` beneath
  `/var/lib/jit/artifacts/<sha>` and then running its `src/main.ts` with sudo is
  affected by the same root escalation: that identity can alter code or imports
  before/during invocation, and can replace even root-owned children via its
  writable parents. Do not use it. The service CLI has no general executable-tree
  ownership gate yet; enforcing that for all manual install/upgrade callers is a
  follow-up. The installer enforces its own protected path and does not invoke
  the staged CLI as root. The inner schema `upgrade` already runs as the service
  identity; that does not protect the initial root CLI import.
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
