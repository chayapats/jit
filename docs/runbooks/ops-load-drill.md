# Runbook: diagnostics, fixture load drill and release evidence (OPS04)

Owner-executable checklist. The drill runs on the dev machine against disposable state. No command here touches the Pi, uses quota, publishes anything, prints credentials or needs public ingress: the Web steps use the private VPN address of the installation, and every CLI prints allowlisted JSON only. Contracts: `docs/contracts/ops-load-drill-v1.md`, `docs/contracts/ops-release-evidence-v1.md`.

## 1. Inspect current state (read-only)

```sh
bun src/main.ts diagnose          # or: bun run ops:drill diagnose
```

- Prints queue/admission, redacted routes, budget/deadline exhaustion, quota/login/authority waits, disk vs watermark, Telegram configured/bound, engine mode and declared state, configured vs observed provider routes, schema, upgrade fence/journal, restore quarantines, evidence references, `nextAction` and every applicable `nextActions` entry.
- Claims no scheduler ownership, starts no background work, never probes the engine or a provider, and writes nothing. `providers.readiness` stays `configured-unverified` until live route evidence (S01/OPS05) exists; diagnose never upgrades it.
- Work through `nextActions` in order using the table below. A listed action is the next owner step, not an authorization.

| `nextAction` | Runbook step |
| --- | --- |
| `finish-or-rollback-upgrade` | §8 Supported upgrades |
| `resolve-restore-quarantine` | §7 Quarantined restore |
| `run-owner-upgrade` | §8 Supported upgrades |
| `use-compatible-app-artifact` | §8: the state is newer than this build; run the matching artifact, never downgrade the database |
| `relieve-disk-pressure` | §4 Disk pressure |
| `restore-engine` | §6 Quota/auth reconnection and engine |
| `inspect-sanitized-diagnostics` | §3 Pause/stop: another instance owns admission |
| `configure-provider-route` | §6 |
| `reconnect-provider-login` | §6 |
| `reauthorize-owner-work` | §6 |
| `wait-for-quota-then-resume` | §6 |
| `resolve-unknown-delivery` | §5 Delivery unknown |
| `resolve-blocked-work` | §3: open the job in `/projects/<id>/jobs`, read its reason, stop or re-enqueue explicitly |
| `drain-queue` | Nothing to fix; queued work is admitted as capacity frees |
| `configure-telegram` / `bind-telegram` | Place the bot credential file (mode 0600) at `JIT_TELEGRAM_BOT_TOKEN_PATH`, then complete the owner binding challenge (`telegram.bind`, then `telegram.confirm` with the challenge nonce) |

## 2. Run the bounded fixture drill

```sh
cat .local/ops-drill.json   # review workload sizes first; all values are finite ceilings
bun run ops:drill drill --config .local/ops-drill.json
```

- Creates disposable state and runs, in order: groups, the static PR path (snapshot → scripted review → alert admission), memory queries, fixture deliveries (including unknown), explicit-clock schedules, a quota wait, a cooperative cancel, a sanitized project export, a managed backup with integrity re-verification, a read-only upgrade preflight, the quarantine gate, a network-isolation check and the disk watermark.
- `scripted` on `backup`/`upgrade-preflight` means the fixture engine declared the snapshot contract; no Schway engine ran.
- `quarantine` is `blocked` with `pending OPS02 (#33)` until the accepted `ops.quarantined_restore/v1` flow is integrated as the drill's restore port; the record then shows `nextAction: integrate-pending-contract`. This gate is part of the result, not a failure to hide.
- A `blocked` outcome is valid. Re-run only with the same config after addressing the recorded `nextAction`; never loosen limits to force a pass. `retry-bounded-drill` means the drill was cancelled or hit `deadlineMs`; the skipped legs are listed as `not-run`.

## 3. Pause/stop

- Stop one admitted job from its Web job page (`job.stop`); the receipt is the acknowledgment, late results cannot publish after the fence, and `observed_stopped` requires every watched attempt to settle.
- Stop the whole service with its supervisor (OPS07 service runbook, `docs/runbooks/ops-service.md`). Admitted attempts are fenced as interrupted and reconciled at the next start.
- `inspect-sanitized-diagnostics` (queue `available: false`) means another live Jit instance holds the scheduler. Stop that instance before any queue-changing command; never delete the scheduler row by hand.

