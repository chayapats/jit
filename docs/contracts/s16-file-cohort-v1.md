# s16-file-cohort/v1

Status: protected current FILE/parser custody component selected by
[ADR 0108](../adr/0108-s16-file-parser-custody.md); aggregate acceptance incomplete.

The current control capability resolves the exact selected/retained files.sqlite
and fixed runtime/file-bytes and runtime/file-parser namespaces under genuine
installation/CHAT exclusion. It never constructs FileStore/FileParser, runs boot
recovery, initializes missing state, decodes input, resets containers or deletes
leftovers. Missing/unowned state refuses; an absent unused namespace stays absent.

Receipt-pinned ready originals/representations and staged artifacts retain their
existing owning hashes. Other files must belong to a retained original row and
one of its closed .part/.blob/.blob.derived names. They remain untrusted custody,
including terminal/withdrawn leftovers; copying bytes never revives their source.
A validating row requires its complete original and exact declared hash/size.
An uploading row may have no file or a bounded fragment; a renamed complete
original still has to match its declared hash. Pending state is never settled.
`rowId` identifies the owning FILE row, not an authenticated owner. Raw upload
states and `artifact_metadata` are custody facts, not fresh usability or CHAT
publication evidence; current owning guards still decide every release.

Retained parser trees use at most 64 generated job names, optional in/out
directories, only in/input and the bounded named stdout outputs. Partial trees
and incomplete/invalid output are preserved as untrusted bytes. No parser JSON
or binary content is interpreted. Unknown names, links, special files, unsafe
ownership/modes, oversize data and missing mandatory parser continuity refuse.
The configured generation and stable container namespace are references only;
original orphan job/image and physical settlement are explicitly unobserved.
Equal input hashes do not manufacture an upload/job correlation.

All reads use fixed 64 KiB buffers with no-follow FD/inode/attribute and EOF/hash
checks. Original files are at most 1 MiB; retained parser text at most 2 MiB,
images 16 MiB each and result metadata 2048 bytes, matching the owning stream
writer's bounds before strict FileParser validation. The whole cohort is at most
20,000 files, 4 GiB observed bytes and 4 MiB metadata. Aggregate native/immutable
budgets still apply across components. Directories and absent entries remain
guarded; revalidation rejects changed original inodes or content even when a new
file has equal bytes. Host-only payload paths never enter the protected manifest.

The immutable observation supplies exact role/row/job/hash identities, separate
host-only payload descriptors and a live assertCurrent capability. Current
publication must revalidate this original cut; an archive cannot create that
capability or use untrusted roles as input/artifact authority. Physical parser
reconciliation and complete aggregate/upgrade/uninstall acceptance are separate.
