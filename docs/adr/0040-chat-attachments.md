---
status: accepted
scope: S13 attachment engineering choices; amends ADR 0037; extends ADRs 0008, 0019, 0025, 0027, 0028, 0036, 0038 and 0039
---

# Chat attachments: untrusted files, sanitized out of process, readable by Jit at every level, guarded on the way out

S13 lets the owner attach images, PDFs and text files in chat, as the Grok bot does. The owner confirmed S13-D01–D10 on 2026-10-29. Until S13 is built, Jit accepts text only:

- the composer is a text form;
- `payload()` caps every body at 16 KiB (`JIT_BODY_BYTES`);
- `app-conversation-v1` banned attachment controls;
- `sources.kind` admits only `topic | message | output | external`;
- Schway's `UserContent` is text only;
- the box takes exactly the mounts in `expectedBoxMounts`;
- backup, export and delete know nothing about files on disk.

This ADR records how S13 is built. The exact names are in [app.attachments/v1](../contracts/app-attachments-v1.md), which tickets #190–#196 implement.

Each choice is labelled. **Confirmed** means an owner decision in S13. **Proposed** means an engineering choice this ADR makes where S13 leaves one open.

## Selected implementation

### Principle

- Every attachment is untrusted data, always (Confirmed, S13 Solution, FR-17).
- File content is never an instruction. It cannot:
  - create a task, role, decision or proposal;
  - change an access level;
  - approve a card;
  - bind a connection;
  - reach configuration.
- The type is decided from the bytes. A display name is never a path.
- The rule "model output and retrieved content cannot grant authority" applies to file content unchanged. A test plants instructions in a file to prove it.

### Feature gate

- `JIT_ATTACHMENTS` is off by default. It can be turned on only after #193 (ATT04, Jit reads attachments) and #195 (ATT06, lifecycle) have merged (Confirmed, S13 Tickets). This way no release can store files that it cannot delete.
- **Proposed:** a code constant `attachmentsReleasable` enforces the gate. While it is false, config load refuses `JIT_ATTACHMENTS=1`. Tests inject configuration, so ATT01–ATT05 can be built with the gate on. The later of ATT04 and ATT06 to merge sets the constant to true.
- **Proposed:** the gate controls ingestion only. While it is off:
  - the upload routes answer 404;
  - `message.send` refuses `attachmentIds`;
  - no composer control renders.
- **Proposed:** attachments that already exist stay viewable, downloadable, readable by Jit, deletable, backed up and restored. Turning the gate off never leaves undeletable files.

### Types (D02)

- **Confirmed (D02):**
  - v1 accepts PNG, JPEG, WebP, PDF and UTF-8 text without NUL.
  - Magic bytes and the extension must agree. `Content-Type` is never trusted.
  - SVG, HTML, archives, Office files (docx/xlsx), executables and HEIC are refused, each with a reason.
  - A display name goes through NFC, loses control and bidi characters, is at most 128 bytes and is never a path.
- **Proposed:**
  - The contract holds the closed extension tables. The text list includes common source-code extensions.
  - Shell, batch and PowerShell scripts count as executables.
  - A file whose second-to-last suffix is itself a known extension, such as `a.pdf.exe`, is refused as `double_extension`.
  - A name without an extension is refused. The script composer names a pasted image from its sniffed type.

### Limits and host scaling (D09)

- **Confirmed (D09):** the defaults are 10 MB per file, 5 files per message and 500 MB per project. A reserve of 2 GB of free disk is kept, and staged files expire after 24 hours. The machine may adjust every value (S12-D13).
- **Proposed:** every limit is an env setting, and the defaults scale with the detected host instead of Pi constants:
  - The project quota is `min(500 MiB, max(50 MiB, 5% of the data filesystem))`, so only a very small disk lowers it.
  - The free-disk reserve stays 2 GiB, because it protects the host whatever its size.
  - Sanitizer memory is `min(512 MiB, max(256 MiB, RAM / 16))`. The pixel cap shrinks with it: 40 MP at 512 MiB.
  - The per-file cap may be set up to 16 MiB. That is the runner's single-write cap, so every accepted file can be copied into a box.
