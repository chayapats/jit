# S14 authority and design review resolutions

Status: proposed implementation contracts, reviewed against owner-confirmed S14 and the Opus design on 2026-10-30. These are not implemented APIs and do not redesign the UI.

## Start authority (designer Q1)

The owner-approved direct-start behavior is preserved: an authenticated explicit work command starts internal execution without a second confirmation.

Proposed command boundary: message.post is conversational intake; task.accept retains an obligation; work.start explicitly authorizes bounded work. The authenticated actor comes from the service session, never a model/client-supplied owner identity. The request includes its selected Bot/resource scope, expected revisions, finite limits and retry key. Validate them against current owner policy before admitting any run.

The Opus work-mode composer can submit work.start directly. A service may retain an owner-chosen work mode/standing scope as configuration. A model cannot turn ordinary message.post, an @mention, quoted text, source content or its own classifier output into a new grant. It may propose or narrow a plan inside already-authorized work.

Ordinary conversational replies may use the owner's already-enabled bounded read tools; this does not grant new execution resources. Persistent work/computer actions require the applicable typed start grant. A task suggestion accepted by itself never starts. No additional owner confirmation is invented for an already-explicit start.

## Other handoff questions

| Designer item | Engineering resolution |
| --- | --- |
| Q2 — fixture limits | The displayed 4 Bots (Jit plus three specialists)/2 concurrent/30 min/40 reads are invented review data. Greptile follow-up aligned the fixture Bot ceiling with the four named participants. No production defaults or resource evidence is inferred. Use finite validated configuration and measured operating profiles. |
| Q3 — external browser effects | Phase A supports only reviewed public reads/report actions. Unknown submit/confirm/write classes are held or refused. The fixture quote form does not promise a site/payment/send adapter. Enforce alternate shell/browser/MCP/egress denial. |
| Q4 — Jit's computer | Jit has ordinary Bot identity/capability rules. A coordinator-only configuration has no warm computer; authorized work can lazily provision its own isolated computer. No privileged access to another Bot's files/session follows from coordination. |
| Q5 — accessible takeover | Keep textual lease/status, keyboard/form controls and an activity log. Do not claim full screen-reader access to a pixel desktop; real device/assistive evidence remains open. |
| Q6 — stop/revoke | Stop fences the named work grant/attempt generation and late publication. It does not revoke unrelated work or routines. A user-cancelled job cannot auto-resume on reboot. |
| Q7 — Bot lifecycle | Retire/delete and capability edits require scoped owner commands, exact revisions and lifecycle preview/fencing. Widening never follows from Bot output. These flows are owned by [BOT14-02](../tickets/s14/BOT14-02.md), with explicit preview/revision/fencing tests, although absent from the prototype. [OPS14-01](../tickets/s14/OPS14-01.md) prevents old-backup lifecycle resurrection before worker activation. |
| P-E1 — script-free takeover | Retain the existing form-based baseline: input type=image posts coordinates, text/key forms post input. ADR 0039 already demonstrates it. The claim that forms cannot forward input is incorrect. Enhanced live interaction is optional. |
| P-E2 — live transport | The existing bounded same-origin image/state/SSE path is a valid starting point. A new WebSocket/WebRTC/CSP exception is not required by this spec and needs separate evidence if selected. |
| P-E3 — mobile tabs | This is an Opus designer proposal within the S14 redesign. Record it as proposed and update affected UI contracts/snapshots in its slice; it is not a newly confirmed owner answer. |

## Report state and coverage

Ready for review means an artifact is committed and inspectable, not that all questions/sources were covered. Keep explicit partial coverage, missing evidence and unmet completion rules visible. A complete work/result claim cannot be derived from the prototype's scene name or a ready badge.

## UI is not a security boundary

OwnerStrip is an Opus visual/interaction proposal. Its appearance, mono formatting, a visible receipt or a Stop button cannot prove authorization. Only typed authenticated commands, current policy/revision checks and fenced service execution enforce it. Untrusted source text cannot render authority controls.

## Design provenance and verification

Orchestrator creation, completed task metadata and read-only thread configuration all report model claude-opus-5-5 and option effort=high. The delegate also saw an internal numeric display of 25; its mapping to provider internals was not inspected and is not asserted. The recorded orchestrator selection remains high. No rerun or model substitution was performed.

The designer authored the experience document and all prototype UI/UX. Parent integration is limited to contract/factual annotations and a fixed-height embedding adapter; the source prototype is unchanged. Parent html_preview rendered the initial Thai/dark state at 728 px, concurrent progress at 728 px and English/light report at 390 px with no console messages. This is sample rendering, not verification of every scene/device or real product behavior.

Prototype data, costs, budgets, names and site/hash examples are fixtures. DOM/static checks are separate from real layout, screen-reader, live API and Linux evidence.
