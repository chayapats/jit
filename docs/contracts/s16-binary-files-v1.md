# S16 isolated binary files v1

FILE16-01B [#401](https://github.com/chayapats/jit/issues/401) extends [the text contract](s16-files-v1.md), [ADR 0077](../adr/0077-s16-isolated-binary-input-and-model-images.md) and the [authored file workflow](../design/S16-rakazo-experience.md). It uses the same authenticated upload, message and artifact routes. Existing v1 text receipts/commands and S14/legacy defaults retain their meanings. Full S16 parity, global artifact revisions and file-derived memory are not established by this slice.

## Explicit selection and actual capability

`files: true` in an explicit `s15-runtime/v1` configuration retains the text-only profile. An owner-controlled object `{ parserImage, imageProbes }` opts into strict binary processing. `parserImage` must be a digest-pinned image built from parser generation 3 in `ops/box/Containerfile`. Jit never pulls/builds it at ingress. DATA15 remains mandatory. `imageProbes: []` permits PDF text, without image-model support. Passing exact route/model records must be independently established for the installed account at `SCHWAY_PINNED_REVISION`; fixture and duplicate records are refused by installed configuration validation. Neither enabling files nor accepting a receipt expands installed standing rules or recipient permissions.

Bootstrap probes real parser availability, then reauthenticates. It advertises extension/MIME/byte pairs in `uploads.formats`, the independent `textBytes` bound, PDF/image limits and an unavailable reason when the parser or exact model-image route cannot be used. A configured but unavailable parser still permits bounded text input. Binary metadata creation independently checks current parser and image-route capability. Byte validation and every model release repeat the owning guards. Capability advertisement is not an authority grant or availability lease. HTML/assets use the protected `session` read rather than repeatedly probing a parser.

| Bound | Strict S16 profile |
| --- | --- |
| Original | 1 MiB, or a narrower configured custody limit |
| Text input / PDF-derived UTF-8 | 64 KiB each; complete nonempty extraction only |
| PDF | At most 50 pages; no encryption, including empty-password encryption |
| Source image | PNG/JPEG; 4,194,304 decoded pixels; either dimension at most 16,384 |
| Model image | Re-encoded PNG/JPEG; either dimension at most 2,048; at most 1 MiB |
| Clean intermediate | At most 1 MiB; never rendered or sent as the model image |
| Message / custody defaults | Four originals, 4 MiB per message, 64 MiB total original/derived/artifact custody |
| Queue | Four total active/queued jobs per file installation, serialized |
| Time | At most 60 seconds upload/validation admission lifetime; parser process 30 seconds; finite readiness/cleanup controls |
| Parser resources | 256 MiB decode memory plus the runtime's capped output tmpfs allowance; separate 32 MiB `/tmp`, 1 MiB `/run`; one CPU; 64 pids; no swap expansion |

The reusable runtime's output stream independently caps metadata (2 KiB), PDF output (2 MiB), and each image intermediate (16 MiB), and its tmpfs is finite. S16 applies the narrower bounds above before receipt publication. No hidden truncation is accepted. Page/pixel/output/time/custody rejection, resource holds and model-call budgets are distinct. No OCR, WebP, GIF, archive, executable, Office or active-document input is advertised. A PDF without extractable text is refused.

## Lifecycle and immutable receipt

`created → uploading → validating → ready` is the successful binary lifecycle. The `validating` state is journal-backed and queryable while the byte POST waits. Rejection/cancellation/expiry/withdrawal retain the opaque upload identity. Client retries recover that identity first, without automatically resending bytes or fabricating resumability. Only a ready receipt enters a message. Cancellation aborts the owning stream/job, suppresses late publication and retires original/derivative bytes when safe. An uncertain parser cleanup retains its separate private snapshot until a conclusive reset. Boot marks interrupted uploads rejected and reconciles orphan parser custody before exposing the service. It never replays work or adopts partial parser output.

Binary receipt `s16-file-receipt/v2` retains original `id`, `sha256`, `conversationId`, display `name`, original `mime`, `bytes` and `expiresAt`. It adds `validation: "s16-isolated-file/v1"`, immutable `parserGeneration` (the pinned image in production), and `representation`:

- `sha256`, `bytes`, `mime`: exact validated model representation, separate from the original hash.
- `pages`: complete extracted PDF page count, otherwise null.
- `width`, `height`, `originalWidth`, `originalHeight`: actual model/original image dimensions, otherwise null.

The parser emits the matching validation version and, for PDF, `encrypted: false`. The host independently validates named private regular non-link outputs, actual metadata/byte limits, UTF-8/credential screening for text, dimensions and model descriptor/hash. Unknown paths, extra files, invalid signatures, malformed/incomplete/encrypted output and missing strict runtime fail closed. No raw binary decoder, service environment or general-purpose subprocess runs in the protected service. Only test-owned, known fixtures can use the controlled local parser adapter.

The file journal stamps `user_version=2` atomically at first binary upload creation. First accepted binary-bearing CHAT ingress stamps CHAT `user_version=3`; later text ingress cannot downgrade it. Old text-only journal readers and old file-aware CHAT readers refuse these formats, including after manifest rollback. New explicitly file-aware readers retain text compatibility. Missing binary history/parser custody cannot be silently recreated or enabled as a text store.

## Actual model input and publication

Every original remains a separate private DATA15 source on its pinned resource. Entire selected-set ancestry is registered before any model stream. PDF `file_read` returns actual extracted UTF-8 chunks; complete contiguous derived-text coverage is required, while its evidence still binds the original source. Image `file_read` cannot stand in for image processing. Public Schway `createImageContent`, `HostInput.images`, `HostOptions.images.probes/resolve` supply actual re-encoded pixels. The resolver freshly verifies the selected original/representation and every source/resource fence on each model attempt/tool round.

MODEL15 keeps image references in native context and input hashes; `imageData` remains an ephemeral hash-keyed byte map. It is excluded from durable model records and disclosure metadata. Supported provider adapters perform wire encoding. The existing final physical-send authorizer invokes the caller's image guard for initial sends and supported auth resends. That guard rechecks owner generation, running work, TEAM/resource ceilings, all selected original/derived hashes, active sources and current recipient approval; it verifies the exact outgoing map and performs real reserved/settled/published POLICY reads. One image's refusal fences the send, never silently drops that image.

Host-created `kind: "input"`, `tool: "image_input"` evidence records original file ID, derived hash/size/dimensions and `status: "admitted_for_model_send"`. It is distinct from actual tool invocation evidence and from proof of provider receipt/semantic understanding. Successful MODEL15 completion plus matching input evidence and current guards are required before CHAT can commit an answer/artifact. Failed/refused/reconcile-only model attempts cannot publish a file result. Image bytes/base64 never enter ordinary durable model/native/disclosure records; protected original/derived byte custody remains explicit. Withdrawal blocks all future source use, result/evidence projection, artifact preview/download, including after restart. Previously downloaded copies cannot be recalled.

Immutable text artifacts keep the first slice's exact `s16_files/artifact_create` POLICY action, source ancestry, staged-candidate versus committed-reference distinction and freshly guarded hash-verified attachment download. File work still neither retrieves nor retains MEM content and is excluded from later interpreter history. Removing this fence requires #402, including transitive withdrawal/forget/recipient checks.

## Evidence and remaining live proof

`tests/s16-file-parser.test.ts` covers protocol bounds, complete extraction, invalid outputs, serialized cancellation, cleanup uncertainty and restart reconciliation. `tests/s16-binary-composed.test.ts` uses actual repository image re-encoding and actual PDF/empty-password encrypted PDF parsing in an explicitly controlled fixture adapter, then production composition, guarded model input, immutable download, withdrawal, substitution, recipient and restart checks. `tests/s16-model-images.test.ts` sends actual image bytes through public Codex/Grok adapters to controlled transports, verifies wire data URIs and repeated final guards on Grok auth retry, and checks that bytes/base64 are absent from native/model persistence. `tests/s16-files.browser.test.ts` opt-in Chromium runs actual desktop/mobile React validation/details/result flows in both locales.

These tests do not establish installed Linux isolation or live vision. On a separately authorized disposable rootless Linux host with the rebuilt digest-pinned generation-3 image, run `JIT_LIVE_S16_FILES=1 JIT_LIVE_BOX_IMAGE=<digest-pin> bun test tests/s16-binary.live.test.ts`; record exact image digest, host/cgroup controls, test head and outcome in ignored installation evidence. No automatic image build/pull or owner-host activation occurs. Independently authorize an actual PNG/JPEG challenge through the existing supported image-probe seam for the selected account/model and record only its credential-free result. Fixture records must never be promoted into that evidence. Live parser/account and full #396/S16 acceptance remain pending until those independent observations exist.