- **Proposed:** the quota counts original bytes only. Each `sha256` is counted once per project. Derivatives are bounded by the sanitizer caps, and the disk reserve covers them.

### Upload (D01)

- **Confirmed (D01):**
  - A separate route, `POST /projects/:p/topics/:t/attachments`, keeps the session, CSRF and Origin rules. It streams to a temporary file, hashes with SHA-256 while streaming and stops at the cap.
  - Every other route keeps the 16 KiB cap.
  - The no-script composer posts multipart (text plus files) to `POST .../attachments?send=1`. That route uses the same streaming path and then creates the message. It never goes through `payload()`.
- **Proposed:** the script path uploads one file per request as `application/octet-stream`, with `X-CSRF-Token` and a percent-encoded `X-Jit-File-Name`. Session, Origin, CSRF, the gate, scope and the disk reserve are all checked before any body byte is read. Each file gets its own progress chip.
- **Proposed:** Bun's `maxRequestBodySize` applies to the whole server, not to one route. While the gate is on, `serveFullApp` raises that transport ceiling to the multipart ceiling (`messageFiles × fileBytes + 64 KiB`). Route caps stay where they are enforced today: in the streaming readers. `payload()` keeps `config.bodyBytes` for every non-attachment route, the same way webhook bodies already exceed the owner-form cap without widening it.
- **Proposed:** on `?send=1`, the parts must arrive in a fixed order, with `csrf` first. CSRF is verified before any file part is read. A `requestId` that already has a committed message returns its redirect without reading any file, so a resubmitted form cannot conflict.
- **Proposed:** an image or PDF may be bound to a message while it is still `pending`, because the no-script path cannot wait for the sanitizer. The reply job then waits at admission as `attachments_pending`, the same gate as `box_capacity`, until every inlined file is `ready` or `rejected`. A rejected file is named, with its reason, to the model and the owner.

### Storage (D03)

- **Confirmed (D03):**
  - Files live at `<data>/attachments/<projectId>/<sha[0:2]>/<sha>`, with directories 0700 and files 0600, outside the database and the web root.
  - Dedupe happens inside one project only.
  - The `attachments` and `attachment_events` tables never hold file content. They record upload, reject, sanitize, sends to a model with the route, box copy, download and delete.
- **Proposed:**
  - `<data>` is `dirname(databasePath)`, beside `local-api/` and `webhooks/`.
  - Derivatives (a re-encoded image, a ≤ 2048 px model image, extracted text) are stored with the same layout, keyed by their own hash.
  - Events hold no display name and no hash. Deletion nulls a row's name and hashes and keeps a tombstone.
  - A blob is unlinked only inside a transaction that sees no live reference, and never while a backup is being written.
  - An uploader keeps its staging file until its row commits and the final path is verified.
  - A sweep removes unreferenced files.
- **Proposed:** an attachment becomes a source of the new kind `attachment` when it is bound to a message. Its source id is its attachment id, and `content_text` is NULL: the content stays in the file store. The source form is `attachment:<id>@<revision>`. Every existing lineage, deletion-ledger and restore-replay path then applies to attachments without a parallel mechanism (extends ADRs 0008 and 0019).

### Sanitizing out of process (D04)

- **Confirmed (D04):**
  - Each sanitize is a short job in a container with the box hardening and `--network none`, limited to about 512 MB and 30 s, one job at a time.
  - Images are re-encoded to PNG/JPEG, which strips EXIF/GPS and defeats polyglots. The cap is about 40 MP, and a ≤ 2048 px copy is made for the model.
  - PDFs go through `pdftotext`, with about 50 pages and 2 MB of text at most. A PDF is never rendered or opened in the page.
  - A host without a container runtime still accepts text and PNG/JPEG, with metadata stripped in TypeScript but no re-encode. Those images get no preview and are download-only, and the UI says why. PDF is disabled with a reason.
