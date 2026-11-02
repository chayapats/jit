# VM15-01 bounded contract preparation

Status: **documentation-only, pre-admission**, 2026-11-02, for [#321](https://github.com/chayapats/jit/issues/321). This record does not certify #321, runtime readiness, a completed contract freeze, RT15-01, RF15-G01–G08 or S15-AC03. S14 remains default. All #321 implementation criteria/native prerequisites remain intact; the preparation PR uses **Refs #321** and stays OPEN without merge.

## Admission and inspected inputs

- Inspected integration main: `64f3a94726fdbce2283aec0944884ca7406d9934`, rechecked against remote main. This prepared T3 worktree/branch is `t3/prepare-issue-321-vm-contract`; no extra checkout/worktree was created.
- Read AGENTS.md, CONTEXT.md, workflow, S15 spec, PRD, ADRs 0036/0046/0050/0054/0064/0065, relevant computer/backend/runner/recovery/authority source/tests and exact public Schway declarations. #321/#320/#316 bodies/comments and actual native prerequisites were fetched. #318 comments/ownership were checked as related evidence.
- #321 was OPEN / enhancement / needs-triage, unassigned, zero comments, direct native blocker #320 OPEN. No remote `*321*` branch or competing open PR existed. The prepared current local branch is the selected issue work. #318 is assigned to chayapats, with its existing reviewed unmerged work respected.
- T3 inventory examined all 56 top-level project threads, with no next page; only this thread was active and only it matched VM15/#321 in titles. Additional #321 search was not treated as exhaustive proof. Current open PRs were #345/#346; their changed paths/trees and exact heads were read. Remote branch/issue/native relation checks were successful; no failed broad lookup was used as admission evidence.
- [Scope comment](https://github.com/chayapats/jit/issues/321#issuecomment-6576641978) records the owner-authorized bounded preparation. This is not a claim/label/coordinator workflow or permission to implement. No assignee, dependency or checkbox changes are made.

| Exact input | Revision / state |
| --- | --- |
| #317 / PR #343 | Merged `bf59e4c42c182b8a9c8611bdc2b76c44918faa2b`, included in inspected main |
| #319 / PR #344 | Merged in main; transition blob `5e6ba001820e1f41728c8a124ed361414187e4fb`, ADR 0065 blob `fb451e10fdb67064f484d02029a18cc18672c62b`; proposed audit contracts only |
| Main ADR 0064 | `03593d4622f55aa220b62718fd0da18cb64d8154` |
| #318 / PR #345 | OPEN at `c79aab9d098c902db0cdff7f3d649ca389fff08c`; feasibility blob `f7237a3aa7843da00d55493a127a7107263b0824`, ADR 0064 blob `08099feea574c717684099b1070a2d5fe13e1a18`; Greptile APPROVED exact head, check SUCCESS |
| #320 / PR #346 | OPEN at `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919`; contract `3c1d5596cc3433eca4aaa5507a02256d3d196462`, JSON `63c0f0a756f19fc8c4ceb695cfd9cfa7bf143a7d`, guide `8455f6e2b400e3c98cffd622d1259d7547bebc87`, ADR 0066 `ca62a24e81f7601a9b6778997f7cb6b55b24b4a8`, evidence `28325572b048682a73b1e5880fd20a63eca5f165` |
| #346 inspected review/check | Greptile 5/5 APPROVED at `2026-11-02T10:32:47Z` on that head; current check snapshot SUCCESS completed `2026-11-02T10:38:35Z`. Earlier handoff recorded SUCCESS at `10:32:41Z`; the later check timestamp is a new observed check snapshot, not a different head/review. |
| ADR collision check | Complete main/#345/#346 remote trees were not truncated. Main/#345 have no 0066/0067; #346 owns 0066 and no 0067. Proposed 0067 rechecks active PR trees before publication. |

Unmerged blobs were fetched by exact remote Git blob ID into temporary inspection storage and their Git hashes verified; complete remote trees confirm their paths at the pinned PR heads. No branch from, cherry-pick, merge or whole-file copy from either input PR. Every new actor/action/schema/transport/adapter assumption remains pending reconciliation with **actual merged reviewed** #318/#320 revisions and implementation evidence. Closing an audit or a green review supplies no runtime grant.

## Source and public surface audit

The [contract's source table](../contracts/s15-working-vm-v1.md#public-host-audit-and-reusable-seams) records useful bounded seams and non-reusable S14 semantics. Source files were read as text; no application/store/native/credential constructors were invoked. The pinned tarball was read as archive data only. `schway/host` publicly re-exports the inspected backend/core-tool/session types; internal declaration paths are inspection locations, never proposed production imports.

Pin: `schway@1.0.0-rc.2`, upstream `697bf406a84c8d1deb8d4a6d71876ea1003be5b3`, tarball SHA-256 `1c9d83de46edddff58a0163452e7f5ec8357e656c90093990fa28fa606a0f41b`. Public package exports are `./host` and `./extensions`; this proposal needs only `schway/host`. Static declaration support is not actual model/provider/VM readiness. No demonstrated specific missing public host behavior requires a Schway issue.

The inspected paths include `src/s14/computer.ts`, `computer-types.ts`, `computer-work.ts`, `computer-podman.ts`, `research.ts`, `native-recovery.ts`, `ops-native.ts`; `src/exec/box-backend.ts`, `box-runtime.ts`; `ops/box/runner`; existing computer/backend/runner/authority/recovery tests. Source fingerprints and exact delivered blobs are recorded in the PR alongside final HEAD; no install-specific addresses or secret/private state are needed.

## Delivered proposal and validation boundary

- [Versioned contract](../contracts/s15-working-vm-v1.md): transport-neutral closed operation/management/runner types and trusted signatures, identity/generation/process fences, exact framing/byte/time/resource bounds, path/observation/env/output/error handling, claim/dedupe/final-I/O ordering, cancellation/settlement/publication and replay limits.
- [Proposed ADR 0067](../adr/0067-s15-working-vm-operation-and-settlement.md): protected management, separate capacity facts, reusable public backend composition and explicit consequences.
- [Schema](../contracts/fixtures/s15-working-vm-v1.schema.json), [complete synthetic data](../contracts/fixtures/s15-working-vm-v1.json) and [interpretation/index](../contracts/fixtures/s15-working-vm-v1.md): closed data definitions, exact synthetic byte/hash/frame records, complete worlds and input → expected-state steps. They are not installed APIs or passing tests.
- [Ticket mirror](../tickets/s15/VM15-01.md), [roadmap](../tickets/S15-conversational-autonomy-roadmap.md) and [manifest](../tickets/s15/manifest.json): bounded preparation only; native #320, every original implementation criterion and ready/complete status stay unchanged.

Static validation checks local links/anchors, closed schema references, documented port-data type/property consistency, all complete fixture record/world/step shapes, stage reference resolution, record/byte/frame hashes and immutable request/claim correlations, original ticket criteria/dependency/FR/NFR/acceptance IDs and `git diff --check`. Canonical positive/negative frame bytes are checked for documentation consistency only. The checker is temporary inspection tooling, not a tracked executable probe or scenario/runtime implementation. Final counts/revision are recorded in the PR, avoiding a self-referential evidence-file hash.

**Not run:** synthetic scenario behavior, runner/core-tool/host/runtime tests, runtime typecheck, model/provider/subscription/account calls, VM/backend/hypervisor operations, provisioning, network/bypass tests, Linux x64/arm64 execution, native storage relocation, live adoption/rollback or power-loss proof. No paid route, spending/account configuration, UI/UX, policy/host activation, rollout or merge. Fixture generation/JSON/schema/hash/link inspection does not certify enforcement.

## Open freeze, proof and owner boundaries

VM15-FZ01–FZ07 remain open, including prerequisite reconciliation, actual actor/catalog/adapter and claim/reservation mapping, external endpoint/process/service-transfer proof, filesystem races, real resource/egress enforcement, asset/impact/RT15-01 and current continuity/adoption/rollback. Full runtime/DDL, browser/effect/model transports and platform/build evidence remain their respective slices. No owner input is necessary merely to propose these contracts.

Unrestricted root can destroy guest files/OS/Docker/service uptime; snapshots recover captured versions and do not prevent it. The [asset inventory/matrix](../contracts/s15-working-vm-v1.md#protected-assets-and-rt15-01-impact-inventory) does not select option B, accept guest loss, weaken a guarantee or substitute restricted/read-only administration. A specific owner tradeoff is requested only if actual architecture/evidence requires changing confirmed capability/guarantees before activation. All RF15-G01–G08 remain unproven.

Keep protected Jit/provider/channel/vault/management credentials and owner/policy/effect/continuity/request ledgers, sensitive website sessions and native correlation workspaces outside guest/root/prompts/exports. No guest firewall/sibling/host allowlist/GET/readOnlyHint/model-label universal enforcement claim. Preserve fixed opaque native workspaces, all current claims/usage/withdrawals/policy revocations/request identities and S14/legacy private data/account restrictions in either adoption direction. Old grants/approvals/routines never dispatch. Product-default GitHub publication/replies versus separate installed personal exception/merge authority/production holds remain intact.

[UX15-00 #337](https://github.com/chayapats/jit/issues/337#issuecomment-6572828439) records required exact Claude authoring failing on usage/spend limits at `2026-11-02T08:41:06Z`; no retry, alternate provider/model, catalog-readiness inference, spending increase or primary-authored UX is allowed here. #338/#339 remain separately blocked; the absent S15 experience document is not fabricated.

## Follow-on selection rule

After review, recheck actual native dependencies, ownership/branches/PRs/threads and source drift. Runtime implementation stays blocked until its real prerequisites/freeze/evidence are satisfied. Useful authorized **bounded static preparation** may still be feasible for a later existing slice, for example protected-browser operation/session custody research, without admitting runtime or authoring UI. Do not infer either “all work is ready” or “no work remains” from an open runtime blocker. A follow-on must state its own limited deliverable, respect #318 ownership and #337 authoring limits, and avoid duplicate/premature runtime/UI threads. Record the actual next selection/evidence in the PR handoff rather than changing dependency edges.

## Verified initial review corrections

Greptile on initial head `4ce46d41ac9c93081c697b5366eb40d4f1507631` returned two valid P2 findings. The correction preserves prior channel/captured-response facts in VM15-D33/D34/D35 and the same owner-statement case D84; rejecting stop evidence no longer reopens settled transport or erases captured output. A static monotonic-fact comparison covers every settlement fixture definition.

The backend signatures now expose actor-bound `prepare`, cancellation-signal dispatch, guarded `readResult`, synchronous final `publishResult` and memoized original-scope `cancel`, with closed result/cancel observation schemas and complete positive/pending/withheld/spoofed/cancel definitions. Available results bind the captured response hash and required scope/transport settlement; current guards prevent raw/late payload delivery. No undocumented result side channel or transport retry is needed. New definitions remain unexecuted documentation. Exact corrected HEAD/blobs and final review/check evidence are recorded in the PR; runtime admission and every original limitation remain unchanged.
