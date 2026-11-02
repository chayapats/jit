# POLICY15-01 bounded contract preparation

Status: **documentation-only, pre-admission proposal**, 2026-11-02. Refs [#320](https://github.com/chayapats/jit/issues/320), parent [#316](https://github.com/chayapats/jit/issues/316). This record does not close either issue, complete step 1's reviewed freeze or admit runtime work. S14 remains the implemented default. Requirements retain FR-06/13/14/15/17/18/35/37/38; NFR-05/06/07/14 and S15-AC07/08/09.

## Admission inspected

| Item | Exact observation |
| --- | --- |
| Main / starting HEAD | `64f3a94726fdbce2283aec0944884ca7406d9934`; remote main rechecked at preparation |
| Existing prepared workspace | `t3/prepare-issue-320-policy-contract`; T3 prepared the worktree. No checkout/worktree setup or unmerged-PR integration performed. |
| #320 | OPEN, no assignee or comments at initial admission; enhancement / needs-triage, no ready-for-agent. No competing remote `*320*` branch or related active PR. The only active top-level #320 thread is this prepared worktree. |
| Parent and prerequisites | #316 body/comments read. Native blockers: #318 OPEN, #319 CLOSED. #317 / PR #343 merge `bf59e4c42c182b8a9c8611bdc2b76c44918faa2b` is in base; #319 / PR #344 merge is starting main. Upstream issue closure is not a runtime proof. |
| Merged proposed state artifacts | ADR 0065 blob `fb451e10fdb67064f484d02029a18cc18672c62b`; s15-state-transition/v1 blob `5e6ba001820e1f41728c8a124ed361414187e4fb` |
| Unmerged remote boundary evidence | #318 / PR #345 head `c79aab9d098c902db0cdff7f3d649ca389fff08c`; feasibility blob `f7237a3aa7843da00d55493a127a7107263b0824`; ADR 0064 blob `08099feea574c717684099b1070a2d5fe13e1a18`. Read through exact remote contents, not copied into this branch or described as main/implemented. |
| #345 review status at inspection | OPEN, Greptile 5/5 APPROVED and Greptile Review SUCCESS at that exact head; no merge authorization. This PR does not merge #345. |
| Required UX author | #337 blocked: actual claudeAgent / claude-opus-5-5 / effort high attempt at `2026-11-02T08:41:06Z` failed with rate limit and usage/spend notices, recorded in [owner-authoring evidence](https://github.com/chayapats/jit/issues/337#issuecomment-6572828439). No retry/provider switch/spending change or substitute UX author. #338/#339 remain blocked; no S15 experience design exists in this base. |
| Work record | [Bounded start comment](https://github.com/chayapats/jit/issues/320#issuecomment-6573869519); native dependencies and all implementation acceptance criteria preserved |

## Delivered proposal and source audit

- [s15-standing-policy/v1](../contracts/s15-standing-policy-v1.md): closed record grammar, canonical validation/hash domains, explicit current scope/generation refs, owner/work/approval distinctions, finite conservative accounting, trusted ports/adapter signatures and dispatch/publication/continuity ordering.
- [Fixture interpretation](../contracts/fixtures/s15-standing-policy-v1.md) and [complete synthetic JSON](../contracts/fixtures/s15-standing-policy-v1.json): proposed no-send inputs and required outcomes; no executed-scenario or passing-test claim.
- [ADR 0066](../adr/0066-s15-standing-policy-and-prepared-actions.md): proposed choices, alternatives and freeze/proof obligations. Number/path checked against main and #345 trees before authoring.
- [Ticket mirror](../tickets/s15/POLICY15-01.md), [roadmap](../tickets/S15-conversational-autonomy-roadmap.md), [manifest](../tickets/s15/manifest.json): bounded preparation status only; #320 is blocked / needs-triage, not an implementation claim or new schema-only ticket.

Read source at starting main: `src/s14/application.ts`, `authority.ts`, `authority-types.ts`, `validation.ts`, `policy.ts`, `recovery.ts` and relevant Git/personal effect types. Inspected actual deterministic test source in `tests/s14-authority.test.ts`, `s14-recovery.test.ts`, `s14-personal-effects.test.ts`, `s14-coding-git.test.ts`, `s14-ops.test.ts`, including spoofing/receipt atomicity, stale source/tool/publication, final argument substitution, revocation/expiry races, reservation maxima and unknown claimed effects through stale-image restore. These tests were **not run** for this documentation change.

Reusable S14 seams are the opaque actor registry/current session recheck, receipt+queue transaction, exact bounded canonical records, current generation/source guards, claim-before-performer, current independent-ledger reservation maxima, and separate owner-statement/read-back basis. They do not implement S15 chat authority, standing rules, immediate edits, personal publication/merge or real VM/browser containment. No production source import/signature/behavior was modified. No private Schway path, replacement loop or speculative upstream blocker is introduced.

## Validation and limits

Required document review: local link existence, schema/type/fixture consistency and exact canonical hash examples, preserved FR/NFR/acceptance IDs, dependency/status consistency, English-only additions, scope of git diff and `git diff --check`. Record final HEAD, delivered blobs, commands and actual review/check evidence in the PR; a file cannot embed its own final blob/commit identity. Synthetic fixture hashing is a static documentation calculation, not an executable adapter probe or a runtime test.

Documentation self-review checked 47 local links, 50 exact fixture record shapes, 12 record-domain hash examples, 12 raw blob hashes and 42 uniquely ordered scenario definitions without a document-consistency error. Manifest dependency edges, acceptance criteria/case mappings, readiness and labels remain unchanged. The check used a disposable Python documentation checker outside the repository; no executable probe/test was added. `git diff --check` is required again on the committed final head. These counts describe static document checks, not 42 passing policy/effect tests.

Greptile's first review at `faaf39992576c3359ae9649e50fd7b6f4e6b854a` returned 4/5, COMMENTED and a successful check, with two verified P2 contract ambiguities: [claimed actions blocking their original continuation/publication](https://github.com/chayapats/jit/pull/346#discussion_r4441065228), and [approval potentially advancing the action revision it binds](https://github.com/chayapats/jit/pull/346#discussion_r4441065242). The contract now separates new admission, original registered final dispatch, observation and publication guards; reuses the exact existing reservation without charging twice; and specifies command-by-command revision changes. Approval appends a separate record without changing prepared action revision/hash. Synthetic PC15-D41/D42 document the required continuation/publication and unchanged-approval-binding outcomes. They are not executed regression tests. Final reviewed HEAD/artifact blobs and subsequent review/check state belong in the PR evidence.

Not run: runtime typecheck/tests, paid/live inference/subscription/account/host tests, working VM/root/egress or sensitive browser sessions, adoption/restore/rollback, real send/payment/publication adapters, rollout or deployment. No live store/vault/native/session/config was opened. No runtime/DDL, policy/host activation, UI/UX or merge is delivered. Installation-specific addresses/private evidence remain outside tracked files in ignored `.local/` custody.

PC15-FZ01–FZ05 in the contract remain open. All proposed actor/schema/action/adapter choices depend on reconciliation with merged reviewed #318 and actual implementation. Current continuity/request identity/usage/withdrawals/policy revocations and S14 private scopes survive future adoption/rollback; old grants/approvals/routines do not dispatch. RT15-01 and RF15-G01–G08 remain unproven. Green review cannot certify #320 readiness or S15 enforcement.

After this PR's reviewed bounded preparation, recheck real prerequisites, ownership, related PRs/branches and top-level threads before choosing the next executable slice. Do not create a duplicate #320 runtime thread, prematurely ready VM/UI work or retry the blocked required author. No merge of this PR or #345 is authorized.