- **Proposed:**
  - The sanitizer runs the digest-pinned `base` box image (ADR 0036), which gains `poppler-utils`, `python3-pil` and `/opt/jit/sanitize`. It is available when the box runtime is reachable and `JIT_BOX_IMAGE_BASE` is set.
  - The job mounts only a per-job input directory (read-only) and a private `/out` tmpfs. It runs as the box user with a read-only root.
  - **ATT02 fix-round engineering decision:** `/out` has a total cap of 32 MiB + 64 KiB for images or 2 MiB + 64 KiB for PDF, and `nr_inodes=4` or `3` respectively (root plus at most three/two files). The worker reserves that same byte budget before starting; the cgroup memory/swap ceiling adds the full tmpfs cap to the configured parser memory. No parser output is bound to service disk. The script sends length-prefixed, bounded file records through stdout before exiting; Jit checks names, count and per-file/total sizes and writes exclusive 0600 host files only after container removal is proven. No archive extraction or parser-supplied path is accepted. The changed transport requires base-image label `jit.sanitize.version=2`; old images fail capability checks.
  - **ATT02 fix-round engineering decision:** thrown/rejected cleanup commands and non-zero cleanup results become `sanitizer_cleanup_failed`. Keep work and its reservation quarantined, block fallback/retry while runtime is unavailable, and release only after a successful reset. UTF-8 extraction is strict; only an incomplete trailing sequence at the byte cut may be discarded.
  - Jit validates every output (size, magic bytes, UTF-8) before storing it.
  - The worker is driven by `pending` rows, so it survives a restart without a job-queue row. A file that fails twice is `rejected`, and its original is removed.
  - WebP and PDF are refused at upload when no sanitizer is available, so they never become `pending`.
- **Proposed:** a fallback image is never previewed, never sent to a model and never copied into a box. Upload sniffing, UTF-8/NUL validation and the fallback strip are the only reads of file bytes inside the service process. `sharp` and other in-process decoders are not used.

### Safe serving (D05)

- **Confirmed (D05):**
  - `preview` and `download` need the owner session and send `Cache-Control: private, no-store`, `nosniff` and CORP `same-origin`.
  - Only re-encoded images get a preview, with CSP `default-src 'none'; sandbox`.
  - Everything else is served with `Content-Disposition: attachment`.
- **Proposed:**
  - Downloads are always `application/octet-stream`, with an ASCII `filename` and an RFC 5987 `filename*`.
  - A download serves the sanitized file when one exists (the re-encoded or stripped image), otherwise the original (PDF, text).
  - Downloads are audited. Previews are not, because thumbnails load on every page view.
  - The page CSP (ADR 0028, `img-src 'self'`) already allows same-origin thumbnails.

### How Jit reads attachments (D06), and the Read-level amendment

- **Confirmed (D06):**
  - Text, and text extracted from a PDF, enter the run as untrusted sources (`attachment:<id>@rev`), framed like `frameMcpResult` and capped at about 32 KiB.
  - The rest is read with `read_attachment({ id, offset?, maxBytes? })`: a read of Jit's own data within the project, fenced and audited.
  - The owner allowed `read_attachment` at the **Read** level, because it touches neither the host nor the network.
- **Amendment to ADR 0037 and `exec.run_tools/v1`:**
  - The `read` level still opens no box and admits no execution tool.
  - A run that carries attachments may additionally be offered one **Jit service tool**, `read_attachment`, at every level including `read`.
  - `read_attachment` reads only the run's own attachments from the attachment store. It never touches a box, the network or any other part of the host filesystem.
  - Its fence (`serviceToolCurrent`) checks the job authority generation, the owner generation, the admitted job, the active context and that the project is not halted. A halt or the kill switch therefore refuses it. Every call writes an audit row, refused calls included.
  - ADR 0037 carries a dated note.
