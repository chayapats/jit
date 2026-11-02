# TEAM15-01 bounded contract preparation

Status: **proposed pre-admission documentation**, 2026-11-02, Refs [#324](https://github.com/chayapats/jit/issues/324). Actual implementation step 1 still says **Implement** the reviewed team/resource scope; it is NOT admitted or completed. The [contract](../contracts/s15-team-resources-v1.md), [schema](../contracts/fixtures/s15-team-resources-v1.schema.json), [complete serialized worlds](../contracts/fixtures/s15-team-resources-v1.json), [guide](../contracts/fixtures/s15-team-resources-v1.md) and [ADR0071](../adr/0071-s15-mediated-team-resources-and-fenced-handoffs.md) are review inputs only. Every scenario is **UNEXECUTED documentation**, never a passing test.

## Admission and inspected revisions

- Integration main and clean worktree start: `64f3a94726fdbce2283aec0944884ca7406d9934`, branch `t3/prepare-issue-324-team-contract`. T3 prepared this checkout; no additional checkout/worktree was created. No prerequisite branch/merge/cherry-pick/whole-file copy into this worktree.
- Read AGENTS.md, CONTEXT.md, workflow, S15/PRD, ADR0064/0065 and applicable team/sharing/context/concurrency/input/recovery contracts/source. Actual #324/#325/#323/#326/#321/#320/#318/#322/parent #316 bodies/comments and native prerequisites were inspected. Main includes merged #317/#319 audit/planning documents, not implemented S15.
- Rechecked all remote heads, the complete six-open-PR REST list and all **60 top-level project threads** (no pagination remainder). No competing #324 work/branch/active PR was found. A connector broad PR search returned issue-shaped results; an initial unquoted shell URL also failed glob expansion. Neither failure was treated as readiness. The correctly quoted complete REST pull list, exact remote heads and actual native endpoints supplied the authoritative selection audit.
- #324 is OPEN / enhancement / needs-triage / unassigned. Actual native blocker **#323 OPEN** remains. All five original implementation criteria are unchecked. #325 actually depends on #324; #324/#326/#327/#328 are independent #323 siblings. No new dependency from #326. #318 is assigned to chayapats and respected.
- [Bounded scope record](https://github.com/chayapats/jit/issues/324#issuecomment-6581837099) explicitly excludes runtime admission and preserves criteria/ownership/labels/native blockers. Only the relevant #324 ticket mirror/manifest/roadmap preparation note is updated; no readiness advancement or new schema-only issue.
- Main and all six relevant active PR trees were collision-checked: ADR0066/0067/0068/0069/0070 are occupied by #346/#347/#348/#349/#350. Proposed next ADR0071 requires integration recheck.

## Exact merged input blobs

| Input at inspected main | Git blob |
| --- | --- |
| [docs/contracts/s15-state-transition-v1.md](../contracts/s15-state-transition-v1.md) | `5e6ba001820e1f41728c8a124ed361414187e4fb` |
| [docs/adr/0065-s15-state-preservation-and-policy-adoption.md](../adr/0065-s15-state-preservation-and-policy-adoption.md) | `fb451e10fdb67064f484d02029a18cc18672c62b` |
| [docs/adr/0064-conversational-authority-and-protected-control-plane.md](../adr/0064-conversational-authority-and-protected-control-plane.md) | `03593d4622f55aa220b62718fd0da18cb64d8154` |

The transition and ADR0065 are merged **proposed audit** contracts. The main ADR0064 differs from #345's proposed revision. Neither review nor closure activates the target or admits a dependent runtime.

## Exact unmerged input blobs

All six proposals remain OPEN and absent from main, read only at these exact remote heads. Every new actor/transport/action/schema/adapter/model/cost/resource/handoff/lease assumption remains pending reconciliation with actual merged reviewed prerequisite revisions and implementation evidence. No whole prerequisite file is incorporated here. The small complete external scenarios/frames are explicitly labelled byte projections.

| PR / exact head | Input path | Git blob |
| --- | --- | --- |
| [#345](https://github.com/chayapats/jit/pull/345) `c79aab9d098c902db0cdff7f3d649ca389fff08c` | [docs/adr/0064-conversational-authority-and-protected-control-plane.md](https://github.com/chayapats/jit/blob/c79aab9d098c902db0cdff7f3d649ca389fff08c/docs/adr/0064-conversational-authority-and-protected-control-plane.md) | `08099feea574c717684099b1070a2d5fe13e1a18` |
| [#345](https://github.com/chayapats/jit/pull/345) `c79aab9d098c902db0cdff7f3d649ca389fff08c` | [docs/contracts/s15-runtime-feasibility-v1.md](https://github.com/chayapats/jit/blob/c79aab9d098c902db0cdff7f3d649ca389fff08c/docs/contracts/s15-runtime-feasibility-v1.md) | `f7237a3aa7843da00d55493a127a7107263b0824` |
| [#346](https://github.com/chayapats/jit/pull/346) `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919` | [docs/adr/0066-s15-standing-policy-and-prepared-actions.md](https://github.com/chayapats/jit/blob/de2a4b08f9653d01dc0766e5cefa65ac6e2b9919/docs/adr/0066-s15-standing-policy-and-prepared-actions.md) | `ca62a24e81f7601a9b6778997f7cb6b55b24b4a8` |
| [#346](https://github.com/chayapats/jit/pull/346) `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919` | [docs/contracts/fixtures/s15-standing-policy-v1.json](https://github.com/chayapats/jit/blob/de2a4b08f9653d01dc0766e5cefa65ac6e2b9919/docs/contracts/fixtures/s15-standing-policy-v1.json) | `63c0f0a756f19fc8c4ceb695cfd9cfa7bf143a7d` |
| [#346](https://github.com/chayapats/jit/pull/346) `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919` | [docs/contracts/fixtures/s15-standing-policy-v1.md](https://github.com/chayapats/jit/blob/de2a4b08f9653d01dc0766e5cefa65ac6e2b9919/docs/contracts/fixtures/s15-standing-policy-v1.md) | `8455f6e2b400e3c98cffd622d1259d7547bebc87` |
| [#346](https://github.com/chayapats/jit/pull/346) `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919` | [docs/contracts/s15-standing-policy-v1.md](https://github.com/chayapats/jit/blob/de2a4b08f9653d01dc0766e5cefa65ac6e2b9919/docs/contracts/s15-standing-policy-v1.md) | `3c1d5596cc3433eca4aaa5507a02256d3d196462` |
| [#346](https://github.com/chayapats/jit/pull/346) `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919` | [docs/evidence/s15-policy-contract-preparation.md](https://github.com/chayapats/jit/blob/de2a4b08f9653d01dc0766e5cefa65ac6e2b9919/docs/evidence/s15-policy-contract-preparation.md) | `28325572b048682a73b1e5880fd20a63eca5f165` |
| [#347](https://github.com/chayapats/jit/pull/347) `f6cb307b9ee56f5090960a9b737b20be6957baa6` | [docs/adr/0067-s15-working-vm-operation-and-settlement.md](https://github.com/chayapats/jit/blob/f6cb307b9ee56f5090960a9b737b20be6957baa6/docs/adr/0067-s15-working-vm-operation-and-settlement.md) | `7aab500ef07780a35c1b089694b9ef17ebc0cc60` |
| [#347](https://github.com/chayapats/jit/pull/347) `f6cb307b9ee56f5090960a9b737b20be6957baa6` | [docs/contracts/fixtures/s15-working-vm-v1.json](https://github.com/chayapats/jit/blob/f6cb307b9ee56f5090960a9b737b20be6957baa6/docs/contracts/fixtures/s15-working-vm-v1.json) | `e18393661cc4180314db03f2e336fb0aa64db65d` |
| [#347](https://github.com/chayapats/jit/pull/347) `f6cb307b9ee56f5090960a9b737b20be6957baa6` | [docs/contracts/fixtures/s15-working-vm-v1.md](https://github.com/chayapats/jit/blob/f6cb307b9ee56f5090960a9b737b20be6957baa6/docs/contracts/fixtures/s15-working-vm-v1.md) | `7657ddd3d7d729db7f3a5b3e95b88a52b1960689` |
| [#347](https://github.com/chayapats/jit/pull/347) `f6cb307b9ee56f5090960a9b737b20be6957baa6` | [docs/contracts/fixtures/s15-working-vm-v1.schema.json](https://github.com/chayapats/jit/blob/f6cb307b9ee56f5090960a9b737b20be6957baa6/docs/contracts/fixtures/s15-working-vm-v1.schema.json) | `6bca159a369b1ebc56e8fef250a5e9ed7c82bd92` |
| [#347](https://github.com/chayapats/jit/pull/347) `f6cb307b9ee56f5090960a9b737b20be6957baa6` | [docs/contracts/s15-working-vm-v1.md](https://github.com/chayapats/jit/blob/f6cb307b9ee56f5090960a9b737b20be6957baa6/docs/contracts/s15-working-vm-v1.md) | `6922f2ff77661ddbe64a34d0c8b5c0a33e04db35` |
| [#347](https://github.com/chayapats/jit/pull/347) `f6cb307b9ee56f5090960a9b737b20be6957baa6` | [docs/evidence/s15-vm-contract-preparation.md](https://github.com/chayapats/jit/blob/f6cb307b9ee56f5090960a9b737b20be6957baa6/docs/evidence/s15-vm-contract-preparation.md) | `2fbb4f3849aafc3483eec37e6685db8cde8dbcda` |
| [#348](https://github.com/chayapats/jit/pull/348) `7c16b7b6b08005715cacb147e0382f824674ccce` | [docs/adr/0068-s15-protected-browser-operations-and-evidence.md](https://github.com/chayapats/jit/blob/7c16b7b6b08005715cacb147e0382f824674ccce/docs/adr/0068-s15-protected-browser-operations-and-evidence.md) | `4d98bcbf1dbd11d8a76e78c10eaa9feed44fa49d` |
| [#348](https://github.com/chayapats/jit/pull/348) `7c16b7b6b08005715cacb147e0382f824674ccce` | [docs/contracts/fixtures/s15-protected-browser-v1.json](https://github.com/chayapats/jit/blob/7c16b7b6b08005715cacb147e0382f824674ccce/docs/contracts/fixtures/s15-protected-browser-v1.json) | `7e9e9019fdac0c771873306db8e911fc37dc6848` |
| [#348](https://github.com/chayapats/jit/pull/348) `7c16b7b6b08005715cacb147e0382f824674ccce` | [docs/contracts/fixtures/s15-protected-browser-v1.md](https://github.com/chayapats/jit/blob/7c16b7b6b08005715cacb147e0382f824674ccce/docs/contracts/fixtures/s15-protected-browser-v1.md) | `236cdeb442ec87cc6b8e5100bfb445b986585d1b` |
| [#348](https://github.com/chayapats/jit/pull/348) `7c16b7b6b08005715cacb147e0382f824674ccce` | [docs/contracts/fixtures/s15-protected-browser-v1.schema.json](https://github.com/chayapats/jit/blob/7c16b7b6b08005715cacb147e0382f824674ccce/docs/contracts/fixtures/s15-protected-browser-v1.schema.json) | `120c46e490b9dd00b02e0c077f64daa993206f5a` |
| [#348](https://github.com/chayapats/jit/pull/348) `7c16b7b6b08005715cacb147e0382f824674ccce` | [docs/contracts/s15-protected-browser-v1.md](https://github.com/chayapats/jit/blob/7c16b7b6b08005715cacb147e0382f824674ccce/docs/contracts/s15-protected-browser-v1.md) | `11fc079342c7baa49ea6532bd23a37f533030819` |
| [#348](https://github.com/chayapats/jit/pull/348) `7c16b7b6b08005715cacb147e0382f824674ccce` | [docs/evidence/s15-browser-contract-preparation.md](https://github.com/chayapats/jit/blob/7c16b7b6b08005715cacb147e0382f824674ccce/docs/evidence/s15-browser-contract-preparation.md) | `d75cc72c3ca54e36840b027c2216dd2163a5cfcc` |
| [#349](https://github.com/chayapats/jit/pull/349) `c5d281b5825432a1a2dbf451233cc64f749f195b` | [docs/adr/0069-s15-conversational-admission-and-result-continuity.md](https://github.com/chayapats/jit/blob/c5d281b5825432a1a2dbf451233cc64f749f195b/docs/adr/0069-s15-conversational-admission-and-result-continuity.md) | `f9824661f412456ea0857349595a19d50b46a7fa` |
| [#349](https://github.com/chayapats/jit/pull/349) `c5d281b5825432a1a2dbf451233cc64f749f195b` | [docs/contracts/fixtures/s15-conversation-v1.json](https://github.com/chayapats/jit/blob/c5d281b5825432a1a2dbf451233cc64f749f195b/docs/contracts/fixtures/s15-conversation-v1.json) | `7272828286209c23c986f903b5e0b554104a05a3` |
| [#349](https://github.com/chayapats/jit/pull/349) `c5d281b5825432a1a2dbf451233cc64f749f195b` | [docs/contracts/fixtures/s15-conversation-v1.md](https://github.com/chayapats/jit/blob/c5d281b5825432a1a2dbf451233cc64f749f195b/docs/contracts/fixtures/s15-conversation-v1.md) | `4eeaba8ccec797f41c9f8c38437d252c0a9a9572` |
| [#349](https://github.com/chayapats/jit/pull/349) `c5d281b5825432a1a2dbf451233cc64f749f195b` | [docs/contracts/fixtures/s15-conversation-v1.schema.json](https://github.com/chayapats/jit/blob/c5d281b5825432a1a2dbf451233cc64f749f195b/docs/contracts/fixtures/s15-conversation-v1.schema.json) | `1ab6ba4b5c2cf60465e10f8d458a4d16b8a5faa3` |
| [#349](https://github.com/chayapats/jit/pull/349) `c5d281b5825432a1a2dbf451233cc64f749f195b` | [docs/contracts/s15-conversation-v1.md](https://github.com/chayapats/jit/blob/c5d281b5825432a1a2dbf451233cc64f749f195b/docs/contracts/s15-conversation-v1.md) | `ad23421bbca55edd40a4602de09c47eb957c49bf` |
| [#349](https://github.com/chayapats/jit/pull/349) `c5d281b5825432a1a2dbf451233cc64f749f195b` | [docs/evidence/s15-chat-contract-preparation.md](https://github.com/chayapats/jit/blob/c5d281b5825432a1a2dbf451233cc64f749f195b/docs/evidence/s15-chat-contract-preparation.md) | `f33a6d7f760e945726318a4e383030ae181932cd` |
| [#350](https://github.com/chayapats/jit/pull/350) `e0988281cb79bc31c8e373d66a83a61f6cf46030` | [docs/adr/0070-s15-approved-model-selection-and-disclosure.md](https://github.com/chayapats/jit/blob/e0988281cb79bc31c8e373d66a83a61f6cf46030/docs/adr/0070-s15-approved-model-selection-and-disclosure.md) | `88392e75e62df9de42af7adb379b16f6915b9659` |
| [#350](https://github.com/chayapats/jit/pull/350) `e0988281cb79bc31c8e373d66a83a61f6cf46030` | [docs/contracts/fixtures/s15-model-selection-v1.json](https://github.com/chayapats/jit/blob/e0988281cb79bc31c8e373d66a83a61f6cf46030/docs/contracts/fixtures/s15-model-selection-v1.json) | `751c457c364f9e10e806591d3dd74b482d3029ad` |
| [#350](https://github.com/chayapats/jit/pull/350) `e0988281cb79bc31c8e373d66a83a61f6cf46030` | [docs/contracts/fixtures/s15-model-selection-v1.md](https://github.com/chayapats/jit/blob/e0988281cb79bc31c8e373d66a83a61f6cf46030/docs/contracts/fixtures/s15-model-selection-v1.md) | `3ba3c7eb8aab65cee063d45d4cd549ed34dc9a3c` |
| [#350](https://github.com/chayapats/jit/pull/350) `e0988281cb79bc31c8e373d66a83a61f6cf46030` | [docs/contracts/fixtures/s15-model-selection-v1.schema.json](https://github.com/chayapats/jit/blob/e0988281cb79bc31c8e373d66a83a61f6cf46030/docs/contracts/fixtures/s15-model-selection-v1.schema.json) | `bd9f8c8b7c9153e03cd4a30cea6bb1d84e4e6d83` |
| [#350](https://github.com/chayapats/jit/pull/350) `e0988281cb79bc31c8e373d66a83a61f6cf46030` | [docs/contracts/s15-model-selection-v1.md](https://github.com/chayapats/jit/blob/e0988281cb79bc31c8e373d66a83a61f6cf46030/docs/contracts/s15-model-selection-v1.md) | `6c45d9d13dc82c83625912079e7afc51d9c98070` |
| [#350](https://github.com/chayapats/jit/pull/350) `e0988281cb79bc31c8e373d66a83a61f6cf46030` | [docs/evidence/s15-model-contract-preparation.md](https://github.com/chayapats/jit/blob/e0988281cb79bc31c8e373d66a83a61f6cf46030/docs/evidence/s15-model-contract-preparation.md) | `79e2491ccc750414a4617518e9b9993ddfe32177` |

The owner-supplied exact-head review records identify 5/5 APPROVED / Greptile Review SUCCESS for these inputs. #326's final handoff is [recorded here](https://github.com/chayapats/jit/issues/326#issuecomment-6581682985). Those are review inputs, never implementation/merge/admission authority. No predecessor PR was changed, merged or watched by this preparation.

## Static source fingerprints

The following source paths were inspected for architecture/logic/current contracts. A blob identifies the exact source, not a runtime test or external enforcement proof. Web-related source/test files were read for wiring/logic only, without UI/UX authoring.

| Source at inspected main | Git blob |
| --- | --- |
| [AGENTS.md](../../AGENTS.md) | `4b348a8211e66c0cdd8183ca2afc1bc0e82c7a88` |
| [CONTEXT.md](../../CONTEXT.md) | `8b2c3e27785802816d27b6231403a87741443773` |
| [docs/agents/workflow.md](../../docs/agents/workflow.md) | `6b2a7a2b282c3b807fae7835c47cf52762dafab0` |
| [docs/specs/S15-conversational-autonomy.md](../../docs/specs/S15-conversational-autonomy.md) | `ff17e1f117f1c980c41f166cd0d406d3f2c54790` |
| [docs/product/02-prd.md](../../docs/product/02-prd.md) | `a297b16ae526e80a6e730f6eb79b2bad6580fdfa` |
| [src/s14/graph.ts](../../src/s14/graph.ts) | `18f9ca3a2380828107c4b84047525c5780740e02` |
| [src/s14/graph-types.ts](../../src/s14/graph-types.ts) | `d90fe48ed084f0239403f6612fac36e234763281` |
| [src/s14/sharing.ts](../../src/s14/sharing.ts) | `05191a506107af62420700c44aa6bbe09bc20b01` |
| [src/s14/sharing-types.ts](../../src/s14/sharing-types.ts) | `879dd17266aac24ced1329c730805ca4c6bce1f3` |
| [src/s14/memory.ts](../../src/s14/memory.ts) | `408aa3ffa14461681d70eee3447876489663b09a` |
| [src/s14/memory-types.ts](../../src/s14/memory-types.ts) | `b3e0c7810b855e3145a35bb4d0516f3090b2bc4e` |
| [src/s14/computer.ts](../../src/s14/computer.ts) | `4823faaf2e6cc9af20e7b685fe9d0814c37e5347` |
| [src/s14/computer-types.ts](../../src/s14/computer-types.ts) | `39afedb1d5af96a6a728205092f5d7444b5d1a07` |
| [src/s14/authority.ts](../../src/s14/authority.ts) | `ad122dce76c498fa5ee198521db3a82c70b226f4` |
| [src/s14/authority-types.ts](../../src/s14/authority-types.ts) | `9d626483adedfe43d297e11fd7efb53c432b5ef9` |
| [src/s14/types.ts](../../src/s14/types.ts) | `08b93ec26fc0a4e303a99b91c6ff4f872b5225b9` |
| [src/s14/lifecycle.ts](../../src/s14/lifecycle.ts) | `2d138a0e3f00425e1198382377dd28c3da33c855` |
| [src/s14/research.ts](../../src/s14/research.ts) | `be8cc7b4c2eefeb12f7b61969c2930fb65b20aed` |
| [src/s14/research-handoff.ts](../../src/s14/research-handoff.ts) | `988eb2540cb8d22d0c7039f66a99316e0fef6aab` |
| [src/s14/native-recovery.ts](../../src/s14/native-recovery.ts) | `0d1ded8a4150f12954dec26c844745da282e0dd6` |
| [src/s14/recovery.ts](../../src/s14/recovery.ts) | `3f53b59bdfa163ffc745b1a67160c4ecfc2fa5bf` |
| [src/s14/chat.ts](../../src/s14/chat.ts) | `d7d0fad15a9c90a946c421345b16ff18680cd980` |
| [tests/s14-team.test.ts](../../tests/s14-team.test.ts) | `ecb76a075690e697ba5e643758f8bc9687911534` |
| [tests/s14-sharing.test.ts](../../tests/s14-sharing.test.ts) | `518bec20527f622793f3f3ea0f6eab5b0e7f2b09` |
| [tests/s14-memory.test.ts](../../tests/s14-memory.test.ts) | `0e65e554053208b7a5e455134cc43d34fce934be` |
| [tests/s14-authority.test.ts](../../tests/s14-authority.test.ts) | `bc6335ba0b2efa8f8ab1b9044474f6f497e295e2` |
| [tests/s14-computer.test.ts](../../tests/s14-computer.test.ts) | `7f34d70ac0cb4f21f72387c4d66899964642e47e` |
| [tests/s14-input-evidence.test.ts](../../tests/s14-input-evidence.test.ts) | `62090690d065581827651f029d7f41917a31f7f9` |
| [tests/s14-recovery.test.ts](../../tests/s14-recovery.test.ts) | `9f66fb588d3f056ed9d74d1d16bdab5dde779a55` |
| [tests/context-packet.test.ts](../../tests/context-packet.test.ts) | `6159c37ba504190b0cefedea2f7d6f3e9fb93a92` |
| [tests/s14-share-recovery-ui.test.ts](../../tests/s14-share-recovery-ui.test.ts) | `dd1ca47a01457c4984595e6cda4b8ee22cee386a` |

The S14 graph enforces private Bot/resource/share intersections; memory filters before relevance and retains uncited producer ancestry; sharing copies exact bounded immutable receiver snapshots; computer input uses current exclusive lease/takeover generations; recovery retains uncertain capacity and independent usage maxima. Their implementation meanings are preserved. `schwayChat` remains empty tools / maxTurns:1; message.post/task.accept/work.start are not reinterpreted.

## Public Schway artifact

Pin: `vendor/schway-1.0.0-rc.2-697bf40.tgz`, version `1.0.0-rc.2`, upstream `697bf406a84c8d1deb8d4a6d71876ea1003be5b3`, recomputed SHA-256 `1c9d83de46edddff58a0163452e7f5ec8357e656c90093990fa28fa606a0f41b`. Package exports and relevant public re-exported declarations were read as inert bytes only. No module was imported/executed and no account/session/catalog/readiness/provider API was called. Reading a declaration file does not make its private path a production import.

| Inert artifact member | SHA-256 of exact bytes |
| --- | --- |
| `package/package.json` | `c08391c7eb0be98c8ba6e468e18bb5eb307d5e943cfa93e570349c2da8df77f1` |
| `package/dist/types/host/index.d.ts` | `d67a8584e19b0caa643d5f84b68677bfa41623bea3d3e9bf23c796d2d57b2a32` |
| `package/dist/types/model/model.d.ts` | `696ea52cdd64617bf50a3745f782843b32542bcda4228625b5ddf5983d59d667` |
| `package/dist/types/tools/backend.d.ts` | `38ce4dd3951f3e68cb20370c37a9bb7d2f3d0eea0bdf4da5d67ae2e3c46c2384` |
| `package/dist/types/tools/types.d.ts` | `460db4ffcad52d1a6c42eae48e4ad365e0d5df862981d4b0fd61e604a7338b28` |
| `package/dist/types/context/policy.d.ts` | `d52ee98748599bb61602268db7cf4ce5d9f0874c433bef63b8d0efaaeb9c4d2a` |
| `package/dist/types/host/image-input.d.ts` | `6af09a90fb114dba4c75368861391cbaa5d4274d1e1d519a2a9e39445278760c` |
| `package/dist/types/host/credential-lifecycle.d.ts` | `8356774dc842873ac52c54a5faede182d6cac375a572d6bd389288c39fe7bd92` |
| `package/dist/types/host/session-inventory.d.ts` | `188c0929d63126fe82d91a915254e04a44bf58a6f2a9e1399e2f69f189fa6790` |

The public Model/Host/tool/backend/context/image/session/lifecycle/inventory seams compose trusted Jit adapters. Native tool exclusivity is not a cross-run lease; backend paths/observations are not a malicious-root sandbox; public snapshots/inventory do not relocate native state. Preserve #321 actor-bound prepare/accept/signal/guarded read/synchronous publication/original-scope cancellation, #322 independent facts/same action-or-read emitter/original child charges/header-inclusive directional frames, #320 original paid continuation/nonrefundable finite bounds and #326 noncircular authorized packet preparation.

MG15-P01–P03 are demonstrated proposed public requirements from the exact #326 artifact, not available new hooks or newly executed failing probes. The necessary outer Model stream guard cannot prove post-credential/per-physical dispatch (including Grok's internal 401 renewal resend), public thinking cannot prove exact sent/honored effort, and codex has no enforced output-token cap. Retained bytes/subscriptions/null usage cannot bound monetary cost. No upstream issue/native edge/private protocol/provider invocation/renewal implementation/competing Jit loop is invented; production governed support remains unproven.

## Static validation and delivery identity

Performed **document checks only** with a temporary Python Draft202012 JSON Schema validator (`jsonschema 4.26.0`, installed in `/tmp/jit-team324/validation`, no repository dependency change), standard JSON/base64/hash/Git readers and temporary static-check scripts outside the repository:

```sh
python3 /tmp/jit-team324/check.py
python3 /tmp/jit-team324/check_docs.py
shasum -a 256 vendor/schway-1.0.0-rc.2-697bf40.tgz
git diff --check
```

The schema meta-schema, closed root, all named scalar/data examples and malformed-document rejection are checked. Static traversal verifies every record domain/hash, raw byte wrapper/Blob catalog, reservation/charge/claim identity, complete original antecedent times, dispatch/capture/publication causality, decision bytes, immutable old charges, monotonic independent facts and exact external owning scenario/frame bytes against their original checked-in schema. Additional local link/requirement/signature/ticket/mirror/manifest/ADR collision/diff checks cover the final artifacts. The fixture guide describes reproduction and conversion; temporary scripts are not product validators, executable probes, runtime tests or passing scenario evidence.

Final static consistency: **73 schema definitions, 71 closed named type/value arms and directly valid examples including scalars, 77 complete UNEXECUTED worlds, six malformed root counterexamples, 5651 record-hash occurrences, 1147 byte wrappers, 4816 BlobV1 references, 854 serialized world-catalog blob/byte pairs, 77 complete typed cost-basis bindings, 2115 causal-time assertions, 948 monotonic-fact assertions, 247 exact owner-decision byte inclusions, two unchanged complete external scenarios and two unchanged complete directional frames**. Document checks also cover **97 local links, 37 exact pinned input links, 18 signature data names, nine unchanged original obligation sections, 25 unchanged other manifest tickets, five unchecked implementation criteria and seven collision-checked main/input trees**. These are artifact consistency counts, not executed/passing runtime or scenario tests.

The exact checked HEAD/delivered blobs are recorded in the containing PR after the immutable commit is created. A file cannot embed its own final Git blob/commit without changing that identity. Use the PR's final checked HEAD and `git rev-parse HEAD:<path>` for the exact delivered artifact, separately from inspected main. Review remediation must rerun affected static checks, record its new head and preserve these source/input revisions.

## Open obligations and explicit limits

TEAM15-FZ01–FZ07 remain OPEN. All five #324 implementation criteria and native #323 remain outstanding. Exact reviewed proposals are not merged, installed, frozen or implementation-ready. Full runtime/DDL/storage materializers, actual owner/worker/catalog/adapter issuance, physical file/lease/CAS/input/final emitter/settlement enforcement, real transports/brokers/platform/build evidence remain their slices. Synthetic setup neither authenticates actors nor proves support.

Preserve current continuity/request/claim identity, nonrefundable usage, withdrawals/policy revocations, original source bytes, explicit private/account/receiver restrictions, old grants/approvals/routines nondispatchability and fixed opaque native workspaces through adoption/rollback. No raw profile/native relocation/copy/promotion, inherited numeric allowance/account/budget/model readiness, permanent-Bot policy or Jod integration. Unknown effects/reads/calls remain reconcile-only; stop/expiry cannot erase capture/dispatch/channel facts or settle an unrelated sibling. Ordinary owner output is not outbound approval. Default GitHub publication/replies versus bounded installed personal exception, separate merge authority and production holds persist.

No option B, guest-loss acceptance, weaker destructive-gate guarantee or read-only substitute for full administration/general browser is selected. RT15-01/RF15-G01–G08 remain unproven. Required Claude author remains unavailable under [#337's record](https://github.com/chayapats/jit/issues/337#issuecomment-6572828439); no retry, substitution, subagent, UI/UX/provider/model/settings/account/spending change. S14 stays default.

No runtime tests/typecheck, executable/live probe, browser/CDP/VM/backend/ingress implementation, account/profile/session/model/provider/subscription/catalog/readiness call, credential inspection, host/policy activation, provisioning, rollout or merge. The proposed PR uses Refs #324, no closing keyword, documentation label or review-disabling keyword. Normal exact-head review is requested; after the final review handoff the PR stays OPEN/no merge and its watch is removed. Useful next authorized bounded work is reassessed in actual dependency order after review, not assumed from issue numbering or runtime blocker closure.
