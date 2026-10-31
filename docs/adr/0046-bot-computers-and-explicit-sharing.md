---
status: proposed
scope: S14-D02/D03/D10/D13; supersedes per-project ownership in ADRs 0036 and 0039 for S14
---

# Persistent Bot computers and explicit sharing

## Confirmed direction

Each Bot has a persistent isolated computer on the owner's Linux host, with private files and browser sessions. Sharing is explicit. Multiple Bots work concurrently, while input to one browser/desktop has one owner.

## Confirmed disk provisioning decision — 2026-10-31

The owner selects an install-time pool: initially eight slots, each containing one finite 1 GiB sparse ext4 workspace image and one finite 1 GiB sparse ext4 profile image. Root provisions loop mounts through boot-enabled systemd mount units under the S14 data root with nodev/nosuid and ownership mapped to the service's rootless keep-id user namespace. No runtime root helper runs. Before provisioning, available host capacity must cover every image's remaining growth to its full logical size, all new images and the installer reserve. Sparse allocated bytes alone are insufficient.

The installer-owned manifest and parents are protected from the service; only mounted filesystem contents are service-writable. Re-runs preserve image bytes, repair mounts and can extend the pool with `--computer-slots N`; they never shrink or reformat it. Uninstall retains data and its boot mount units.

The application transaction claims an unused slot on first computer use and persists its Bot/computer/generation binding in the computer record. A new claim is dirty until a service-identity wipe verifies success. Idle stop/restart retains the claim and files. Reset stops both components and wipes both filesystem contents; delete returns the slot only after that wipe succeeds. Failed/interrupted wipes retain the claim. New claims always wipe before use, including after stale-store recovery, so another Bot cannot inherit previous contents. A full pool refuses with `computer_disk_pool_full_rerun_installer_to_extend`; there is no unbounded directory fallback.

Local mount proof remains mandatory. A remote-mode client is accepted only at the current service uid's protected, actual Unix Podman socket with matching daemon hostname/rootless uid mapping. TCP/SSH, foreign/missing/linked sockets and unverified local filesystems refuse. The service still checks ext4 mount roots, unique devices, nodev/nosuid, total filesystem capacity, exact container mounts and kernel limits before dispatch.

Requirements remain FR-35/36/38/40; NFR-04/06/07/14. Pool sizing and provisioning are confirmed; the implementation uses the existing lifecycle and public Schway backend. Linux evidence is recorded separately from deterministic tests.

## Proposed choice

Reuse the rootless Podman/runner integration on Linux x64/arm64 behind a BotComputer service; VM backends remain possible without changing product identity. Bot identity owns persistent volumes, not a disposable run. Idle stop removes processes, not volumes; reset/delete requires an exact owner command and lifecycle handling.

Enforce isolation with separate execution boundaries and volume grants, not folders alone. No host home, service state, provider credential store, backup directory or runtime/control socket is mounted into an execution container. Use finite CPU/RAM/PID/disk/network limits and fail closed if the selected boundary cannot be established.

A logical Bot computer may contain separately isolated workspace and browser components. Persistent website sessions stay in the Bot-private browser component/profile, inaccessible to the workspace shell and MCP process. This is sensitive session material, not a model/provider/channel credential. Owner login occurs through takeover; masks and sanitized live views do not by themselves establish session secrecy. Avoid raw cookie, arbitrary CDP/JavaScript, browser-profile file or credential export tools.

The Jit gateway supplies only allowed browser/desktop operations. It classifies effects independently of model-declared intent. Unknown action classes require approval or refusal. An unrestricted network shell cannot coexist with a claim that external effects are fully mediated: egress and broker-only effect paths must be enforced and tested. Unsupported effect types remain unavailable.

A persistent input lease binds Bot computer, browser/desktop, actor, attempt and generation. One lease permits input at a time; takeover fences agent input and vice versa. Screenshot/read operations are separately bounded. End of takeover does not approve a held submit.

Sharing creates a revisioned grant to a named immutable artifact/source snapshot and receiver Bot/work scope. Copy through a bounded service-owned artifact gateway; do not mount all Bot volumes together or grant generic host paths. Validate type, size, hash and lineage before import. Recheck grants at admission/use/publication. Revocation stops future access and retires affected contexts; already disclosed knowledge cannot be clawed back.

No shared browser login is inferred from a shared file or memory claim. A new Bot receives no accounts by creation alone.

## Alternatives and consequences

A single unrestricted shared computer is cheaper but contradicts S14-D03. Separate folders/browser profiles under the same unrestricted shell identity do not prove isolation. One fully warm desktop per idle Bot wastes resources, so startup is lazy with a finite active-computer ceiling.

Browser profile isolation, network enforcement, takeover and artifact transfer need real Linux evidence in addition to fixtures. Container isolation is not protection against a compromised host administrator/kernel.

## Evidence required

Cross-Bot filesystem/profile/network denial; path/symlink traversal; raw-socket and alternate-tool bypass attempts; credential/state mount absence; input lease races and takeover; share/revoke/late-result races; idle persistence and reset scope; Linux resource smoke. Requirements: FR-17/35–FR-40; NFR-06/07/14.
