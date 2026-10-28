# Specialist results, v1

Owner: Jit #11 (TEAM02). Contract: `app.specialist_results/v1`. Lives beside team dispatch in `src/team/dispatch.ts` and attributed conversation/source commits. Complements `app.team_dispatch/v1` and `app.run_records/v1`.

A specialist result is committed only when `WorkContext.commit` accepts a succeeded step for `team.specialist-analysis` and the normalized `ApplicationRunOutcome` is `complete` with nonempty fixture output. The trusted producer writes one output source (`commitOutputSource` with participant/run attribution) and one topic message in the same app transaction as the retained specialist run outcome. Since BOT04 the message advances the topic's message order but not its revision, and each attempt reserves `floor(outputTokens / (retries + 1))` output tokens. Incomplete, blocked, cancelled or invalid outcomes record the outcome on the run without a successful history message and never alter role configuration.

Participation projection exposes `state`, `reason`, `nextAction`, `route`, committed `output` source reference and cleared progress after commitment. `coverageGap` lists selected roles that are not completed/skipped/excluded. Peer results are ordinary untrusted text if later read as sources; they are never copied into another role's `instructions.operator` or shared managed context.

Stop/supersede/cancel fencing prevents duplicate committed answers for the same generation. Host finished/completed without valid normalized output becomes `invalid_result` / non-complete evidence, not a successful analysis. Resume of quota/login/route waits remains on the original fixture admission route (`jit-fixture/scripted/internal`) while the captured request route stays unchanged.

## v2: `app.specialist_results/v2`

Owner: Jit #114 (S10 REL02). Decision: [ADR 0033](../adr/0033-deterministic-routing-and-result-contract.md) ("Result contract"). Implementation: `src/team/specialist-results.ts`, `src/team/dispatch.ts`, `src/team/types.ts`. Requirements: FR-29, FR-30, FR-03, FR-07, FR-17, FR-19, NFR-10. Uses `app.specialist_results/v1`, `app.coordinator_synthesis/v1` and `app.jit_reply/v1` without changing their admission or fencing.

```ts
type SpecialistResultStatus = "done" | "partial" | "blocked" | "failed" | "incomplete";
interface SpecialistResultV2 {
  version: 2; status: SpecialistResultStatus; result: string;
  evidence: SourceReference[] | "none"; unblock: string | null; raw: string | null;
}
export function normalizeSpecialistResult(output: string, allowedEvidence: readonly SourceReference[]):
  { result: SpecialistResultV2; droppedEvidence: number };
export function specialistResultView(run): { version: 1 | 2; status: SpecialistResultStatus; unblock: string | null } | null;
```

**Shape.** A specialist run gets one trusted operator line (`specialistResultInstruction`) that asks for one JSON object, optionally inside one ```` ```json ```` fence, with exactly the keys `status`, `result`, `evidence` and optionally `unblock`:

- `status` is `done`, `partial`, `blocked` or `failed`. `incomplete` is assigned by the service only; a model that reports it gets `incomplete` like any other malformed output.
- `result` is non-empty, well-formed text.
- `evidence` is `"none"` or a list of exact `{sourceId, revision, generation}` references. A well-formed reference that is not one of the run's manifest sources is dropped and counted (`droppedEvidence` on the run record and `evidence dropped N` in the job evidence). An empty list reads as `"none"`. A malformed entry makes the whole result `incomplete`.
- `blocked` needs exactly one unblock action: one non-empty line of at most 200 characters. A missing, empty, multi-line or list value is `incomplete`. Every other status has no unblock action; a non-null value is `incomplete`.
- Unknown keys (`task`, `decision`, …), plain prose, truncated JSON and any other shape are `incomplete`, with the raw text kept for inspection (at most 2000 UTF-16 units, never splitting a surrogate pair). An `incomplete` result never counts as done.

A result is analysis only. It cannot add authority, a task, a decision, a role or a route.

**Storage.** New specialist runs write `result: null` and `policyVersion` at admission. When a complete outcome commits inside the attempt fence, the normalized result is stored on the run (`team_runs.record_json`) and the output source text is rendered by the service: it starts with the specialist's name (`<role> · <mode>`), then `status: <status>`, the result text (the bounded raw text for `incomplete`) and `unblock: <action>` when blocked. A non-complete outcome stores `result: null` and commits no message, as in v1. v1 records are never rewritten. `specialistResultView` reads both: a v2 record returns its status; a v1 record (no `result` key) with a committed complete outcome reads as `done`; a run without one has no result. Participation projection adds `result` to each `DiscussionParticipation` from that view.

**Gaps.** `done` and `partial` results are citable. `blocked`, `failed` and `incomplete` results are coverage gaps (`coverageGap`, synthesis `missing`, team reply `gaps`) with reason `result_<status>`, and never count as done (the team card's done count, "answer now" and the discussion list count only citable results). A blocked gap keeps only its specialist `runId`; the read models (team reply view, team card, decision read model) read the unblock action from that run record, so data deletion, which redacts the run record's `result`, `raw` and `unblock` with its outcome output, covers every place it shows. Unblock text is specialist output: it is shown escaped as data and never enters an operator line.

**Re-dispatch.** In `admitJitDispatch`, a named role whose latest committed result for the same request (same topic, role and discussion purpose, the owner message text normalized by `dispatchPurpose`) is `blocked` is not called again. It is recorded on the proposal as `blocked: [{ roleId, roleName, runId }]` and the card shows its unblock action instead; if no named role remains, the proposal is `empty` with that note. A different request is admitted. The owner's own `team.dispatch` is never refused; once the role's latest result for the request is no longer blocked, Jit may call it again. `settleDispatch` never dispatches; it admits the team reply with the blocked role as a gap.

**Web.** The team card, the team reply details, the discussion page and the decision panel show a status pill (`team.result_status_*`) and the unblock line (`team.unblock`). A dispatch that held roles back shows `dispatch.held_blocked` (and `dispatch.empty_blocked_note` when nobody was called). Everything is server-rendered; `app.js` does not touch it, so pages are the same with and without script.

**Evidence.** `tests/team.test.ts` (normalization cases), `tests/dispatch-allowance.test.ts` (one done + one blocked through team reply and synthesis; refused re-dispatch and a different request; injection; a v1 record on the team card in Thai and English), `tests/jit-reply.test.ts` (policy on replies), `tests/memory-delete.test.ts` (v2 text is redacted by lineage).
