# s16-owner-export/v1

Status: implemented ordinary projection under
[ADR 0114](../adr/0114-s16-current-owner-content-export.md). This does not complete
OPS16-01 or protected [recovery custody](s16-recovery-point-v1.md).

The existing same-origin authenticated owner/client service owns each download.
Cookie/CSRF/Origin/Host checks and current owner generation remain mandatory.
An operator CLI, archive, model/tool or exported ID cannot grant access. Export
is a fresh read, not work admission, policy installation, approval, restore or a
persisted cached artifact. Explicit retries reacquire current state.

## Capability and request

`s16-client-capabilities/v1` optionally advertises `dataExport` with
`available: true`, `contract: "s16-owner-export/v1"`, the actual available
`sections` and these exact `limits`: `items: 4096`, `bytes: 16777216`,
`memberBytes: 8388608`. An absent capability leaves older services compatible.
The shared client validates the capability; unavailable owning ports do not
become placeholder choices.

`POST /api/s16/client/export` takes only this JSON shape, without query fields:

```json
{
  "contract": "s16-owner-export-request/v1",
  "sections": ["history", "memory", "work"],
  "conversationId": null,
  "from": null,
  "to": null
}
```

Sections are nonempty, unique and available. The canonical order is `history`,
`memory`, `work`, `routine`, `artifact`, `file`, `bot`, `connection`, `skill`.
Conversation is null or one opaque ID; timestamps are null or nonnegative safe
integer Unix milliseconds, inclusive, with `from <= to`. Filters apply to each
record's creation time and conversation before counts. A record with no
conversation cannot satisfy a selected conversation. Bot configuration belongs
with its selected conversation's Bot; global connection/skill settings do not
silently bypass a conversation filter. The UI interprets creation dates in the
client's local timezone, including the complete selected end day.

## Attachment and exact records

The complete UTF-8 JSON shape is `{contract, generatedAt, scope, counts, records}`.
`contract` is `s16-owner-export/v1`; `scope` is the normalized request above.
`generatedAt` is a nonnegative safe integer timestamp, fixed across both reads.
`counts` has exactly the selected section keys, including zeros. Each is the
number of currently eligible exported records, never a count of hidden data.
Duplicate `(kind,id)` identities refuse.

Every record has only `kind`, `id`, `title`, `state`, `at`, `conversationId`,
`redacted` and the fields defined below. IDs are opaque data, with no execution
permission. Configuration is inert; downloading it neither imports nor enables it.

| Kind | Additional fields and source |
| --- | --- |
| `history` | `text`: complete eligible owner message, plus its currently published reply for the root command. Continuation commands keep their own creation time. No grants, slips, evidence/action payloads or raw request rows. |
| `memory` | `text`: current active claim text after dependency, FILE, DATA15, TEAM resource and retained private-scope checks. Forget also suppresses the corresponding source history. |
| `work` | `text`: original request and completion description from the current responsibility and its readable CHAT source. No dispatch/retry/effect state is restored. |
| `file` | `mime`, `representation`, `text`, `bytes`, `sha256`: one current ready input sent in eligible CHAT history, deduplicated. UTF-8/text-PDF representations use `utf8`; sanitized PNG/JPEG copies use `base64`. Unsent, incomplete, withdrawn and untrusted originals are excluded. |
| `artifact` | The same file fields: full current committed UTF-8 deliverable, after producer publication and every transitive input guard. Staging alone is not publication. |
| `routine` | `configuration`: `name`, `instruction`, `schedule`, `timezone`, `misfire`, `quiet`, `limits` (`maxRuns`, `endsAt`), `requestedScope` (`purposeId`, `resourceIds`, `access`). No policy/proposal/dispatch/tick/feed receipts. |
| `bot` | `configuration`: `name`, `responsibility`, `model` (provider/modelId/effort or null), `excluded` (id/label), `assignments`. Existing owner-readable Bot export, without its changing export timestamp. No grants/computers/accounts/history. |
| `connection` | `configuration`: source `kind`, `endpoint`, `authentication: "reconnect_required"`, `tools` (name/title/description/requestedClass), `truncated`. GitHub instead has `kind: "github"`, `selectedRepositories`, `authentication`. No tokens, fingerprints, auth/session or review receipts. |
| `skill` | `configuration`: active current `name`, `description`, `version`, `license`, `pin`, `origin`, `importSource`, `requestedAvailability`, `requestedExecutable`, `dependencies` (key/endpoint/transport). No imported package/unit bodies, recipient hashes, reviews or authority. Reimport/review remains explicit. |

