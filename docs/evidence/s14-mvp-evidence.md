# S14 live MVP evidence — EVID14-01 / #256

Run date: 2026-10-31. **The S14 release gate is not passed. Keep #256 open.** This record separates observed host behavior, the selected model route, research usefulness and unexercised requirements. A passing deterministic test, configured image or completed model response is never substituted for live evidence.

Raw commands, screenshots, timelines, source/report bodies, installation addresses and private receipts remain in the owner's ignored `.local/s14-256-live/` record. This file contains no installation address or credential. The legacy service was left installed and running. No public release, PR merge, provider/model/billing fallback or authenticated Parallel key was used.

## Tested builds and environments

Both installations started at `50ea1f5`. Fixes were built natively and deployed through the real supervised `service upgrade` path, with protected operator artifacts and health checks. The five-task final research round used `f8840b08bb64d138a1416bac606cf4131217cc54`. The subsequent restore fixes used `0d8b40c` and `8b6ea9f`. The final runtime build is `c2775c06dc70adadb1f3acc7ddadc8ae7356ac03`; its additional change corrects existing composer checkbox defaults. Earlier failed rounds are retained, not replaced by later successful subcases.

| Measurement/environment | Linux x64 | Linux arm64 |
| --- | --- | --- |
| OS/kernel | Ubuntu 26.04.1; Linux 7.0.0-42 | Ubuntu 24.04; Linux aarch64 |
| CPU / RAM / swap | 8 CPU; 16,226,283,520 B RAM; 4,294,963,200 B swap | 4 CPU; 8,308,228,096 B RAM; no swap |
| Root filesystem total / initial available | 104,028,168,192 / 86,514,810,880 B | 40,483,942,400 / 29,745,336,320 B |
| Bun / Podman | 1.4.2 / 5.7.0 | 1.4.2 / 4.9.3 |
| Initial service memory / peak | 50,696,192 / 104,431,616 B | 43,122,688 / 103,661,568 B |
| Final sampled service memory / peak | 224,305,152 / 238,731,264 B | 167,079,936 / 217,362,432 B |
| CPU accumulated in those final service samples | 22.534 s | 7.938 s |
| Final sampled service startup (systemd start to actual listening journal entry) | 20,738.259 ms | 1,376.668 ms |
| Later root available | 85,409,132,544 B | 24,350,371,840 B |
| Later allocated service data / release trees | 2,306,539,520 / 1,453,412,352 B | 8,740,429,824 / 3,173,584,896 B |
| Computer startup observation | Repeated `computer_startup_timeout`; no successful startup certified | Real workspace/browser containers and Web screenshots succeeded |

These are samples from this run, not resource promises, minima or benchmarks. Release trees, retained upgrade artifacts and disk-pressure writes affect allocated bytes. The smaller arm64 VM ran real Codex, Parallel, scheduled controls, computers and restore. Its host/computer lifecycle checks passed; the overall product gate still requires the pending cases below.

x64 had a material storage stall. The service was observed in kernel `jbd2_log_wait_commit` through `ext4_sync_file`/`fsync`; I/O PSI reached `some avg10=77.43`, `full avg10=77.08`. Podman's blocked `storage-chown-by-maps` helper held image/layer storage locks while preparing a rootless keep-id layer. A later computer attempt also timed out. This is observed failure evidence, not proof of an upstream root cause or a successful fix. Durability, isolation and the 30-second startup ceiling were not weakened to force a pass.

## Selected route and public research

Real first chat replies, Bot proposals, accepted Bots and explicit work starts ran through Codex `gpt-6.1-sol` subscription on both architectures. Route readiness is demonstrated by actual calls, not the original `configured-unverified` label. No Codex quota error was observed. Natural credential renewal during concurrent work was not established.

Parallel was anonymous throughout. Actual searches/fetches returned inspectable source identities, URLs, timestamps and snippet/excerpt coverage. Blocked/oversized/partial retrievals remained visible. `parallel_quota` classifies rate-limit/quota responses; it does **not** establish that Codex subscription quota was exhausted. Such responses occurred during the run; queued jobs later completed with transparent unsupported/partial reports. No new research reads were started after the aggregate quota condition was recognized. No key or alternate route was introduced.

The [corpus and fixed rubric](s14-research-corpus.md) were committed before the first live model call. All five requests were submitted through the Web on both hosts, using two concurrent Bots, 30 minutes and 40 reads per work. English was the x64 owner locale; Thai was the arm64 owner locale. Input language and output locale are recorded separately.

**The owner has not read or accepted the reports.** No report-acceptance control was clicked. Rubric assessment is delegated evaluation, not owner acceptance.

