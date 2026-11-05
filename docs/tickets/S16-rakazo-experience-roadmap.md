# S16 delivery graph — Rakazo-style persistent teammates

Parent: [#392](https://github.com/chayapats/jit/issues/392). [Spec](../specs/S16-rakazo-experience.md). [ADR 0074](../adr/0074-rakazo-reuse-and-product-convergence.md). Owner direction: 2026-11-05.

The complete self-hosted scope is required. Rows below are delivery slices, not automatically admitted tickets. A row without a scoped GitHub issue is planned work, not ready-for-agent. No runtime implementation, native-client availability or parity is claimed by this graph. Each published implementation issue follows [the workflow](../agents/workflow.md), including current ownership/PR/prerequisite checks, acceptance, tests and no self-merge. No implement-parallel coordinator/claim workflow applies.

## Initial facts

- Main base: `76e15e9f`; no open PRs and no existing Rakazo/S16 issue were found at initial inspection, before opening #392/#393.
- S15 code already supplies protected conversation/policy/model/team/memory/VM/work/GitHub/effect/adoption services, Web and Telegram. It is opt-in. Inspect current code, not historical preparation-document statuses, before reusing it.
- The current provisioned browser is static/public/approved-origin only; chat uploads are unavailable. Rakazo's `packages/chat-ui` depends on its contracts/core/UI packages and React; it is not a drop-in dependency for Jit's existing SSR renderer.
- S15 #340/#341 remain open. Their pending model/account/device/live evidence is neither waived nor a blocker to unrelated deterministic S16 development.
- Stack choices are open for improvement. Shared React clients and a protected Jit API are a candidate, not a requirement to preserve the old Web stack or import the whole upstream backend.

## Slices and direct prerequisites

All runtime slices currently require Frontier judgment. Split Standard tickets only after exact signatures/data shapes and tests remove that judgment. Dependencies name contracts/deliveries, not arbitrary waiting waves.

| Key | Observable outcome / scope | Direct prerequisites | Acceptance |
| --- | --- | --- | --- |
| DOC16-01 [#393](https://github.com/chayapats/jit/issues/393) | Record confirmed scope, architecture alternatives, source pin/license and complete graph | None | All baseline mappings |
| UX16-01 [#394](https://github.com/chayapats/jit/issues/394) | Owner-selected Astra/high experience handoff after detailed Mobbin MCP research; cover the complete product and first working slice, comparing upstream React adaptation with current UI | DOC16-01 baseline; pinned source; inspected Mobbin references | AC01–AC22 experience |
| BASE16-01 | A reusable source import and release-notice process, with the first actually used adapted module attributed | DOC16-01; chosen module/dependency audit | AC21/22 |
| API16-01 [#395](https://github.com/chayapats/jit/issues/395) | A client performs a real tool-backed conversation against protected Jit through shared contracts, with progress/stop/receipts and reconnect | DOC16-01; UX16-01 for rendered interaction | AC02/14/21 |
| FILE16-01 [#396](https://github.com/chayapats/jit/issues/396) | Attach a text/document/image to a conversation, use it in real bounded work and return a committed downloadable result | API16-01; UX16-01; current sanitizer/Schway image seam audit | AC03/04 |
| ART16-01 | Search, preview, revise and download actual produced files with current lineage/authorization | FILE16-01 | AC04/20 |
| BROW16-01 [#397](https://github.com/chayapats/jit/issues/397) | Complete a modern public-site task with supported page interaction and real effect/disclosure enforcement | DOC16-01; current protected browser/VM/policy contract audit; UX16-01 | AC06 |
| DESK16-01 | Watch a working desktop, take control for protected input and hand back without stale agent input | BROW16-01; computer capability/transport contract | AC05/07 |
| TEAM16-01 | Persistent Bots share approved working resources and use explicit private computers without profile races | API16-01; computer/privacy migration contract | AC01/05 |
| BOT16-01 | Create/configure/archive/restore/export an accepted persistent Bot with continuous work/history | TEAM16-01; UX16-01 | AC01/20 |
| DELEG16-01 | Delegate to a peer or temporary worker and retain sibling results through cancellation/restart | TEAM16-01; supported Schway session/delegation seam | AC08 |
| ROUT16-01 | Run a conversational schedule or signed/file reaction with coalescing, notifications and durable waits | API16-01; current WORK/trigger contract audit | AC09 |
| MEM16-01 | Find, correct and forget useful memory across Bots/clients, preserving provenance/private scope | API16-01; current TEAM/MEM contract audit | AC10/20 |
| CONN16-01 | Connect/reconnect/revoke a real app from the client, with shared team availability and no config edits | API16-01; resource/credential/effect contract | AC11 |
| MCP16-01 | Add and use an HTTPS MCP tool source with governed discovery, per-run sessions and protected effects | CONN16-01 | AC12 |
| OPEN16-01 | Add an OpenAPI/GraphQL or gateway source and execute a supported tool through the same policy | CONN16-01; reviewed schema-to-action mapping | AC12 |
| SKILL16-01 | Import a pinned plugin/skill, select availability and use it without protected-host code execution | MCP16-01; instruction/executable-part contract | AC13 |
| MODEL16-01 | Configure and select additional approved Schway routes/models with actual usage/pins and continuity | API16-01; demonstrated supported engine contracts | AC14 |
| VOICE16-01 | Dictate and speak replies with configured providers/local voice, finite costs and interruption | API16-01; CONN16-01; UX16-01 | AC15 |
| CALL16-01 | Hold a continuous voice conversation with interruption and the same authority/approval semantics | VOICE16-01 | AC15 |
| CHANNEL16-01 | Use bound messaging with real attachment/result/needs-me delivery and capability-aware review links | FILE16-01; API16-01; channel identity/transport contract | AC18 |
| DESKTOP16-01 | Package a desktop client of the same Jit service with supported install/update and native privilege boundaries | API16-01; FILE16-01; UX16-01 | AC16 |
| MOBILE16-01 | Package a mobile client of the same service with files, approvals, reconnect and native notifications | API16-01; FILE16-01; UX16-01 | AC17 |
| COMPUTER16-01 | Add a second useful computer backend under a tested capability/settlement/state-portability contract | TEAM16-01; DESK16-01; provider isolation review | AC19 |
| SPACE16-01 | Organize/search work and availability with explicit single-owner isolation semantics if spaces are introduced | BOT16-01; ART16-01; MEM16-01; resource-scope migration | AC20 |
| OPS16-01 | Install/upgrade/backup/export/restore the selected stack and clients with state-preserving adoption/rollback | Reviewed chosen runtime/client/storage deliveries | AC21 |
| EVID16-01 | Demonstrate the complete multi-client task matrix at exact builds; record pending owner/device/provider inputs | Required feature slices; actual selected host/client matrix | AC01–AC22 |
| CUT16-01 | Adopt the tested release on the named installation under an exact owner-reviewed transition | OPS16-01; EVID16-01 | AC21/22 |

The first file slice can be further split into a safe text/document path and image support if it remains one concrete end-to-end outcome per issue. Runtime/API work should not depend on unrelated voice or native packaging. Human credentials are separated from implementation and requested only at the concrete live-test boundary.

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

UX16-01 has an authored [complete experience handoff](../design/S16-rakazo-experience.md) and [Mobbin research record](../design/S16-mobbin-research.md) against baseline `80cc1c80`, reviewed for the distinction between existing bindings and proposed contracts. The first slice selects a Bun-built React client over the protected Jit service, retaining current stores initially; upload receipts, immutable artifact publication and live steering require implementation. The design is not runtime or live acceptance evidence.

Every owning issue records tested SHA, current contracts, imported-file provenance, checks, residuals and opt-in live outcomes. Follow the S16-AC22 scenarios. A terminal child response, closed upstream ticket, compile success, mock UI, copied source tree or feature count does not establish completion. Publish honest pending/unsupported cases; do not mark the parent complete for documentation or the first working slice.