File `text` is the UTF-8 string or base64 payload. `bytes` and `sha256` describe
the actual exported decoded bytes, after conversion/redaction, not a claim about
original upload identity. Images are the existing sanitizer's immutable copies;
export neither reparses originals nor runs OCR. Text fields are screened whole
with the existing outbound credential guard, including registered fingerprints,
before serialization/encoding. `redacted` reports changed text/title/configuration.
Recognized credentials remaining in binary bytes or final JSON refuse the whole
response. Export does not read credentials from a vault/key/profile to obtain
content. It does not export raw SQL, owner/authentication material, native/helper/
VM custody, host paths or raw authority/grant/slip/action rows.

## Consistency, capacity and release

Every record uses its actual owning current-read guard. Unavailable/withdrawn
data is filtered before counts; corrupt/missing required state refuses instead
of reconstructing empty state. The CHAT content read does not refresh action
presentations or write journals. Full text iteration shares existing search
eligibility without using search snippets as export bodies.

Two fresh complete projections must agree byte for byte, with current owner
checks throughout and immediately before synchronous in-memory release. Changed
content/eligibility returns `owner_export_source_changed` (409), with no prepared
attachment. The initially authenticated actor must remain current across streamed
request-body reads; a request cannot switch to a later owner generation. This is
release-time consistency, not recall of a file already downloaded by its owner.

There are at most 4,096 records, 16 MiB of complete encoded JSON and 8 MiB per
encoded record. Known large file sizes are checked before owning byte reads;
encoded-member and complete-envelope sizes are checked too. Exceeding a bound
returns `owner_export_capacity` (413), without a partial download. Narrowing scope
is a new explicit read. There is no export work grant, journal, task, automatic
retry or persisted private export cache. Existing unknown-effect dedupe,
withdrawals, policy, usage and source journals are not changed by this read.

Successful responses use `application/json; charset=utf-8`, exact
`Content-Length`, `Content-Disposition: attachment; filename="jit-export.json"`,
`X-Content-SHA256`, `Cache-Control: private, no-store`, `nosniff`, no-referrer,
same-origin resource policy, `Vary: Cookie` and script-free sandbox CSP. The
shared client bounds the stream, validates the entire digest, scope/schema/counts
and each file digest/length before returning bytes. Abort/auth/session loss
fences late completion. No response bytes enter application state or storage;
the dialog's temporary download Blob URL is revoked after use/unmount.

## Evidence and boundaries

`tests/s16-owner-export.test.ts` exercises actual owning composed HTTP/shared
client, pure CHAT reads, DATA15/TEAM withdrawal, MEM forget/restart, FILE/artifact
lineage/corruption, sanitized images, Bot/routine/connection/skill settings,
credential screening, capacity, changed state and streamed authentication loss.
It asserts current database bytes, VM/network/vault calls and resulting content,
not merely HTTP success. `tests/s16-owner-export.browser.test.ts` exercises the
real bundle's actual download, scope/empty/error/auth states, keyboard focus and
English/Thai widths 1440/390; controlled capacity/changed/auth responses isolate
the UI states while successful content comes from the actual service.

`ops/evidence/s16-owner-export.ts` copies and seals the selected package, installs
its pinned dependencies and runs these cases through artifact production imports
with separately hashed fixture drivers. A private receipt records the exact
source/package/dependency and browser image hashes. No live provider, account,
production host or native-device acceptance is claimed. Protected forward restore,
compatible service/client lifecycle and #429 aggregate acceptance remain separate.
