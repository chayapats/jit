# CHAT15-01 bounded contract preparation

Status: **proposed pre-admission documentation**, 2026-11-02, Refs #323. This is implementation step 1 preparation only, not runtime admission, final contract freeze, issue completion or acceptance. S14 remains the implemented default. The [conversation contract](../contracts/s15-conversation-v1.md), [ADR0069](../adr/0069-s15-conversational-admission-and-result-continuity.md), [closed schema](../contracts/fixtures/s15-conversation-v1.schema.json), [complete serialized definitions](../contracts/fixtures/s15-conversation-v1.json) and [guide](../contracts/fixtures/s15-conversation-v1.md) are the deliverables.

## Selection, ownership and actual prerequisites

The owner selected this separate T3 top-level worktree/branch `t3/prepare-issue-323-chat-contract`; it was already prepared by T3. No shell checkout/worktree, delegate or alternative provider/model/settings was created. Rechecked before authoring: #323 OPEN, unassigned, enhancement/needs-triage, zero prior comments, native #321 OPEN, no competing remote *323* branch, active PR or other top-level thread. All remote branches, all four open PRs and all 58 project top-level threads were inspected with no pagination remainder. The initial prior audit had 57 threads; this selected thread accounts for the additional entry. #318 remains assigned to chayapats and was not taken over.

Actual #323/#321/#320/#318/#322/#316 bodies/comments/native prerequisites and #326's body/comments were read. Native edges are #323→#321, #321→#320, #320→#318/#319, #318→#317. #317/#319 are closed/merged; #318/#320/#321/#322 remain OPEN. #326/#324/#327/#328 depend on #323 by actual tracker data; ticket numbering does not create dependencies. No readiness label, native edge or original acceptance criterion is advanced. [Start record](https://github.com/chayapats/jit/issues/323#issuecomment-6579145269).

Inspected integration main is `64f3a94726fdbce2283aec0944884ca7406d9934`; DOC15 PR #343 is merged at `bf59e4c42c182b8a9c8611bdc2b76c44918faa2b`; STATE15 PR #344 is merged in this base. Its transition/ADR0065 files remain proposed audit contracts. Main contains ADR0064/0065, not 0066–0069. Active #346/#347/#348 trees occupy 0066/0067/0068 respectively; #345 has its proposed 0064 refinement. ADR0069 is proposed here after that collision check; integration must check again.

## Exact remote proposal inputs

All four PRs are OPEN/unmerged and absent from main. Exact-head Greptile approvals and Greptile Review SUCCESS were rechecked: #345 `2026-11-02T08:32:49Z`; #346 `10:32:47Z`; #347 `12:43:08Z`; #348 `13:53:45Z`. Confidence is 5/5 in the existing review records, not new implementation evidence. #348's final reviewed revision includes the action-or-read emitter, complete directional frame and exact prior child-charge corrections. No reviewed prerequisite was merged, branched from, cherry-picked or copied wholesale into this worktree. Every new actor/transport/action/schema/adapter assumption requires reconciliation with actual merged reviewed prerequisite revisions and implementation evidence.

