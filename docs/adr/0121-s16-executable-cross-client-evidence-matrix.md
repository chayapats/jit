---
status: implemented source-input validator/executor; aggregate exact-build acceptance pending
date: 2026-11-21
scope: EVID16-01; S16-AC01–AC22; FR-01–FR-42; NFR-01–NFR-14
---

# Keep acceptance claims tied to executed outcomes and exact builds

The existing [backlog coverage](../tickets/S16-rakazo-experience-coverage.json)
records ownership at its historical baseline. Individual source/tests and issue
closure establish useful inputs, but do not execute the complete
[S16 experience](../specs/S16-rakazo-experience.md). Existing composed services,
actual React browser fixtures, installed-client package checks and scripted
transports remain the implementation owners. Rakazo reuse stays at the already
reviewed public product/client seams under ADR 0074; this evidence slice imports
no upstream source, runtime, authority stack or additional test framework.

Select a versioned JSON acceptance matrix plus a small Bun/TypeScript validator
and bounded executor over reviewed repository test profiles. Each required AC,
inherited FR/NFR obligation and complete journey names observable assertions,
evidence owner, current owning suites, negative paths, transport classification
and separate required live/device evidence. Retain the old ownership inventory
unchanged. A static Markdown checklist alone would duplicate those relationships
without enforcing missing rows, unsupported cases or stale evidence. A second
application/backend would add operational cost without improving these proofs.

Profiles supply fixed test paths and supported environment flags. They cannot
contain shell commands, arbitrary executable paths, credentials or arbitrary
environment assignments. The executor runs explicit selected profiles in a
clean exact source checkout, with finite process/output/time bounds, fresh private
receipts/logs and unchanged source checks before/after. It records actual passing,
failing, skipped, unavailable and unobserved outcomes. A successful process with
missing expected test observations, zero assertions or skipped required cases
cannot certify acceptance. Missing required owning delivery or journey stays a
blocking row instead of disappearing from coverage.

Receipts name matrix/source/lock/dependency/engine/vendor hashes and available
package/client/parser artifacts with their actual basis. Unrecorded digests remain
explicit gaps; source execution cannot be relabelled packaged/native UI evidence.
Inherited tests are labelled reused and become current proof only when executed
at the reported revision. Distinguish deterministic acceptance from product/live
acceptance: scripted provider/VM/connector/audio/native ports require no live
credential, while physical devices, Linux isolation, subscriptions and owner-host
cutover have separately owned pending rows. Any unsupported required deterministic
case blocks the deterministic result; live gaps also block full product acceptance.

No runtime default, standing policy, account, owner-host configuration, source
scope or work/effect state changes. Test fixtures remain disposable. User interface
evidence reuses the authored design, EN/TH bundles, keyboard/mobile-width cases
and original guarded commands. Product acceptance follows the current AGENTS.md
and S16-D06–D11/ADRs 0084–0085; obsolete personal-only GitHub or Telegram behavior
is historical baseline evidence, never the current S16 default.

The executor reports `source_inputs_passed` only after observed Bun assertions.
Integrated owning inputs now include the selected operations lifecycle and a
same-service native dictation/mobile Send/web read/restart journey. Scripted
native ports do not establish native UI. Package/client/parser artifact import
and final exact-build execution remain explicit gaps; `deterministicAcceptance`
and `productAcceptance` stay blocked. This is not completed #430 acceptance.
The [runbook](../runbooks/s16-cross-client-evidence.md) records commands, finite
bounds, private receipt meaning and the remaining work.
