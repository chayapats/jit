# BROW15-01 bounded contract preparation

Date: 2026-11-02. Status: **documentation-only pre-admission proposal**, revision 1. Refs [#322](https://github.com/chayapats/jit/issues/322), step 1 only. No implementation admission, final freeze, acceptance completion, ready-for-agent status or S15 activation.

## Scope and selection evidence

Inspected integration main / initial checkout HEAD: `64f3a94726fdbce2283aec0944884ca7406d9934`. Branch: `t3/prepare-issue-322-browser-contract`, prepared by T3 workspaceStrategy; no extra checkout/worktree was created. #317 / PR #343 and #319 / PR #344 are merged in this base. S14 remains default; explicit legacy/omitted-runtime service selection retains its existing meaning.

Before authoring, rechecked actual #322/#321/#320/parent #316 bodies/comments/native prerequisites, current assignees/labels, remote main/branches/open PRs and **all 57 top-level project threads**, with no pagination remainder. #322 was OPEN / enhancement / needs-triage, unassigned, zero comments, no competing branch/PR/thread. Native edges remain #322→#321 OPEN, #321→#320 OPEN, #320→#318 OPEN and #319 CLOSED. #318 remains owned by chayapats. Only #345/#346/#347 were open, at the pinned heads below. A failed unquoted tree query was corrected with a quoted exact tree query; it was not treated as evidence of absence. Main and all three active PR trees have no ADR0068; #346 occupies 0066 and #347 occupies 0067. Recheck at integration.

The bounded start record is [#322 comment](https://github.com/chayapats/jit/issues/322#issuecomment-6577554392). Open runtime blockers do not prohibit this authorized static architecture/logic preparation. They still prohibit treating it as runtime implementation admission. All original acceptance criteria, test requirements, native edges and needs-triage labels remain unchanged.

## Exact input artifacts

These were read remotely at exact Git blob revisions and their Git hashes verified. None was merged/cherry-picked/branched from or copied wholesale into the checkout. All new assumptions require reconciliation with actual merged reviewed prerequisite revisions and implementation evidence.

| Input | Exact revision / state |
| --- | --- |
| #318 / PR #345 | OPEN, head `c79aab9d098c902db0cdff7f3d649ca389fff08c`; exact-head Greptile 5/5 APPROVED / check SUCCESS; unmerged, not implemented |
| #318 feasibility | `f7237a3aa7843da00d55493a127a7107263b0824` |
| #318 proposed ADR0064 | `08099feea574c717684099b1070a2d5fe13e1a18` |
| #320 / PR #346 | OPEN, head `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919`; exact-head Greptile 5/5 APPROVED / check SUCCESS; unmerged, not implemented |
| #320 policy / synthetic JSON | `3c1d5596cc3433eca4aaa5507a02256d3d196462` / `63c0f0a756f19fc8c4ceb695cfd9cfa7bf143a7d` |
| #320 guide / ADR0066 / preparation evidence | `8455f6e2b400e3c98cffd622d1259d7547bebc87` / `ca62a24e81f7601a9b6778997f7cb6b55b24b4a8` / `28325572b048682a73b1e5880fd20a63eca5f165` |
| #321 / PR #347 | OPEN, head `f6cb307b9ee56f5090960a9b737b20be6957baa6`; exact-head Greptile 5/5 APPROVED at 2026-11-02T12:43:08Z, check SUCCESS at 12:43:01Z; unmerged, not implemented |
| #321 contract / synthetic JSON | `6922f2ff77661ddbe64a34d0c8b5c0a33e04db35` / `e18393661cc4180314db03f2e336fb0aa64db65d` |
| #321 schema / guide | `6bca159a369b1ebc56e8fef250a5e9ed7c82bd92` / `7657ddd3d7d729db7f3a5b3e95b88a52b1960689` |
| #321 ADR0067 / preparation evidence | `7aab500ef07780a35c1b089694b9ef17ebc0cc60` / `2fbb4f3849aafc3483eec37e6685db8cde8dbcda` |
| #321 final record | [issue comment](https://github.com/chayapats/jit/issues/321#issuecomment-6577491529); 111 UNEXECUTED documentation scenarios, not passing tests |
| #319 merged state transition / ADR0065 | `5e6ba001820e1f41728c8a124ed361414187e4fb` / `fb451e10fdb67064f484d02029a18cc18672c62b`; proposed audit contracts, not implemented S15 |
| Main ADR0064 / #317 merged PR #343 | `03593d4622f55aa220b62718fd0da18cb64d8154` / `bf59e4c42c182b8a9c8611bdc2b76c44918faa2b` |

#320's original-context exact reservation continuation, separate publication guards, nonrefundable conservative upper bounds, unknown usage and immutable action revision/hash at action.decide are preserved. #321's actor-bound prepare/accept, signal-aware dispatch, guarded readResult, synchronous publishResult and memoized original-scope cancellation remain distinct. Rejected stop evidence cannot rewind existing captured response/channel facts.

## Source and public surface fingerprints

The audit read source/contracts/tests as text. No source test was rerun. Git blobs below identify the inspected bytes on main.

| Source | Git blob |
| --- | --- |
| `src/s14/computer.ts` | `4823faaf2e6cc9af20e7b685fe9d0814c37e5347` |
| `src/s14/computer-types.ts` | `39afedb1d5af96a6a728205092f5d7444b5d1a07` |
| `src/s14/computer-podman.ts` | `d71ac852b676f3b8245fda29aa6d2084dc366775` |
| `src/exec/browser.ts` | `d9f554e7a5691424c0fc313fe3639f68cc24307a` |
| `src/exec/takeover.ts` | `1b5bd7d661fcc8daeec4242afcd77a6b740671d8` |
| `src/exec/cdp-stream.ts` | `636370e785bd14688e10a8f1d864ffe5a79898cf` |
| `ops/box/cdp-relay` | `d2ec182cbffbcae1b345fcac4b1cfde7c117ded3` |
| `src/s14/authority.ts` / `src/s14/recovery.ts` | `ad122dce76c498fa5ee198521db3a82c70b226f4` / `3f53b59bdfa163ffc745b1a67160c4ecfc2fa5bf` |
| `docs/contracts/app.input-lease-v1.md` | `db95bd57d42d8131b85465639a228631eddf1d5e` |
| `docs/contracts/app.bot-computer-v1.md` | `3e03aed1ec91ceb194dcb5cfe1a1f457c9324d3f` |
| `tests/s14-computer.test.ts` | `7f34d70ac0cb4f21f72387c4d66899964642e47e` |
| `tests/s14-computer-podman.test.ts` | `45eda68a4b6d519d7941d2e9da4515ae409bb80d` |
| `tests/s14-input-evidence.test.ts` | `62090690d065581827651f029d7f41917a31f7f9` |
| `tests/browser-use.test.ts` | `18fe06d1eda481bb453c405a475d3519a61a7f81` |
| `tests/s14-authority.test.ts` / `tests/s14-recovery.test.ts` | `bc6335ba0b2efa8f8ab1b9044474f6f497e295e2` / `9f66fb588d3f056ed9d74d1d16bdab5dde779a55` |

Pinned public artifact: `vendor/schway-1.0.0-rc.2-697bf40.tgz`, upstream `697bf406a84c8d1deb8d4a6d71876ea1003be5b3`, SHA-256 `1c9d83de46edddff58a0163452e7f5ec8357e656c90093990fa28fa606a0f41b` (recomputed). `package.json`, `dist/types/host/index.d.ts`, public `tools/types.d.ts`, `host/image-input.d.ts` and related public host/session/image declarations were read from the tarball. Reading the declaration behind a public re-export is not permission to import its internal path. No install, host/model/session/runner execution or new Schway blocker. Public `schway/host` owns loop/provider/native behavior; browser mediation is a Jit adapter/proof obligation.

## Delivered proposal and limitations

- [Contract](../contracts/s15-protected-browser-v1.md): closed operation/session/input/observation/request/effect-support/settlement semantics; exact proposed paths/ports/serializer; actual input/network emitter proof; candidate support/impact/attack matrix and BROW15-FZ01–FZ07.
- [Schema](../contracts/fixtures/s15-protected-browser-v1.schema.json), [complete synthetic JSON](../contracts/fixtures/s15-protected-browser-v1.json), [interpretation](../contracts/fixtures/s15-protected-browser-v1.md): complete browser worlds with explicit fake trusted-port facts, full exact parent/child action projections, byte/frame definitions and manually authored expected outcomes.
- [ADR0068](../adr/0068-s15-protected-browser-operations-and-evidence.md): proposed architecture choices; relevant #322 mirror/manifest/roadmap additions record bounded progress only.

No live physical browser/manager/egress mechanism, runtime/DDL, full target materializer, real effect broker/import/session transport or platform proof is supplied. The mediator requirements are obligations, not evidence of bypass resistance. General browser capability without bespoke business integration remains required; universal site support is not promised and read-only-only completion is not substituted. Unknown actual effect/disclosure semantics refuse before dispatch; known supported preparable actions may be held.

RT15-01 and RF15-G01–G08 remain unproven. No option B, guest data loss, reduced administration/destruction guarantee, inherited numeric budget/account/model readiness, permanent-Bot policy or Jod integration. Product-default publication versus explicit bounded personal GitHub rules, separate merge authority and production holds persist. Current continuity and S14-private/fixed opaque native boundaries persist through adoption/rollback.

Required Claude UI/UX authoring remains unavailable under [#337's recorded usage/spend limit](https://github.com/chayapats/jit/issues/337#issuecomment-6572828439). No retry, provider/model/settings switch, account/spending change, subagent or primary-authored UI/UX. `docs/design/S15-conversational-experience.md` remains absent; #338/#339 remain blocked. No screen, layout, product copy or interaction form is authored here.

## Static validation and final revision record

The disposable standard-library checker `/tmp/jit-322-prep/validate-docs.py` validates closed JSON Schema constructs, every complete typed fixture, canonical bytes/record/action/frame hashes, noncircular parent/child payload projections, prior observation/target lineage, request/claim/response correlations, exact scenario index and monotonic expected response/channel/dispatch/usage/charge/action facts. It does not execute scenarios, policy decisions, browser tools or a runtime. Local document links, signature data types, unchanged ticket criteria/native dependencies/requirements and `git diff --check` are additionally inspected. This is static consistency evidence only.

Final preparation HEAD, delivered Git blobs, final validation counts and exact-head Greptile findings/reviews/checks are recorded in the PR body and #322 completion-of-preparation comment. Those identify the final immutable artifact without embedding a self-referential commit hash in this file. Review/check evidence applies only to the named head. Leave the PR and #322 OPEN with no merge and no implementation acceptance claim.

**NOT RUN:** runtime tests/typecheck, executable probes, controlled browser/CDP/VM/backend operation, live website/account/profile/session, model/provider/subscription, real manager/network/bypass/platform/Linux proof, provisioning, policy/host activation, installation adoption/rollback or rollout. All 99 scenario definitions remain **UNEXECUTED documentation**, never passing tests. The full implementation ticket retains its original test/evidence obligations for a later admitted slice.
