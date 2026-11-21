# s16-ledger-image/v1

Status: internal OPS16-01 building block. This is a bounded, read-only
observation of one settled protected ledger, not a backup/restore API, an
installation identity check, a SQLite integrity certificate or admission
authority. Full aggregate operations remain under #429.

`observeS16LedgerImage(path, expected)` accepts a trusted host path and an
owning reader's expected `{ applicationId, formats, ownerUid }`. Callers derive
these from the selected installation and reviewed release, never an archive,
model, guest or ordinary client body. `formats` is an explicit nonempty list of
at most 16 distinct unsigned SQLite reader versions; browser continuity's
historical application/version zero may be named only by its owning adapter.

The caller must hold the aggregate maintenance lease and settle owning writers
before using the result in a consistency manifest. This observer supplies no
such lease. A successful observation cannot clear an unknown effect, prove
physical VM settlement or authorize rollback. Per-store identity, required
tables/rows, foreign keys and current continuity need separate owning validation.

The function rejects relative/noncanonical paths, symlink ancestors/final
entries, nonregular or multiply linked files, wrong owner, permissions beyond
0600, pending SQLite sidecars, unsupported application/version, invalid header
or size, and changes observed during reading. Missing state is never created.
It never opens SQLite, follows a final link, checkpoints WAL, removes a sidecar,
rewrites permissions or returns stored rows/bytes. System-owned macOS `/tmp`
and `/var` aliases follow the existing protected maintenance-path policy.

Files are streamed in 64 KiB blocks with a 1 GiB per-ledger bound, including
the portable work-file archive's supported capacity. Header page size and
exact main-image length must agree. The first 100 bytes, fixed application ID
and exact reader version are checked before the complete SHA-256 is computed.
Any `-wal`, `-shm` or `-journal` entry requires settlement rather than silently
hashing an older main image. A valid main image deliberately does not establish
that all rows are semantically valid.

The returned immutable object is exactly:

```ts
{
  contract: "s16-ledger-image/v1";
  validation: "header_and_hash";
  applicationId: number;
  readerVersion: number;
  journalMode: "rollback" | "wal";
  bytes: number;
  sha256: string;
}
```

It contains no path, credential, installation-specific address, principal,
policy, row content or inferred permission. Safe fixed error codes distinguish
unavailable continuity, untrusted paths/files, unsupported reader, required
settlement, invalid image and a changed image. No underlying filesystem error
or path is exposed. Current protected state stays authoritative throughout.
