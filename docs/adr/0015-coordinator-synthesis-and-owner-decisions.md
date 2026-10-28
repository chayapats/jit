# ADR 0015: Coordinator synthesis and owner decision revisions

Status: accepted for TEAM03 engineering choices (Jit #14). Requirements: FR-03, FR-04, FR-07, FR-10, FR-14, FR-15, FR-17, NFR-05, NFR-07, NFR-10.

## Confirmed decisions and required behavior

ADRs 0004, 0008, 0011 and 0012 keep task acceptance, configuration and execution separate from model text. TEAM02 commits attributed specialist outputs only. The owner remains the decision maker. A coordinator recommendation, a specialist majority, a phrase that says a choice is already approved, retrieved memory and untrusted source text do not record an owner decision, accept a task or change configuration.

## Selected implementation

Store coordinator runs, immutable proposal revisions and owner decisions in schema v8. A proposal row is inserted only after scripted citation checks pass against the specialist result revisions frozen when synthesis was admitted. The artifact always records `recommendationOnly: true`. Disagreement or a missing role forces `consensus` off. Extra model fields such as approval, majority and memory are discarded.

Synthesis is one bounded interactive job, `team.coordinator-synthesis`, admitted through `jobs.queue_admission` and published through `jobs.attempt_fence`. The owner command `decision.synthesize` starts it. The job is hidden from the generic job picker. Stop, a failed citation check, an expired budget and a late result record synthesis state only. They do not insert a decision. If a live owner decision is already at least as new as that synthesis, the late result is cancelled and does not replace the decision or publish another proposal over it.

`decision.accept` and `decision.supersede` are the only writers of `owner_decisions`. They require the current proposal id and revision, use `app.command_receipts`, and store actor, time, project, topic, rationale and source links apart from the recommendation. One live decision per topic is enforced. Supersede keeps the previous row. Accept does not enqueue a job.

The topic and discussion pages project `app.decision_read_model/v1`. GET does not accept a decision. Unavailable evidence stays unavailable. Source rows remain for later continuity.

## Alternatives and consequences

Keeping the recommendation only inside `team_runs` would not give the owner a revision to accept. Mutable proposal JSON would let a stale page accept a different recommendation under the old revision. Treating a finished model call as success would record invented citations. Automatic acceptance on majority or on the words "approved" would move authority off the owner.

Schema v8 follows the snapshot-before-DDL migration. Delivery tables stay at v7. The v6 telegram DDL stays behind `current < 6`, so a database that already has those tables can move through v7 to v8. This slice does not add task lifecycle, memory extraction, debate loops or autonomous important decisions.

The exact surfaces are recorded in [coordinator-synthesis-v1](../contracts/coordinator-synthesis-v1.md).
