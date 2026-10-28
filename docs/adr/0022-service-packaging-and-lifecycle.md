# ADR 0022: Reproducible service packaging and supervised lifecycle

Status: proposed for OPS07 engineering choices (Jit #35). Requirements: FR-10, FR-13, FR-14, FR-15, FR-17, FR-18, NFR-02, NFR-03, NFR-04, NFR-05, NFR-06, NFR-07, NFR-08, NFR-09, NFR-10, NFR-12.

## Context

The confirmed decisions are in CONTEXT.md, the MVP spec and ADR 0021. OPS07 must deliver a reproducible install/operate package for the composed Jit application on Linux ARM64 with versioned artifacts, trusted configuration, supervised startup and safe upgrade. Actual Pi provisioning, VPN setup, credential login and reboot activation are OPS05 human gates, and full schema-migration semantics belong to the open OPS06 (#32) path.

## Decisions

The rest of this record lists proposed engineering choices, not product decisions.

1. **Build from explicit paths, pin everything.** `ops/package/bun-build.ts` takes absolute source/output directories plus declared engine pins and records app/Bun/lockfile/schema/engine/arch in the manifest. Desktop builds mark Pi validation pending; `artifactPiStatus` returns `not-run` off arm64. Output-directory tests prove no dev-cwd dependence.
2. **Trusted configuration is allowlisted and secret-free.** `parseServiceConfig` admits one fixed shape with a dedicated non-root identity, absolute directories, managed state outside releases, opaque secret references and loopback/VPN-only binds. `planServiceConfig` diffs only non-secret fields; secret references compare as counts. Rendered units and configs are scanned for secret-shaped values.
3. **Preflight gates activation, status stays readable.** `preflightService` checks config, schema, engine, quarantine ledger, scheduler, delivery worker, secret files and artifact pins before `startFullApp` enables jobs, memory assembly or deliveries. `gatherServiceStatus` stats but never reads credential material; `observed-ready` needs explicit live evidence.
4. **One start path, never the probe runner.** `serve [--service-config]` and the systemd unit both call `startFullApp` (preflight → bridge gate → pre-listen preparation → one managed composition → ledger gate → boot reconciliation → opt-in channels) and then `serveFullApp`. Stop drains with a bounded timeout and reports `unknown` rather than inventing settlement.
5. **Default-deny wildcard and public binds.** `JIT_HOST` rejects `0.0.0.0` and `::`; the service config admits loopback or a private/VPN address on a named interface, with owner authentication still enforced.
6. **systemd through an injectable runner.** Operator commands (`service plan|install|start|stop|status|upgrade|disable|uninstall`) drive one unit through fixed `systemctl` argv vectors via a `CommandRunner`; tests substitute a fake supervisor that runs the rendered `ExecStart`. Releases are immutable directories behind an atomically switched symlink; state, backups and the ledger stay outside them. Logs go to a bounded journald namespace.
7. **Artifacts carry a content pin and a sealed, host-installed dependency tree.** The artifact includes `ops/package` and the vendored engine tarball; a content hash detects modified releases at plan, install, upgrade and boot. Dependencies are installed by an explicit operator step on the target host (hoisted, bin links removed) and sealed as a digest over the symlink-free tree, recomputed at every runtime validation, because native dependencies differ between desktop and ARM64 and a metadata-only record is forgeable.
8. **Package upgrade delegates schema work to ops.schema_migrations/v1.** The package flow stops the unit, runs the new build's owner `upgrade` (recovery point, staged migration, activation), then switches the release and health-checks. It never copies or restores the database itself; rollback to the prior release is allowed only while the state schema still matches it, otherwise the recovery point is reported for an OPS02 quarantined restore. This replaces the earlier `upgradeStaged` file-copy rollback, which bypassed the managed backup and could discard newer ledger state.
9. **Ledger through a seam backed by OPS02.** Activation consumes the installation deletion/suppression ledger through `LedgerGate`, whose default is OPS02's `syncLedgerCheckpoint` against the configured `ledgerPath` (writing only at boot). Install only seeds a service-owned placeholder when the file is absent; the first boot establishes the checkpoint and every later untrusted state fails closed.
11. **Installed ownership is explicit.** Plan resolves the identity's numeric UID and primary GID; the unit uses that GID, the ledger seed is `<uid>:<gid>` and the config `root:<gid>`, and install fails on any ownership error. Status and preflight use read-only SQLite connections, and the command runner kills whole process groups on a wall-clock timeout.
10. **Channels are opt-in and fail closed.** The delivery worker and Telegram poller start after reconciliation only when `channels.telegram` is enabled and both the token reference and a supported transport are available. No live Bot API transport ships yet, and the service never executes inbound project commands because that requires an owner session.

## Consequences

- Deterministic tests prove packaging, configuration negatives, boot/restart ownership, crash/timeout fencing, quarantine refusal, upgrade rollback and CLI preflight/status without provisioning, login or reboot.
- Keyring-backed installs report blocked secret access until OPS05 collects real host evidence; no plaintext fallback is inserted to force a pass.
- ARM64 dependency compatibility, per-route readiness and unattended boot remain S01/OPS05 gates owned by human-involved tickets; `JIT_OPS_SMOKE=1 bun run ops:smoke` is the opt-in Linux arm64 package smoke.
- Follow-ups: a live Telegram Bot API transport (the `DeliverySender` contract is synchronous, so it needs an outbox contract revision) and an owner-delegated adapter credential for unattended inbound command processing.
