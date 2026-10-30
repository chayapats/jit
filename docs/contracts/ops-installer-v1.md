# Linux installer contract, v1

Owner: Jit #176 INST01. `ops.installer/v1` implements S12-D11/D13, S13-D03/D09,
NFR-07 and NFR-09, using `ops.service_package/v1`, `app.owner_identity/v1` and
`app.setup/v1`. Engineering decisions: ADR 0042. It does not certify real-host
readiness, authorize model inference, or bypass `ops.schema_migrations/v1`.

## Entry points and consent

`curl -fsSL <release>/install.sh | sh` or `./install.sh` from an extracted release
prints the complete change plan and asks once on `/dev/tty` (stdin belongs to
the piped script). `--yes` accepts that plan unattended. `--uninstall` stops and
disables Jit and its installer-managed Secret Service, removes their units and
journald config, and retains identity, linger, packages, Bun, releases, config,
database, ledger, attachments, backups, keyring and its unlock file. Data deletion
is a separate owner operation. No public bind, firewall rule or VPN is installed.

Detection is read-only before consent: 64-bit Linux + systemd, x64/arm64,
`/etc/os-release` as data, RAM, online CPUs, total/available bytes on `/var/lib`.
Debian/Ubuntu families use apt, Fedora/RHEL families use dnf. Other systemd
distributions use the same artifact when core tools are already installed;
missing prerequisites stop at `dependencies` with a next action. No ARM/Pi
constant is used as a host assumption. Unsupported architecture/32-bit userland
fails before mutation.

`--source /absolute/path` selects a trusted local source/service artifact.
Every local package input and ancestor must belong to root or the invoking sudo
owner, without group/other write or symlinks. A `jit`-owned source or an artifact
under its mutable home is refused. The owner-entered bootstrap is opened before
sudo; the privileged shell copies package inputs into a root-owned snapshot
before executing Bun, excluding checkout dependencies, `.env` and `bunfig`.
`/opt/jit/current` is resolved once only after checking its root-owned link and
parent; its resolved source must satisfy the same checks. Uninstall uses the
selected/downloaded release bootstrap, never implicitly executes an older
installed installer from `current`.
`--dry-run --root /absolute/disposable/root` requires `host.json` of the
`HostFacts` shape. It simulates identity, packages, supervisor and health, writes
only inside that root, rejects symlink parents, never invokes sudo/systemctl,
a package manager or Podman, and creates no setup credential. It is a scripted
fixture rather than live host evidence.

## Provisioning and resources

The root bootstrap performs approved administrative steps from its root-owned
snapshot with a minimal environment and protected cwd. It uses the existing
dependency-free service-package API for install/start/stop/uninstall, never a
service-built CLI or `node_modules` as root. `jit.service`, dependency installation
and sealing, all home/keyring/user-unit writes, ledger seeding, schema inspection,
the setup-link helper, Podman and box-doctor run as the
dedicated non-root, non-login `jit` user. Host commands have finite timeouts;
raw command output is captured/discarded. Failures stop with the step name and
a concrete next action. A re-run repeats safe steps and preserves durable data.

| State | Initial value / contract |
| --- | --- |
| Identity | `jit`, non-root UID/GID, non-login shell, home `/var/lib/jit`, mode 0700 |
| Bun | 1.4.2 at `/opt/jit/bin/bun`; x64 baseline or arm64, glibc/musl assets, SHA-256 pinned in bootstrap; atomic replacement through a fresh root-owned temporary file; protected root-owned parents |
| Data | `/var/lib/jit/state`, backups, work, ledger and keyring directories 0700; all home path components traversable by the service identity |
| Attachments | `/var/lib/jit/state/attachments` mode 0700, outside Web root; ATT01 owns runtime quotas/reserve enforcement |
| Service config | `/etc/jit/service-config.json`, root:service GID 0640, directory 0750; existing trusted field values retained, formatting canonicalized by the service package |
| Route defaults | Existing `builtInModels` recommendations for Codex/Grok; `runPort: schway`; configured model selection is not login or verification (FR-13); owner still chooses a route in Web |
| Network/channels | `127.0.0.1:3000`, Telegram disabled; private ingress remains an explicit owner step |
| Service memory | RAM/3, floored to whole MiB, bounded 256 MiB–8 GiB |
| Journald | Disk/1000, bounded 16–256 MiB, retained 14 days; supervisor restart ceilings use service-package defaults |
| Box recommendations | RAM/4 bounded 256 MiB–8 GiB per box, CPUs/2 bounded 0.5–4; capacity RAM/4096 MiB bounded 1–8; recorded in `installer-state.json` until a real execution image is configured |
| Disk reserve | 2 GiB for ordinary disks (20–100 GiB); below 20 GiB use 10% (minimum 256 MiB); above 100 GiB use 2% (maximum 16 GiB). Require another 512 MiB for staging, recheck actual disk after staging |

