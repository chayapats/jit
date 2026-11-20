# s16-payload-set/v1

Status: protected OPS16-01 component for explicitly selected immutable bytes.
It does not certify aggregate completeness, current source availability,
artifact publication, native settlement or restore admission.

`captureS16PayloadSet` accepts a trusted owning resolver's exact opaque aliases,
paths, byte counts and SHA-256 identities, installation/point identity, private
output parent and synchronous current guard. Paths never come from a client,
model or candidate archive. The aggregate owner holds its maintenance fence
and revalidates the owning metadata; a matching hash alone supplies no grant.

The capturer validates finite bounds and canonical manifest size before
creating the exclusive private point. Names are flat ASCII aliases, unique
also under case folding, and cannot reserve `manifest.json`. Limits are 20,000
files, 1 GiB per file, 4 GiB total and 4 MiB of manifest metadata; callers may
narrow the total ceiling. Empty files and an explicitly empty selected set are
valid component inventories, never inferred installation completeness.

The inventory encoder enforces these component bounds independently from the
shared application's 256-entry/128 KiB command encoder. Each closed file record
still uses that canonical encoding; larger arrays and directory comparisons
use the component's explicit bounds. Existing small manifest bytes/hashes
remain identical. A real 512-file capture/verification exceeds both command
limits, while an oversized manifest/file count refuses before output creation.

Each source must be an existing canonical private regular same-owner file,
without symlink ancestors, executable/special permissions or multiple links.
The source opens with no-follow/nonblocking flags. Inode, ownership, mode,
link count, size and nanosecond modification/change timestamps are checked
before/after the streamed read. The implementation copies at most 64 KiB at
once, handles short writes, hashes exact bytes, verifies EOF, fsyncs the new
mode-0600 file and independently reads back its hash. Contents are never decoded,
executed, returned or projected into model/artifact paths.

The current guard runs before/after each file and before publishing the
canonical manifest last. Failure leaves a private unpublished point; no ID is
overwritten, resumed or automatically deleted. `s16PayloadSetManifestHash`
returns the hash for the outer independent protected receipt. Verification
requires that receipt's expected hash plus exact installation/point and file
identities from verified owning metadata. It rejects changed/noncanonical
metadata, missing/extra files and incorrect/untrusted bytes without repair.
Candidate self-hashes are not independent provenance.

## Owning file custody resolution

`fileCustodyPayloads` is a host-only resolver over the current FILE journal and
its actual `file-bytes` directory. It checks the owning application/reader,
installation identity and bounded metadata before loading record bodies.
Limits are 10,000 records, 128 KiB per record and 16 MiB total metadata.

Ready uploads name their exact original `id.blob`; v2 binary receipts also
name the exact isolated-parser representation `id.blob.derived`. Immutable
artifact records retain their `id.blob` whether staged or published. This is
protected custody, not publication: CHAT associations, source withdrawals,
lineage, private scope and current owner checks continue to govern any use.
Display names never select paths. Withdrawn/rejected/cancelled/expired or
metadata-only created uploads contribute no byte source.

Uploading/validating rows are reported as pending. Every physical name absent
from the selected immutable inventory is reported as untracked, including a
stale body or partial file for an otherwise known row. The resolver never
boots FileStore, replays validation, deletes partials, silently includes an
orphan or fabricates settlement. Pending/untracked custody must be reconciled
by the aggregate owner before aggregate success. Parser working directories
are separate custody and are not certified by this resolver.

Actual owning-client upload/withdrawal, staged artifacts and controlled PDF
parser receipts are exercised in `tests/s16-ops-file-payloads.test.ts`.
`tests/s16-ops-payload-set.test.ts` covers exact multiblock bytes, independent
receipts, source/candidate substitution, finite bounds, interruption and current
guard loss. Controlled parser fixtures are deterministic evidence, not native
isolation or account/device acceptance.
