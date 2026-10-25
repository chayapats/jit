# Runbook: install, operate and upgrade the Jit service (OPS07)

Owner-executable checklist for the packaged service (`ops.service_package/v1`, docs/contracts/ops-service-package-v1.md). Build and plan run anywhere; install/enable/start/stop/upgrade on the host happen only in an owner-approved change window. Never paste tokens, addresses or raw diagnostics into issues; attach only sanitized summaries. Every command below has finite timeouts and never downloads packages or requests accounts, except the explicit dependency step in §1.

## 0. Host prerequisites (owner, not automated)

- A dedicated non-root, non-login service identity (for example `jit`, shell `/usr/sbin/nologin`, home outside `/home`). The package never creates users.
- Directories owned by that identity, mode 0700: state (for example `/var/lib/jit/state`), backups (`/var/lib/jit/backups`); a working directory (`/var/lib/jit/work`); a releases parent (`/opt/jit`).
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
- `install-deps` is the only step that may fetch packages, and only when the owner runs it. Run it on the host that will execute the artifact.

## 2. Write and plan trusted configuration

Create ignored `.local/service-config.json` (fields in the contract). Configure exactly one `ledgerPath` for the installation and never hand-edit that file after the service has established it. Then:

```sh
sudo bun src/main.ts service plan --config .local/service-config.json --artifact <outDir> --bun <abs bun>
```

- Run as root: access is checked as the service identity with `runuser -u <identity> -- test ...` (state, backups, ledger, working directory, release parent, config directory, credential files).
- Exit 0 only when every check passes; each blocked check names its next action (create identity, restrict directory, provision credential file, install pinned Bun, rebuild artifact, bring up private interface, stop running unit).
- The plan prints the exact unit and journald texts, file paths/modes/digests and commands; secret references appear by name only. Nothing is written.

## 3. Install

```sh
sudo bun src/main.ts service install --config .local/service-config.json --artifact <outDir> --bun <abs bun>
```

- Run as root. Creates `/etc/jit` as root:<service gid> 0750 and writes `/etc/jit/service-config.json` (root:<service gid>, 0640), `/etc/systemd/system/jit.service` (0644), `/etc/systemd/journald@jit.conf` (0644), stages `/opt/jit/releases/<artifactId>`, points the active-release symlink, seeds the ledger placeholder only if absent (owned by the service identity, 0600), `daemon-reload` and `enable`. It does not start the service.

## 4. Owner setup, start, status, stop

```sh
sudo -u <identity> JIT_DATABASE=<stateDirectory>/app.sqlite \
  <abs bun> /opt/jit/current/src/main.ts setup          # trusted local owner provisioning (once; interactive password)
sudo bun src/main.ts service start
sudo bun src/main.ts service status                     # or as a member of the service group: /etc/jit is root:<gid> 0750
sudo bun src/main.ts service stop
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
sudo <abs bun> <newDir>/src/main.ts service upgrade --artifact <newDir> --password-stdin
```

- Run the upgrade from the new build: it validates the artifact, refuses an older-than-state artifact or a quarantined ledger, stops the unit, runs the new build's owner `upgrade` (ops.schema_migrations/v1: fence, verified recovery point in the configured backup directory, staged migration, validation, activation), switches the release, starts and health-checks.
- `upgrade-failed`: the prior release stays active; inspect the upgrade journal (Web `/upgrades`).
- `rolled-back`: health failed and the prior release was compatible with the state; it is active again.
- `activation-unhealthy`: health failed after a schema change; the service stays stopped. Return to the prior version only through an OPS02 quarantined restore of `recoveryBackupId`. Never point the symlink back by hand.
- After switching to a build with a newer schema (for example schema 23 from OPS02), `serve` refuses the installation until the owner `upgrade` has run; `service upgrade` performs that step.

## 6. Disable or remove

```sh
sudo bun src/main.ts service disable      # stop and disable boot start
sudo bun src/main.ts service uninstall    # also remove unit and journald files
```

- Configuration, releases, state, backups, the ledger and secret references are preserved. Deleting managed data requires a distinct authorized operation.

## 7. Evidence boundaries and the Pi live round

- Deterministic tests simulate systemd, `getent`, `ip`, dependency install and upgrade outcomes; they really build, install into disposable directories, boot the full app from the release, authenticate the owner over HTTP and persist state across stop/start.
- `JIT_OPS_SMOKE=1 bun run ops:smoke` (Linux arm64 only) builds, installs dependencies, validates and launches the release against disposable state. It is opt-in and not part of `bun test`; its summary still is not reboot evidence.
- Real unit install, unattended boot, restart/reboot, credential access and VPN reachability on the Pi belong to OPS05 (#36, `docs/runbooks/pi-live-round.md` Round D). Probe-only FEAS05 (#25) evidence does not substitute.