The installer manages only its default directory layout. A custom service
identity or relocated managed directory stops at `configuration` and directs
the operator to the service package, rather than changing arbitrary host paths.
Existing model/network/resource selections are preserved. Sources are copied
into installer staging; local release files are never chowned or modified.

Podman, uidmap and slirp4netns installation is best effort. An absent Podman
produces a successful chat-only install and an explicit container-unavailable
message. For an available runtime, subordinate-ID allocation considers both
files, preserves existing usable service ranges, and appends an unused 65536-ID
range. Linger, the user manager and `/var/lib/cni` follow the operational runbooks.

### 2026-10-29 — OPS09 user API contract (#224)

After linger/user-manager setup the installer enables and starts the identity's
`systemctl --user enable --now podman.socket`, as that identity. Optional pulls
and box-doctor use the explicitly selected remote API; no container command
enters the hardened service's local rootless namespace. Missing Podman and
unavailable API are distinct chat-only results, each with a next action.
`service install` and `service upgrade` repair this idempotently too; upgrade
rewrites/reloads the unit before activation. Core setup, schema authority,
credential handling and uninstall preservation remain the existing contracts.

The rendered unit retains all sandbox directives, exposes only the optional
user socket directory (and the existing Schway session bus), sets
`JIT_PODMAN_MODE=remote` plus `XDG_RUNTIME_DIR` and hides default container
storage. It grants no access to container storage or setuid helpers.
Socket repair after an absent bind requires a Jit restart. Hosts using a custom
graphroot must exclude that path in unit policy and keep it outside Jit managed
directories. The managed activation CLI entry is accepted under the full OPS08
checks described in ADR 0042; arbitrary symlink invocations stay refused.

The service identity's user unit starts GNOME Secret Service on its own D-Bus.
A cryptographically random unlock value is created once at 0600 and supplied
through systemd `StandardInput=file:` to `gnome-keyring-daemon --unlock` at boot;
stdout/stderr are suppressed. Existing keyrings/unlock files are preserved.
The installer verifies `Locked = false` on the login collection before proceeding.
This does not verify any provider account or inference capability.

## Artifact lifecycle and optional images

`bun ops/package/installer/release.ts <checkout> <fresh-output> <release-tag>`
creates `install.sh`, `jit-install.tar.gz` and `jit-install.tar.gz.sha256` without
publishing. The bootstrap inside both outputs pins downloads to that release
tag. The archive contains the bootstrap and the unchanged service artifact in
`artifact/`, with no dependencies or credentials. The host installs locked,
script-disabled dependencies as the service identity and seals them through
the existing package contract. Root first locks staging directories top-down to
prevent symlink/path swaps during copy, rejecting foreign-owned entries; it then
copies staging to new inodes behind a 0700
root-owned directory, rejects all links/special files (including manifests and
dependency records), sets root:root/no group-or-other-write throughout, then
validates runtime hashes and the original content pin there. Only then is the
copy exposed for service read/traverse access and passed to the service-package
install API. Every parent up to `/` is root-owned, non-symlink and not writable
by group/other. Existing unsafe managed parents, Bun/config/system paths or
release targets fail closed. Open staging descriptors cannot change the copy.
OPS08 also enforces protected release/config/unit paths for every root-run
manual service CLI command; non-root development behavior is unchanged. Its
bootstrap checks before application imports and its staging checks protect the
copy it executes. The installer retains this snapshot flow and dependency-free
API; it does not use the manual CLI. The install API's `skipLedgerSeed` mode
refuses a missing seed instead of writing inside the mutable home as root.
Publish the three assets together; the HTTPS release and checksum share the
same trust origin, not a separate signature authority.

