# Runbook: combined Pi live round (FEAS03 + FEAS04 + FEAS05 + OPS05)

Owner-executed, one combined live round on the Pi. Each round below is copy-pasteable and independently stoppable: a `blocked` result is valid evidence, never a reason to improvise a bypass. Do every step as the owner, in order, in a single approved host-change window where possible.

Rules for the whole round:

- Real hostnames, SSH targets, usernames beyond the sanitized service label, tokens and raw process output stay in ignored `.local` notes on the operator machine. Nothing of that enters issues, chat or shared docs.
- `<...>` placeholders below are filled from those private notes at execution time.
- Export and attach only sanitized summaries (`export` command output, never raw records).
- Quota-affecting steps run only with explicit per-round owner approval recorded before the command.
- Never add plaintext secret storage, never copy credentials from another CLI, never switch provider/billing when a route fails.

Entry criteria: the deterministic release checklist (`bun run ops:drill report`) is composed, and the OPS07 service package (manifest + rendered unit + preflight record) is built and reviewed.

## Round A — host inventory as the service identity (#7)

Goal: prerequisite proof that the exact runtime, identity and state paths exist on the Pi, observed from the service context rather than the interactive shell.

1. Record before touching the host: installation label, planned changes (Bun install, dedicated identity, PATH/working directory for that identity, persistent state directory, minimal probe mechanism) and what is out of scope (reboot, subscription login/inference belong to later rounds).
2. Apply only that scope. Service identity conventions from prior evidence: dedicated system user, writable state under its own installation, no read access to owner credential caches.
3. From the service identity and its working directory, run the inventory with an explicit tested PATH:

```sh
bun run host:evidence inventory --config .local/host-evidence-config.json
```

4. Confirm Secret Service availability for the service identity without using the interactive keyring as a substitute. Missing or locked store is a `blocked` store result with next action, not a prompt to create plaintext storage.
5. Export and review:

```sh
bun run host:evidence export --id <evidence-uuid>
```

6. Record: exact Bun and dependency versions on ARM64, installed/absent/unverified rows, evidence ID, scope of changes, cleanup/rollback instructions and remaining boot/login assumptions.
7. Stop here if anything is absent or blocked. Do not proceed to probes on an unverified runtime.

## Round B — per-route bounded probes (#22)

Goal: observe Grok and Codex access separately, each on its own selected model, in the exact service context.

1. The owner selects the exact route and model IDs and approves the bounded login/inference window first, including maximum attempts and deadline. One route's pass never certifies the other.
2. Perform account login explicitly for the service credential identity through the supported flow. Never read another CLI's cache.
3. Run the FEAS02 opt-in probe command once per intended route with the logged finite budgets. Keep setup, configured access, capability preflight and inference attempts distinct in the notes.
4. Classify honestly: only an actual successful request in the service context becomes `observed-ready`. Missing store, login required, rejection, quota and network failures stay `needs-login`, `store-unavailable`, `quota-waiting` or `failed` with next actions.
5. Record live renewal only if the normal lifecycle actually renewed; otherwise mark renewal `fixture-only` or `untested`. Never call refresh proven because login or inference succeeded.
6. Exercise cancellation once: a cancelled probe must read as interrupted with its evidence ID, never as completed, and no uncontrolled duplicate probe may run after it.
7. Record per-route evidence IDs and which support assertions remain blocked before reboot proof. Attach only reviewed sanitized summaries.

## Round C — restart, reboot and resource samples (#25)

Goal: prove unattended boot, interrupted-probe recovery and probe-level resource behavior.

1. Coordinate a bounded restart window followed by a reboot window. After boot, the service identity must start on its configured PATH/directory and read persisted probe state without owner unlock.
2. For each route separately record: credential accessibility, optional bounded post-boot inference (only with fresh opt-in approval) and any actually observed normal renewal. Startup, credential-read, inference and refresh are separate rows, never one collapsed pass.
3. Recover the controlled interrupted probe as `interrupted` under its previous evidence ID. No orphaned attempt or late response is reported as completed, and no duplicate quota-consuming probe runs after reboot.
4. If unattended Secret Service or credentials fail, record the exact safe blocked state, its support impact and next action. Do not add a new backend, manual-unlock requirement or billing fallback.
5. Sample memory, disk, startup and probe durations plus small bounded concurrency under the recorded runtime/model/sample conditions. These are probe feasibility observations, not full-app capacity claims.
6. Emit the per-route support matrix with tested versions, evidence references and explicit pending renewal/boot gates. Hand this matrix to Round D; it does not approve the pilot.

## Round D — full-app drill and pilot handoff (#36)

Goal: representative full-application load and recovery evidence with the packaged service, then an honest handoff.

1. Confirm entry: per-route/service readiness rows, production bridge compatibility and deterministic MVP release cases all pass. Record the exact build, runtime, engine, host profile, service identity and approved workload.
2. Run the OPS04 fixture workload on the Pi (no live model traffic needed to measure scheduling and storage behavior):

```sh
bun src/main.ts diagnose
bun run ops:drill drill --config .local/ops-drill.json
bun run ops:drill report --id <drill-uuid> --checklist .local/release-checklist.json
```

3. If the owner opts into live smoke checks, declare route, model, attempts, deadline and quota use first, then reuse the Round B probe mechanism. Keep transport, semantic, renewal and boot observations separate; record `not-run` or `blocked` honestly.
4. With disposable approved state, drill restore/deletion quarantine and the stop/reconnect path: the owner inspects failures, unknown deliveries, paused schedules and current revision evidence over Web/VPN and configured Telegram.
5. Using the OPS07 package and the approved window, restart the full Jit service and perform the real reboot. Verify service identity and network access, boot credential access, committed projects/tasks/decisions, queue/attempt/cursor/outbox reconciliation and current deletion/suppression state. Interrupted full-app work is fenced, never claimed successful or blindly resent. These observations stay separate from the Round C probe-only evidence.
6. Produce the release gate checklist with evidence references, known limits, residual privacy/external-copy risks, recovery/rollback instructions and the owner handoff. Missing latest deletion ledger, unready routes or failed trust invariants block pilot readiness.
7. Collect owner feedback without imposing any fixed project-count or value benchmark. The product-value verdict, pilot repository and next priorities remain the owner's choice.

## After the round

- File per-round evidence IDs back to #7, #22, #25 and #36 with sanitized summaries only.
- Any blocked gate keeps its ticket open with a next action; closing a blocker never certifies an untested path.
- Desktop fixture results are never cited as Pi evidence, and probe-only evidence is never cited as full-app evidence.
