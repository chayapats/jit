# S14 UI/UX brief — constraints for the Opus designer

Parent: [S14](../specs/S14-bot-first-local-assistant.md), [issue #244](https://github.com/chayapats/jit/issues/244). This file is a behavioral/engineering brief, not a UI design.

The owner requires all UI/UX design to be authored by Claude Opus 5.5 at effort high. The primary agent may review authority, contracts and feasibility but must not invent or replace the visual/interaction design.

## Required product outcomes

Persistent Bots, Jit as main coordinator, no required Project or hidden General project; isolated persistent local computers; explicit shares; owner/global plus Bot-private memory; immediate authorized internal work; exact-action external-effect approval; permanent Bot proposals require acceptance; bounded concurrent research; routines only by standing authorization; safe recovery; free-first Parallel with explicit paid enablement; persisted cited report/artifacts.

Research is MVP. Coding and personal email/calendar assistance are mandatory later phases; distinguish planned capabilities from usable controls. Linux x64/arm64 is the runtime target, with Web/PWA access on other devices. Fresh state is permitted; no migration wizard or destructive reset is implied.

## Existing requirements to retain or explicitly flag for refinement

Thai default and English; accessible responsive keyboard/touch behavior; meaningful textual status; dark/light; Jit name/meditating-bot brand and existing self-hosted assets. Review docs/design/README.md and S09/S12/S13. Existing progressive-enhancement/no-script and static-only PWA cache requirements remain until a proposed change is explicitly documented; do not silently replace the framework/build policy.

Design the actual information architecture, layouts, navigation, flows, hierarchy, components, copy, spacing, tokens and interactions yourself. Reference OpenBot/OpenDuet for useful ideas, not copied assets/code. The product spec's nouns do not prescribe screen layout.

Cover setup/route readiness, first useful research, direct Bot work, creating/granting a Bot, delegation, concurrent progress/cancel, evidence and downloadable report, partial/stale/incomplete result, unknown effect/approval, browser view/takeover, explicit sharing/memory, routines, free quota/provider failure and safe resume. Include accessible mobile and English/light examples. Only persist owner decisions through authenticated commands; a prototype must never imply model-generated approval.

## Deliverables and boundary

Only author docs/design/S14-bot-first-experience.md and docs/design/s14-bot-first-prototype.html (optional supporting assets inside docs/design/s14-assets/). The HTML is a self-contained reviewable interactive prototype, labelled as a prototype with fixture data, not wired to real services. No external network dependencies or credentials. Do not edit application code, specs, ADRs or Git branches.

Document design choices as designer proposals, required states, interaction semantics, responsive/accessibility behavior and implementation handoff. Keep future-phase controls honest. Any user-visible UI output is the designer's responsibility. Do not use implement-parallel or start other agents.

The root will integrate requirements and publish the standalone HTML with the supported inline-render tools. Do not start a server, use preview tools, open PRs or publish GitHub mutations.