| Task | x64 result | arm64 result |
| --- | --- | --- |
| R1 Podman/cgroups | Fail: no verified official-source coverage after quota refusals; provisional uncited guidance | Fail: required cited coverage incomplete; quota refusals |
| R2 SQLite backup/WAL | Fail: no verified official-source coverage after quota refusals | Fail: no verified official-source coverage after quota refusals |
| R3 systemd timers | Fail: no verified official-source coverage after quota refusals | Fail: no verified official-source coverage after quota refusals |
| R4 uncertain HTTP writes | Rubric pass, 10/10; cited partial report; real browser download/hash verified | Rubric pass, 10/10; cited partial report; real browser download/hash verified |
| R5 WCAG/WAI checklist | Fail: provisional uncited checklist; missing research siblings | Partial cited checklist; full rubric/delivery acceptance pending |

Scores below are relevance/traceability/coverage honesty/reasoning/delivery. Delivery scores of 1 retain the material gap that those artifacts were not downloaded through the Web before their later lineage withdrawal. A total of 8 without delivery=2 is not a rubric pass.

| Task | x64 scores / total | arm64 scores / total |
| --- | --- | --- |
| R1 | 1/0/2/1/1 = 5 | 1/2/2/2/1 = 8, no pass |
| R2 | 1/0/2/1/1 = 5 | 1/0/2/1/1 = 5 |
| R3 | 1/0/2/1/1 = 5 | 1/0/2/1/1 = 5 |
| R4 | 2/2/2/2/2 = 10 | 2/2/2/2/2 = 10 |
| R5 | 1/0/2/1/1 = 5 | 1/2/2/2/1 = 8, no pass |

Remaining tasks do not receive a corpus pass: missing traceability or unverified delivery cannot be averaged away. Later lifecycle deletion of a deliberately introduced memory marker withdrew dependent report revisions/artifacts. That withdrawal was previewed in the Web and survived restoring the older image; it must not be bypassed to re-download those revisions. The unaffected R4 artifacts remained readable with these verified SHA-256 values:

- x64: `186c0d390b5cff309ad9d3fbb04973e633ff468606d39b11c720b1c8bb695737` (4,791 B, `text/markdown`).
- arm64: `f53ba2e708d9b15f65dd85a366c036c8b81d266f025e15e8a1a3df9ef084bac6` (6,673 B, `text/markdown`).

Concurrency is evaluated from recorded intervals, not selection or reservation counts. The final x64 R4 round has **39,741 ms** of overlap between the two accepted non-main research Bots, followed by dependency-respecting synthesis. Earlier arm64 R3 has **25,078 ms** of such overlap; interrupted/replayed intervals are not treated as continuous execution. The final arm64 corpus round did not demonstrate overlap between those two non-main Bots in each task. Other final tasks also lacked that overlap. The requested corpus-wide concurrency condition therefore remains unpassed even where a report is useful. Queue and dependency waits are retained in the raw timelines.

Contracts remain application schema 17 with the pinned `schway-1.0.0-rc.2-697bf40.tgz` public host surface. HTTP command/authority envelopes were not widened. The new report candidate validator rolls back publication; offline stop reconciliation accepts only matching confirmed cleanup; decoded Git inventory is capped at 32 MiB before verification.

## Acceptance matrix

`Pending` means at least one required part remains unexercised or blocked. A passed subcase is named explicitly; it does not pass the entire acceptance case.

