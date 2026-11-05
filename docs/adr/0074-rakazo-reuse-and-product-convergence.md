---
status: proposed engineering; owner-confirmed product direction recorded separately
date: 2026-11-05
scope: S16-D01–D05; FR-01–FR-42; NFR-01–NFR-14
---

# Selective Rakazo reuse and product convergence

## Confirmed inputs

The owner requested the Rakazo-style product, authorized source/concept reuse, chose Jit + Schway as the retained project/engine, and invited stack changes that make development or the product simpler. [S16](../specs/S16-rakazo-experience.md) records these outcomes. They supersede a research-only or static-browser capability ceiling, not the need for explicit owner authority, protected credentials, evidenced effects or state preservation.

Existing runtime selections remain unchanged: S14 default, explicit S15 opt-in, legacy compatibility. S15's implemented modules are useful assets rather than a mandate to preserve their internal structure. Existing live acceptance in #340/#341 does not certify S16.

## Inspected sources

- Jit base: `76e15e9faece6b321a242725f161271fe1c20cf2`.
- Rakazo commit: `abf3c08145a05cba92a912d6c24fdfb5f569d0e0`, tree `f8ca5adc96366b722bb60186c21cb29cec0f5390`.
- GitHub source archive SHA-256: `10aa4afe806a958a56fa996451466899956d7b5db9bd7b3ce06109350f7150a3`.
- Root license: Apache-2.0, copyright 2026 Rakazo contributors. The inspected root has no NOTICE file; individual modules/dependencies still need their own notice/license check before import.
- Source was read without executing upstream install/build/runtime scripts. No Rakazo runtime source has been imported by this documentation change.

## Current integration mismatch

Rakazo's clients share React/Expo/Electron and contract/core packages. Its server uses Hono/oRPC, PostgreSQL/Prisma and a Pi-backed execution runtime, plus broad computer/connector adapters. Jit currently uses Bun/TypeScript, server-rendered enhanced Web pages, protected S15 services/journals and Schway's public engine surface.

Copying the complete upstream server would introduce a competing authentication, database, job, approval and execution stack. Copying only visual components without replacing their data/command bindings would create a convincing but nonfunctional interface. Reimplementing every client feature from scratch would discard the owner's explicit reuse direction. These are integration costs to evaluate, not prohibitions on changing a stack.

## Candidate architecture

1. Retain Jit's product identities and Schway's execution ownership. Define a shared client-facing Jit contract for Bots, conversations, work/events, files/artifacts, computers, resources, skills, approvals and voice. Reuse existing public service operations when they express the outcome; propose a versioned replacement where they do not.
2. Prototype a React Web client adapted from upstream concepts and selected components, backed by the actual protected Jit service. Evaluate sharing components/contracts with desktop/mobile. The required designer owns layouts/interactions; architecture and authority remain implementation review responsibilities.
3. Replace the old presentation path once a capability-complete, migration-safe alternative is verified. Permanent parallel UI stacks and preserving no-script behavior are not preselected requirements for new clients. Until replacement lands, existing routes continue to work.
4. Adapt useful upstream pure contracts, file classification, rich-message rendering, client state and protocol adapters at explicit seams. Review their dependencies and provenance before importing. Pure helpers can be reused directly where their behavior fits; policy-bearing services need Jit semantics and independent tests.
5. Evaluate storage per owning service. Keep current ledgers where they already satisfy durable authority; propose PostgreSQL or another simpler shared state model where it demonstrably reduces cross-store coordination and client features. A storage change requires a versioned migration, single-writer/recovery semantics and preserved revocations/usage/unknown effects; preservation does not require the old storage implementation forever.
6. Compose computer, browser, connector and voice providers through protected capability adapters. An adapter owns actual credential custody, recipient/action classification, dispatch, reconciliation and evidence. Schway supplies engine/model/session/tool primitives through supported public contracts.

These are proposed choices. A concrete slice records the chosen stack and exact supported versions after reviewing the upstream dependency graph, operational cost and migration impact. A substantial incompatibility with retained owner decisions is reported with an alternative; it is not hidden behind an unsupported UI control.

## Browser/computer boundary

The current provisioned browser is static and accepts credential-free GET navigations without query/body to approved origins. That is not S16-AC06. Add modern interaction and protected session reuse with genuine action/request mediation; investigate simpler browser isolation/transport designs rather than treating the present broker implementation as fixed.

The live graphical computer and shared website identity do not have to occupy the same trust domain. Sensitive website state must remain outside the full-root working guest unless an explicitly reviewed replacement establishes the required protection. Generic desktop input, model approval classification, HTTP method labels and a prompt cannot alone prove a protected action gate. A backend's capabilities and residuals must be explicit.

If the existing guarantee makes a requested website workflow impossible, the slice must show the exact conflict, a workable alternative and its threat/authority tradeoff for the owner. Broad unreviewed network/session access is not smuggled in as a UI port.

## Upstream source and license procedure

For each imported/adapted file, keep an inventory of upstream repository, immutable commit/path, original SHA-256, destination path, license, applicable notices and local modifications. Keep an unmodified copy of the applicable license in the distributed source/release and preserve required notices. Modified files carry a prominent change notice. Verify nested/vendor/assets licenses separately; a root Apache-2.0 declaration does not establish rights to every dependency or trademark.

Keep existing Jit-origin code under its existing MIT license. Imported Apache-2.0 code retains its applicable terms; root/package metadata and release notices must explain mixed provenance rather than claim an MIT-only redistribution. Retain the Jit name and assets unless separately licensed and selected. Do not imply upstream endorsement. License attribution is source attribution, not model attribution.

Use a pinned, reproducible reference. Never run code fetched from a model-selected URL in the protected service. An upstream update is a reviewed dependency change, including relevant security fixes and local adaptations. Avoid a full vendored monorepo merely to make parity appear implemented.

## Delivery and proof

[The S16 graph](../tickets/S16-rakazo-experience-roadmap.md) maps all feature acceptance to vertical slices. Start with a real file-to-result workflow and the shared client/API foundation, while resolving the general-browser contract and reuse strategy. Continue through app/tool/skill connections, teammate/routine continuity, voice and native clients. Existing modules can satisfy a slice only after composed observable acceptance and compatibility checks.

Deterministic tests cover actual service/client contracts using scripted models, controlled adapters and fake clocks. Label real website/provider/device/host evidence separately. Readiness requires working inputs, work execution, delivery, cancellation, recovery and protected approvals; source import, compilation or a mock client alone is insufficient. No live host, policy, account or runtime default changes in the documentation phase.
