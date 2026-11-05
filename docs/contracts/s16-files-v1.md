# S16 first file workflow v1

FILE16-01A [#400](https://github.com/chayapats/jit/issues/400) is a partial implementation of FILE16-01 [#396](https://github.com/chayapats/jit/issues/396), following the [authored experience](../design/S16-rakazo-experience.md) and [ADR 0076](../adr/0076-s16-file-custody-and-react-client.md). Text alone does not close #396, S16-AC03 or the complete artifact library. PDF, images, file-derived memory, revisions and cross-conversation reuse remain required downstream work.

## Selection and capability

Opt-in S15 accepts `files: true` in `s15-runtime/v1`; trusted composition accepts `files: { limits? }`. DATA15 is required. The explicit `/s16` React client shares the existing service, owner session and protected API. Existing runtime selection and routes remain unchanged. No installation configuration or installed policy is edited by building this feature.

Bootstrap advertises upload availability, exact server limits, the closed extension list and `memory: false`. Without file composition the existing unavailable reason codes remain. The initial profile accepts UTF-8 `.txt`, `.md`, `.markdown`, `.csv`, `.tsv`, at most 64 KiB per file, four files and 128 KiB per message, 32 MiB total, with 24-hour unbound staging. Actual signature, valid UTF-8, NUL, byte count, hash and credential screening precede a ready receipt. Executable/archive/PDF/image/active-HTML signatures are refused. A text file can legitimately contain escaped code; it never executes in preview. Parser support is not inferred from a MIME label or picker filter.

Tool/model/route budgets are independent of byte-custody limits. A file accepted into custody can still encounter a finite work budget or resource/recipient hold. The model must observe all selected bytes before certifying a file-derived result; no selected file is silently omitted.

## HTTP and identities

All paths below start with `/api/s16/client`. The shared client's exact origin, Host, owner-session, CSRF, no-redirect, no-store and bounded JSON rules apply. A byte stream revalidates the live session/CSRF after every awaited read, including EOF. There is no upload bearer URL or exposed host path.

| Method / path | Contract and behavior |
| --- | --- |
| POST `/conversations/:id/uploads` | Exact `{requestId, conversationId, name, bytes, sha256}`; the path/body conversation must match. Returns `s16-file-upload/v1` with an opaque upload ID, HTTP 201. Same owner/request/body recovers that identity; changed metadata conflicts. |
| POST `/uploads/:id/bytes` | `application/octet-stream`, exact declared bytes. One finite 30-second stream into private quarantine. Signature/hash/UTF-8/size and credential screening complete before `ready`. A ready retry returns its receipt; an interrupted or rejected transfer never silently restarts. |
| GET `/uploads/:id` | Current owner-scoped lifecycle, including terminal identity after cancellation, rejection or expiry. No work starts. |
| POST `/uploads/:id/withdraw` | Empty JSON. Cancels staging or withdraws a ready source, aborts its active stream and retires source bytes. Terminal states never revive. |
| POST `/conversations/:id/messages` | File commands use the new exact `s16-conversation/v2`: ordinary command fields, `continuation: null` and nonempty `files: [{id, sha256}]`. V1 still rejects file fields. Text may be empty only with valid file references; this persists receipt/inputs in `accepted` without any model or work. |
| GET `/requests/:id/artifacts/:artifactId` | Current owner plus CHAT publication/producer/source checks, then exact immutable bounded bytes. Only artifacts in a completed request's committed reference set are downloadable. `application/octet-stream`, attachment disposition, nosniff, no-store and `X-Content-SHA256`; no active inline rendering. |

Upload states are `created → uploading → ready` or `rejected/cancelled/expired`; `ready` may become `withdrawn` or unbound `expired`. The `s16-file-receipt/v1` fixes ID, SHA-256, conversation, safe display name, detected text MIME, byte count and staging expiry. Its version identifies this closed UTF-8 validation profile. Committed message inputs lose staging expiry, retaining withdrawal. Quarantine never becomes a model input. Expired unbound reservations are reclaimed on subsequent capacity admission.

## Authority, actual work and memory

Original authenticated owner text alone determines work intent. File text/names never enter the isolated interpreter. A narrow v2-only grammar recognizes an explicit terminal local-file deliverable such as “Summarize these notes and create a downloadable Markdown brief.” Conditions, another mixed mutation and v1 report-only semantics retain their ceilings. The interpreter still proposes purpose/resources/access inside current policy; it cannot install rules or approve anything.

The first file work port exposes only `file_inputs`, `file_read` and, for authorized reversible/effect execution, `file_create`. It opens no VM, app, shell or external-effect tool. The computer resource revision/generation is pinned at upload creation, then intersected with current work scope and TEAM read/write restrictions. Every selected input is a distinct private DATA15 source, stamped before any work-model stream, not only after its first tool read. New recipients therefore need actual current approval for those sources. File selection is not recipient permission.

`file_read` performs a real POLICY reserved/claimed/settled read, returning bounded 4096-byte UTF-8 chunks with exact offsets/hash. The complete actual response hash is retained. A trusted host-only evidence projection records observed source/hash/ranges without duplicating all private text into the cumulative evidence body. Only contiguous complete observed coverage of every selected input permits successful completion.

`file_create` uses the registered `s16_files` action adapter, operation `artifact_create`, class `ordinary_edit`, exact bounded text/name payload, pinned resource and input lineage fences. It writes a real private immutable object and records its bytes/hash/producer. A new default standing-policy proposal includes the adapter; existing installed rules are never expanded. An exact held action follows the existing owner review path. Internal output staging has no external recipients and does not authorize publication elsewhere.

File requests currently neither retrieve nor retain MEM context. Their owner/assistant text is excluded from later interpreter history, and every run gets its own native session. This deliberate first-slice fence prevents file-derived content from surviving withdrawal through an untracked memory/history path. Automatic file memory and artifact-as-input need precise transitive source ancestry before enabling them; they remain product requirements, not a new product restriction. Withdrawal blocks future protected publication and use; it does not promise forensic erasure of protected audit/native evidence or recall already downloaded copies.

## Publication and recovery

Custody lives in protected `files.sqlite` plus `file-bytes/`, with an exclusive journal lock and private canonical directories. Files are opaque generated names, not owner filenames, and reads refuse symlinks, wrong modes, sizes or hashes. Boot converts interrupted uploads into retained rejected identities and removes partial bytes. Graceful close aborts/awaits uploads before closing their authentication and policy dependencies.

Objects stage before CHAT atomically commits result text and artifact references. This is a staged-object protocol, not a distributed transaction: unreferenced candidates remain private and cannot be downloaded or listed as delivered. A commit failure/interrupted work keeps honest held/reconcile-only state; it never reruns a model/effect automatically. Artifact staging is idempotent under the protected action identity, and message replay returns its original receipt/references. Retaining input bytes before a failed CHAT transaction can leave conservative retained custody; it grants no work or publication and remains owner-withdrawable within finite capacity.

An artifact records immutable ID/hash/type/bytes/name, request ID, work ID, timestamp and selected input lineage. Both owner projections and downloads reopen current producer authority and source guards. Withdrawal withholds result, evidence and artifact references. A v2 stop that loses the race to a committed completed result preserves that already delivered result; source withdrawal is a separate explicit operation.

The composition manifest adds exactly `files.sqlite` on explicit enablement. Listed ledgers or byte directories may not be recreated when missing. The first committed v2 command atomically stamps CHAT `user_version=2` in the same writer transaction, with no table conversion. Only an explicitly file-aware store can open it. Older binaries reject format 2 even if an installer restores an earlier composition manifest; they cannot publish retained file-derived text without its source guards. Text-only format 1 stays supported, and a failed file ingress rolls its format stamp back. No S14/legacy store or private data is converted. Rollback after adoption therefore needs a reviewed compatible release/state plan.

## Client and evidence

The Bun-built React client implements the authored neutral rail/conversation/inspector, keyboard entry, pick/paste/drop, independent upload chips, real errors/removal/status recovery, input-only receipt, current result/evidence, exact-review links and verified artifact preview/download. Preview is escaped text. Downloads fetch fresh authorization and verify the complete byte count and SHA-256 before creating a short-lived blob URL. Navigation/generations fence late responses; authentication failure hides protected projections and aborts transfers. Fetch offers no true sent-byte progress, so the chip uses an indeterminate progress indicator instead of inventing a percentage or separate parser event.

The browser surface requires WebCrypto, normally available through HTTPS or localhost (including the documented local SSH-forward installation path). A browser without UUID/hash support receives a specific reload/connection explanation before any client request or work, rather than an empty page or an unverified download. Native transport consumers must provide the standard crypto APIs as part of their platform adapter.

The artifact view is limited to the current bounded conversation window. Search is limited to current navigation labels; organization-wide search/library/revision/edit flows are not claimed. Live steering remains false. Remaining S16 interactions must use real owning-service contracts before enabling their controls.

Deterministic tests exercise actual composed byte upload, POLICY read, output staging, committed byte download/hash, restart, dedupe, malicious input, input-only acceptance, cross-conversation refusal, candidate withholding, new-recipient hold, cancellation and source withdrawal. Opt-in headless Chromium tests execute the actual React bundle at desktop and mobile widths, including escaped preview, download, reload, keyboard focus and withdrawal, with no live model/account/VM/network. This is not live provider, Linux parser isolation, native-device or owner-host evidence.
