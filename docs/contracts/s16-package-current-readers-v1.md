# s16-package-current-readers/v1

Status: read-only component under
[ADR 0124](../adr/0124-s16-sealed-package-current-reader-probe.md).
Aggregate selected service/client lifecycle remains incomplete.

A protected operator supplies an absolute target package directory, its original
expected package content SHA-256, the current configuration path and its original
canonical parsed SHA-256. These are trusted host inputs, not client/model/archive
fields. The normal CLI requires the existing root-owned immutable tree policy.
Only explicit test composition can supply the existing fake-root ownership policy.

Verify the whole target tree and runtime/dependency seal before loading any
target module. Load the actual target's parser, current control constructor,
fence reader and executing-package inspector. A missing API or unsupported
format/configuration refuses; a new reader never stands in for the target.
Require already adopted current operations metadata, exact current owner/config
bindings and the target's genuine installation/CHAT/controller exclusion. The
original pending operations gate remains unchanged.

The observation contains package/reader/notices/dependency pins, configuration,
owner/control hashes, every selected/retained SQL source's actual application ID,
format and logical image SHA-256, and hashes of current FILE/GitHub/external/
helper/native-namespace custody. SQL images come from the target's genuine
complete writer cut, sharing its bounded serializer and only the documented
SQLite journal-byte 18/19 normalization. Images are not copied or returned.
Asynchronous helper and external observations stay outside the SQL cut; current
source/custody/package identities are rechecked before returning metadata.

`native: namespace_metadata_only` does not establish deep public native ancestry.
`helpers: current_metadata_not_physical_settlement` retains physical uncertainty.
No private inventory paths, credentials, messages or payload bytes are returned.
This observation is not a complete consistent recovery point, compatibility
exception, executable-selection receipt, work grant or acceptance result.

`openS16PackageReaderProbe` returns an original capability before opening current
sources. `observe` can run only once; failed observation still retains its exact
target context/cut. `close` must conclusively release those original resources
before the operator accepts an observation. Unknown release preserves the
capability and actual process locks for same-capability disposal. The CLI prints
its result only after conclusive close, and a refusal emits a fixed code without
host paths or target errors. Neither close nor process exit clears an original
durable operations gate.

Upgrade/fallback still needs an independently journalled original command and
cohort, exact source/target/selector identities, root-only atomic selection,
current readback and owning service/client interruption proofs. It must retain
all current trial-service facts and refuse incompatible older readers. No old
SQL, composition, native state or VM disk may be restored to make a reader pass.
