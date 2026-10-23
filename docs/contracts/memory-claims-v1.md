# Memory claims, lineage and active generation, v1

Owner: Jit #23 (MEM01). Schema: 11. Contracts: `app.memory_claims/v1`, `app.memory_lineage/v1`, `app.memory_active_generation/v1`. [ADR 0019](../adr/0019-memory-claims-and-lineage.md) distinguishes required behavior from selected engineering choices.

## Public application surface

- `Application.execute(actor, ExtractMemoryCommand): MemoryReceipt` authorizes one `memory.extract` background job. It requires an authenticated Web owner, exact project aggregate revision and payload `{topicId, roleId, source, dependencies, limits}`. The global request receipt and extraction/job/audit commit together. Replayed IDs return the original receipt; changed payload conflicts. Independent requests for the same extractor `claims/v1`, policy `1`, exact source revision/generation reuse one logical extraction, without resetting budgets. A failed extraction needs a later extractor/policy/source version, rather than an unlimited retry button.
- `Application.memory(actor, projectId, after?, sourceAfter?, extractionAfter?, query?)` reads paginated claims, eligible sources and extraction/job status offline. Each cursor is independent. `query` is a bounded literal substring over claim text; English ASCII case is folded and Thai/Unicode is preserved. It starts no work. The current requested production route and actual fixture execution are distinct.
- `Application.memoryClaim(actor, projectId, ClaimReference)` resolves one exact `{claimId, revision, generation}` and its lineage through `lookupActiveClaim`.
- `lookupActiveClaim(tx, projectId, reference)` is the active-generation consumer contract. It refuses missing/noncurrent source revisions/generations, inactive or missing claims and unavailable transitive dependencies. A fail-closed ceiling of 8 levels/64 visited nodes bounds traversal. All admitted context claims become derivation dependencies, including claims omitted by model-authored lineage. Conflict references are retained and checked too. Callers must authorize project scope before the transaction seam.

Claims have stable UUID/revision/generation, origin project, extraction ID, status, exact source reference/quote, fact/inference kind, dependencies, conflicts and commit time. Initial immutable records use revision/generation 1. Later MEM03/04/05 own correction/suppression/deletion policies and propagation; this contract already checks active generations rather than trusting a materialized index. No embedding/vector database is required. Indexes are derived from retained source/claim records and can be rebuilt without provider transcripts or model weights.

## Extraction and validation

One source and up to seven existing active same-project claim references fit within the configured TEAM source/context limits. Requests capture effective role/project route and configuration, empty tools and all strict discovery/lookup flags off. JOB01 budgets and JOB02 authority/lease/source/context fencing apply at every attempt. The captured source text is evidence, never trusted instructions. New contexts begin at admission and native identities persist before dispatch; restart/reconcile and explicit read resume do not replay retired ancestry.

The response is `{version:1, complete:boolean, claims:[{kind,text,quote,source,dependencies,conflicts}]}` with no undeclared fields. Maximum 16 assertions, 2048 UTF-8 bytes per text/quote and the configured job output ceiling. Each quote must be an exact substring of the admitted exact source. Dependencies/conflicts must cite admitted active references. Fabricated/wrong-project/wrong-generation references, missing lineage, invalid quotes and unsupported explicit facts are rejected. Valid siblings can commit as partial. Malformed envelopes publish no claims and retain a failed extraction reason under a partial job. Quota/login/unavailable route waits keep the selected route and use existing queue reasons/actions.

`explicit_fact` requires owner attribution, exact quote equal to claim text and no derived input. It records an owner statement, not objective truth or an authoritative preference/task/decision. Participant agreement and externally inferred statements remain inference. Conflicting claims coexist; latest-wins truth selection is absent. Semantic relevance/quality is not guaranteed by citation validation.

Extraction results are not sources or canonical conversation messages, so they cannot trigger recursive extraction. Committed conversations, task proposal sources and specialist/coordinator outputs remain inspectable inputs; task/decision authority and current status stay in `app.project_continuity/v1`. No automatic source scan is authorized by merely reading an inspector or saving a role.

## Web and lifecycle boundaries

GET `/[api/]projects/:id/memory` inspects; POST on the same path uses Origin/session/CSRF and the shared owner command boundary. GET `/[api/]projects/:id/memory/claims/:claimId?revision=...&generation=...` opens exact lineage. The inspector shows source availability, origin, status, partial/rejected counts and queue next action; rendered text is escaped. Receipts exclude captured run requests. Private request snapshots remain retained attempt evidence and later lifecycle work must retire/redact all relevant retained projections.

Production inference is deferred to JBR01. The local service registers a scripted fixture extractor through `ApplicationRunPort`, never a live provider or a private Schway API. It echoes a bounded source excerpt with correct attribution and marks truncation incomplete. No login, subscription, quality, complete learning, cross-project retrieval or deletion-support claim is made.

## Deterministic evidence

`tests/memory.test.ts` covers command → bounded queue → independent run → cited claims → Web/offline reopen; global/logical dedupe and rollback; owner fact versus inferred legacy preference and hostile participant output; invalid citation/generation/lineage; conflicts and transitive unavailable ancestors; cancellation/owner reset/context retirement/deadline/source changes; malformed/partial/quota/oversized output; authorization, pagination and Thai/English search. Full suite and typecheck are required without live accounts. Migration preserves existing tasks/decisions/sources and snapshots the prior store under the normal APP01 guard.
