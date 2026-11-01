# S14 default and retained-legacy cutover (CUT14-01)

The code default is S14. The owner confirmed installation of fresh S14 separately on the Pi while retaining legacy. #256 closed after PR #304 merged at `143ca067e3728af94badfc2eb677b4f04a5cdb59`; #265 is closed. #267 remains open until all three actual host criteria below pass. This procedure is for the parent/operator's authorized change window; no host operation is implied by a code test or this document.

## Selection and compatibility

Bare source `serve`, `setup` and `ops` select `.local/s14/application.sqlite` and `http://localhost:3001`. Foreground interactive serve displays the existing one-time owner link; redirected/non-TTY output receives none. `--s14` remains supported. Legacy-only source commands require `--legacy`, or an existing supported named legacy service config. `JIT_DATABASE` never maps to S14; a source invocation carrying it must explicitly select a runtime. No reset/switch/conversion flow is added.

```sh
bun start
bun src/main.ts serve --s14                 # retained alias
bun src/main.ts serve --legacy              # retained source pilot
./install.sh                               # new independent jit-s14 installation
./install.sh --legacy                       # retained jit installation/repair
./install.sh --uninstall                    # S14 units only; data retained
./install.sh --legacy --uninstall           # legacy units only; S14 retained
```

Existing service configs without `runtime` stay legacy. Their canonical `serve --service-config <path>` and prior artifact argv stay unchanged. S14 units retain `serve --s14 --no-refusal-page` and their generated S14 environment. Service operator commands select S14 through exact `--config /etc/jit-s14/service-config.json`; omission keeps the historical `/etc/jit` operator default, with no installation discovery. See [ADR 0061](../adr/0061-s14-default-selection-and-legacy-compatibility.md) and [service operations](ops-service.md).

## Remaining owner-host acceptance sequence

1. Bind the exact reviewed main SHA, platform artifact/content hash, pinned Bun and current Pi host-key/identity mapping from protected local records. Retain the existing prior legacy code, original config/unit/argv/enablement, identity/subordinate mappings, keyring/native state, boxes/profiles and backups. Keep addresses, exact custom paths and protected recovery references only in ignored `.local` records. Do not substitute an evidence VM or assume managed legacy paths.
2. Take independent complete protected recoveries. Managed S14 backup excludes credentials and computer/profile volumes and cannot replace whole-installation recovery. Do not open/export credential values or move legacy login material to the new identity.
3. Quiesce all legacy writers through normal controls and confirm actual settlement within finite bounds, including shutdown/checkpoint activity, before the baseline. Do not force-clear claims, delete boxes or restore bytes to make hashes agree. If settlement fails, stop the change window and diagnose.
4. Capture complete consistent **R0**: actual database and sidecar presence/bytes, boxes/profile/backup trees, config/units/code, ownership/modes, identities and link targets. Hash all actual protected roots without following untrusted symlinks. Validate private copies if needed; do not open the original database through SQLite. Retain the writer-quiescence witness and full protected recoveries separately.
5. Verify S14 paths/identity do not alias or overlap legacy/recoveries. New managed paths are `/opt/jit-s14`, `/etc/jit-s14`, `/var/lib/jit-s14`. Existing S14 owner data requires scope reconciliation, never silent reset. Verify capacity for retained/new full sparse commitments, image intermediates, staging/reserve and recovery/log budgets; do not discard recoveries for space.
6. Install the exact reviewed **bare-default** release through the existing installer from a controlling terminal. Private fd 3 bootstrap occurs while S14 is stopped, then the link appears once only after health. No plaintext capability may reach terminal recording, logs or evidence. Preserve all trust, identity, disk, image and scratch boundaries in the service runbook.
7. Complete existing Web password setup and native device sign-in only if actual readiness requires it. The independent S14 keyring does not inherit legacy login. For the authorized first reply, use the exact Codex `gpt-6.1-sol` subscription route and one bounded tool-free message. No computer, Parallel, Google, repository, effect or fallback is needed. Record quota/auth/provider failure as pending; do not switch model/provider/account/billing.
8. Retain sanitized actual reply/route/model/artifact and committed outcome. Capture **R1** while legacy writers remain stopped and require complete R0/R1 equality for legacy bytes and preserved descriptors/identities. Shared OS dependency/subid changes are separately recorded, not a whole-OS equality claim.
9. Stop S14 normally and confirm its transports/components settled. Start the retained actual prior legacy unit/build with its original identity/config/state/argv. Verify bounded private health and owner/history access without model/effect calls; stop legacy cleanly again. Never pass a new flag to an immutable old build or point it at S14 state. A same-schema S14 code rollback is separate and cannot satisfy this prior-legacy-release criterion.
10. Disclose legitimate writes during the legacy rollback interval. Capture a fresh quiesced **R2** after that shutdown, then reactivate the same reviewed S14 installation without resetting owner/setup/reply. Capture **R3** with legacy still stopped and require complete R2/R3 equality. R0/R1 and R2/R3 are distinct byte-preservation windows; later live SQLite writes are not comparable to the stopped baseline.
11. If a real compatible prior S14 artifact exists, its additional code rollback uses supported `service upgrade --config ... --artifact <retained-prior>` from trusted code/Bun, with stopped-supervisor, schema/ledger/fence checks and exact health. Different schemas remain stopped/refused. Never switch links manually or activate `prior.sqlite` directly; OPS14 maintenance supports only 17→17 here.
12. Record final active/enabled services, exact rollback command, all retained recoveries and actual R0–R3 results privately. S14 is the intended ordinary service; preserve the prior legacy enablement/restore path explicitly. If legacy resumes, state when bytes may change. Publish only a credential-free summary with exact tested artifacts and limitations.

The parent can close #267 only after actual default first reply, consistent byte preservation and prior-release rollback evidence are accepted. #244 closure remains separate. Existing #256 evidence is per tested build/architecture/route, with owner-unread reports and owner-deferred AT/mobile observations unchanged; no new broad readiness or website support follows from cutover.
