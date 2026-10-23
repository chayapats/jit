# Runbook: fixture load drill and release evidence (OPS04)

Owner-executable checklist. Every command runs on the dev machine against disposable state unless stated otherwise. No command touches the Pi, uses quota, or publishes anything.

## 1. Inspect current state (read-only)

```sh
bun src/main.ts diagnose
```

- Prints queue/admission, active routes (redacted), budget/deadline exhaustion, disk vs watermark, Telegram configured/unconfigured, evidence references, and one safe next action.
- Claims no scheduler ownership and starts no background work. If `available` is false, another Jit instance holds the scheduler; stop it before queue-changing commands.

## 2. Run the bounded fixture drill

```sh
cat .local/ops-drill.json   # review workload sizes first; all values are finite ceilings
bun run ops:drill drill --config .local/ops-drill.json
```

- Creates disposable state, exercises groups, scripted PR snapshots, memory queries, fixture deliveries (including unknown), explicit-clock schedules, and a cancel probe.
- PR legs are `scripted` fixtures until #24 lands; quarantine is `blocked` until #33; export is `not-run` until #31. These gates are part of the result, not failures to hide.
- A `blocked` outcome is valid. Re-run only with the same config after addressing the recorded `nextAction`; never loosen limits to force a pass.

## 3. Disk pressure

- `nextAction: relieve-disk-pressure` means managed-state growth passed `JIT_OPS_DISK_WATERMARK_BYTES`.
- Inspect with `diagnose`, prune `.local/ops-evidence` per `JIT_OPS_RETENTION_DAYS`, and re-run the drill before any release claim.

## 4. Delivery unknown

- `unknownDeliveries > 0` is expected fixture behavior: the scripted sender classifies sent/failed/unknown without Bot API traffic.
- Real unknown deliveries on the live path need the delivery runbook: inspect the outbox intent, resolve on the same route, and resend explicitly. Never treat unknown as sent.

## 5. Quota/auth reconnection

- Quota-waiting jobs stay `waiting` on their exact route; resume explicitly after quota returns. No route, model or billing fallback is ever applied.
- `needs-login` or `store-unavailable` means owner login or Secret Service access is required first; record the evidence ID and continue in the Pi runbook.

## 6. Pause/stop

- Stop an admitted job with the owner stop command; late results cannot publish after the fence. `observed_stopped` requires every watched attempt to settle.
- Quarantined restore: until #33 lands, restores stay quarantined and the drill records this as `blocked`. Do not hand-edit the deletion ledger to force readiness.

## 7. Supported upgrades and evidence collection

- Upgrades follow the OPS07 service package path; check the release checklist for blocked gates first.
- Collect evidence with `bun run ops:drill report --id <drill-uuid> --checklist .local/release-checklist.json`.
- Attach only the printed summaries for review. Full records stay in ignored `.local/ops-evidence`; never paste tokens, addresses or raw diagnostics into issues.
