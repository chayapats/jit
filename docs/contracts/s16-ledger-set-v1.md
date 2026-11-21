# s16-ledger-set/v1

Status: protected internal capture primitive for OPS16-01. It captures the
caller-selected SQLite set at one write cut. It is not the complete installation
backup, ordinary export, restore validation or a worker-admission certificate.
The aggregate coordinator must enumerate all selected owning stores, hold its
maintenance/owner/configuration fence and handle non-SQLite custody separately.

`captureS16LedgerSet` receives trusted owning database handles, unique opaque
`*.sqlite` aliases, explicit reader expectations, a pre-existing private output
parent, a fresh 32-hex ID, installation ID, current-guard callback and optional
fake clock/narrower byte ceiling. None is an ordinary client/archive-selected
path, SQL statement, authority or execution context.

The implementation is synchronous. It validates the complete input, calls the
current guard, acquires `BEGIN IMMEDIATE` on every owning handle before reading
any image, and refuses existing transactions, duplicate handles and busy writers.
Already acquired transactions roll back on any refusal. No callback may await
or mutate/close a source. Source rows are never rewritten. Holding all SQLite
writer reservations establishes one cut for this selected set; it does not
prove another unlisted store, guest, helper driver or parser is settled.

`BEGIN IMMEDIATE` alone is insufficient for a read-only or query-only handle.
After checking the actual main reader, a zero-row main-table DML probe must
succeed inside each reservation. It changes no row, fires no row trigger and
does not dirty a header page; a temporary database is not an acceptable probe.
Read-only/query-only handles refuse before creating a point. An independent
process test proves both owning main writers remain excluded during the cut.

Before allocating serialized images or creating a point, SQLite page metadata
checks the per-image/total ceiling and exact reader. `quick_check(1)` and
`foreign_key_check` reject structural/referential corruption on the held owning
connections. These do not replace each service's semantic/identity validation.
Only after all reservations and these checks succeed does it exclusively create the private
output directory. Each owning SQLite handle serializes its current snapshot,
including committed WAL content, into a newly created mode-0600 image. The
image is fsynced and checked through `s16-ledger-image/v1`. Empty/duplicate or
invalid names, unsupported headers, image/type/hash errors and finite bounds
refuse. At most 256 ledgers and 2 GiB total SQLite bytes are admitted, with the
image primitive's 1 GiB per-ledger ceiling; a caller may select a narrower
positive total ceiling. This step does not read ordinary directory contents
into the point or copy live WAL/lock files by filename.

The new serialized image's read/write journal-mode bytes (18/19) are converted
to rollback mode before validation, as documented by
[SQLite's deserialize contract](https://www.sqlite.org/c3ref/deserialize.html).
No source byte or `user_version` is changed. The staged image is independently
opened read-only and checked for SQLite/foreign-key integrity before its hash
is admitted to the manifest; a WAL-header blob that only passes a hash check
is insufficient.

Every acquired transaction is released in reverse order before publication.
After successful release the current guard runs again. Only then is a bounded
canonical `manifest.json` written exclusively and durably. The manifest names
the installation, point ID, capture time, measured total and exact image
metadata under unique aliases; its `scope` is `caller_selected_ledgers`.
Its `validation` is `sqlite_integrity_and_image_hashes`.
It contains no source path, row contents, credential or permission. Image files
are protected raw control state and must never enter the ordinary artifact or
download route.

On interruption, unsupported source, failed guard, full disk or release failure,
partial private files remain without a published manifest. No incomplete point
is resumable and an existing ID is never overwritten, auto-deleted or treated
as a successful retry. The outer coordinator owns original request receipts,
finite retention and explicit cleanup. A release failure is reported as
`s16_ops_source_release_unknown`; it cannot be reported as current runtime
settlement. The primitive never closes another service's connection.

Restore must separately verify all files and owning schemas/identities, preserve
independent current policy/withdrawals/private scope/usage/unknown-command
continuity, reconcile before admission, and use a compatible release. This
component grants none of those outcomes by producing a manifest.

## Independent verification

The outer owning receipt retains `s16LedgerSetManifestHash(manifest)` before
reporting a capture as retained. `verifyS16LedgerSet` requires that independent
hash, exact installation/point identity and reviewed reader/alias set. The
candidate cannot supply its own trusted hash or expected reader capabilities.
The verifier bounds and hashes the canonical manifest before parsing it,
rejects extra/missing files and unknown fields, then re-observes every private
image and compares all metadata. It requires rollback journal mode before
opening SQLite, checks actual SQLite/foreign-key integrity read-only and
rechecks file/manifest hashes. Returned metadata still grants no restore,
current authority or aggregate completeness.

The protected producer may resume original unpublished staging: compare each
existing image to a fresh complete simultaneous current cut, without overwrite,
then create only missing members. `verifyOnly` requires all images/manifests and
cannot repair prepared/published points. Changed current bytes or unknown names
refuse. Default capture still refuses an existing target. These options supply
no original request, receipt or restore authority.
