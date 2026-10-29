---
status: accepted
scope: INST01 engineering choices; implements S12-D11/D13 and S13-D03/D09
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
and root-owned Bun for manual operations. General service CLI ownership gates
remain a follow-up; the installer does not invoke that unsafe entry path.

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
Origin/Host rules protect password submission. no-referrer/no-store cover all
bootstrap responses. The setup token is distinct from owner session authority;
only completed owner creation followed by normal login issues a session.
No password is entered/stored in the terminal. SIGN01 owns the later account
login. VM/Pi acceptance remains opt-in owner evidence and is not run by this slice.
