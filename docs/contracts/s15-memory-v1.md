# s15-memory/v1

Implemented opt-in MEM15-01 contract, revision 1, 2026-11-03. Requirements: **FR-04/05/16/17/31/38; NFR-07/08/09; S15-D14; S15-AC13**. Exported TSDoc in `src/s15/memory/` defines the TypeScript surface; [ADR 0071](../adr/0071-s15-mediated-team-resources-and-fenced-handoffs.md) records the TEAM/MEM simplification. S14 remains default. No installed state, provider/account/billing, host adoption or Jod integration changes.

## Retention and provenance

Protected composition supplies current `retention(WorkAuthority): DataScope | null`; null disables automatic retention. Actual POLICY work actors and TEAM access checks precede retention/retrieval. `retain` accepts original trusted ingress/observations and bounded untrusted extraction candidates, never authority. The default local extractor recognizes explicit English/Thai first-person preferences/facts, named build/test commands and marked inferences. It makes no extra model/network call. Broader semantic extraction is not claimed. Trusted callers may propose at most sixteen candidates, with exact source quotes; a fact's text must equal its quote. Generated work knowledge is always marked inference/unconfirmed. Owner-stated facts represent statements, not independently verified truth or authenticated policy decisions.

Only relevant quoted subsets enter TEAM source storage. MEM retains original message/work identity, conversation/time, full-input hash, source reference, scope and resource revisions rather than another full transcript. Claim JSON contains:

- `contract: s15-memory-claim/v1`, `id`, `revision`, `sourceId`, `createdAt`;
- `kind: fact | inference`, `category: fact | preference | working_knowledge`, `text`, `quote`;
- `provenance: {origin, scope, resources, teamSourceId, sourceHash}`;
- `confirmation: owner_stated | observed | unconfirmed`;
- `lifecycle: active | superseded | forgotten`, `supersedes`, `correction`, full `dependencies`;
- `authority: none`, including imported/historical or approval-shaped statements.

Credentials/registered secrets refuse before storage or prompts. Existing S14-private input requires an explicit Bot/S14 privacy label and stays private; this service reads no S14 database. Resource restrictions and full source/claim ancestry are checked before lexical relevance. Preferences are automatically eligible for later tasks. Other facts/working knowledge require bounded lexical relevance and the current resource scope; this is not semantic/vector recall. Initial packets have at most sixteen claims/16 KiB. Successful tool observations extend context lineage before bytes return to the model, up to 128 claims/sources per request. Every generated summary/artifact inherits complete input lineage, including uncited claims.

## Corrections and forget

`memory.correct` authenticates the current owner, checks the exact claim revision, suppresses the superseded source and dependent claims, retires derived contexts/summaries/artifacts/native references and creates a new owner-sourced replacement. The old row points to its correction. Source siblings are conservatively retired too. The replacement preserves inherited Bot/S14 privacy labels and resource revision ceilings even when an ancestor was uncited. A correction is data; it cannot approve an action.

`memory.forget` erases affected claim/quote bytes and retained derivative text, suppresses original-source hashes and normalized quote/claim fingerprints, and retires every dependent claim/context/summary/artifact/native reference. It follows correction descendants. Whole-source suppression deliberately favors forgetting over retaining another fact from the same source. It also excludes that original message/retired reply from ordinary CHAT history. Reusing a new source ID, ordinary replay or restart cannot re-extract the same forgotten content. Previously delivered/seen remote/model bytes cannot be recalled; no arbitrary semantic paraphrase detection is claimed.

TEAM withdrawal commits first, then MEM tombstones/retirement and the command receipt commit atomically. A failed second commit leaves data withheld through both source guards and history filtering; an identical retry completes MEM retirement. Receipts retain only correction IDs/revisions and counts, never a forgotten replacement's text. A stale/retired context blocks subsequent model/tool/result publication. Existing fresh-session Schway retirement/close handles active native cleanup; no native byte parsing or session resurrection is added.

## JSON owner API

Mount optional `resources` and `memory` ports on `createConversationHandler` using the same protected owner authentication, exact Host/Origin and POST CSRF controls. Models/working guests receive none of these mutation ports.

| Method/path | Result |
| --- | --- |
| `GET /api/s15/resources` | `s15-team-resources-view/v1`: credential-free resource, potential team/Bot audience and explicit restrictions |
| `GET /api/s15/memory` | `s15-memory-view/v1`: claims/provenance/scope/source state/lifecycle/correction, plus `nativePolicy: fresh_sessions_retire_on_close` |
| `POST /api/s15/memory/commands` | Exact command below; mutation returns `s15-memory-receipt/v1`, impact returns `s15-memory-impact/v1` |

Command shape is `{contract:"s15-memory-command/v1", requestId, kind, claim:{id,revision}}`. `kind` is `memory.correct`, `memory.forget` or read-only `memory.impact`. Correction additionally requires `text`; every other extra key refuses. Same mutation ID/exact payload returns its original receipt; changed payload conflicts. Impact counts are `claims`, `sources`, `summaries`, `artifacts`, `contexts`, `nativeSessions` and distinct `workItems`. Inspecting impact grants no authority and mutates nothing. Thai/English keys support future Opus-authored UI; no visual UI is implemented.

## Storage and migration seam

MEM uses protected SQLite application ID **0x4a495437**, `user_version=1`; `MEMORY_SCHEMA_V1` explicitly declares installation identity, sources, claims, derivatives, immutable suppressions and command receipts. TEAM is separately **0x4a495436**, version 1. Exclusive runtime locks prevent simultaneous writers/recovery, foreign/old/new headers refuse before writable open, and existing stores require matching installation identity. Custody refuses at 64 MiB without evicting withdrawal/dedupe history. Neither store is an ordinary backup image or guest file. No implicit bootstrap repairs missing current continuity.

MIG15 must preserve both current schemas, exact identities/provenance, correction heads, suppression hashes, derivative retirement, TEAM withdrawals/fences/unknown leases and owner-command dedupe. Restoring one older store independently is unsupported. Version-one records and exported `MemoryProvenance` form the future adapter seam; no Jod backend, transport, synchronization or import implementation is supplied.

Deterministic evidence: `tests/s15-memory.test.ts`, `tests/s15-memory-conversation.test.ts` and `tests/s15-team.test.ts`. They use real POLICY actors, scripted public Schway models, fake clocks, barriers and reopened isolated stores. Real-host power-loss, Linux/VM/browser enforcement, provider/account readiness and migration/adoption remain separate evidence work.
