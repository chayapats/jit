---
status: accepted
scope: INST01 and OPS08 engineering choices; implements S12-D11/D13 and S13-D03/D09
---

# One-command Linux provisioning and first-owner Web capability

The confirmed product decisions remain S12-D01–D13 and S13-D01–D10. This record
selects implementation details for #176 (`ops.installer/v1`), consuming ADR 0022's
service package and retaining ADR 0026's owner-authorized staged migration gates.
It does not widen project access or model authority (ADRs 0004 and 0037).

Use a POSIX shell bootstrap for detection, a complete plan and one approval,
minimal dependency/Bun provisioning, and HTTPS release fetching. Bun/TypeScript
then provisions the dedicated identity, files and user manager and calls the
existing service package. The service and all account/container-facing helpers
run as the non-root identity. SHA-256-pinned Bun assets cover x64 baseline/arm64
and glibc/musl. apt/dnf are the first package-manager adapters; other systemd
distributions require existing core prerequisites. Release building is separate
from publishing and binds a bootstrap to its release tag.

Use detected resources with explicit clamped formulas, retain existing config,
and refuse custom managed layouts instead of chmod/chown on arbitrary paths.
Create attachments inside the owner-only state tree and check a hardware-scaled
2 GiB default reserve plus staging headroom. Runtime enforcement remains ATT01.
Compatible-code updates reuse `service install`; schema changes stop with the
existing staged-upgrade next action rather than adding an installer authority or
requesting the owner's password in the terminal. The installer does not provide
automatic same-schema release rollback; immutable previous releases remain.

Keep privileged execution separate from service-writable build output. The shell
checks protected parents, copies only trusted root/sudo-owner package inputs
into a root-owned bootstrap snapshot, and runs pinned root-owned Bun from `/`
with a minimal environment. Reject symlinks, non-root managed parents and
group/other write instead of trying to repair them while an attacker can race.
Dependency installation, sealing, keyring/user-unit writes, ledger seeding and
schema inspection all run as `jit`. Transfer fresh staging bottom-up; lock its
directories top-down before copying to prevent pathname/symlink races while root
reads it. Copy its result into new inodes behind a private root directory, make
the complete copy
root:root with no group/other write, and validate both runtime hashes and the
original pre-staging content pin there. The installed release has the same
protection and the service needs read/traverse access only.

Root lifecycle calls the trusted bootstrap's dependency-free service-package
API; it never executes staged `src/main.ts` or imports service-produced
`node_modules`. This also prevents a compromised `jit` identity from turning a
forged dependency seal into root code. The installer disables privileged ledger
seeding; a missing service-created seed fails closed. Only schema upgrades lazily
load the full lifecycle/engine graph; this changes no upgrade semantics.

Health polls HTTP on `bindHost:port` with the configured origin's Host header,
manual redirects and the existing 20-second bound. HTTPS private ingress is only
the browser origin; the host need not resolve or route through that ingress.

