# Coordinator synthesis and owner decisions, v1

Owner: Jit #14 (TEAM03). Contracts: `app.coordinator_synthesis/v1`, `app.decision_commands/v1`, `app.decision_read_model/v1`. Implementation: `src/team/decisions.ts`, `src/team/types.ts`, `Application`, topic and discussion HTML. Builds on committed `app.specialist_results/v1` outputs. Requires `app.run_port/v1`, `jobs.queue_admission/v1`, `jobs.attempt_fence/v1`, `app.command_receipts` and `app.source_records/v1`. Schema user_version 7.

The owner remains the decision maker. A coordinator artifact is a recommendation. It does not accept a task, enqueue execution, or change role configuration.

## Exact public surface

```ts
export const coordinatorSynthesisWorkId = "team.coordinator-synthesis";
export const coordinatorSynthesisMarker = "This is an explicitly authorized scripted coordinator synthesis, not live inference.";

export function decisionIdentity(command: DecisionCommand, maximumBytes: number): string;

export function normalizeCoordinatorSynthesis(
  output: string, allowed: readonly SynthesisCitation[], gaps: readonly SynthesisGap[],
): { state: "complete"; artifact: SynthesisArtifact }
  | { state: "failed"; reason: "malformed" | "invented_citation" | "no_artifact" }
  | { state: "incomplete"; reason: "missing_citation" };

export function readDecisionModel(
  tx: AppTransaction, projectId: string, topicId: string, discussionId?: string,
): DecisionReadModel;

export function prepareSynthesis(
  tx: AppTransaction, command: Extract<DecisionCommand, { kind: "decision.synthesize" }>,
  config: AppConfig, queue: JobQueue | undefined, generation: number, now: number,
): DecisionReceipt;

export function acceptDecision(
  tx: AppTransaction, command: Extract<DecisionCommand, { kind: "decision.accept" }>,
  channel: "web", now: number,
): DecisionReceipt;

export function supersedeDecision(
  tx: AppTransaction, command: Extract<DecisionCommand, { kind: "decision.supersede" }>,
  channel: "web", now: number,
): DecisionReceipt;

export function coordinatorSynthesisWork(
  store: TransactionStore, config: AppConfig, port: ApplicationRunPort, now?: () => number,
): WorkDefinition;

Application.execute(actor: OwnerActor, command: DecisionCommand): DecisionReceipt;
Application.decision(actor: OwnerActor, projectId: string, topicId: string): { project: Project; topic: Topic } & DecisionReadModel;
Application.discussion(actor: OwnerActor, projectId: string, discussionId: string): { project: Project; discussion: Discussion; decision: DecisionReadModel };
```

`DecisionCommand` is `decision.synthesize` (discussion id, job limits, expected discussion revision), `decision.accept` or `decision.supersede` (proposal id, option id or null, conclusion, rationale, expected proposal revision; supersede also carries the current decision id). `DecisionReceipt` is `{ revision, synthesis?, proposal?, decision? }`. `DecisionReadModel` is `{ synthesis, proposal, proposalEvidence, decisions, currentDecision }`.

## Behavior

`decision.synthesize` reads committed specialist outputs for that discussion revision. Completed available results become the only allowed citations, with role and route copied from the participation. Other participations that are not skipped or excluded are gaps. The scripted coordinator request carries those texts as untrusted manifest data. Fixture output is normalized only inside the attempt fence. Every allowed result revision must be cited. An invented reference fails the synthesis. A missing citation or a missing artifact leaves it incomplete or failed. Consensus is false when specialists disagree or a gap remains. Approval, majority and memory fields are ignored.

A proposal row is immutable and keyed by discussion and revision. `decision.accept` records one live owner decision for that exact proposal revision, with actor `owner`, channel `web`, time, project, topic, rationale and source links. A stale revision, a duplicate request with a different payload, or a second live decision does not insert another row. The same request id and payload replays the original receipt. `decision.supersede` keeps the previous row and points `supersededBy` at the new decision. Stop, budget expiry and a synthesis that finishes after a newer owner decision do not create or replace that decision.

The read model resolves evidence through the source registry. Unavailable content is `unavailable` with a reason and null text. Source rows stay in place.

## HTTP

| Route | Behavior |
| --- | --- |
| `POST /[api/]projects/PROJECT/team/discussions/ID/synthesis` | `decision.synthesize`; `expectedRevision` is the discussion revision; form `limits` is a JSON string |
| `GET /api/projects/PROJECT/topics/TOPIC/decisions` | Read model only |
| `GET /projects/PROJECT/topics/TOPIC/decisions` | Redirects to the topic `#owner-decision` and does not insert |
| `POST /[api/]projects/PROJECT/topics/TOPIC/decisions` | `mode=accept` or `mode=supersede`; `optionId` `own` or empty is the owner's own conclusion |
| Topic and discussion HTML | Shows disagreement, gaps, the question, evidence and the decision form |

POST requires the owner session, `Origin` and CSRF. GET never accepts a decision. Unknown body keys are rejected.

## Schema

user_version 7 adds `coordinator_syntheses`, `decision_proposals` and `owner_decisions`. One live decision per topic is a partial unique index. Migration snapshots the previous file before DDL. The v6 telegram tables are created only when `current < 6`.

Deterministic evidence: `tests/team.test.ts` (TEAM03 cases) with the scripted port, a fake clock and no paid model calls. See [ADR 0014](../adr/0014-coordinator-synthesis-and-owner-decisions.md).