- **Proposed:** the run request carries **references** (`RunAttachmentRef`), never content. The framed text is read from the store when the attempt starts, and each attachment is re-checked as live. The current code requires this:
  - `jobData(request, config.team.contextBytes)` bounds a whole run request at 32 KiB by default, so an inline 32 KiB frame cannot be persisted in it.
  - Without persisted content, deleting a file needs no scrubbing of job records for file text.
  - A file deleted between admission and attempt start is never used (with #186).
- **Proposed:**
  - A Jit reply carries the live attachments of the messages in its history window. Only the newest owner message's attachments are inlined. The inline total per run is 64 KiB.
  - `read_attachment` accepts only ids the run carries: project scope, narrowed further to the run.
  - Without a grant, a run that offers it may take up to 8 turns within its call budget.
  - **ATT04 fix-round engineering decision:** freeze each attachment attempt's context ceiling to at most the job ceiling divided by its initial attempt count, further capped by the remaining context. Reserve inline text once and at most one 64 KiB continuation per remaining read turn. Reduce attachment-only model turns and the service tool's call allowance to fit that share; web/box tools retain their existing turn budgets. Runs without attachments keep their existing accounting. A provider wait spends its reservation but leaves a share for each authorized owner resume.
  - `ApplicationRunRequest.tools` stays empty, as the scripted port requires.

### Outbound channels and the exfiltration guard (D07)

- **Confirmed (D07):** while a run carries attachment content, outgoing queries and URLs are checked for long verbatim spans of the file (≥ 24 contiguous characters). A match blocks the call and asks the owner once. Disabling the web for any run with an attachment was rejected, because it breaks "just works".
- **Proposed mechanism:**
  - One shared guard module, `src/security/outbound-guard.ts`. #173 adds private-context entries (memory, owner messages) to the same corpus.
  - Both sides are normalized: NFC, case folding, collapsed whitespace, no format characters, and URLs percent-decoded.
  - **ATT04 fix-round engineering decision:** cap candidate verification at 65,536 code-point comparisons per outgoing value, shared across normal and form-value interpretations. Exhaustion returns a conservative hold with `reason: verification_budget_exhausted` and a potential outgoing span, rather than claiming a confirmed source match or allowing the call. Every guarded channel uses the same owner-only release or existing marked-card path. Directly confirmed matches still require at least 24 normalized code points.
  - The corpus is the full text of every attachment the run carries. A granted run's corpus also includes every attachment with a copy in the box, because a later run can `cat` an old copy.
  - "Ask once" means the first refused call of a run creates one `outbound_release` approval card, and later matches in that run are refused without a new card. If the call would already create a card (a non-read-only MCP tool, a browser or computer confirm action, an effect tool), that card is marked as containing file text instead.
  - The card is Web-only, never auto-approved and single-use. Approving it makes the effect executor perform exactly that one call and post the result to the topic as untrusted data (ADR 0037 cards do not block a run).
- **Outbound channels.** "Guarded" means the guard checks the channel. "Owner-gated" means an approval card shows the exact content first. "Residual" means a risk this design does not close, stated plainly:

| Channel | Where | Treatment |
| --- | --- | --- |
| The model provider receiving attachment text or images | every run that carries attachments | **Intended**, not guarded. Every send writes a `send_model` event with its route. The composer says "files are sent to the model provider". Copies held by the provider cannot be deleted (existing residual `provider_session_copies_not_exported`). |
| `web_search` query, `web_fetch` URL | wherever #173 offers web tools | **Guarded** (D07). SearXNG forwards queries to outside engines, so the query is the outbound content. |
| `browser_open` URL, `browser_type` text | Workspace, Full (ADR 0039) | **Guarded** (D07). |
| MCP tool argument values | Workspace, Full (ADR 0038) | **Guarded** (D07). Non-read-only tools already ask through an `mcp_tool` card, and that card is marked. |
| `computer_type` text | Full (ADR 0039) | **Guarded** (proposed addition to the S13 list, because typing into a page can submit text). |
| Effect tools: GitHub comment or PR text, git push, deploy | Full (ADR 0037) | **Owner-gated.** The card shows the exact action and is marked when its text contains a span. A pushed commit can carry a box copy: Jit writes `/workspace/.jit/.gitignore` containing `*`, but a forced `git add` still works (residual). |
| `bash`/`curl` in the box through the registry proxy | **Workspace** | **Residual.** The box holds attachment copies (#194). `startRegistryProxy` checks only the host and port 443 of an allowlisted registry, then tunnels bytes without reading them. File content can leave in a URL path, a query or a request body sent to a registry. An MCP server running in the box can do the same. The UI shows a notice at Workspace. |
| `bash`/`curl` in the box | **Full** | **Residual.** The box has full network and holds attachment copies (#194), so any process can send them anywhere. The UI shows a notice at Full. |
| Encoded, split or paraphrased content (base64, translation, summary, chunks under 24 characters) | every guarded channel | **Residual.** A verbatim check cannot catch it. |
| Text the model reads from an image | ATT07 routes | **Residual.** Images add nothing to the corpus (no OCR in v1). |
| Jit replies that quote a file, delivered to the owner's Telegram chat | Telegram | Existing residual `telegram_delivery_copies_not_exported_or_deleted`. Deleting the attachment cannot recall them. |
| The sanitizer container | sanitize jobs | Closed: `--network none`. |
| Logs, audit rows and exports | local | Closed: never file content. Exports are metadata only (D08). |

### Box copies (S13 Required behavior)

- **Confirmed (S13):** at Workspace or Full, sanitized copies go to `/workspace/.jit/attachments/<id>-<safe>` through the runner, with no new mount.
- **Proposed:**
  - What is copied: the re-encoded image, the extracted PDF text or the text file. Never an original or a fallback image.
  - The copy is made when a granted run's tools open, through `writeFileAtomically` (runner `write`, 16 MiB cap).
  - Copies are tracked in `attachment_box_copies`.
  - The runner has no delete operation. Removal therefore runs `rm` through the runner when the box is running. When the box is stopped, Jit removes the copy host-side while the box manager holds the project, after checking that no path component is a symlink.
  - Every box open also removes copies that no live attachment owns.
  - A copy a process made elsewhere in the workspace is not tracked (residual).

### Images to models (D10)

- **Confirmed (D10):**
  - Only re-encoded PNG/JPEG images are sent as `input_image` (xAI accepts only jpg/png), and only on routes that passed a live probe.
  - Images from a host without a container runtime are never sent.
  - On other routes, Jit says plainly "this route can't see images yet" and never guesses an image's content.
  - This waits for Schway image content ([schway#436](https://github.com/chayapats/schway/issues/436)).
- **Proposed:** only the ≤ 2048 px model derivative is sent, and each image is audited with its route. ATT07 does not ship until schway#436 either purges image bytes from native sessions and snapshots, or never persists them. Deleting an attachment must reach every copy Jit can reach.

### Lifecycle: delete, forget, staged files

- **Confirmed (S13 Required behavior):**
  - Forgetting or deleting a message, topic or project deletes its files too, with a reference count per project, through the existing preview → confirm.
  - A file deleted between admission and attempt start is never used.
- **Proposed:**
  - An attachment source is itself a deletion scope. A message, topic or project scope reaches the attachments bound in it.
  - The preview shows the file count and bytes. Confirmation records the attachment sources in the deletion ledger, fences runs that cite them and removes blobs, derivatives and box copies.
  - The operation is `complete` only when none of the scope's files is left on disk.
  - A forget that reaches an attachment source deletes its files, although a forget keeps message text. Bytes have no "raw history" value worth keeping against the owner's request.
  - Staged files that were never sent are deleted after the staged lifetime. They have no source, so they are not in the ledger.

### Backup, export and restore (D08)

- **Confirmed (D08):**
  - Backups include attachments as a bounded artifact. Exports hold metadata only by default.
  - Restore replay never brings back a deleted file.
  - When a backup's attachments exceed the bound, the backup **fails with a clear reason**. Files are never dropped silently.
- **Proposed:**
  - The existing 64 MiB ceiling (`backupRetention.maxBytes`) bounds the application image plus native snapshots, and it stays.
  - Attachments get their own bound, `JIT_BACKUP_ATTACHMENT_BYTES`, by default `min(2 GiB, max(256 MiB, 10% of the backup filesystem))`. Exceeding it fails creation with `backup_attachments_too_large` before anything is written, and the error names the bytes and the bound.
  - A missing or corrupt blob makes the manifest `incomplete`, which cannot be restored.
  - Blobs go into a content-addressed store shared by all retained backups (`<backupDir>/attachments/`), with a per-backup index file. Up to 10 retained backups then do not copy the same photo 10 times. Retention prunes the oldest backups until the union of retained attachment blobs fits the bound.
  - Listing a backup checks sizes. Restore preparation hashes every blob.
- **Proposed:** in v1 an export always holds metadata only; there is no option to include files. A file's name is included only with `includeHistory`, because it is owner-typed text.
- **Proposed restore:**
  - Ledger replay marks attachments whose source was deleted or suppressed as deleted.
  - Unbound staged attachments are dropped, because a draft never survives a restore.
  - Only the blobs of surviving rows are written into the live store, before activation. The store is content-addressed, so this is safe while the old database is live.
  - After activation, the sweep removes blobs the new database does not reference.
- **Proposed:** the composer and the Backups page show a notice when the installation's attachment bytes pass 80% of the backup bound, before a backup fails.

## Alternatives and consequences

- **Rejected:**
  - Raising `JIT_BODY_BYTES` or parsing multipart in `payload()`: it would widen the cap for every owner route.
  - Decoding images in the service process (`sharp`), or parsing PDFs there: it would put a large attack surface beside the database and credentials.
  - A new box mount for attachments: `box_mount_mismatch` would refuse it, and the two-mount rule is a deliberate invariant.
  - Disabling the web for any run with a file (D07 alternative): it breaks "just works".
  - Leaving attachments out of backups (D08 alternative): restore would lose them, and the owner chose inclusion.
- **Rejected:** persisting inline text in the run request. It does not fit the request bound, and every deletion would have to scrub job records for file text.
- **Consequence:** the guard is verbatim only. It raises the cost of careless leaks, and model mistakes are the common case. It does not stop a determined model, nor any process at Workspace or Full. Those residuals are stated in the table and in the UI.
- **Consequence:** a planted instruction can still make the model *ask* the owner to release text through an `outbound_release` card. The card shows the exact text and the matched span, and only the owner can approve it.
- **Consequence:** upgrades create their recovery point through the same staged backup (`stageManagedBackup`). An installation whose attachments exceed the backup bound cannot upgrade until the owner deletes files or an operator raises the bound. The upgrade error names the reason. The 80% notice exists so this does not arrive as a surprise.
- **Consequence:** the `sources` CHECK change needs a table rebuild in ATT01's migration. The new tables must be classified in `backupImageTables` in the same migration, or every backup fails as `backup_schema_unclassified`.

## Open questions

1. **Default of `JIT_ATTACHMENTS` once releasable.** S13 says off by default and allowed on after ATT04 and ATT06. "Just works" argues for on.
   - Recommendation: the PR that sets `attachmentsReleasable` keeps the default off. The owner flips the default in a one-line follow-up after one live check on a reference host.
2. **Upgrade recovery points versus the attachment bound** (see Consequences). This ADR keeps them fail-closed.
   - The alternative is an explicitly recorded exclusion for upgrade recovery points only, which is not silent. Restoring such a point would then need the live blobs to still exist.
   - Recommendation: keep fail-closed, and revisit with measured attachment volumes from real installs.