The manual `sudo <newDir>/src/main.ts service upgrade` entry point has the same
risk when `<newDir>` or an ancestor belongs to `jit`, including artifacts under
`/var/lib/jit/artifacts/<sha>`. Use a trusted operator-built root-owned snapshot
and root-owned Bun for manual operations. OPS08 (#206) now applies the same
trust primitive to all root-run service CLI commands. Move dependency-free path/tree assertions into `ops/package/trusted-paths.ts`
and keep the installer exports compatible; bootstrap `src/main.ts` checks before
loading the unchanged application command module. Recover the original Linux
script path from `/proc/self/cmdline`, since Bun resolves `argv[1]` through
symlinks; command-line parsing is fixture-injectable and unsupported wrappers
fail closed. This is needed because a gate inside the lifecycle CLI would run after its application/dependency imports.
Validate source and installed config, Bun, units/drop-ins, journals and release
parents too. Validate a managed root-owned activation link only after its parent,
then read its direct protected target; do not admit arbitrary symlink aliases.
Protected ancestors prevent service-user pathname swaps between check and use;
staging validates both existing destinations and new copies before execution.
Root subprocesses use the system PATH and a protected default cwd. Non-root
commands retain existing behavior; uid/boundary/metadata and runtime directory
are injectable fixture seams only. The error is CLI-only English and names the
path plus the runbook's exact protected-copy command. Builds may run as `jit`;
root executes a fresh inode copy, never an in-place chown of builder output.
The operator still trusts build provenance before invoking any bootstrap.
The installer retains its dependency-free API, and OPS06 recovery semantics and
service-identity schema upgrade execution remain unchanged.

Give the service identity a Secret Service user unit, written as that identity,
using systemd file stdin
for a generated, persistent 0600 unlock value. Preserve the existing keyring and
verify its collection is unlocked. This is credential-store availability only,
not provider login/readiness. The unlock file is necessarily stored beside the
encrypted keyring for unattended boot; filesystem access to that identity remains
inside the installation trust boundary. It is never an owner password or prompt.

Do not invent container image digests. One optional list-driven pre-pull step is
initially empty because there is no published box digest and WEB02/ATT02 images
do not exist. Later tickets add real digest-pinned entries; missing Podman,
images and optional doctor failures leave a chat-only installation.

Bootstrap the first owner with a random 256-bit, 15-minute capability in a 0600
file beside the database, storing only its hash and expiry. No schema migration
is needed, and no bootstrap capability enters backup/export images. Issue/rotate
and commit checks use the database's writer lock. Final owner creation shares
the existing password-validation/Argon2id/save path and cannot reset an owner.
Owner existence fences concurrent/replayed links even if file cleanup fails.

A first GET clears the token-bearing URL into an HttpOnly setup cookie and
redirects to a clean form. A separate derived CSRF proof and the existing
Origin/Host rules protect password submission. no-store covers all bootstrap
responses; no-referrer covers the link redirect and error pages, and the clean
form page uses same-origin (2026-10-30 amendment below). The setup token is distinct from owner session authority;
only completed owner creation followed by normal login issues a session.
No password is entered/stored in the terminal. SIGN01 owns the later account
login. VM/Pi acceptance remains opt-in owner evidence and is not run by this slice.

## 2026-10-29 — OPS09 (#224): user Podman socket and activation entry

The confirmed hardened-unit decision is retained. Installer, `service install`
and `service upgrade` idempotently enable linger, start the service identity's
user manager and enable/start its user `podman.socket`. They never run rootful
containers. Optional socket/executable failure leaves chat available and reports
the distinct cause and repair command. Upgrade re-renders/reloads the descriptor
for existing installs; compatible health rollback restores the previous descriptor.

Every resolved-UID unit sets `JIT_PODMAN_MODE=remote`, `JIT_SERVICE_USER` and
`XDG_RUNTIME_DIR`, binds only `/run/user/<uid>/podman` back into
`ProtectHome=tmpfs` and grants write access only to that directory in addition
to the existing managed paths. The optional bind allows chat on hosts without
Podman. Default container storage below the resolved service home is
inaccessible; no storage or setuid-helper exception is granted. Schway still
receives only its existing session-bus bind. The user socket must exist before
the service starts; after repairing an absent socket directory, restart Jit to
rebind it. Custom Podman graphroots must be excluded by the operator's unit
policy too, outside all Jit managed/writable paths.

Keep client configuration readable under the existing read-only filesystem:
Podman loads `containers.conf` before connecting to the API, and an inaccessible
config directory can fail that load. Only storage is hidden; no writable
configuration exception is added. See the [Podman config loader](https://github.com/containers/common/blob/v0.57.3/pkg/config/new.go).

The root CLI now accepts the sole managed invocation alias
`/opt/jit/current/src/main.ts`. It checks the protected parent and root-owned
link before reading its direct, fully protected target, and requires that
target to equal the running release. Arbitrary aliases, symlinked targets,
mutable/foreign ancestors, dependencies and configuration remain refused.
The original invocation still comes from `/proc/self/cmdline` before imports.

## Amendment 2026-10-30 (EVID01 #222)

A fresh-VM run showed that browsers post a form from a `Referrer-Policy: no-referrer` page with `Origin: null`. The Origin rule rejected every owner-setup submission, so no real browser could create the owner. The clean `/owner/setup` form page now uses `same-origin`, which still sends no referrer to any other origin. The token-bearing link's redirect and the error pages keep `no-referrer`. The Origin rule is unchanged, and `Origin: null` stays rejected.

The same run found that the installer wrote `/etc/subuid` and `/etc/subgid` as 0600 under `install.sh`'s umask 077, which broke rootless Podman for every user on the host. The write helper now sets modes explicitly. A re-run restarts the service identity's Podman pause process when it is stuck in a one-ID namespace.
