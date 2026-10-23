# ADR 0022: Reproducible service packaging and supervised lifecycle

Status: proposed for OPS07 engineering choices (Jit #35). Requirements: FR-10, FR-13, FR-14, FR-15, FR-17, FR-18, NFR-02, NFR-03, NFR-04, NFR-05, NFR-06, NFR-07, NFR-08, NFR-09, NFR-10, NFR-12.

## Context

The confirmed decisions are in CONTEXT.md, the MVP spec and ADR 0021. OPS07 must deliver a reproducible install/operate package for the composed Jit application on Linux ARM64 with versioned artifacts, trusted configuration, supervised startup and safe upgrade. Actual Pi provisioning, VPN setup, credential login and reboot activation are OPS05 human gates, and full schema-migration semantics belong to the open OPS06 (#32) path.

## Decisions

The rest of this record lists proposed engineering choices, not product decisions.

1. **Build from explicit paths, pin everything.** `ops/package/bun-build.ts` takes absolute source/output directories plus declared engine pins and records app/Bun/lockfile/schema/engine/arch in the manifest. Desktop builds mark Pi validation pending; `artifactPiStatus` returns `not-run` off arm64. Output-directory tests prove no dev-cwd dependence.
2. **Trusted configuration is allowlisted and secret-free.** `parseServiceConfig` admits one fixed shape with a dedicated non-root identity, absolute directories, managed state outside releases, opaque secret references and loopback/VPN-only binds. `planServiceConfig` diffs only non-secret fields; secret references compare as counts. Rendered units and configs are scanned for secret-shaped values.
3. **Preflight gates activation, status stays readable.** `preflightService` checks config, schema, engine, quarantine ledger, scheduler, delivery worker, secret files and artifact pins before `startFullApp` enables jobs, memory assembly or deliveries. `gatherServiceStatus` stats but never reads credential material; `observed-ready` needs explicit live evidence.
4. **Boot the composed app, never the probe runner.** `startFullApp` registers exactly the Web worker set and refuses quarantined starts that would run extraction, monitoring or delivery without a ledger. Stop drains with a bounded timeout and reports `unknown` rather than inventing settlement. Upgrades back up the state/artifact pair, health-gate the swap, and roll back byte-preserving the ledger.
5. **Default-deny wildcard bind.** `JIT_HOST` rejects `0.0.0.0` and `::`; service binds loopback or an explicit private interface behind configured private ingress, with owner authentication still enforced.

## Consequences

- Deterministic tests prove packaging, configuration negatives, boot/restart ownership, crash/timeout fencing, quarantine refusal, upgrade rollback and CLI preflight/status without provisioning, login or reboot.
- Keyring-backed installs report blocked secret access until OPS05 collects real host evidence; no plaintext fallback is inserted to force a pass.
- ARM64 dependency compatibility, per-route readiness and unattended boot remain S01/OPS05 gates owned by human-involved tickets.
