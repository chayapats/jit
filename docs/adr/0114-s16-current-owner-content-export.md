---
status: implemented ordinary export; aggregate operations acceptance incomplete
date: 2026-11-21
scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12
---

# Export current owner content through its existing owners

## Required behavior

[#429](https://github.com/chayapats/jit/issues/429) and
[ADR 0104](0104-s16-forward-recovery-and-retained-admission.md) distinguish ordinary
user export from protected recovery. A host operator's filesystem access does not
prove an authenticated owner's right to receive current content. Historical data,
withdrawn source bytes, protected native sessions, credentials and authority rows
cannot become ordinary downloads by adding an archive manifest.

## Comparison and choice

Dumping SQL or reusing a protected recovery point would be easy to implement but
would include private continuity, credentials' references and past authority that
ordinary clients cannot read. Persisting a prepared export would require another
private cache, expiry/deletion protocol and withdrawal fence. Returning search
snippets would silently truncate user content.

Select a bounded fresh owner projection over the actual existing authenticated
service/client. Export has no private on-disk cache, task, work grant, operation
journal or automatic retry. Each explicit download reacquires the current owner
and original owning projections. Existing CHAT publication, source withdrawal,
FILE lineage, MEM dependency/resource/private scope and owner-generation guards
precede inclusion and run again before response release. Missing/corrupt required
current state refuses rather than creating empty state. Credentials are screened
with the existing outbound credential guard, including registered fingerprints;
export never reads a vault/key/profile to obtain output content.

Select a distinct `s16-owner-export/v1` JSON attachment. It contains explicit
user-content/configuration DTOs and current readable deliverables, never spread
request records, raw tables, grants, slips, action payloads, owner/authentication
material, native/helper/VM state or host paths. Reusable Bot/routine configuration
is data; export neither installs it nor grants its named resources. Binary source
custody and protected recovery remain separate. Readable FILE representations and
committed deliverables use their existing owning checks; output identifies the
representation/redaction rather than claiming altered bytes are original files.
Sent current ready inputs contribute full UTF-8 text (including a PDF's validated
text) or the already sanitized PNG/JPEG copy, encoded as base64. Unsent uploads,
raw binary originals, unpublished artifacts and private skill package bodies are
not ordinary exported content. Skill settings retain the current immutable pin
and inert configuration metadata for explicit review/reimport.

A closed scope selects sections and an optional conversation/time range. Total
item/encoded-byte limits apply before large byte reads. Capacity refusal returns
no partial download; the owner can narrow scope. Current authorization filtering
precedes exported counts. The service does not turn unavailable content into a
cached retry or reveal unavailable private counts. Final current-owner/source
validation precedes an in-memory attachment response with private no-store,
nosniff and restrictive content policy.

The owning CHAT view can refresh action presentations and refs; ordinary export
therefore uses a separate pure current-content read with the same publication
and delegated-authority guards. Full content iteration shares the existing
search eligibility rules without its text clipping. Two complete fresh reads
must produce identical content before synchronous release. The initially
authenticated actor remains current even if a request body arrived in chunks;
the request cannot adopt a later owner generation. Limits are 4,096 records,
16 MiB for the complete encoded JSON and 8 MiB for one encoded member. Large
known file sizes are rejected before reading bytes; no partial body is released.

## Product and acceptance

Use the authored S16 rail/dialog/notice conventions and existing shared client
transport. The primary owns the UI. Offer actual available export sections,
explicit scope and a download, with English/Thai copy, keyboard behavior and
loading/empty/capacity/current-source-changed/authentication/reconnect states.
Do not present a placeholder or a protected backup as a client download.

Exercise actual owning composed HTTP and the shipped browser bundle on disposable
scripted data: guarded content and configuration, source withdrawal/private
retirement before release, credential screening, corruption/bounds and auth loss.
Assert response bytes and unchanged policy/usage/unknown-effect dedupe. Source
presence, transport success and model prose do not prove lifecycle acceptance.
Native-device/account/physical-host outcomes remain separately labelled under
#431/#432. This decision changes no S14 default, S15 opt-in or installed policy.

The exact DTOs, transport, coverage and remaining boundaries are frozen in the
[ordinary export contract](../contracts/s16-owner-export-v1.md). The standalone
copied-package evidence driver runs owning conformance cases and the real
English/Thai browser download through production imports from the verified
artifact; fixture drivers remain outside the immutable package.
