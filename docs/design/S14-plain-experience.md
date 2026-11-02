# S14 Plain experience

Status: owner-approved scope, 2026-11-02. Refines S14-AC13, FR-10/23/24/25 and NFR-11/13. The owner explicitly authorized direct replacement and a task-specific exception to the usual UI/UX author requirement.

Tracking: [Plain parent #307](https://github.com/chayapats/jit/issues/307), [implementation/review #308](https://github.com/chayapats/jit/issues/308) and [remaining coverage triage #309](https://github.com/chayapats/jit/issues/309). Published on 2026-11-02 after implementation commit `388c119773bcb1244912fa70ec3ec67b5cd0544d` was pushed. Implementation is on `t3/plain-handoff-scope-review`, pending PR/review/merge; remaining device/AT coverage is not a new implicit release gate. The closed original S14 parent #244 remains a historical baseline.

## Confirmed decisions

- Replace the S14 presentation and information architecture across every existing feature surface. No old renderer, feature flag or UI compatibility layer is required. Legacy remains its separately selected runtime.
- Use the supplied Study02 visual direction and original Plain flow reference. Neither demo state nor demo execution behaviour is a runtime contract.
- Open Jit's most recently visited conversation, remembered independently per browser. New conversations require the existing explicit owner action. Explicit deep links select their named destination.
- Conversations retain one Bot. Multi-Bot collaboration uses existing bounded Work grants.
- Primary navigation foregrounds Bots, conversations and Work. Work aggregates every Bot's active work, owner decisions and retained results. Memory, Routines and management surfaces remain discoverable in grouped secondary navigation.
- Chat is the initial mode after successful submission, entering another conversation or selecting another Bot. A mode selection alone starts nothing.
- Mobile details replace the conversation with a full page and a direct return path. Desktop retains a secondary work pane.
- Composer drafts persist locally per browser for 30 days after their last edit, across reload and browser restart. They do not sync across devices.

## Presentation

Use warm monochrome surfaces, a readable text column, thin separators and quiet metadata. Owner messages use an indented text rule; answers lead the reading order. Ordinary lists and settings use spaced rows rather than nested cards. Exact approval payloads, uncertainty, coverage gaps and authority-changing actions retain distinct labelled sections.

The desktop sidebar starts with the Jit mark, new conversation, Work, Bot identities and recent conversations. A native mobile navigation disclosure provides the same destinations. A labelled needs-owner link remains available in each page header. Secondary destinations are grouped by knowledge, automation and installation management; none becomes dependent on a demo's coverage.

Work limits remain editable and visible in Work mode. The send control explicitly names Chat or starting Work. Advanced scope details retain actual selected Bots/resources/tools and current revisions. The server translates the same strict forms into the existing typed commands.

## Invariants and verification

S14-D04/06/11/16, AC03/05/09/11/12 and their FR/NFR mappings remain unchanged. Task acceptance does not start work. Exact external approval is separate from work start. Stop retains its named scope and transport settlement. Unknown external effects are reconcile-only. Model/source text cannot create authority controls. Existing lifecycle, routine, report, sharing, computer, coding, personal-account and operations flows remain reachable.

No React demo, scripted cursor, fake reply, forced replay, synthetic completion timer or demo input lock is shipped. Same-origin hashed assets, CSP, session/Host/Origin/CSRF checks, escaping and no-script command forms remain. Browser-local navigation/drafts confer no authority. See ADR 0062 for the browser-state boundary.

Validation must identify the tested revision and distinguish deterministic handler/DOM tests, browser layout observations and actual device/provider evidence. Earlier evidence does not certify this replacement.


## Reconciled output flows — 2026-11-02

The earlier 2026-11-01 handoff also confirmed a cross-work output Library and seamless inline Work. The owner authorized completing the omitted flows and babysitting them through review/merge. [PLAIN14-04 #313](https://github.com/chayapats/jit/issues/313) and [PLAIN14-05 #314](https://github.com/chayapats/jit/issues/314) track them without reopening the completed S14 baseline or exploring a new style.

The latest primary-navigation decision remains Bots/conversations and Work. Library is a discoverable grouped knowledge destination alongside the existing Memory and Shares entries. Reports/Files list actual committed revisions across work/Bots with current coverage/review facts, original Work links and authenticated downloads. Missing/withdrawn content stays unavailable; readiness, coverage and owner acceptance are distinct.

Conversation Work cards show current results, report/source/file facts and the existing exact effect components without requiring a detail-page transition. Git approval still requires its immutable diff/check review page. A selected Progress pane owns its own exact controls, so they are not repeated in the same conversation. Details and every existing deep link remain available. Each inline work has a refresh region separate from its receipt disclosure; focused owner input defers its own replacement. See ADR 0063 for query bounds and lineage.
