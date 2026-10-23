# Runbook: install, operate and upgrade the Jit service (OPS07)

Owner-executable checklist for the packaged service. Build and validation run on the dev machine; install/enable/start/stop/upgrade on the host happen only in an owner-approved change window. Never paste tokens, addresses or raw diagnostics into issues; attach only sanitized summaries.

## 1. Build the versioned artifact

```sh
bun ops/package/bun-build.ts <checkout> <outDir> jit.schway.bridge/v1
```

- Review `manifest.json`: app version, Bun version, lockfile hash, schema version, engine contract and build arch must match the tested revision.
- `piValidation` stays `pending`. A desktop build never proves ARM64; do not relabel it as Pi evidence.

## 2. Write and plan trusted configuration

Create ignored `.local/service-config.json` with the dedicated service identity (never root), absolute release/working/state/ledger/backup paths (state outside releases), non-secret routes, opaque secret references, loopback or explicit VPN/private bind (wildcards rejected) and finite resource ceilings.

- Preview changes with plan mode before installing; the plan prints non-secret diffs only.
- Rendered units and configs contain references, never values. Scan them before copying anywhere.

## 3. Install service descriptors

- Copy the rendered `jit.service` unit and the artifact to their host paths in the approved window.
- The unit runs as the dedicated identity with bounded restart, memory cap and no new privileges. Persistent state lives outside replaceable releases.
- Disable or remove the service to stop it; managed data and secret references stay unless a distinct authorized deletion is used.

## 4. Preflight, status, start, stop

```sh
bun src/main.ts preflight
bun src/main.ts status
```

- Preflight gates activation on config, schema, engine, quarantine ledger, scheduler, delivery worker, secret files and artifact pins. Resolve each blocked gate; do not bypass.
- Status stays available while blocked. `observed-ready` appears only with explicit live evidence.
- Stop drains cooperatively within its timeout. `unknown` means the supervisor must terminate and reconciliation runs on next start; never treat it as stopped or sent.

## 5. Upgrade and rollback

- Stage a validated pinned artifact, back up state plus the artifact pair, then swap under the health gate.
- Failed health restores the backup pair; the deletion ledger is never rewritten and newer suppression state is never ignored.
- Rollback is permitted only to a compatible artifact/state pair. Record the backup ID in the private notes.

## 6. Hand off to the Pi live round

- The packaged service, its manifest and the preflight record are prerequisites for `docs/runbooks/pi-live-round.md`.
- Full-app restart and reboot evidence on the Pi belongs to OPS05 (#36); probe-only evidence from FEAS05 (#25) does not substitute for it.
