# ADR 0020: Layered memory context with recorded provenance

Status: accepted for MEM02 engineering choices (Jit #26). Requirements: FR-02/03/04/05/10/14/17/18 and NFR-05/07/10/11.

## Context

The confirmed decisions are in CONTEXT.md, the MVP spec and [ADR 0003](0003-cross-project-memory-with-provenance.md). Jit uses cross-project context automatically. It keeps explicit facts separate from inferences, discloses the provenance of an inference when that inference matters, and never moves tasks or decisions across projects. MEM01 ([ADR 0019](0019-memory-claims-and-lineage.md)) supplied cited claims and `lookupActiveClaim`. MEM02 decides how claims and current project state reach runs, and how runs remember what they used.

## Decisions

The rest of this record lists proposed engineering choices, not product decisions.

1. **Assemble inside the owner transaction, on the existing run port.** Dispatch and synthesis already freeze exact sources inside the owner command. Context assembly happens in that same transaction, and the context travels as an optional `manifest.context` on `app.run_port/v1`. This needs no Schway change and no new execution path. The layout carries labels only. Trusted precedence is one fixed operator line, never derived from memory or source text.
2. **Current state comes from committed tables, not memory.** Constraints are read from the same task and decision rows that `app.project_continuity/v1` exposes, with a finite ceiling and current-topic-first ordering. The ceiling exists because the full continuity read is unbounded per topic. Memory claims are only explicit preferences or inferences. Topic messages and native history are never replayed.
3. **Deterministic lexical retrieval.** Policy 1 combines ASCII words with code-point trigrams for non-ASCII runs. This handles Thai without word segmentation or new dependencies. Paraphrase recall is a documented limitation. Embeddings remain optional future work and are not mandated.
4. **Project first, cross-project bounded and always inferred.** Relevant project claims come first, then at most three relevant cross-project claims. Cross-project claims are always labelled `inference` with their origin project. Recent project owner statements fill any slots left, so stated preferences survive questions with no lexical overlap. Conflict counterparts are pulled in when budget allows, so contradictions stay visible.
5. **One immutable provenance record per discussion or synthesis.** Schema v12 adds `memory_contexts` and an `(kind, entry_id)` entry index. MEM03/04/05 can then find affected runs without scanning team JSON. The record snapshots the policy, exact revisions and generations, owner generation, project revision and assembly time.
6. **Fence stale context like stale sources.** Freshness joins the existing attempt gate (`isCurrent`), so a stale result never commits. Owner task commands and decision supersession proactively fence pending runs and cancel them after commit, matching MEM01 extraction fencing. A decision acceptance does not stale an earlier context, so TEAM03's late-synthesis semantics are unchanged.
7. **Loop guard by derivation depth.** Outputs produced with claims are marked derived. Extraction refuses derived sources. Follow-on and summary runs whose evidence is derived receive constraints but no claims. This limits memory → answer → memory amplification without blocking owner follow-up from the topic source.

## Consequences

- Runs and the inspect view show exactly what was used, including omissions and stale entries. Answers can stay honest when context is missing or truncated.
- A project with many tasks or decisions shows only the 12 highest-priority constraints, and the omission is disclosed. Owners can open the full continuity view.
- Task edits or acceptance fence queued discussions that included the task. The owner re-dispatches to get current context. This is deliberately conservative.
- Retained private attempt snapshots and stored team command receipts still contain claim text until MEM04 redaction. The public discussion and context projections already withhold withdrawn claim text.
- The local service uses the same layout with the scripted fixture answer. Live inference quality stays out of scope until JBR01.
