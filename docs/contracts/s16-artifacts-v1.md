# S16 artifact library and revisions v1

ART16-01 [#407](https://github.com/chayapats/jit/issues/407) extends [file custody](s16-files-v1.md), [binary inputs](s16-binary-files-v1.md), [sourced file memory](s16-file-memory-v1.md) and [ADR 0082](../adr/0082-s16-artifact-library-and-revisions.md). It delivers a durable cross-conversation artifact library with provenance, immutable revisions and an isolated HTML viewer. Organization-wide cross-object search, labels/spaces and Bot-scoped library filters remain SPACE16-01 [#428](https://github.com/chayapats/jit/issues/428). File-to-VM collection remains FILE16-01C [#433](https://github.com/chayapats/jit/issues/433).

## Selection and capability

The library exists wherever the explicit file composition does (`files: true` or the binary configuration object in `s15-runtime/v1`). It adds no store, migration, installed rule or default. The first adopted input stamps the file journal format 3 (monotonic; formats 1/2 remain readable). Releases that only accept 1/2 refuse to open it rather than ignore parent links. The capability projection adds three optional fields to `artifacts`:

```ts
{ available: true; preview: "escaped_text"; library?: "s16-client-artifacts/v1"; revisions?: boolean; html?: "sandboxed_static" }
```

The capability revision is unchanged. Older services omit them; the client then keeps conversation cards only.

## What the library lists

An artifact is listed, shown, previewed, downloaded or adopted only when all of these hold on that read:

1. FileStore holds the staged immutable record for the current owner identity and generation.
2. Every transitive input source is a ready, current upload with its exact hash (see Lineage).
3. CHAT's root request is `completed`, has a non-null result, has the artifact's exact work ID, root request ID and conversation, and its committed reference set contains this exact ID and SHA-256.
4. CHAT's publication guard (`policy.guard(work, "publication")`, file guard and memory guard) passes.

Staging is not publication. A candidate whose request failed, stopped or is still running is never listed. The index is recomputed on every request. Nothing is cached between pages.

## HTTP

All paths start with `/api/s16/client`. The shared client's exact origin, Host, owner-session, CSRF, no-redirect, no-store and bounded JSON rules apply.

| Method / path | Contract and behavior |
| --- | --- |
| GET `/artifacts?q&type&conversation&before` | `s16-client-artifacts/v1`: at most 50 current items, newest first (`createdAt`, then ID). `q` is a case-insensitive name substring (≤128 characters, no control characters). `type` ∈ `all, text, markdown, csv, html`. `conversation` is an exact ID. `before` is the opaque `createdAt.id` position of the previous page's last item. Filters run before the position, and `next` is non-null only when more current items exist. Unknown or repeated keys return HTTP 400; a malformed position returns 409. |
| GET `/artifacts/:id` | `s16-client-artifact/v1`: the current item, the producing request's exact inputs (`id, name, mime, bytes, sha256, origin`) and the committed revision family, oldest first. The family is bounded to 256 members: the viewed file, all its ancestors, then the newest others. `familyTotal` counts the whole current family. `preview` is `sandboxed_html` for `text/html`, otherwise `escaped_text`. An unlisted artifact returns 409 `artifact_unavailable`. |
| POST `/artifacts/:id/inputs` | Exact `{requestId, conversationId, sha256}`. The artifact must be currently listed, `conversationId` must be its own conversation (else 403), and `sha256` must equal its current hash (else 409). Returns 201 with a ready `s16-file-upload/v1` whose receipt is `s16-file-receipt/v1` over the exact artifact bytes. The same owner, request ID and body return the original input. A changed payload conflicts. Nothing starts work. |
| GET `/requests/:rid/artifacts/:aid/preview` | HTML artifacts only (else 409 `preview_unavailable`). Allowed only for `Sec-Fetch-Dest: iframe`, `Sec-Fetch-Site: same-origin` and `Sec-Fetch-Mode: navigate`; any other context returns 403 `preview_context_rejected`. Same guards as the download. The response is `text/html; charset=utf-8` with the CSP below, nosniff, no-store, `Cross-Origin-Resource-Policy: same-origin`, a restrictive `Permissions-Policy` and `X-Content-SHA256`. |

The existing download route is unchanged. It always returns `application/octet-stream` as an attachment, including for HTML.

Item shape (`s16-client-artifacts/v1` and detail): `{ artifact: FileArtifact, conversationId, label, revision, parent, inputs }`. `label` is the producing owner message as plain text, at most 120 characters. `revision` is 1 + the maximum parent revision. `parent` is the first parent artifact ID or null. `inputs` is the input count. No field is authority.

## Lineage and revisions

`adoptArtifact` copies the exact committed bytes into a new private upload record in the artifact's own conversation. The record carries `origin: { contract: "s16-artifact-input/v1", artifact: {id, sha256} }` and the resource generation pinned by its parent's original input. Restricting adoption to the artifact's conversation keeps the producing Bot's conversation and private scope. Cross-conversation reuse needs SPACE16/TEAM scope rules first. Chains are limited to 32 levels (`revision_limit`), and one input set to 128 transitive sources (`lineage_limit`).

An adopted input is usable only while its parent artifact exists with the same hash, owner and conversation, and every input of that parent is itself usable, recursively. This is metadata-only, and each upload is evaluated once per check, so a history where several copies share ancestors stays linear. A withdrawn ancestor makes the adopted input project as `withdrawn` with code `lineage_withdrawn` without a second write, and refuses `read`, `source().active`, `pinsCurrent` and message admission.

When work uses an adopted input:
- `guard` stamps every transitive ancestor upload as a DATA15 source of the work before any model stream. Recipient checks and withdrawal therefore see the complete original private ancestry, not only the copy.
- Every POLICY read/action and image reservation fences the complete lineage set.
- MEM file pins include every transitive ancestor.

A new artifact staged from adopted inputs records `parents`: the distinct origin artifacts of its inputs. Artifacts staged before this change have no `parents` and count as revision 1. A revision is always a new object with a new ID and hash. The original record and bytes are never modified.

## Revision request grammar

The explicit English/Thai terminal file deliverable grammar additionally accepts the adjectives `revised`/`updated`, the type `html`, the noun `page` and the Thai qualifiers `ฉบับแก้ไข`/`ฉบับปรับปรุง`. Conditional, negated, quoted and mixed-mutation wording keep their holds, and only v2 file commands use the grammar. The client's editable templates (`s16.artifact.reviseStart` + owner changes + `s16.artifact.reviseEnd`) are tested to be explicit terminal deliverables in both languages.

## HTML artifacts and the viewer

`file_create` accepts `.html`/`.htm` as `text/html`: valid UTF-8, no NUL, no credential, a single extension and no other format's signature. HTML is inert data. It is downloaded as an attachment or rendered by the viewer:

```
sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'
```

The client embeds it only in `<iframe sandbox="">` after a fresh verified byte/hash read. That read repeats every four seconds. A failure closes the viewer. The token-free sandbox gives an opaque origin, so the document has no service cookies, no parent DOM, no scripts, forms, popups, top navigation or downloads, and automatic refresh is off. The `/s16` page adds `frame-src 'self'`. Link navigation inside the frame to any other origin is therefore refused by the embedding page. Same-origin targets are protected JSON/pages with `frame-ancestors 'none'`. Interactive (script-enabled) output needs a separately reviewed execution capability.

## Client

`JitClient.artifacts`, `artifact`, `artifactInput` and `artifactPreviewUrl` strictly validate responses and never retry. `artifactInput` may be resent with the same command after an unknown outcome. The React client adds `/s16/artifacts[/<id>]`, described in the [design record](../design/S16-artifact-library.md).

## Evidence

`tests/s16-artifacts.test.ts` uses the production composition with scripted models. It covers:
- uncommitted candidates withheld from the library
- a revision after restart with distinct, re-verified bytes and hashes, including after a further restart
- exact parent bytes read through the guarded file tool
- revision numbering and family navigation
- query and cursor validation
- idempotent, exact, conversation-confined adoption that starts no work
- boundary refusals for CSRF, Origin, authentication, extra keys and changed hash
- withdrawal of an ancestor blocking search, detail, download, adoption, stale cursors, adopted inputs, message admission and snapshots, including after restart
- withdrawal between acceptance and work blocking the revision before any model stream
- HTML viewer headers and request-context refusals
- the format-3 rollback fence refusing an older reader
- the revision grammar, including the real dictionary templates

`tests/s16-artifacts.browser.test.ts` is opt-in (`JIT_S16_BROWSER_TESTS=1`) and runs the real bundle in Chrome.
- At 1440 px English and 390 px Thai: library search, empty search, provenance, keyboard Escape focus return, explicit Revise with an editable template and no model call, sending the revision, revision history navigation, deep-link reload, withdrawal emptying the library and closing the preview, no horizontal overflow, no page errors and no external requests.
- A real loopback server checks that Chrome sends the iframe/same-origin/navigate context. The HTML document renders its inline style. Its scripts never run, cookie and parent access are denied, the origin is `null`, and parent messages are none. Image, style, refresh, nested-frame, link, `_top`, `_blank` and form attempts make no external request. Loosening the page's `frame-src` makes this test fail.

This is not live provider, Linux, native-device or owner-host evidence.
