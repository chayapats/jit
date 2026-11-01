# S14 owner-Pi cutover acceptance — 2026-11-01

The three host acceptance criteria of [CUT14-01 #267](https://github.com/chayapats/jit/issues/267) are **met for the named arm64 installation/build**. Complete post-first-reply R4 equality also passed. GitHub #267 and parent #244 remain OPEN at this pre-merge checkpoint: reviewed closeout merge, verification of #267 closure, and then parent closeout are separate actions. Requirements: S14-AC01/14; NFR-06/08/12. The earlier [#256 release evidence](s14-mvp-evidence.md) retains its own builds, failures and limits.

## Tested source and installation

| Pin | Actual value |
| --- | --- |
| Default-selection delivery | [PR #305](https://github.com/chayapats/jit/pull/305), merged `5eec7aa7adb73858b5f7091348ef1611949cc82a` |
| Tested/installed source | `5eec7aa7adb73858b5f7091348ef1611949cc82a` |
| Source tree | `c98a8a2d44283bee0b72e894f58012e1458932dd` |
| Linux arm64 artifact | `aae92971-89fe-4b16-a5ad-b4a329b24491` |
| Artifact content SHA-256 | `014ff34216d117470d67611292da6efafd2211655eaedf75ab850f396d77c488` |
| Sealed dependency SHA-256 | `fa614129567efd9ef94c62f4ce590e320a5b9c068252f37dd35637354fc6f612` |
| Runtime/store | Bun 1.4.2; independent S14 schema 17 |
| Selected live route | Codex subscription, exact `gpt-6.1-sol` |

All 873 source files and 409 packaged source files matched the reviewed tree; the 7,066 Linux arm64 dependency files were independently verified on Pi and Mac. The source tree equals PR #305's passing six-shard CI tree: 3,177 pass, six opt-in skips, no failure, plus typecheck and deterministic aggregation. That result is attributed to the default-selection code, not a substitute for host acceptance or a later-head certification. Immutable package fields `engineRevision: unverified` and `piValidation: pending` were not rewritten; exact source/vendor/lock pins and actual host observations are retained separately.

The supported bare-default `runInstaller` call omitted the S14 selector and created fresh separate service, identity, application state, keyring and computer pool. Existing legacy state was retained. Setup used the existing private fd 3/controlling-terminal and Web cookie/CSRF/password contracts; credentials and capabilities were not logged or transferred from legacy. S14 was reactivated as the same owned installation, active/enabled, with legacy retained inactive/disabled and an explicit original-release restore path.

## Required host results

| Criterion | Actual evidence | Result |
| --- | --- | --- |
| Fresh installation reaches a first reply | Owner completed native Codex approval. One committed tool-free `message.post` produced a persisted successful reply, correlated to its original request receipt, owner message, reply and Bot message. Exact route above; `tools: []`, hosted lookup off, one turn/attempt, 60,000 ms runtime deadline, no retry or fallback. | PASS |
| Legacy database, boxes and backups retain identical bytes | Complete R0/R1 and R2/R3 preserved manifests matched, 586,905 entries per comparison. R1 preceded provider approval; complete R4 after native approval and the actual first reply also equalled R2/R3, independently verified on Mac. | PASS |
| Prior-release rollback is rehearsed | The actual retained legacy service started with unchanged prior code, configuration, state, identity, argv and Bun. Independent bounded public login health returned HTTP 200 without redirect; supervised process/identity and copied owner/history provenance were verified. The same owned S14 installation was then reactivated. | PASS |

The preservation sets cover every retained file and absence, database sidecar/control/native/box/profile/backup bytes, hardlink topology, symlink targets, xattrs/ACLs, modes, ownership and modification time. They are complete comparisons, not samples. Both R0 and R2 retain full protected raw recoveries, verified archive content/metadata/link records, separate verified Pi filesystem copies and independently verified Mac copies. Shared administrative identity/subordinate-ID additions are recorded separately; this is not whole-OS equality.

Legacy startup/shutdown legitimately changed seven retained entries between R0 and R2. Those changes are disclosed separately; R0/R1 and R2/R3/R4 are distinct quiesced windows. No manual SQL state edits, legacy conversion/deletion, credential migration, image shrinking, pruning or restoring old bytes to manufacture equality occurred. The original legacy database was not opened by the operator: idle-state and copied history inspection used disposable verified recovery clones with read-only/query-only SQLite and all recorded sidecars. Unknown state was never silently counted as zero.

## Retained failures and scoped observations

- A prior-release start-control helper returned exit 2 after initiating the original start. Its exact failed assertion was not emitted, so no cause is invented. A later bounded read-only observation proved the actual original supervised process and health without another start or repair. The failed helper invocation remains FAIL; the actual rollback rehearsal has independent PASS evidence.
- The retained legacy unit actually used Bun 1.4.2 while its older manifest/dependency metadata named 1.4.3. Those bytes were preserved and the actual restart passed. This observation makes no general runtime-version compatibility promise.
- Initial conservative cold-start inspection retained one projected-expired card and three dormant notifications. Exact pinned source/configuration predicates verified that they could not dispatch on this unchanged cold start; raw records were retained. Earlier inspector and private-cwd diagnostics remain failed history.
- The installed service-evidence helper falsely treated optional `buildInputsHash` provenance as a third image reference. Independent read-only checks verified both actual image references/digests. The closeout fix checks only base/browser refs and keeps absent/timed-out images false; it does not change runtime image pins, isolation, resources or authority, and is not claimed as a new Pi deployment.

The finite pool had eight slots/sixteen 1 GiB ext4 images, full sparse-growth commitment, required mount boundaries and a verified 128 MiB Git scratch tmpfs. Separate credential service, private user API and retained state boundaries were observed. No new computer/model research, website adapter, external effect, arbitrary power-loss, reboot, CPU-overlap or cross-host certification follows from this installation and one first reply.

## Evidence custody and remaining limits

Raw manifests/recoveries, exact target mappings, custom paths, private receipts and operational commands remain in protected ignored `.local` records. No account identifier, device approval data, password/session material or raw recovery content is published here. The parent reviewed 477 indexed cutover files (5.93 GB), 254 pinned prior-source files, complete preservation witnesses and later receipt-correlated first-reply/R4 evidence. This documentation does not itself repeat live operations.

Research reports remain explicitly **owner-unread** under the original delegated rubric/usefulness decision; direct owner report acceptance is a separate fact. VoiceOver chat/new-reply/error remain **NOT RUN** under the recorded owner deferral. Real iPhone observations remain **NOT RUN** within the recorded coverage limits. Earlier Mac samples and all #256 results keep their exact tested-build scope. These disclosed limits are not converted into passes or new acceptance gates. See [ADR 0061](../adr/0061-s14-default-selection-and-legacy-compatibility.md), the [cutover runbook](../runbooks/s14-default-cutover.md), and the [ticket checkpoint](../tickets/s14/CUT14-01.md).
