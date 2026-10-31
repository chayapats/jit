---
status: accepted for opt-in implementation
scope: installer/service half of CUT14-01; S14-AC01/11/14; NFR-06/08/12/14
---

# Separate opt-in S14 service before the default flip

The owner explicitly requests the real service path for #256 before its live
gate can pass. The default flip and installation on the existing owner host
remain later actions under #267. ADRs 0042/0049's bootstrap trust and fresh-state
rules still apply. This record chooses engineering for that bounded delivery;
it does not claim Linux evidence or a new product authority.

Use `install.sh --s14` as the one runtime choice. Give S14 its own `jit-s14`
identity, home/state/vault/keyring/Podman user API, `/opt/jit-s14` code/Bun,
`/etc/jit-s14` config, system unit, journal namespace and port 3001. A separate
identity avoids accidentally sharing native credential state or granting access
to legacy private files. Shared OS packages and subordinate-ID allocation retain
the existing installer contract. Legacy defaults remain unchanged.

Reuse the service-package implementation with an explicit, validated optional
runtime/config branch. Bind S14 database/origin/path settings through its
environment and invoke its existing composition root. Suppress the fresh-state
refusal listener in the unit so a refusal cannot satisfy health. Keep every
legacy sandbox directive, root-owned release and service-identity helper
boundary. Never seed or interpret the legacy JSON ledger for S14.

Use a systemd service-private `TemporaryFileSystem=` for disposable host Git
scratch: 128 MiB, mode 0700, resolved service UID/GID, nosuid/nodev/noexec.
This avoids a host-global mount lifecycle and stale scratch after restart.
The Git broker still verifies the actual filesystem and prlimit boundary before
object readers. Include the existing box build inputs in the content-pinned
artifact and build both targets as the service identity; record only verified
manifest digests, never invented registry pins or mutable tags as runtime refs.

ADR 0046's subsequent confirmed disk-pool decision closes this slice's original local-disk-proof gap. The installer creates eight finite ext4 pairs, checks full sparse commitments and enables boot mount units. The service retains all hardening and uses only its verified same-host user Unix API; remote hosts and missing disk/cgroup proof still fail closed. Image installation alone remains insufficient evidence.

Deliver owner setup through the already supported `owner-link --s14
--output-fd 3` CLI as the service identity with matching database/origin. Open
the controlling terminal before issuance, discard standard streams, bound the
private pipe, validate the exact link and display once on that terminal.
Headless progress/journald must never receive a capability. Re-run rotates only
an unowned setup capability; an existing owner receives sign-in.

An S14 installer re-run opens the operator terminal and stops/verifies only its existing S14 unit before image mapping preparation. The installer's Podman requests cannot share the running runtime's private namespace-planning queue. Image preparation remains optional: an unavailable image pair proceeds through installation/start/health as an explicit chat-only configuration. Before stopping, retain the prior config as `installer-previous-config.json` under the protected S14 config directory. A failure before activation restores the prior config while its unit/release remain selected, and resumes only a previously active service after successful preparation. If preparation was unavailable, a subsequent failure retains the prior installation with an explicit Podman-cleanup/start-or-rerun recovery action instead of resuming computer planning against unconfirmed layer locks. Activation and health failures retain the existing explicit installer recovery policy; this does not add automatic health rollback or touch the legacy unit.

Add a content-bound optional S14 schema pin to artifacts. Compatible-code
service upgrades stop, validate state/fences/lifecycle availability through the
trusted build as the service UID under the exclusive runtime lock, switch and
health check. Compatible rollback rechecks through the prior build before
restoring its unit/link. No password or legacy schema command participates in
this code-only activation. Actual schema changes remain staged authenticated
OPS14 maintenance; no previous released S14 schema is invented. The installer
retains its existing explicit recovery policy rather than promising automatic
health rollback.

The opt-in read-only service evidence tool returns only bounded fixed checks,
artifact/schema and pending gates. Deterministic fake-root/pipe/package tests
prove orchestration and byte preservation, not host enforcement, account
readiness, research usefulness, restart/reboot or the #256 release gate.

## EVID14-01 first-owner contention

Clean x64 runs reproduced SQLITE_BUSY during ATTACH preparation while the newly healthy service was writing. A bounded open-only wait improves diagnostics for a manual concurrent helper but did not make that path reliable in live reruns; it is not the installer's correctness mechanism. The installer now opens the controlling terminal before stopping an existing unit, captures fd 3 exactly once while the unit is stopped after installation, then starts and health-checks before displaying anything. Pending plaintext exists only in the private delivery closure, is erased on display/close, and is discarded on failure. A failed health check never prints a link. No capability issuance, work or effect is retried. Existing owners still receive sign-in without reset. Deterministic ordering/private-pipe tests and real stopped-service clean-path evidence are recorded separately from live research.