| Case | x64 | arm64 | Actual coverage and remaining requirement |
| --- | --- | --- | --- |
| S14-AC01 | Pending | Pending | Real setup/profile/main chat and clean bootstrap delivery exercised. Full old-state refusal/fresh-owner end-to-end matrix not certified by this round. |
| S14-AC02 | Pending | Pending | Real proposal and exact Web acceptance create permanent Bots; normal chat starts no team. Running capability/retire/delete races passed (computer work on arm64; tool-free real inference on x64). Stale/injected Bot-proposal coverage remains incomplete. |
| S14-AC03 | Pending | Pending | Explicit finite Web work starts observed. Task acceptance without execution and duplicate ingress/source-command injection need complete live coverage. |
| S14-AC04 | Pending | Pending | Real overlapping research, queues, dependency waits, partial synthesis and retained successful evidence observed. All-five-task overlap/coverage condition remains unpassed. |
| S14-AC05 | Fail / pending | Pending | x64 computer startup blocks the full isolation drill. arm64 actual mounts, paths, environment, network and kernel bounds tested; full shell/MCP/private-memory/share/revocation matrix remains incomplete. |
| S14-AC06 | Pending | Pending | Real private memory labels, deletion preview, derived report/artifact withdrawal and anti-resurrection after restore observed. Full extraction/correction/shared-promotion/native-replay matrix not certified. |
| S14-AC07 | Pass | Pass | Actual anonymous Parallel reads and visible partial/oversize/quota outcomes; no key/provider/model/billing fallback. This does not pass corpus usefulness. |
| S14-AC08 | Pending | Pending | R4 immutable cited partial revisions, source links, media type, checksum and real Web download pass. Other corpus tasks lack required evidence or complete delivery checks. |
| S14-AC09 | Pending | Pending | No real approved external-write/unknown-outcome/reconciliation drill. No fixture claim substitutes for it. |
| S14-AC10 | Pending | Pending | Real scheduled quiet `no_update` and deliberately failing occurrence pass: quiet has no attention notice; failure is visible once. Out-of-scope proposal/no-new-authority case remains pending. |
| S14-AC11 | Pending | Pending | Real mid-run SIGKILL, systemd recovery and VM reboot; replay-safe replacements and retained sibling evidence observed. arm64 mid-computer-run reboot retained files and kept the attempt count at one with handler_requires_reconciliation. Unknown-effect and natural-renewal cases remain pending. |
| S14-AC12 | Pending | Pending | arm64 Web screenshot, agent lease, owner takeover and owner input observed. Running capability/retire/delete controls fenced publication, with no result committed for any of the six race runs. Late agent browser-input refusal remains unexercised. x64 startup blocks equivalent computer evidence. |
| S14-AC13 | Pending | Pending | Existing Thai/English desktop Chromium flows used. Full keyboard/no-script/dark-light/responsive/assistive review remains incomplete; real device, Safari, Firefox and screen-reader checks are pending. |
| S14-AC14 | Fail | Pass (this host) | x64 repeated computer startup/storage stalls fail its just-works check. arm64 actual startup, five-minute idle stop, process/VM persistence, reset and selected-route readiness passed under the recorded limits. This does not pass other S14 gates. |

## Kernel, recovery and operations evidence

On arm64, the actual product-created workspace and protected browser components had separate single writable mounts, read-only roots, only the fixed non-secret environment names, `network=none`, no state/vault/control-socket mount, private namespaces and dropped capabilities. Operator probes ran inside those actual containers; marker data was synthetic, enforcement was the real kernel. This is not a real website-login claim.

Actual kernel reads showed `memory.max=536870912`, `memory.swap.max=0`, `pids.max=128`, `cpu.max=50000 100000`. Bounded pressure produced OOM kill of the allocation child, PID creation refusal (`EAGAIN`), CPU throttling and `ENOSPC` on each tested filesystem. Workspace writes reached about 1,004,535,808 B and profile writes about 993,001,472 B before refusal; filesystem capacity was 1,020,702,720 B. Direct outbound connect failed with `ENETUNREACH`; raw socket creation failed with `EPERM`. Foreign host/slot paths were absent. These subcases do not prove the unrun scoped registry proxy or arbitrary MCP/memory/share matrix.

Both kernels ran the valid Git pack-bomb procedure inside the installed service mount namespace and service identity. A valid commit/tree graph referenced a 2 GiB zero blob in a 2,087,535 B bundle. Before the fix, the mirror was incorrectly verified. After the fix, push import refused with `git_decoded_objects_bound` before verification or credential release, while a small valid control passed. The real `prlimit` values were AS 268,435,456 B, FSIZE 134,217,728 B and CORE 0. The private 128 MiB tmpfs returned `ENOSPC` under aggregate pressure; scratch was cleaned. This is broker/kernel evidence, not an authenticated GitHub push. Scoped registry routing/denial and the live skip-worktree procedure remain pending.

On the final runtime, arm64 also completed an actual five-minute idle stop (`computer_idle`), preserving its files and clearing the lease. A later real VM reboot interrupted a correlated computer attempt: the attempt count stayed one and the work became `handler_requires_reconciliation`, without automatic resubmission. Its model-written workspace marker and operator-written synthetic profile marker persisted. The exact Web reset then emptied both filesystems after actual settlement while other Bots' workspace/profile markers remained. An initial observation immediately after the reset receipt still had files; that was intent, not claimed completion.

Dedicated disposable Bots on both hosts completed capability-change, retire, explicit re-enable and delete races during recorded running attempts. arm64 used real computer work; x64 used tool-free Codex inference because its computer startup remained broken. All six race runs committed zero work results. Both Bots reached terminal deleted state, and their disk claims were returned. The first arm64 retirement confirmation was correctly refused as `stale_lifecycle_preview`; a fresh exact preview succeeded. No existing research Bot was deleted for this drill.

Both services were actually SIGKILLed during research. systemd restarted them; recorded `replay_safe_resumed` checkpoints link old and replacement attempts. Already committed sibling evidence remained. Conservative original reservations were not refunded, and some recovery paths exhausted their remaining budget. Both VMs were actually rebooted and returned with changed boot IDs and mounted pools. An interrupted interval is not an uninterrupted run or power-loss durability proof.