| Input | Exact commit | Path | Git blob |
| --- | --- | --- | --- |
| #318 | `c79aab9d098c902db0cdff7f3d649ca389fff08c` | [docs/adr/0064-conversational-authority-and-protected-control-plane.md](https://github.com/chayapats/jit/blob/c79aab9d098c902db0cdff7f3d649ca389fff08c/docs/adr/0064-conversational-authority-and-protected-control-plane.md) | `08099feea574c717684099b1070a2d5fe13e1a18` |
| #318 | `c79aab9d098c902db0cdff7f3d649ca389fff08c` | [docs/contracts/s15-runtime-feasibility-v1.md](https://github.com/chayapats/jit/blob/c79aab9d098c902db0cdff7f3d649ca389fff08c/docs/contracts/s15-runtime-feasibility-v1.md) | `f7237a3aa7843da00d55493a127a7107263b0824` |
| #320 | `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919` | [docs/adr/0066-s15-standing-policy-and-prepared-actions.md](https://github.com/chayapats/jit/blob/de2a4b08f9653d01dc0766e5cefa65ac6e2b9919/docs/adr/0066-s15-standing-policy-and-prepared-actions.md) | `ca62a24e81f7601a9b6778997f7cb6b55b24b4a8` |
| #320 | `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919` | [docs/contracts/fixtures/s15-standing-policy-v1.json](https://github.com/chayapats/jit/blob/de2a4b08f9653d01dc0766e5cefa65ac6e2b9919/docs/contracts/fixtures/s15-standing-policy-v1.json) | `63c0f0a756f19fc8c4ceb695cfd9cfa7bf143a7d` |
| #320 | `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919` | [docs/contracts/fixtures/s15-standing-policy-v1.md](https://github.com/chayapats/jit/blob/de2a4b08f9653d01dc0766e5cefa65ac6e2b9919/docs/contracts/fixtures/s15-standing-policy-v1.md) | `8455f6e2b400e3c98cffd622d1259d7547bebc87` |
| #320 | `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919` | [docs/contracts/s15-standing-policy-v1.md](https://github.com/chayapats/jit/blob/de2a4b08f9653d01dc0766e5cefa65ac6e2b9919/docs/contracts/s15-standing-policy-v1.md) | `3c1d5596cc3433eca4aaa5507a02256d3d196462` |
| #320 | `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919` | [docs/evidence/s15-policy-contract-preparation.md](https://github.com/chayapats/jit/blob/de2a4b08f9653d01dc0766e5cefa65ac6e2b9919/docs/evidence/s15-policy-contract-preparation.md) | `28325572b048682a73b1e5880fd20a63eca5f165` |
| #321 | `f6cb307b9ee56f5090960a9b737b20be6957baa6` | [docs/adr/0067-s15-working-vm-operation-and-settlement.md](https://github.com/chayapats/jit/blob/f6cb307b9ee56f5090960a9b737b20be6957baa6/docs/adr/0067-s15-working-vm-operation-and-settlement.md) | `7aab500ef07780a35c1b089694b9ef17ebc0cc60` |
| #321 | `f6cb307b9ee56f5090960a9b737b20be6957baa6` | [docs/contracts/fixtures/s15-working-vm-v1.json](https://github.com/chayapats/jit/blob/f6cb307b9ee56f5090960a9b737b20be6957baa6/docs/contracts/fixtures/s15-working-vm-v1.json) | `e18393661cc4180314db03f2e336fb0aa64db65d` |
| #321 | `f6cb307b9ee56f5090960a9b737b20be6957baa6` | [docs/contracts/fixtures/s15-working-vm-v1.md](https://github.com/chayapats/jit/blob/f6cb307b9ee56f5090960a9b737b20be6957baa6/docs/contracts/fixtures/s15-working-vm-v1.md) | `7657ddd3d7d729db7f3a5b3e95b88a52b1960689` |
| #321 | `f6cb307b9ee56f5090960a9b737b20be6957baa6` | [docs/contracts/fixtures/s15-working-vm-v1.schema.json](https://github.com/chayapats/jit/blob/f6cb307b9ee56f5090960a9b737b20be6957baa6/docs/contracts/fixtures/s15-working-vm-v1.schema.json) | `6bca159a369b1ebc56e8fef250a5e9ed7c82bd92` |
| #321 | `f6cb307b9ee56f5090960a9b737b20be6957baa6` | [docs/contracts/s15-working-vm-v1.md](https://github.com/chayapats/jit/blob/f6cb307b9ee56f5090960a9b737b20be6957baa6/docs/contracts/s15-working-vm-v1.md) | `6922f2ff77661ddbe64a34d0c8b5c0a33e04db35` |
| #321 | `f6cb307b9ee56f5090960a9b737b20be6957baa6` | [docs/evidence/s15-vm-contract-preparation.md](https://github.com/chayapats/jit/blob/f6cb307b9ee56f5090960a9b737b20be6957baa6/docs/evidence/s15-vm-contract-preparation.md) | `2fbb4f3849aafc3483eec37e6685db8cde8dbcda` |
| #322 | `7c16b7b6b08005715cacb147e0382f824674ccce` | [docs/adr/0068-s15-protected-browser-operations-and-evidence.md](https://github.com/chayapats/jit/blob/7c16b7b6b08005715cacb147e0382f824674ccce/docs/adr/0068-s15-protected-browser-operations-and-evidence.md) | `4d98bcbf1dbd11d8a76e78c10eaa9feed44fa49d` |
| #322 | `7c16b7b6b08005715cacb147e0382f824674ccce` | [docs/contracts/fixtures/s15-protected-browser-v1.json](https://github.com/chayapats/jit/blob/7c16b7b6b08005715cacb147e0382f824674ccce/docs/contracts/fixtures/s15-protected-browser-v1.json) | `7e9e9019fdac0c771873306db8e911fc37dc6848` |
| #322 | `7c16b7b6b08005715cacb147e0382f824674ccce` | [docs/contracts/fixtures/s15-protected-browser-v1.md](https://github.com/chayapats/jit/blob/7c16b7b6b08005715cacb147e0382f824674ccce/docs/contracts/fixtures/s15-protected-browser-v1.md) | `236cdeb442ec87cc6b8e5100bfb445b986585d1b` |
| #322 | `7c16b7b6b08005715cacb147e0382f824674ccce` | [docs/contracts/fixtures/s15-protected-browser-v1.schema.json](https://github.com/chayapats/jit/blob/7c16b7b6b08005715cacb147e0382f824674ccce/docs/contracts/fixtures/s15-protected-browser-v1.schema.json) | `120c46e490b9dd00b02e0c077f64daa993206f5a` |
| #322 | `7c16b7b6b08005715cacb147e0382f824674ccce` | [docs/contracts/s15-protected-browser-v1.md](https://github.com/chayapats/jit/blob/7c16b7b6b08005715cacb147e0382f824674ccce/docs/contracts/s15-protected-browser-v1.md) | `11fc079342c7baa49ea6532bd23a37f533030819` |
| #322 | `7c16b7b6b08005715cacb147e0382f824674ccce` | [docs/evidence/s15-browser-contract-preparation.md](https://github.com/chayapats/jit/blob/7c16b7b6b08005715cacb147e0382f824674ccce/docs/evidence/s15-browser-contract-preparation.md) | `d75cc72c3ca54e36840b027c2216dd2163a5cfcc` |

