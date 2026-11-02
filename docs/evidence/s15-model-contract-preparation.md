# MODEL15-01 bounded contract preparation

Status: **proposed, pre-admission, documentation only**, 2026-11-02. Refs [#326](https://github.com/chayapats/jit/issues/326); no closing keyword or runtime implementation admission. [Contract](../contracts/s15-model-selection-v1.md), [schema](../contracts/fixtures/s15-model-selection-v1.schema.json), [complete synthetic definitions](../contracts/fixtures/s15-model-selection-v1.json), [guide](../contracts/fixtures/s15-model-selection-v1.md), [ADR0070](../adr/0070-s15-approved-model-selection-and-disclosure.md).

## Selection and immutable input audit

Inspected main/initial checkout: `64f3a94726fdbce2283aec0944884ca7406d9934`. The T3-prepared issue workspace is `t3/prepare-issue-326-model-contract`; no shell checkout/worktree setup, merge/cherry-pick or prerequisite whole-file copy was performed. #317/PR#343 and #319/PR#344 are merged; their documents remain proposed audits, not implemented S15. Main's transition blob is `5e6ba001820e1f41728c8a124ed361414187e4fb`, ADR0065 `fb451e10fdb67064f484d02029a18cc18672c62b`, ADR0064 `03593d4622f55aa220b62718fd0da18cb64d8154`.

Rechecked actual #326/#323/#321/#320/#318/#322/#316 bodies/comments and native prerequisite lists. Native edges: #326→#323 OPEN; #323→#321 OPEN; #322→#321 OPEN; #321→#320 OPEN; #320→#318 OPEN and #319 CLOSED; #318→#317 CLOSED. #326 was unassigned with zero comments before the [bounded-scope record](https://github.com/chayapats/jit/issues/326#issuecomment-6580504083). #318 is assigned to chayapats; its work is respected. There was no remote *326* branch/related active PR/competing top-level thread. All remote heads, the complete five-open-PR list and all 59 top-level project threads were checked without pagination remainder. The prior #323 thread was finishing its authorized handoff, not competing for #326.

The GitHub search connector returned unrelated issues for an open-PR query. That result was **not** readiness evidence: the actual complete REST pulls list, remote refs and native relations were checked independently through repository `gh` workflow. Open runtime blockers do not exclude this bounded static preparation. #324/#326/#327/#328 independently depend on #323; #325 actually depends on #324. No numbering-derived/new native edge or gratuitous schema-only issue is introduced.

Main and exact active proposal trees were collision-checked. #346/#347/#348/#349 occupy ADR0066/0067/0068/0069; 0070 is proposed here and must be rechecked at integration. Every row below is an **exact OPEN/unmerged proposal input**, read as inert Git blobs without adopting it. These assumptions require reconciliation with actual merged reviewed prerequisites and implementation evidence. Review/closure is not runtime admission.

| Exact input head | Artifact | Git blob |
| --- | --- | --- |
| `c79aab9d098c902db0cdff7f3d649ca389fff08c` | [docs/adr/0064-conversational-authority-and-protected-control-plane.md](https://github.com/chayapats/jit/blob/c79aab9d098c902db0cdff7f3d649ca389fff08c/docs/adr/0064-conversational-authority-and-protected-control-plane.md) | `08099feea574c717684099b1070a2d5fe13e1a18` |
| `c79aab9d098c902db0cdff7f3d649ca389fff08c` | [docs/contracts/s15-runtime-feasibility-v1.md](https://github.com/chayapats/jit/blob/c79aab9d098c902db0cdff7f3d649ca389fff08c/docs/contracts/s15-runtime-feasibility-v1.md) | `f7237a3aa7843da00d55493a127a7107263b0824` |
| `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919` | [docs/adr/0066-s15-standing-policy-and-prepared-actions.md](https://github.com/chayapats/jit/blob/de2a4b08f9653d01dc0766e5cefa65ac6e2b9919/docs/adr/0066-s15-standing-policy-and-prepared-actions.md) | `ca62a24e81f7601a9b6778997f7cb6b55b24b4a8` |
| `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919` | [docs/contracts/fixtures/s15-standing-policy-v1.json](https://github.com/chayapats/jit/blob/de2a4b08f9653d01dc0766e5cefa65ac6e2b9919/docs/contracts/fixtures/s15-standing-policy-v1.json) | `63c0f0a756f19fc8c4ceb695cfd9cfa7bf143a7d` |
| `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919` | [docs/contracts/fixtures/s15-standing-policy-v1.md](https://github.com/chayapats/jit/blob/de2a4b08f9653d01dc0766e5cefa65ac6e2b9919/docs/contracts/fixtures/s15-standing-policy-v1.md) | `8455f6e2b400e3c98cffd622d1259d7547bebc87` |
| `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919` | [docs/contracts/s15-standing-policy-v1.md](https://github.com/chayapats/jit/blob/de2a4b08f9653d01dc0766e5cefa65ac6e2b9919/docs/contracts/s15-standing-policy-v1.md) | `3c1d5596cc3433eca4aaa5507a02256d3d196462` |
| `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919` | [docs/evidence/s15-policy-contract-preparation.md](https://github.com/chayapats/jit/blob/de2a4b08f9653d01dc0766e5cefa65ac6e2b9919/docs/evidence/s15-policy-contract-preparation.md) | `28325572b048682a73b1e5880fd20a63eca5f165` |
| `f6cb307b9ee56f5090960a9b737b20be6957baa6` | [docs/adr/0067-s15-working-vm-operation-and-settlement.md](https://github.com/chayapats/jit/blob/f6cb307b9ee56f5090960a9b737b20be6957baa6/docs/adr/0067-s15-working-vm-operation-and-settlement.md) | `7aab500ef07780a35c1b089694b9ef17ebc0cc60` |
| `f6cb307b9ee56f5090960a9b737b20be6957baa6` | [docs/contracts/fixtures/s15-working-vm-v1.json](https://github.com/chayapats/jit/blob/f6cb307b9ee56f5090960a9b737b20be6957baa6/docs/contracts/fixtures/s15-working-vm-v1.json) | `e18393661cc4180314db03f2e336fb0aa64db65d` |
| `f6cb307b9ee56f5090960a9b737b20be6957baa6` | [docs/contracts/fixtures/s15-working-vm-v1.md](https://github.com/chayapats/jit/blob/f6cb307b9ee56f5090960a9b737b20be6957baa6/docs/contracts/fixtures/s15-working-vm-v1.md) | `7657ddd3d7d729db7f3a5b3e95b88a52b1960689` |
| `f6cb307b9ee56f5090960a9b737b20be6957baa6` | [docs/contracts/fixtures/s15-working-vm-v1.schema.json](https://github.com/chayapats/jit/blob/f6cb307b9ee56f5090960a9b737b20be6957baa6/docs/contracts/fixtures/s15-working-vm-v1.schema.json) | `6bca159a369b1ebc56e8fef250a5e9ed7c82bd92` |
| `f6cb307b9ee56f5090960a9b737b20be6957baa6` | [docs/contracts/s15-working-vm-v1.md](https://github.com/chayapats/jit/blob/f6cb307b9ee56f5090960a9b737b20be6957baa6/docs/contracts/s15-working-vm-v1.md) | `6922f2ff77661ddbe64a34d0c8b5c0a33e04db35` |
| `f6cb307b9ee56f5090960a9b737b20be6957baa6` | [docs/evidence/s15-vm-contract-preparation.md](https://github.com/chayapats/jit/blob/f6cb307b9ee56f5090960a9b737b20be6957baa6/docs/evidence/s15-vm-contract-preparation.md) | `2fbb4f3849aafc3483eec37e6685db8cde8dbcda` |
| `7c16b7b6b08005715cacb147e0382f824674ccce` | [docs/adr/0068-s15-protected-browser-operations-and-evidence.md](https://github.com/chayapats/jit/blob/7c16b7b6b08005715cacb147e0382f824674ccce/docs/adr/0068-s15-protected-browser-operations-and-evidence.md) | `4d98bcbf1dbd11d8a76e78c10eaa9feed44fa49d` |
| `7c16b7b6b08005715cacb147e0382f824674ccce` | [docs/contracts/fixtures/s15-protected-browser-v1.json](https://github.com/chayapats/jit/blob/7c16b7b6b08005715cacb147e0382f824674ccce/docs/contracts/fixtures/s15-protected-browser-v1.json) | `7e9e9019fdac0c771873306db8e911fc37dc6848` |
| `7c16b7b6b08005715cacb147e0382f824674ccce` | [docs/contracts/fixtures/s15-protected-browser-v1.md](https://github.com/chayapats/jit/blob/7c16b7b6b08005715cacb147e0382f824674ccce/docs/contracts/fixtures/s15-protected-browser-v1.md) | `236cdeb442ec87cc6b8e5100bfb445b986585d1b` |
| `7c16b7b6b08005715cacb147e0382f824674ccce` | [docs/contracts/fixtures/s15-protected-browser-v1.schema.json](https://github.com/chayapats/jit/blob/7c16b7b6b08005715cacb147e0382f824674ccce/docs/contracts/fixtures/s15-protected-browser-v1.schema.json) | `120c46e490b9dd00b02e0c077f64daa993206f5a` |
| `7c16b7b6b08005715cacb147e0382f824674ccce` | [docs/contracts/s15-protected-browser-v1.md](https://github.com/chayapats/jit/blob/7c16b7b6b08005715cacb147e0382f824674ccce/docs/contracts/s15-protected-browser-v1.md) | `11fc079342c7baa49ea6532bd23a37f533030819` |
| `7c16b7b6b08005715cacb147e0382f824674ccce` | [docs/evidence/s15-browser-contract-preparation.md](https://github.com/chayapats/jit/blob/7c16b7b6b08005715cacb147e0382f824674ccce/docs/evidence/s15-browser-contract-preparation.md) | `d75cc72c3ca54e36840b027c2216dd2163a5cfcc` |
| `c5d281b5825432a1a2dbf451233cc64f749f195b` | [docs/adr/0069-s15-conversational-admission-and-result-continuity.md](https://github.com/chayapats/jit/blob/c5d281b5825432a1a2dbf451233cc64f749f195b/docs/adr/0069-s15-conversational-admission-and-result-continuity.md) | `f9824661f412456ea0857349595a19d50b46a7fa` |
| `c5d281b5825432a1a2dbf451233cc64f749f195b` | [docs/contracts/fixtures/s15-conversation-v1.json](https://github.com/chayapats/jit/blob/c5d281b5825432a1a2dbf451233cc64f749f195b/docs/contracts/fixtures/s15-conversation-v1.json) | `7272828286209c23c986f903b5e0b554104a05a3` |
| `c5d281b5825432a1a2dbf451233cc64f749f195b` | [docs/contracts/fixtures/s15-conversation-v1.md](https://github.com/chayapats/jit/blob/c5d281b5825432a1a2dbf451233cc64f749f195b/docs/contracts/fixtures/s15-conversation-v1.md) | `4eeaba8ccec797f41c9f8c38437d252c0a9a9572` |
| `c5d281b5825432a1a2dbf451233cc64f749f195b` | [docs/contracts/fixtures/s15-conversation-v1.schema.json](https://github.com/chayapats/jit/blob/c5d281b5825432a1a2dbf451233cc64f749f195b/docs/contracts/fixtures/s15-conversation-v1.schema.json) | `1ab6ba4b5c2cf60465e10f8d458a4d16b8a5faa3` |
| `c5d281b5825432a1a2dbf451233cc64f749f195b` | [docs/contracts/s15-conversation-v1.md](https://github.com/chayapats/jit/blob/c5d281b5825432a1a2dbf451233cc64f749f195b/docs/contracts/s15-conversation-v1.md) | `ad23421bbca55edd40a4602de09c47eb957c49bf` |
| `c5d281b5825432a1a2dbf451233cc64f749f195b` | [docs/evidence/s15-chat-contract-preparation.md](https://github.com/chayapats/jit/blob/c5d281b5825432a1a2dbf451233cc64f749f195b/docs/evidence/s15-chat-contract-preparation.md) | `f33a6d7f760e945726318a4e383030ae181932cd` |

Exact-head Greptile approvals were rechecked: #345 at `c79aab9d098c902db0cdff7f3d649ca389fff08c`, #346 at `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919`, #347 at `f6cb307b9ee56f5090960a9b737b20be6957baa6`, #348 at `7c16b7b6b08005715cacb147e0382f824674ccce`, #349 at `c5d281b5825432a1a2dbf451233cc64f749f195b`; current exact-head Greptile checks are success. These are prerequisite review facts, not this proposal's review or enforcement evidence. Preserve #323's final closed type/value union, scalar examples and corrected receipt/charge/admission/evidence/publication causal times; no prerequisite artifacts were edited or retimed.

## Inspected implementation bytes

Every source below is unchanged at the inspected main. Existing tests are inspected source only, **not rerun**; historical legacy context/route tests do not establish S15 behavior. Existing exported signatures retain their S14 meaning. Web references were inspected only for logic/wiring, without UI/UX authorship.

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
| [src/s14/types.ts](../../src/s14/types.ts) | `08b93ec26fc0a4e303a99b91c6ff4f872b5225b9` |
| [src/s14/lifecycle.ts](../../src/s14/lifecycle.ts) | `2d138a0e3f00425e1198382377dd28c3da33c855` |
| [src/s14/coding-model.ts](../../src/s14/coding-model.ts) | `d74dbfd9314cb60cb6385e45ca76a81e69cd97b0` |
| [src/s14/graph.ts](../../src/s14/graph.ts) | `18f9ca3a2380828107c4b84047525c5780740e02` |
| [src/s14/chat.ts](../../src/s14/chat.ts) | `d7d0fad15a9c90a946c421345b16ff18680cd980` |
| [src/s14/research.ts](../../src/s14/research.ts) | `be8cc7b4c2eefeb12f7b61969c2930fb65b20aed` |
| [src/s14/policy.ts](../../src/s14/policy.ts) | `b69639eb4ec92315373e37f6277fa6aba86c60f8` |
| [src/s14/authority.ts](../../src/s14/authority.ts) | `ad122dce76c498fa5ee198521db3a82c70b226f4` |
| [src/s14/authority-types.ts](../../src/s14/authority-types.ts) | `9d626483adedfe43d297e11fd7efb53c432b5ef9` |
| [src/s14/memory.ts](../../src/s14/memory.ts) | `408aa3ffa14461681d70eee3447876489663b09a` |
| [src/s14/native-recovery.ts](../../src/s14/native-recovery.ts) | `0d1ded8a4150f12954dec26c844745da282e0dd6` |
| [src/s14/recovery.ts](../../src/s14/recovery.ts) | `3f53b59bdfa163ffc745b1a67160c4ecfc2fa5bf` |
| [tests/s14-host-conformance.test.ts](../../tests/s14-host-conformance.test.ts) | `73e904dfb7f416943693f84b0185bfc472db8fad` |
| [tests/fixtures/s14-host-consumer.ts](../../tests/fixtures/s14-host-consumer.ts) | `00bffc1e56d3d17e52093f75d629b9c693d00d13` |
| [tests/schway-bridge.test.ts](../../tests/schway-bridge.test.ts) | `df41b2269f0a0224d5286f35a39d4d5c7f201e7b` |
| [tests/s14-authority.test.ts](../../tests/s14-authority.test.ts) | `bc6335ba0b2efa8f8ab1b9044474f6f497e295e2` |
| [tests/s14-recovery.test.ts](../../tests/s14-recovery.test.ts) | `9f66fb588d3f056ed9d74d1d16bdab5dde779a55` |
| [tests/s14-bots.test.ts](../../tests/s14-bots.test.ts) | `1c020f3e6384669577b7f0e1f13acc02e035cac2` |
| [tests/context-packet.test.ts](../../tests/context-packet.test.ts) | `6159c37ba504190b0cefedea2f7d6f3e9fb93a92` |
| [tests/route-catalog.test.ts](../../tests/route-catalog.test.ts) | `4031dd4c2d05a3c6f3785ff1c769afff4a8a24e6` |
| [tests/route-options.test.ts](../../tests/route-options.test.ts) | `67bb33e4d77a30540de6314933e20890f730c4fb` |

## Public artifact inspection and demonstrated gaps

Pinned [tarball](../../vendor/schway-1.0.0-rc.2-697bf40.tgz): version `1.0.0-rc.2`, upstream `697bf406a84c8d1deb8d4a6d71876ea1003be5b3`, recomputed SHA-256 `1c9d83de46edddff58a0163452e7f5ec8357e656c90093990fa28fa606a0f41b`. Package exports and public re-exports were traced through declarations. Relevant packaged source was inspected statically for adapter evidence; no module was imported, executed or used to access an account. No private import is proposed. Extraction/validation used temporary files outside the repository and loaded no Schway runtime.

| Inert packed entry | SHA-256 of exact entry bytes |
| --- | --- |
| `package/package.json` | `c08391c7eb0be98c8ba6e468e18bb5eb307d5e943cfa93e570349c2da8df77f1` |
| `package/dist/types/host/index.d.ts` | `d67a8584e19b0caa643d5f84b68677bfa41623bea3d3e9bf23c796d2d57b2a32` |
| `package/dist/types/model/model.d.ts` | `696ea52cdd64617bf50a3745f782843b32542bcda4228625b5ddf5983d59d667` |
| `package/dist/types/host/auth-routes.d.ts` | `381afd71813111ad6fb9a7f61ca639b2e769bf6fd3bc2b7c95187718c3348563` |
| `package/dist/types/host/credential-lifecycle.d.ts` | `8356774dc842873ac52c54a5faede182d6cac375a572d6bd389288c39fe7bd92` |
| `package/dist/types/host/route-models.d.ts` | `b286e6d4fee5dd2f4f4bedbaf9771235e3cd769a95a73a345a2d8e4eefe7908d` |
| `package/dist/types/host/image-input.d.ts` | `6af09a90fb114dba4c75368861391cbaa5d4274d1e1d519a2a9e39445278760c` |
| `package/dist/types/context/policy.d.ts` | `d52ee98748599bb61602268db7cf4ce5d9f0874c433bef63b8d0efaaeb9c4d2a` |
| `package/dist/types/host/session-inventory.d.ts` | `188c0929d63126fe82d91a915254e04a44bf58a6f2a9e1399e2f69f189fa6790` |
| `package/src/host/auth-routes.ts` | `385b4d6b08547a2d785878d52d23f29683117024d78c65877f07761253b67c90` |
| `package/src/host/runtime.ts` | `582c842f28c2664e58f1bca929161223230e130dfba975aa8099841fbe8f0f9f` |
| `package/src/host/credential-lifecycle.ts` | `2c395e4eb4040e1038cafcc6d07124c583f6deca05bbe3eee2f3a40fe7ee9e7e` |
| `package/src/model/loader.ts` | `9e3abf351f2149c5eec30b216bbf90bb4bc1058b4092588bf774de21f7fbae36` |
| `package/src/model/providers/codex-subscription.ts` | `4f6169e0c55be8afff5905c8184470206318129b7a99e1bb02b08ed334aa856e` |
| `package/src/model/providers/xai.ts` | `418413994b5ea2911a26b5a15da4f9f0d19b89d35cab01dab5a5917fa5823839` |
| `package/src/model/thinking.ts` | `8035904317627ec3a1542628094af8b8ae782c0ec3a474246b928704e8728f72` |

The contract records the actual HostOptions/HostLimits, public Model/ModelRequest/ModelCallOptions, auth/lifecycle/catalog/readiness, run usage/clock/progress, context/discovery, images/probes/resolver and session/inventory signatures. Concrete public composition remains `host.auth.createModel()` → protected forwarding `Model` → `session.submit`; `submitWithRoute` has no caller-model parameter. Metadata/role/provider/id/hash/catalog values never authenticate actors/accounts or grant power. Credentials/protected state remain outside guest/model/prompt/log/ordinary exports.

MG15-P01 is a demonstrated contract limit: the outer stream guard precedes an adapter credential wait, and xAI/Grok can resend after 401 inside one stream. Public options expose no normalized final post-wait/per-physical-dispatch authorization boundary. `HostAuthFetch` is a protocol/credential-bearing deterministic-test seam, not an adopted policy API. MG15-P02 distinguishes requested thinking from exact supported/sent control; host createModel has no account-scoped effort-capability input or public sent-control observation. MG15-P03 retains the enforceable cost-bound requirement; codex explicitly lacks an output-token cap. A byte-retention limit, subscription or null telemetry cannot prove a monetary bound.

The smallest public-only counterexamples are UNEXECUTED documentation, not failing executable probes. Proposed Schway requirements are recorded in the contract/ADR without inventing a current hook, private import, Jit provider/renewal/retry implementation, new upstream issue or native blocker. Actual supported contract/version and final physical linearization remain MODEL15-FZ03/04. Every successful selection/run world uses explicitly future synthetic trusted-port evidence; none marks current production support verified.

## Static validation and delivered artifacts

Validation covers the actual checked-in root Draft 2020-12 schema, every named type/value arm and scalar, complete input/expected records, all raw blob/byte lengths and SHA-256 values, containing-record hash domains, request/receipt/plan/call/charge/claim/result correlations, exact prior charge identity/counts, known usage subsets, monotonic independent facts and causal timestamps. The complete original #323 command/receipt bytes are cross-checked statically. Two canonical complete #322 scenario projections retain original charge/time/hash records unchanged; they are data retention examples, not copied whole files, browser execution or authority.

Static counts at preparation validation:

- blob byte pairs: **28**.
- blob refs: **2895**.
- byte wrappers: **215**.
- causal time assertions: **1671**.
- complete result records: **37**.
- definitions: **58**.
- exact external scenario projections: **2**.
- exact remote input blobs: **25**.
- external typed byte records: **4**.
- local links: **88**.
- monotonic fact transitions: **231**.
- named examples: **56**.
- named union arms: **56**.
- record hashes: **2456**.
- root schema counterexamples: **8**.
- signature type names: **24**.
- typed cost basis bindings: **107**.
- unchanged other manifest tickets: **25**.
- unchanged ticket sections: **6**.
- worlds: **106**.
- zero allowance worlds: **14**.

These are document-consistency counts, **not passing runtime/scenario tests**. All 106 worlds remain UNEXECUTED. Static validation uses a temporary Python/jsonschema 4.25.1 environment solely to validate serialized documents; no checker/generator/runtime probe or dependency change is added to the repository. Supplementary checks validate local/remote exact-blob links, signature type/property names, unchanged requirement/acceptance/native dependency sections and other manifest entries, scoped English-only repository changes and `git diff --check`. Final counts and exact checked HEAD/delivered Git blobs belong in the PR after commit, avoiding a self-referential committed HEAD/hash.

Only the contract, closed schema, synthetic definitions/guide, proposed ADR, this record and necessary MODEL15-01 planning mirrors change. No runtime/DDL/storage materializer, executable fixture, broker/transport/provider protocol or live integration is delivered. No runtime test/typecheck, executable/live probe, model/provider/subscription/catalog/readiness call, account/profile/session access, browser/CDP/VM/backend/ingress implementation, provisioning, activation, rollout, UI/UX/Claude retry/subagent/substitution, settings/account/spending change or merge was run or is authorized.

## Preserved constraints and admission limits

#326 remains OPEN / blocked / needs-triage, unassigned, with native #323 OPEN and all four original implementation criteria unchecked. The proposed PR uses **Refs #326** and no documentation/review-disabling label. It does not freeze step 1 or bypass open runtime prerequisites. MODEL15-FZ01–FZ07 remain open. Required Claude UX authoring remains unavailable under [#337's exact recorded failure](https://github.com/chayapats/jit/issues/337#issuecomment-6572828439); no live availability inference/retry/author substitution or concrete UI is supplied.

Preserve #320 original registered exact paid-reservation continuation at zero remaining allowance, separate new claim/final dispatch/publication and nonrefundable enforceable bounds; unknown usage is not zero and cache/reasoning subsets never double-charge. Preserve #321 actor-bound prepare/accept/signal-aware dispatch/guarded readResult/synchronous publishResult/original-scope memoized cancel. Preserve #322 independent input/network/capture/channel/scope/process/publication facts, action-or-read emitter and exact already committed original child read charges; a paid parent cannot fund a new child at zero. Complete directional frames include headers and differ from decoded image/output BytesV1. Stop/rejected evidence cannot erase facts or refund charges.

One current continuity authority retains request/receipt/claim/usage/withdrawal/policy-revocation identities, old authority nondispatchability, original S14/legacy bytes/private scopes and fixed opaque native workspaces through adoption/rollback. No raw native/profile relocation/copy/promotion, inherited numeric allowance/account/budget/model readiness, permanent-Bot policy or Jod integration. Product-default GitHub publication/replies, installed bounded personal exception, separate merge authority and production holds remain distinct. Human gates remain protected across every alternate tool route. Ordinary authenticated-owner output is not approval to send to others.

RT15-01/RF15-G01–G08 remain unproven. No option B, guest-loss acceptance, reduced administration guarantee or general-browser replacement is selected. Full runtime/DDL/materializers/transports/brokers/platform/build/host/adoption evidence remain their slices. No review, fixture, issue closure or this preparation activates S15 or changes S14 default. Exact-head review/check evidence will be recorded in the open PR; no implementer merge.