OPS14-01 completed a real installed-state backup/restore round trip on each architecture. Backup was requested through the Web, then a private owner-authenticated offline prepare/validate/exact-hash activate sequence restored an older image against the current independent lifecycle ledger. A memory marker created before backup and deleted afterwards stayed deleted; dependent evidence remained withdrawn and the unaffected R4 artifact retained its bytes/hash. Actual service starts during quarantine exited with status 1 and exposed no Web listener; no new work was present after activation. Backup images excluded computer/profile volumes and credentials. Later Bot retirement/resource revocation permutations remain separate pending cases.

## Bugs exposed and corrected

1. Privileged installer failures discarded useful diagnostics (the existing PR fix).
2. Anonymous Parallel's real discovery schema differed from the pin; strict discovery refused real reads. The anonymous pin now matches observed discovery; authenticated-key mode remains separately unverified.
3. Research used an arbitrary 60-second deadline and could consume its final inference budget on tools. It now uses the remaining original grant deadline/call slice, reserves a finishing inference and preserves safe failure categories without fallback.
4. Invalid/oversized report candidates failed only after model completion. Candidate validation now uses a rolled-back transaction and at most one charged, tool-free correction under the same grant. Citation/authority/budget validation remains strict.
5. Compressed valid Git imports could exceed the decoded-object ceiling before mirror verification. Actual decoded object sizes are now bounded before verification/push credential release.
6. First-owner installer bootstrap raced service writers. The installer now captures its private link while stopped and delivers it only after health. Actual installer reruns and twelve clean stopped-bootstrap rounds passed on each architecture. Concurrent manual `owner-link` beside an active x64 service still produced `SQLITE_BUSY`; the bounded attach retry is not claimed to solve that case.
7. Offline restore needlessly required a runtime to stop already confirmed stopped computers in quarantine. Matching current volume cleanup evidence now settles only those boot stops, advances generations and clears leases. Changed/unsettled cleanup still blocks.
8. Restore treated an intentionally omitted, already acknowledged deleted native payload as `native_reference_missing`. Successful complete inventory now preserves that terminal deleted state; missing live/retired/uncertain identities remain unresolved.
9. Composer defaults checked tools held only by unselected Bots. A computer-only Bot's normal work form was rejected with `bot_ceiling`. Existing checkboxes now default from selected Bots only. The actual unchanged Web form was rerun after deployment.

Each code fix has deterministic regression coverage. Those tests establish contracts, not host acceptance. No new UI/UX was designed. Follow-ups for a Claude Opus 5.5 high-effort design agent: review the active Bot's link into a retained closed chat after capability changes and transient stale overview facts while lifecycle polling updates other regions; review the research/grant choices that include main-Bot research under a two-run ceiling; complete the unrun responsive/keyboard/assistive states. These are observations and pending design work, not a new design authored here.

## Validation and remaining gate

Focused protocol/research/report/Git/bootstrap/installer/restore/recovery/composer suites and TypeScript checks passed. The final runtime suite passed 2,997 tests with 5 explicit skips, 0 failures and 239,950 assertions across 142 files. The post-documentation full-suite rerun and final-head whitespace check are recorded in draft PR #284. Prior successful full runs are retained privately; an interrupted run during a later fix is not final validation.

The remaining gate includes corpus reruns after anonymous rate-limit/quota recovery, all-five-task overlap and rubric/delivery completion; x64 computer startup/storage investigation and affected reruns; full cross-Bot/MCP/private-memory/share and registry/skip-worktree enforcement; late agent browser input and the x64 computer lifecycle cases blocked by startup; real external-effect unknown-outcome recovery; natural credential renewal if observed; remaining routine authority and OPS lifecycle permutations; and device/browser/accessibility acceptance. This evidence supports `Refs #256`; the issue remains open.

## Successor handoff

The final host runtime is `c2775c06dc70adadb1f3acc7ddadc8ae7356ac03`; the evidence-only commit does not require a host upgrade. Both services are left active with no queued/running/stopping test work and no active computer. The disposable lifecycle Bots are deleted; the original research Bots remain. Temporary browser tabs, local tunnel gateway and this agent's SSH forwards are closed before the phase-2 handoff marker. Successors must wait for that private marker before changing either host.

Retained OPS recovery points consume finite backup slots (four on arm64, three on x64 in the completed round); inspect the supported current status before another operation. Do not bypass retention, lifecycle tombstones or old withdrawn report artifacts. No live Codex quota exhaustion or natural concurrent credential renewal was observed. Anonymous Parallel quota/rate-limit classification and x64 storage stalls remain distinct blockers. Implementation-era pending checklists in runbooks are not newer evidence than this record.