## 4. Disk pressure

- `relieve-disk-pressure` means managed `.local` state (or drill growth) passed `JIT_OPS_DISK_WATERMARK_BYTES`.
- Inspect with `diagnose`; prune `.local/ops-evidence` records older than `JIT_OPS_RETENTION_DAYS`; prune managed backups from `/backups` (`backup.prune`, keeps the newest 1–10); remove expired exports from the project's exports page. Re-run the drill before any release claim. Never delete SQLite, WAL or backup files directly.

## 5. Delivery unknown

- In the drill, `unknownDeliveries > 0` is expected: the scripted sender classifies sent/failed/unknown without Bot API traffic, and PR alert intents wait unbound.
- On a live installation, `resolve-unknown-delivery` means a send may or may not have reached Telegram. Open `/projects/<id>/delivery`, check the chat, then resend explicitly (`delivery.resend`) or retire the intent (`delivery.retire`). Never treat unknown as sent; migration, restore and reconciliation never resend on their own.

## 6. Quota/auth reconnection and engine

- `wait-for-quota-then-resume`: the job waits on its exact route. After quota returns, resume it from its job page (`job.resume`). No route, model or billing fallback is ever applied.
- `reconnect-provider-login`: the provider route needs owner login or Secret Service access. Log in on the installation per the Pi runbook (`docs/runbooks/pi-live-round.md`), record the evidence ID, then resume the job. Diagnose never reads or prints the credential.
- `reauthorize-owner-work`: owner authority changed (for example `bun src/main.ts reset-owner` revoked sessions), so work admitted under the old authority is blocked `authorization_changed`. Sign in again and re-enqueue the work you still want; nothing resumes on stale authority.
- `configure-provider-route`: `JIT_RUN_PORT=schway` but no owner/project/role route is configured. Save one on the Web team page (`route.save`).
- `restore-engine`: the pinned Schway release contract does not match, or a host directory under `<state>/.jit-host` is a symlink, not a directory, or group/other accessible. Reinstall the pinned artifact or fix the directory mode to 0700 owned by the service user, then run `bun src/main.ts preflight`. In the drill, the same action follows an `engine_unavailable`/`native_snapshot_unavailable` block.

## 7. Quarantined restore

- `resolve-restore-quarantine`: a restore quarantine is open (or the shared fence is held by a restore). Open `/restores`, read the journal's checks and `nextAction`, and either continue the next step or discard the quarantine. A quarantine is never started by workers and never activates on its own.
- Never hand-edit the deletion ledger, quarantine files or the fence to force readiness; a blocked validation stays blocked until its reason is fixed.
- Restore activation and its ledger replay follow `ops.quarantined_restore/v1` (OPS02 #33). Until that flow is in the integration base, the drill records only that a verified backup exists.

## 8. Supported upgrades

- `run-owner-upgrade`: the database is older than this build. Stop the service, then `bun src/main.ts upgrade [--target <schema>] --password-stdin` (owner password on stdin, never in arguments). It runs prepare → migrate → validate → activate with a recovery-point backup; reconciliation completes at the next service start. The drill's `upgrade-preflight` leg shows the same schema plan and engine check without migrating.
- `finish-or-rollback-upgrade`: an upgrade journal holds the fence (or activation awaits reconciliation). Open `/upgrades/<id>` and take one of its listed actions; rollback is offered only before activation. After activation, returning to the prior version is a §7 restore of the recovery point.

## 9. Evidence collection

```sh
cat .local/release-checklist.json   # exactly { "human": { "FEAS": …, "OPS": … } }
bun run ops:drill report --id <drill-uuid> --checklist .local/release-checklist.json
```

- Deterministic J01–J05/crash/trust rows are derived from the drill's executed legs; the checklist file only links human FEAS/OPS gates by ops-evidence UUID. Rows the drill covers only partially stay `blocked` with the uncovered scope named (suite or human evidence).
- Attach only the printed summaries for review. Full records stay in ignored `.local/ops-evidence`; never paste tokens, addresses or raw diagnostics into issues.
