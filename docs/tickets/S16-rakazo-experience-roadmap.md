# S16 delivery graph — Rakazo-style persistent teammates

Parent: [#392](https://github.com/chayapats/jit/issues/392). [Spec](../specs/S16-rakazo-experience.md). [ADR 0074](../adr/0074-rakazo-reuse-and-product-convergence.md). Owner direction: 2026-11-05.

The complete self-hosted scope is required. Rows below are delivery slices, not automatically admitted tickets. A row without a scoped GitHub issue is planned work, not ready-for-agent. No runtime implementation, native-client availability or parity is claimed by this graph. Each published implementation issue follows [the workflow](../agents/workflow.md), including current ownership/PR/prerequisite checks, acceptance, tests and no self-merge. No implement-parallel coordinator/claim workflow applies.

## Initial facts

- Main base: `76e15e9f`; no open PRs and no existing Rakazo/S16 issue were found at initial inspection, before opening #392/#393.
- S15 code already supplies protected conversation/policy/model/team/memory/VM/work/GitHub/effect/adoption services and Web. Its Telegram channel is removed by NOTIFY16-01 (ADR 0085). It is opt-in. Inspect current code, not historical preparation-document statuses, before reusing it.
- At initial main inspection, the provisioned browser was static/public/approved-origin only and chat uploads were unavailable. The current draft stack adds uploads; the modern browser gap remains. Rakazo's `packages/chat-ui` depends on its contracts/core/UI packages and React; it is not a drop-in dependency for Jit's existing SSR renderer.
- S15 #340/#341 remain open. Their pending model/account/device/live evidence is neither waived nor a blocker to unrelated deterministic S16 development.
- Stack choices are open for improvement. Shared React clients and a protected Jit API are a candidate, not a requirement to preserve the old Web stack or import the whole upstream backend.

## Slices and direct prerequisites

All runtime slices currently require Frontier judgment. Split Standard tickets only after exact signatures/data shapes and tests remove that judgment. Dependencies name contracts/deliveries, not arbitrary waiting waves.

| Key | Observable outcome / scope | Direct prerequisites | Acceptance |
| --- | --- | --- | --- |
| DOC16-01 [#393](https://github.com/chayapats/jit/issues/393) | Record confirmed scope, architecture alternatives, source pin/license and complete graph | None for this scoped delivery | All baseline mappings |
| UX16-01 [#394](https://github.com/chayapats/jit/issues/394) | Owner-selected Astra/high experience handoff after detailed Mobbin MCP research; cover the complete product and first working slice, comparing upstream React adaptation with current UI | [#393](https://github.com/chayapats/jit/issues/393) | AC01–AC22 experience |
| BASE16-01 [#405](https://github.com/chayapats/jit/issues/405) | A reusable source import and release-notice process, with the first actually used adapted module attributed | [#400](https://github.com/chayapats/jit/issues/400) | AC21/22 |
| API16-01 [#395](https://github.com/chayapats/jit/issues/395) | A client performs a real tool-backed conversation against protected Jit through shared contracts, with progress/stop/receipts and reconnect | [#393](https://github.com/chayapats/jit/issues/393) | AC02/14/21 |
| FILE16-01 [#396](https://github.com/chayapats/jit/issues/396) | Attach a text/document/image to a conversation, use it in real bounded work and return a committed downloadable result | [#395](https://github.com/chayapats/jit/issues/395), [#394](https://github.com/chayapats/jit/issues/394) | AC03/04 |
| ART16-01 [#407](https://github.com/chayapats/jit/issues/407) | Search, preview, revise and download actual produced files with current lineage/authorization | [#400](https://github.com/chayapats/jit/issues/400), [#402](https://github.com/chayapats/jit/issues/402) | AC04/20 |
| BROW16-01 [#397](https://github.com/chayapats/jit/issues/397) | Complete a modern public-site task with supported page interaction and real effect/disclosure enforcement | [#393](https://github.com/chayapats/jit/issues/393), [#394](https://github.com/chayapats/jit/issues/394) | AC06 |
| DESK16-01 [#410](https://github.com/chayapats/jit/issues/410) | Watch a working desktop, take control for protected input and hand back without stale agent input | [#408](https://github.com/chayapats/jit/issues/408), [#395](https://github.com/chayapats/jit/issues/395) | AC05/07 |
| TEAM16-01 [#411](https://github.com/chayapats/jit/issues/411) | Persistent Bots share approved working resources and use explicit private computers without profile races | [#395](https://github.com/chayapats/jit/issues/395) | AC01/05 |
| BOT16-01 [#412](https://github.com/chayapats/jit/issues/412) | Create/configure/archive/restore/export an accepted persistent Bot with continuous work/history | [#411](https://github.com/chayapats/jit/issues/411) | AC01/20 |
| DELEG16-01 [#413](https://github.com/chayapats/jit/issues/413) | Delegate to a peer or temporary worker and retain sibling results through cancellation/restart | [#411](https://github.com/chayapats/jit/issues/411), [#402](https://github.com/chayapats/jit/issues/402) | AC08 |
| ROUT16-01 [#414](https://github.com/chayapats/jit/issues/414) | Run a conversational schedule or signed/file reaction with coalescing, notifications and durable waits | [#395](https://github.com/chayapats/jit/issues/395) | AC09 |
| MEM16-01 [#416](https://github.com/chayapats/jit/issues/416) | Find, correct and forget useful memory across Bots/clients, preserving provenance/private scope | [#395](https://github.com/chayapats/jit/issues/395), [#402](https://github.com/chayapats/jit/issues/402) | AC10/20 |
| CONN16-01 [#417](https://github.com/chayapats/jit/issues/417) | Connect/reconnect/revoke a real app from the client, with shared team availability and no config edits | [#395](https://github.com/chayapats/jit/issues/395) | AC11 |
| MCP16-01 [#418](https://github.com/chayapats/jit/issues/418) | Add and use an HTTPS MCP tool source with governed discovery, per-run sessions and protected effects | [#417](https://github.com/chayapats/jit/issues/417) | AC12 |
| OPEN16-01 [#419](https://github.com/chayapats/jit/issues/419) | Add an OpenAPI/GraphQL or gateway source and execute a supported tool through the same policy | [#417](https://github.com/chayapats/jit/issues/417) | AC12 |
| SKILL16-01 [#420](https://github.com/chayapats/jit/issues/420) | Import a pinned plugin/skill, select availability and use it without protected-host code execution | [#418](https://github.com/chayapats/jit/issues/418) | AC13 |
| MODEL16-01 [#421](https://github.com/chayapats/jit/issues/421) | Configure and select additional approved Schway routes/models with actual usage/pins and continuity | [#395](https://github.com/chayapats/jit/issues/395), [#402](https://github.com/chayapats/jit/issues/402) | AC14 |
| VOICE16-01 [#422](https://github.com/chayapats/jit/issues/422) | Dictate and speak replies with configured providers/local voice, finite costs and interruption | [#395](https://github.com/chayapats/jit/issues/395), [#417](https://github.com/chayapats/jit/issues/417) | AC15 |
| CALL16-01 [#423](https://github.com/chayapats/jit/issues/423) | Hold a continuous voice conversation with interruption and the same authority/approval semantics | [#422](https://github.com/chayapats/jit/issues/422), [#406](https://github.com/chayapats/jit/issues/406) | AC15 |
| NOTIFY16-01 [#441](https://github.com/chayapats/jit/issues/441) | Remove Telegram entirely and deliver needs-you, non-quiet routine outcomes and finished work through Web Push from the PWA (replaces CHANNEL16-01 #424, closed as not planned 2026-11-06) | None | AC02/09/18 |
| AUTH16-01 [#442](https://github.com/chayapats/jit/issues/442) | Grok-style default autonomy: short human-required list approved by a one-press in-chat card, GitHub publication/merge by default, trusted/sensitive website tiers | None; browser tiers coordinate with [#408](https://github.com/chayapats/jit/issues/408)/[#409](https://github.com/chayapats/jit/issues/409) | AC02/06/07/11 |
| DESKTOP16-01 [#425](https://github.com/chayapats/jit/issues/425) | Package a desktop client of the same Jit service with supported install/update and native privilege boundaries | [#395](https://github.com/chayapats/jit/issues/395), [#400](https://github.com/chayapats/jit/issues/400) | AC16 |
| MOBILE16-01 [#426](https://github.com/chayapats/jit/issues/426) | Package a mobile client of the same service with files, approvals, reconnect and native notifications | [#395](https://github.com/chayapats/jit/issues/395), [#400](https://github.com/chayapats/jit/issues/400) | AC17 |
| COMPUTER16-01 [#427](https://github.com/chayapats/jit/issues/427) | Add a second useful computer backend under a tested capability/settlement/state-portability contract | [#411](https://github.com/chayapats/jit/issues/411), [#410](https://github.com/chayapats/jit/issues/410) | AC19 |
| SPACE16-01 [#428](https://github.com/chayapats/jit/issues/428) | Organize/search work and availability with explicit single-owner isolation semantics if spaces are introduced | [#412](https://github.com/chayapats/jit/issues/412), [#407](https://github.com/chayapats/jit/issues/407), [#416](https://github.com/chayapats/jit/issues/416) | AC20 |
| OPS16-01 [#429](https://github.com/chayapats/jit/issues/429) | Install/upgrade/backup/export/restore the selected stack and clients with state-preserving adoption/rollback | 16 feature contracts: see [#429](https://github.com/chayapats/jit/issues/429) and the [exact dependency index](S16-rakazo-experience-coverage.json) | AC21 |
| EVID16-01 [#430](https://github.com/chayapats/jit/issues/430) | Demonstrate the complete multi-client task matrix at exact builds; record pending owner/device/provider inputs | 21 feature contracts: see [#430](https://github.com/chayapats/jit/issues/430) and the [exact dependency index](S16-rakazo-experience-coverage.json) | AC01–AC22 |
| CUT16-01 [#432](https://github.com/chayapats/jit/issues/432) | Adopt the tested release on the named installation under an exact owner-reviewed transition | [#429](https://github.com/chayapats/jit/issues/429), [#430](https://github.com/chayapats/jit/issues/430), [#431](https://github.com/chayapats/jit/issues/431) | AC21/22 |

The file delivery is split into text #400, isolated binary #401 and working-computer processing #433; #402 supplies precise ancestry. The dependencies above are the verified native final-delivery edges, with scope details in each issue. Runtime/API work should not depend on unrelated voice or native packaging. Human credentials are separated from implementation and requested only at the concrete live-test boundary.

CHAT16-02 [#406](https://github.com/chayapats/jit/issues/406) adds owner steering of running work over Schway's new `schway.host.steering/v1` and concurrent conversations: see the [steering contract](../contracts/s16-steering-v1.md) and [ADR 0086](../adr/0086-s16-live-steering-and-concurrent-conversations.md). NOTIFY16-01 [#441](https://github.com/chayapats/jit/issues/441) removes Telegram from every runtime and adds Web Push from the PWA: see the [notifications contract](../contracts/s16-notifications-v1.md) and [ADR 0085](../adr/0085-remove-telegram-web-push-notifications.md). Live provider/device evidence remains #431.

## Owner revision — 2026-11-06

The owner chose Grok-style autonomy and removed Telegram: [S16-D06–D11](../specs/S16-rakazo-experience.md), [ADR 0084](../adr/0084-s16-grok-style-default-autonomy.md), [ADR 0085](../adr/0085-remove-telegram-web-push-notifications.md). Consequences for this graph:

- CHANNEL16-01 #424 is closed as not planned; NOTIFY16-01 #441 owns AC18, now notifications rather than messaging surfaces. #429/#430 depend on #441 instead.
- AUTH16-01 #442 owns the new default policy, in-chat approval and website tiers.
- The protected browser is required only for sensitive sites; public and trusted-site browsing uses the working VM browser. #397/#408/#409/#410 carry the narrowed scope.
- GitHub publication/merge after required checks is the product default; "product-default versus opt-in personal GitHub" wording in older issue bodies is replaced by the S16-D07 list.
- References to Telegram or messaging channels above and in older documents are historical.

## Upstream reuse candidates

All paths refer to Rakazo commit `abf3c08145a05cba92a912d6c24fdfb5f569d0e0`. A candidate is not imported or approved just because it appears here.

| Upstream area | Candidate reuse | Jit integration review |
| --- | --- | --- |
| `packages/contracts/src/attachments.ts`, `packages/chat-ui/` | File metadata/preview concepts, rich messages and shared client behavior | Do not copy upstream byte limits or active-HTML rendering trust. Audit transitive React/core/UI/renderer dependencies and isolate previews. |
| `apps/web/`, `packages/ui-web/`, `packages/ui-tokens/` | React product shell and reusable experience/components | Required designer selects adaptations; bind actual Jit commands/events, Thai/English, accessibility and protected review rather than mock data. |
| `apps/desktop/`, `apps/mobile/` | Existing-instance clients, packaging, native permissions and notifications | Replace upstream identity/API/billing assumptions. Native host execution remains separately explicit. |
| `packages/core/src/agent-skill.ts`, `packages/core/src/mcp.ts` | Skill/plugin and MCP data/validation concepts | Version pin, availability/privacy, schemas and effective tools are governed by Jit; source instructions never create authority. |
| `packages/adapters/src/` connector/computer/voice modules | Protocol handling, transport behavior and conformance ideas | Separate upstream Pi/database/auth coupling; keep credentials/effect dispatch and actual external recipients under Jit policy. |
| `packages/memory/` | Memory retrieval/provider ideas | Preserve Jit provenance, withdrawals and private lineage; no mandatory hosted memory vendor or replacement by copying files. |
| `packages/db/`, `apps/api/`, `apps/worker/` | Potential simplification of cross-store state/API/job architecture | Evaluate instead of importing a second authority or scheduler. Any replacement needs migration, fencing, reconciliation and operational evidence. |

## Completion evidence

API16-01 has the first [shared protected-client implementation](../contracts/s16-client-v1.md) and [ADR 0075](../adr/0075-s16-shared-protected-client.md): real text/tool conversation, current owner snapshots/events, send recovery, stop and typed exact decisions. Its headless capability projection explicitly withholds files, immutable artifacts and live steering; these are not inferred from a successful tool fixture. Rendered React/file work remains downstream.

UX16-01 has an authored [complete experience handoff](../design/S16-rakazo-experience.md) and [Mobbin research record](../design/S16-mobbin-research.md) against baseline `80cc1c80`, reviewed for the distinction between existing bindings and proposed contracts. The first slice selects a Bun-built React client over the protected Jit service, retaining current stores initially; upload receipts, immutable artifact publication and live steering require implementation. The design is not runtime or live acceptance evidence.

Every owning issue records tested SHA, current contracts, imported-file provenance, checks, residuals and opt-in live outcomes. Follow the S16-AC22 scenarios. A terminal child response, closed upstream ticket, compile success, mock UI, copied source tree or feature count does not establish completion. Publish honest pending/unsupported cases; do not mark the parent complete for documentation or the first working slice.

FILE16-01 is split into [FILE16-01A #400](https://github.com/chayapats/jit/issues/400), the first real UTF-8 upload → authorized read → immutable artifact → React preview/download vertical slice, and [FILE16-01B #401](https://github.com/chayapats/jit/issues/401), required isolated PDF/image processing. Its [binary contract](../contracts/s16-binary-files-v1.md) and [ADR 0077](../adr/0077-s16-isolated-binary-input-and-model-images.md) describe implemented strict decoding, actual Schway image sends and honest pending Linux/live-account evidence. [MEM16-01A #402](https://github.com/chayapats/jit/issues/402) carries precise file ancestry through memory and later conversations before removing the first-slice memory/history fence. See [ADR 0076](../adr/0076-s16-file-custody-and-react-client.md) and the [implemented text contract](../contracts/s16-files-v1.md). The text slice does not close #396 or S16-AC03/04. ART16-01 [#407](https://github.com/chayapats/jit/issues/407) adds the durable library, provenance, immutable revisions and the isolated HTML viewer: see the [artifact library contract](../contracts/s16-artifacts-v1.md) and [ADR 0082](../adr/0082-s16-artifact-library-and-revisions.md). Cross-object search/organization remains SPACE16-01 #428, file-to-VM output collection remains #433, and live/device evidence remains #431/#432.

ROUT16-01 [#414](https://github.com/chayapats/jit/issues/414) and ROUT16-02 [#415](https://github.com/chayapats/jit/issues/415) add owner-confirmed routines and signed/GitHub/file-lineage reactions over CHAT's protected `submitRoutine` ingress: see the [routines contract](../contracts/s16-routines-v1.md) and [ADR 0083](../adr/0083-s16-routines-and-reactions.md). Deterministic DST/misfire counts, review waits across restart, coalescing identities, payload isolation and the calendar feed are covered; channel notifications (#424), WORK CI/review wait settlement, live GitHub delivery and owner-host evidence (#431/#432) remain.

## Complete publication audit — 2026-11-05

The current audit baseline is stack head `17b814220371cd1e2126be2ec9bd9753537f69e6`; #398 → #399 → #403 → #404 remain open drafts above older main. The initial facts above are historical, not current completion claims. No runtime code, installation, policy or default is changed by this planning revision.

The [machine-auditable coverage index](S16-rakazo-experience-coverage.json) records all 28 rows, all 22 acceptance IDs, every FR-01–FR-42/NFR-01–NFR-14, actual issue links and verified native dependencies. All 29 new issues are Frontier because contract, authority, lifecycle or platform judgment remains. No vague Standard issue is marked ready.

### Implementation and evidence distinctions

- **Baseline reused:** S15 POLICY/DATA15/TEAM/MEM/WORK/MODEL/VM/browser and adoption services (Telegram removed, ADR 0085); S14/legacy continuity. Their existing implementation is not new S16 acceptance.
- **Implemented on draft:** DOC/UX #393/#394 (#398), API #395 (#399), UTF-8 #400 (#403), binary/image #401 (#404). The authored research is reused; no large Mobbin search is repeated. Reuse attribution already exists for two modules; #405 completes reusable validation.
- **Planned:** #402 and all new deterministic implementation slices. File memory/history fences remain enabled. A generic resource ancestry label does not satisfy exact file-recipient/history checks.
- **Pending live evidence:** #431 and exact adoption #432. Human labels describe required participation, not satisfied prerequisites. Real Linux parser/image account/device evidence is pending; fixtures and browser viewport tests are not native-device acceptance. S15 #340/#341 keep their separate scope.

### Published supplemental vertical slices

- [CHAT16-02 #406](https://github.com/chayapats/jit/issues/406): Steer active work and run an independent conversation.
- [BROW16-01A #408](https://github.com/chayapats/jit/issues/408): Prove a modern browser mediation contract.
- [BROW16-01B #409](https://github.com/chayapats/jit/issues/409): Complete a protected modern website workflow.
- [ROUT16-02 #415](https://github.com/chayapats/jit/issues/415): React to signed events and file changes without duplicate work.
- [LIVE16-01 #431](https://github.com/chayapats/jit/issues/431): Collect exact-build Linux, account and native-device evidence.
- [FILE16-01C #433](https://github.com/chayapats/jit/issues/433): Use attached files in bounded computer work and collect output.

### Next work and concrete blockers

1. #408 is ready for its bounded modern-browser mediation investigation, after rechecking ownership. It must deliver real dynamic-site/effect bypass evidence and a reviewed contract before #409. Existing generic click types/static GET do not satisfy AC06.
2. The primary continues #402 on its already prepared branch after reviewing the precise ancestry/query/commit contract against #400/#401. This planning branch neither claims nor edits it. #416 is the remaining memory client/search outcome, not duplicate ancestry work.
3. #406, #411, #414 and #417 can receive contract review independently against #395; they do not wait for voice, native devices or live credentials. Their implementation readiness is not asserted merely because a draft prerequisite exists.
4. Final aggregate operations #429 and deterministic evidence #430 require the selected feature formats/outcomes. Their inventory/harness design can proceed earlier; native blockers represent final acceptance dependencies, not arbitrary phases. #431 executes real-account/device evidence only when concrete artifacts are ready. #432 requires an exact owner-reviewed transition and does not authorize one now.

Artifact revision/HTML preview (#407), file-to-VM collection (#433), and live steering (#406) remain required despite the first working file client. Search/organization (#428) is required; spaces are conditional on a reviewed single-owner isolation/availability decision, never implicit multi-user tenancy. Every substantial slice records reuse versus a simpler alternative; current frameworks/storage are not product scope limits.

Publication validation rereads every issue, required sections, native parents/dependencies and readiness; checks the graph for cycles and verifies all rows/acceptances/requirements have owners. Documentation-only validation runs link checks and `git diff --check`; no runtime tests are claimed by this PR.