RT15-01 and RF15-G01–G08 remain unproven. No option B, loss acceptance, narrower administration guarantee, read-only-only completion or invented Schway blocker. General browser work and an administrable VM remain confirmed targets. Required UX authoring is separately unavailable as recorded at [#337](https://github.com/chayapats/jit/issues/337#issuecomment-6572828439); no retry, substitute author, account/provider/model/settings/spending change or completed experience handoff. #338/#339 remain blocked.

## Source inventory at inspected main

The following are tracked source/contract bytes read statically; test files were inspected as source, not run. web-product.ts was read for wiring/logic only, with no UI design. Hashes identify source content, not running behavior. No application/store/host constructor or live native/vault/config/state was opened.

| Source | Git blob at inspected main |
| --- | --- |
| [AGENTS.md](../../AGENTS.md) | `4b348a8211e66c0cdd8183ca2afc1bc0e82c7a88` |
| [CONTEXT.md](../../CONTEXT.md) | `8b2c3e27785802816d27b6231403a87741443773` |
| [docs/agents/workflow.md](../../docs/agents/workflow.md) | `6b2a7a2b282c3b807fae7835c47cf52762dafab0` |
| [docs/specs/S15-conversational-autonomy.md](../../docs/specs/S15-conversational-autonomy.md) | `ff17e1f117f1c980c41f166cd0d406d3f2c54790` |
| [docs/product/02-prd.md](../../docs/product/02-prd.md) | `a297b16ae526e80a6e730f6eb79b2bad6580fdfa` |
| [docs/adr/0064-conversational-authority-and-protected-control-plane.md](../../docs/adr/0064-conversational-authority-and-protected-control-plane.md) | `03593d4622f55aa220b62718fd0da18cb64d8154` |
| [docs/adr/0065-s15-state-preservation-and-policy-adoption.md](../../docs/adr/0065-s15-state-preservation-and-policy-adoption.md) | `fb451e10fdb67064f484d02029a18cc18672c62b` |
| [docs/contracts/s15-state-transition-v1.md](../../docs/contracts/s15-state-transition-v1.md) | `5e6ba001820e1f41728c8a124ed361414187e4fb` |
| [src/s14/chat.ts](../../src/s14/chat.ts) | `d7d0fad15a9c90a946c421345b16ff18680cd980` |
| [src/s14/application.ts](../../src/s14/application.ts) | `383127ffbed76317baa9f2274f5c5d48550c32d7` |
| [src/s14/types.ts](../../src/s14/types.ts) | `08b93ec26fc0a4e303a99b91c6ff4f872b5225b9` |
| [src/s14/authority.ts](../../src/s14/authority.ts) | `ad122dce76c498fa5ee198521db3a82c70b226f4` |
| [src/s14/authority-types.ts](../../src/s14/authority-types.ts) | `9d626483adedfe43d297e11fd7efb53c432b5ef9` |
| [src/s14/validation.ts](../../src/s14/validation.ts) | `345d5f8b5cf9d1314f093730d790deab9b3278e9` |
| [src/s14/graph.ts](../../src/s14/graph.ts) | `18f9ca3a2380828107c4b84047525c5780740e02` |
| [src/s14/main.ts](../../src/s14/main.ts) | `b4e894becb1f0c6098189615559db1b862f1da34` |
| [src/s14/pump.ts](../../src/s14/pump.ts) | `f51ad11dfa0e94243923c99c9961ce3b9ea25b53` |
| [src/s14/native-recovery.ts](../../src/s14/native-recovery.ts) | `0d1ded8a4150f12954dec26c844745da282e0dd6` |
| [src/s14/recovery.ts](../../src/s14/recovery.ts) | `3f53b59bdfa163ffc745b1a67160c4ecfc2fa5bf` |
| [src/s14/web.ts](../../src/s14/web.ts) | `ce1d0d3f88de0edad742890fa041bc9f7ebc5ffe` |
| [src/s14/web-product.ts](../../src/s14/web-product.ts) | `422f580e30372de49ea79ffa5f73cf1c8c33df6b` |
| [src/telegram/protocol.ts](../../src/telegram/protocol.ts) | `8c0ab553edf89a43ef75a8d6bdee0e1c86260db9` |
| [src/telegram/binding.ts](../../src/telegram/binding.ts) | `d809119b622ae9faa71a0eaf928027b0d488ce10` |
| [tests/s14-bots.test.ts](../../tests/s14-bots.test.ts) | `1c020f3e6384669577b7f0e1f13acc02e035cac2` |
| [tests/s14-authority.test.ts](../../tests/s14-authority.test.ts) | `bc6335ba0b2efa8f8ab1b9044474f6f497e295e2` |
| [tests/s14-memory.test.ts](../../tests/s14-memory.test.ts) | `0e65e554053208b7a5e455134cc43d34fce934be` |
| [tests/s14-recovery.test.ts](../../tests/s14-recovery.test.ts) | `9f66fb588d3f056ed9d74d1d16bdab5dde779a55` |
| [tests/s14-reports.test.ts](../../tests/s14-reports.test.ts) | `765f4de5359aa6162c3e433000de80dc189611e3` |
| [tests/s14-web-ui.test.ts](../../tests/s14-web-ui.test.ts) | `2eb723750206852b513871c371423885ea012b33` |
| [tests/telegram.test.ts](../../tests/telegram.test.ts) | `0c4a87b346af2621004ee21f73a087d632ff7f53` |
| [tests/telegram-approvals.test.ts](../../tests/telegram-approvals.test.ts) | `b5296f384baa2ccc36423e7f38b83bfa6c633897` |
| [tests/web-reply-stream.test.ts](../../tests/web-reply-stream.test.ts) | `710b4ef75e4d945b97f658e36f37cd7e979d2639` |
| [docs/contracts/s14-foundation-http.md](../../docs/contracts/s14-foundation-http.md) | `7ef09f14caceeb15e28713d3345f8b32d27a212b` |
| [package.json](../../package.json) | `c8ad8b62e4e6317c31f996ddb5ed9a7229d043d3` |
| [bun.lock](../../bun.lock) | `6d2248c4a65c9088ae2887ec508755fb256660ec` |
| [vendor/schway-1.0.0-rc.2-697bf40.tgz](../../vendor/schway-1.0.0-rc.2-697bf40.tgz) | `dae28eee768f463b47cba8304c45ad2670e91aec` |

Public package inspection used only the vendored tarball and its public re-export declarations/documentation. Tarball SHA-256: `1c9d83de46edddff58a0163452e7f5ec8357e656c90093990fa28fa606a0f41b`; Schway `1.0.0-rc.2`, upstream `697bf406a84c8d1deb8d4a6d71876ea1003be5b3`. No package import, hostCapabilities invocation, provider call, subscription test, runner/browser/VM access or executable probe. Included source/internal declarations do not become supported imports.

| Public package text inspected | SHA-256 of exact packed bytes |
| --- | --- |
| `package.json` | `c08391c7eb0be98c8ba6e468e18bb5eb307d5e943cfa93e570349c2da8df77f1` |
| `dist/types/host/index.d.ts` | `d67a8584e19b0caa643d5f84b68677bfa41623bea3d3e9bf23c796d2d57b2a32` |
| `dist/types/tools/types.d.ts` | `460db4ffcad52d1a6c42eae48e4ad365e0d5df862981d4b0fd61e604a7338b28` |
| `dist/types/model/model.d.ts` | `696ea52cdd64617bf50a3745f782843b32542bcda4228625b5ddf5983d59d667` |
| `dist/types/context/policy.d.ts` | `d52ee98748599bb61602268db7cf4ce5d9f0874c433bef63b8d0efaaeb9c4d2a` |
| `dist/types/host/auth-routes.d.ts` | `381afd71813111ad6fb9a7f61ca639b2e769bf6fd3bc2b7c95187718c3348563` |
| `dist/types/host/credential-lifecycle.d.ts` | `8356774dc842873ac52c54a5faede182d6cac375a572d6bd389288c39fe7bd92` |
| `dist/types/host/session-inventory.d.ts` | `188c0929d63126fe82d91a915254e04a44bf58a6f2a9e1399e2f69f189fa6790` |
| `dist/types/host/image-input.d.ts` | `6af09a90fb114dba4c75368861391cbaa5d4274d1e1d519a2a9e39445278760c` |

The available public composition is selected `host.auth.createModel()` → protected public Model forwarding guard → `session.submit`, plus exact admitted tool callbacks/backends. `submitWithRoute` does not accept a caller Model. No before-request hook, effort enforcement, native relocation, universal effect firewall or new host export is invented. The contract records the real result/cancel/progress/image/current-context/usage limitations.

## Static validation, delivered revision and limits

The containing PR records the final checked HEAD and every delivered Git blob, including this record. This file does not embed its own eventual blob or commit hash: doing so would be self-referential. The inspected main above is distinct from the delivered head. No test pass count is claimed.

Static checks completed against the delivered content: Draft 2020-12 schema and complete typed records; raw base64/count/SHA-256 pairs and all BlobV1 byte references; containing-record hash domains/projections; exact original-source byte spans and context-packet/plan identity; receipt/admission references; ordered unique events; unchanged prepared-action bindings; immutable prior charges and zero-allowance original child continuation; monotonic captured-response/channel/input/network/usage facts; local links, signature type names, unchanged requirement/criteria/blocker/labels and documentation-only diff. All 92 worlds are UNEXECUTED documentation. The temporary static validator uses JSON Schema over serialized data and independent byte/hash/identity assertions, not a scenario interpreter, runtime fixture builder or runnable probe. Temporary Python tooling stays outside the repository; no implementation dependency is added.

Post-review content counts: 58 schema definitions, 49 closed named type/value union arms, 17 named complete examples (including two scalars), 92 complete worlds, 99 complete blob/byte pairs, 1227 containing-record hashes, 581 byte-wrapper occurrences and 1027 BlobV1 reference occurrences. Static counts may change with verified review corrections; the PR records the final numbers and exact head. Final static link/type/requirement checks covered 87 local links, 23 exact remote blob links, 32 signature type names, six unchanged original ticket sections and 25 other unchanged manifest tickets; `git diff --check` is clean. These remain document checks, not scenario execution.

Greptile review of initial head `1c440a0e2c2fc4b68a6d055359670c909bc2d35f` completed with check SUCCESS but 4/5 confidence and a COMMENTED review, not approval. Both reported P2 findings were verified and corrected: the checked-in NamedRecordV1 schema now binds every declared type to its exact value schema through a closed union, and clarification receipt/charge/admission/event timestamps now follow causal order. The same clock defect was corrected in the related approval and evidence/publication examples, affecting 16 complete worlds without changing their intended dispositions, prepared action bindings, resource facts or prior charges. All affected containing hashes/references were recomputed. Seven malformed named-example counterexamples are rejected by the root schema; the two valid scalar examples are accepted. Independent static checks cover 439 causal receipt/charge/admission/event relationships across all 92 worlds. These checks operate on serialized documents only. Updated-head review remains necessary; the prior check/review does not cover a new head.

Not run: runtime tests, bun test, bun run typecheck, scenario execution, executable probes, HTTP/CSRF/channel implementation, Schway/provider/model/subscription tests, ingress/backend/VM/browser/CDP operations, live website/account/profile/session access, actual transport/broker/platform/build enforcement, provisioning, host/policy activation, adoption/rollback, rollout or merge. Static fixtures/review/closure prove none of S15-AC01, administration, general browser support or alternate-route enforcement.

No runtime/DDL files, defaults, FR/NFR IDs, credentials or protected state change. Current continuity/request/claim identities, nonrefundable charges, usage/withdrawals/policy revocations, old grants/approvals/routines nondispatchability, S14-private restrictions and original source bytes/fixed opaque native workspaces remain mandatory through adoption/rollback. No raw native/profile relocation/copy/promotion, inherited allowance/account/model readiness, permanent-Bot policy or Jod integration.

CHAT15-FZ01–FZ07 remain open. Full target storage/materializers/maintenance ports, real transports/brokers and VM/browser/root/network/Linux x64/arm64 evidence stay their delivery slices. Publication of this preparation uses Refs #323, keeps #323/PR OPEN and does not authorize merge. Greptile exact-head findings, including nonblocking/outside-diff findings, must be inspected and verified before final handoff; approval alone is not an empty findings record.