Re-runs repair units and upgrade compatible code. The current service is stopped
only after staging/validation, then the existing `service install` contract
switches releases. Newer/older database schemas stop at `schema-upgrade` with an
OPS06/OPS07 owner-authorized staged-upgrade next action. There is no in-place
migration, password input in the installer, fabricated owner actor, or schema
rollback. Compatible-code health failures stop with the old immutable releases
retained for recovery; the installer does not promise automatic rollback.

Local health polls `http://<bindHost>:<port>/login` (bracketed IPv6) with
`Host: <configured origin host[:port]>`, manual redirects and a total 20-second
bound. HTTPS origins never cause an ingress request; the printed setup link still
uses the configured origin.

After bounded local health verification, one optional **pre-pull pinned images**
step consumes `ops/package/installer/pinned-images.json`, an array of
`{ feature, ref }`. `feature` is `execution-base`, `execution-browser`, `search`
or `sanitizer`; `ref` must be a lowercase image name with a full SHA-256 digest.
Invalid lists, absent Podman and pull failures report unavailable features and
never block core setup. The initial list is empty: the repository builds box
images locally but publishes no usable digest, and WEB02 #178 / ATT02 #191 have
not published their images. Those tickets add real entries when available.
Optional box-doctor uses the configured unit environment as the service identity;
failure never blocks the setup link. Neither step starts a container or enables
execution authority.

## One-time first-owner link

`issueOwnerSetupLink` runs locally as the service identity. A 32-byte random
capability is stored only as SHA-256 + absolute 15-minute expiry in
`<database>.owner-setup.json` (0600), outside normal backup/export images.
Rotation and final owner creation serialize with SQLite's writer lock. An
existing owner prevents issuing/using a link; no re-run resets credentials.

The installer captures the helper's stdout privately, verifies the URL shape,
and prints it once after health and optional steps. No token is placed in argv,
environment, config, ordinary logs, exception text, or stored plaintext. The
operator must not record/copy the printed URL into shared evidence.

`GET /owner/setup?token=…` validates without consuming, sets a short-lived
HttpOnly/SameSite=Strict setup cookie (`__Host-` + Secure on HTTPS) and redirects
to `/owner/setup`. Responses use no-store. The link redirect and invalid-link pages
use no-referrer; the clean form page uses same-origin, because browsers post a
no-referrer page's form with `Origin: null` (amended 2026-10-30, #222). The clean form renders a separate capability-bound CSRF proof, never the
token. POST requires the existing Host/Origin rules, the setup cookie, matching
CSRF, matching password fields and the existing 12–256-character policy.

`Application.completeOwnerSetup` reuses the same Argon2id owner/password-save
machinery as local setup, revalidates the live capability inside the owner commit,
creates exactly one owner, clears old sessions/throttle, and signs in through
normal login. Owner existence is the durable single-use fence; best-effort hash
file removal is not the authority. Expired, rotated, malformed, unsafe-file and
replayed capabilities fail closed. The token never authenticates as an owner
session. SIGN01 #175 supplies subsequent provider login; this installer ends at
the setup link.

## Evidence boundary

Deterministic tests cover fake-root cancellation/install/repair/uninstall, host
sizes, reserve failure, optional degradation, subid collisions, staged-release
portability without dependencies, failure recovery, one-time link expiry and
races, Origin/CSRF, password policy, restart and existing-owner refusal. Fake-root
security fixtures verify root execution/import copies and every parent have no
service write access, retained staging descriptors cannot mutate them, resealed
code/metadata/dependency symlinks fail, and IPv4/IPv6 probes use local HTTP with
an HTTPS origin's Host. They use the fixture uid as simulated root, never sudo.
`bun run typecheck`, full `bun test` and `shellcheck install.sh` are required.
Fresh Ubuntu 24.04 x64 and arm64 Pi 5 acceptance stays unchecked until the owner
opts in and records sanitized evidence using the ops-service runbook. Never
substitute a dry run or desktop suite for real install/reboot/account evidence.
