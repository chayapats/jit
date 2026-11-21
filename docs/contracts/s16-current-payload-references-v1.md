# s16-current-payload-references/v1

Status: protected current metadata component of OPS16-01. This is not a complete
current cohort, authenticated candidate, repair plan, usable-source list or
activation/admission authority. [ADR 0116](../adr/0116-s16-current-payload-references-for-forward-recovery.md)
selects the boundary; [ADR 0104](../adr/0104-s16-forward-recovery-and-retained-admission.md)
retains the full forward recovery obligations.

The actual current-control capability exposes `currentPayloadReferences()` while
its original installation, CHAT and controller exclusion and current owner/config
guards remain live. Trusted composition supplies the actual selected/retained
FILE, GitHub and DATA15 readers. Existing source transactions refuse unless the
parent supplies its [original complete live writer cut](s16-ledger-write-cut-v1.md),
authenticated against every exact current handle. Forged, partial and released
cuts refuse; a cut-scoped observation expires when that cut releases. No ordinary
client, model, HTTP or CLI entry point accepts paths, source handles or a catalog
as authority. Retirement or close invalidates the original observation.

The frozen catalog contains only:

- `contract`, current `installationId`, `file` and `github`.
- `file: null` when FILE SQL is absent and unselected/unretained. Otherwise the
  nested `s16-file-current-references/v1` contains `installationId`, `files` and
  `pending`. Each file has logical `name`, original `rowId`, role (`original`,
  `representation`, `artifact`), exact `bytes` and `sha256`. Stored ready upload
  receipts supply original/validated-representation pins; stored artifact rows
  supply inert staged pins. Uploading/validating rows supply only original
  `id`/`state` pending facts. Other upload states supply no payload target.
- `github` uses `s16-github-current-references/v1` with `installationId`,
  `present`, `lineage` and `bundles`. Each bundle has exact `id`, `sha256` and
  current references (`table`, `kind`, `rowId`, `slot`, `state`). The shared owning
  parser retains selection, original selection receipts, action/evidence/effect,
  work evidence and typed DATA15 derived-artifact correlations. Arbitrary remote
  content and unreferenced bundle namespace entries create no reference. Bundle
  length is not asserted: current SQL generally has no such pin.

These are stored custody pins, not release eligibility. FILE ancestry, expiry,
current private scope, CHAT publication, resource membership and recipient checks
remain with their owning services. Staged artifacts do not become published,
pending bytes do not become ready and a historical reference cannot fill a
current missing row. A later repair coordinator must preserve those current
facts and reject any unsupported selection before replacement. The projection
never invokes a FileStore/GithubService constructor or boot recovery.

No payload namespace is listed, probed, created, decoded or opened. A directory
or referenced byte file may be absent, corrupt or inaccessible without changing
these SQL references. Complete FILE/GitHub backup custody keeps its stronger
existing path/inventory/byte/hash requirements and still refuses that damage.
Required missing/corrupt SQL, foreign identity, unsupported reader, invalid typed
reference, untrusted SQL path or bounds breach refuses the entire read without
initializing state or dropping references.

The observation retains SHA-256 of its exact JSON catalog. `assertCurrent()`
rechecks original SQL path attributes and current capability and rereads bounded
current metadata before comparing the original digest. WAL-only reference or
withdrawal changes invalidate it even when the main file and operations revision
are unchanged. Unrelated current facts can remain outside this digest: it must
never substitute for the full current SQL/native/helper/external/package cut.

Bounds are finite and refuse without truncation: FILE <=10,000 rows, 16 MiB JSON,
128 KiB per row and 4 MiB encoded projection; GitHub <=50,000 rows/correlations,
64 MiB owning JSON, 1 MiB per GitHub row and 4 MiB encoded projection; DATA15
<=10,000 rows, 64 MiB JSON and 128 KiB per row; combined catalog <=8 MiB. Actual
reader/schema/identity and byte-pin validation is shared with complete custody.
No raw SQL, path, text, credential, grant, private source context or native state
appears in the catalog.

Current deterministic evidence lives in `tests/s16-ops-file-payloads.test.ts`,
`tests/s16-ops-file-cohort.test.ts`, `tests/s16-ops-github-artifacts.test.ts` and
`tests/s16-ops-control-maintenance.test.ts`. Actual owning upload/artifact and
Git bundle writers seed disposable state; missing directories/bytes, retained
unknown effects, current withdrawals, WAL-only changes and retired capabilities
are exercised without rewriting current state or completing an incomplete point.
Candidate verification, durable quarantine/activation, service/client lifecycle,
physical devices/accounts and owner-host cutover remain separate obligations.
