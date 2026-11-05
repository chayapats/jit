# S16 sourced file memory v1

MEM16-01A [#402](https://github.com/chayapats/jit/issues/402) extends [file custody](s16-files-v1.md), [binary inputs](s16-binary-files-v1.md), [ADR 0078](../adr/0078-s16-file-memory-and-history-ancestry.md) and the authored memory/source/correct/forget experience. It supplies exact file ancestry for later authorized requests. Full memory search/client lifecycle belongs to #416; library revisions, delegation, routing and file-to-VM consumers retain their own delivery issues.

## Explicit configuration and compatibility

An explicit S15 runtime configuration selects `files: true` (text) or the binary configuration object, then separately sets `fileMemory: true`. Trusted composition uses `files: { memory: true, ... }`. DATA15 and the current TEAM retention policy remain required. Omission preserves the existing file-memory/history fence. Configuration does not install or widen a standing rule, change S14/legacy defaults, migrate private data or activate an owner host.

The protected client advertises capabilities revision 2, `uploads.memory: true`, and `uploads.memoryContract: "s16-file-memory/v1"` only with the composed port. Other clients/configurations retain revision 1 and `memory: false`. Current v1 text receipts, v2 binary receipts and file-bearing command identities remain supported. Retention follows the explicitly enabled configuration and current standing policy, independently of upload acceptance or work authorization. Each newly accepted file command freezes `fileMemory: "s16-file-memory/v1"` in its CHAT record. Previously accepted commands without this marker are never promoted by a later configuration change or duplicate send.

First new file-memory ingress stamps CHAT `user_version=4` atomically with that command. TEAM/MEM stamp `user_version=2` when they first persist file pins. Only explicit file-aware compositions accept those versions; turning the integration off or rolling back to an older reader refuses before writable adoption. The file journal retains its text/binary formats 1/2. No table conversion, old command rewrite or native history recovery occurs. Restoring only an earlier manifest cannot remove these fences; recovery needs a compatible release/state plan.

## Immutable metadata and selected-byte verification

`s16-file-source/v1` is a closed metadata pin:

```ts
{
  contract: "s16-file-source/v1";
  source: { id: string; revision: number; generation: number };
  resource: { id: string; revision: number; generation: number };
  sha256: string;
  representationSha256: string | null;
}
```

It identifies the original private source/resource generations, original SHA-256 and, for binary input, the validated model-representation SHA-256. It contains no source bytes, filename/path, credential, owner proof or work principal. A pin cannot authorize access. A closed union is limited to 128 pins and rejects two different generations/hashes for one source. Existing DATA15 64-source and MEM 16-claim/16-KiB context bounds also apply; technical limits are not new financial or dispatch authority.

`FileStore.pin` authenticates the current reader and returns metadata. `pinsCurrent` is a protected status/filter query, not byte permission. It resolves exact IDs directly rather than collecting all files under a computer resource. `verifyPins` reauthenticates and verifies exact current original/derived custody bytes. TEAM's metadata-only `ancestry` checks private scope, all parents, producer and resource generations before ranking; `verifyFiles` performs selected-byte checks before release. MEM's metadata-only `ancestry` returns complete packet pins without rereading raw files. The protected composition checks current owner generation and current work/resource scope, then uses the owning FileStore. No serialized metadata becomes an actor.

## Retention and transitive use

File inputs seed the entire selected-set ancestry before any model stream. Actual `file_read` returns keep their bounded observed byte ranges. The trusted memory adapter reconstructs only newly complete lines whose every UTF-8 byte was actually observed across those ranges. It never borrows unread bytes, duplicates an already observed line, or extracts claims from file names/projected tool metadata. Existing conservative local extraction and quote/hash suppression apply. Work-origin statements remain unconfirmed inferences under the existing MEM rule; they are not authenticated owner facts or decisions.

Complete successful model answers can contribute locally extracted unconfirmed inferences after actual file coverage/model completion is established. Images therefore retain actual admitted pixel/representation ancestry rather than a filename claim. Generated text inherits every selected/context ancestor regardless of citations. After a file-bound claim was forgotten/corrected, generated paraphrases for that same immutable pin cannot silently become a new memory source; the decision uses metadata, not retained erased private bytes. Original files are separate: forget does not delete them or authorize their use, and a fresh explicit authorized file task can still process a current original. Automatic generated retention remains suppressed for retired ancestry.

Claims, TEAM sources, MEM contexts/native references, owner corrections and uncited summary/artifact derivatives carry complete pins and inherited privacy/resource ceilings. A later request can retrieve useful file knowledge without reattaching the file only within its current admitted resources and Bot scope. Retrieval filters before relevance. The final guard repeats after waits, before tools/VM/model sends, completion and later publication. Exact file sources enter DATA15 before work-model selection; an approval for a generic computer source alone cannot authorize them for a new recipient/purpose. Existing VM/disclosure ports inherit these precise sources when a memory-derived command enters computer work.

The implementation reuses current producer/policy/expiry fences; it does not silently broaden those rules or infer authority from old work. Each request owns a fresh public Schway session. Native compaction/old sessions cannot reconstitute withdrawn data or a working principal. Protected native/audit custody is not a promise of forensic erasure or recall of previously observed/downloaded data.

## Inference history is a separate read-only projection

History fragments are bound to exact current MEM packet metadata. Missing/retired/private-to-another-Bot/unavailable fragments are excluded before context construction. Once selected, the same bindings are checked on every physical inference send and after waits; a later change fences that send/result. No unrelated old file is stamped as a blanket dependency of clean work.

Interpretation still has zero tool/read-dispatch authority and no working resources. `InterpretationInput.bot` is an optional protected caller-selected approved Bot; conversation composition binds the configured Bot explicitly instead of using the first Bot as a privacy surrogate. Older callers can omit it. TEAM `bindHistory` creates a process-local inference-only metadata context. It cannot capture a source, read raw TEAM payloads or obtain working resources. Its dedicated history checks intersect current standing resource generations, read availability, allowed/denied Bots and private labels. These are inference privacy checks, never a copied or widened work authority.

The complete exact file pins are added to the existing DATA15 inference privacy projection, which has current standing resources but is never admitted for tools. Final `guardContext` runs through Schway's dispatch authorizer, including supported auth resends. It checks the actual model recipient/purpose against those file sources. History permission for one Bot or purpose cannot stand in for another's private-memory permission. History/source/model text remains untrusted interpretation data; frozen original owner bytes and protected policy still bound execution.

## Withdrawal, correction, impact and publication

File withdrawal commits once in FileStore. Current metadata makes future retrieval/history/payload checks fail across all descendants, including after restart. Current owner memory views withhold the unavailable file-derived claim/quote bytes and show source-withdrawn provenance. Already displayed, downloaded, provider-observed or guest-observed bytes cannot be recalled.

`memory.impact`, `memory.correct` and `memory.forget` retain their authenticated exact-revision command contract. Forget/correct commits TEAM withdrawal before MEM tombstones; an interrupted second commit can only withhold more. Corrections preserve original file/private/resource ceilings. Suppression retains normalized fingerprints/lengths, not erased claim bytes. File withdrawal is resolved precisely by each packet's pins, so a missing erasure span for an unrelated file does not become an installation-wide history hold.

The producer packet is guarded for every committed artifact preview/download. Actual file artifacts also register metadata-only MEM derivatives, so impact counts include affected artifact descendants and uncited replies. Staging is not CHAT publication, and a private candidate cannot become downloadable from memory metadata. A correction/forget of a producing claim invalidates old artifacts and uncited result projections. Missing context or an uncertain cross-ledger operation never adopts/replays a candidate.

Cross-ledger order is explicit: TEAM capture before MEM retention; MEM packet before CHAT binding; file/TEAM revocation before downstream use/tombstones; immutable candidate before committed CHAT reference. Orphaned protected rows remain inaccessible without the owning current binding. Current synchronous guards consult original owners; no mirrored revocation flags or second database are introduced. A shared writer remains an alternative if future migration/operational evidence demonstrates a simpler safe transition.

## Client and evidence

The existing authored memory page renders exact original/representation source hashes and source-conversation links, current source state, impact and exact correct/forget forms. The S16 conversation shows actual retained-item review links and the enabled-memory explanation. English/Thai, keyboard/forms and mobile hash wrapping use current service facts, with no placeholder success. Full search/client lifecycle remains #416.

Deterministic production-composition tests cover actual observed text/image input → sourced memory → a later actual model request, current private Bot scope, exact generic-versus-file recipient checks for work and interpretation, real guarded VM payloads, image hash ancestry, source/hash/resource substitution, partial/cross-chunk/repeated reads, model-wait withdrawal/forget, correction, generated-paraphrase suppression, artifact impact/download withholding, restart, old-reader refusal and preservation of pre-enable commands. A controlled native Grok transport proves one legitimate wire send and refusal of the physical auth resend after file withdrawal. This is not live account evidence.

Opt-in real Chromium tests execute the actual file-memory source/impact/correct/forget forms in English/Thai at 1440/390 px. Existing file browser tests remain. No live provider/device/owner-host activation, migration, merge or full Rakazo parity is claimed. ADR 0064 physical-browser/guest enforcement and #431/#432 live acceptance retain their separate proof obligations.
