# s16-current-byte-custody/v1

Status: protected current FILE/GitHub component selected by
[ADR 0118](../adr/0118-s16-current-byte-custody-for-forward-recovery.md).
No repair, admission, publication or complete current cohort is certified.

`S16ControlMaintenance.currentFileCustody(cut?)` returns
`s16-current-file-custody/v1`: the same present FILE/parser roles as the strict
backup cohort, plus `missing` current ready original/representation/artifact
pins. It shares the bounded owning SQL parser and byte collector with complete
backup. Present mismatched pins refuse; missing pending validating originals and
required parser continuity refuse. Withdrawn/cancelled/expired/rejected originals
are never missing recovery pins. Current pending fragments and parser outputs
remain untrusted and unchanged. A missing immutable-byte directory may be
observed without construction, but selected/retained SQL remains required.

`currentGithubCustody(cut?)` returns `s16-current-github-custody/v1`: all present
verified bundles and exact current correlations, plus missing referenced bundle
IDs, digests and correlations. Missing lengths are not invented. Unreferenced
present bundles remain in custody; unreferenced historical bundles are never
recovery targets. Current DATA15 pre-publication pins remain distinct from actual
GitHub selection/action/receipt slots. Required corrupt SQL refuses.

Default `fileCustody()` and `githubArtifacts()` still return their original v1
complete-backup values and reject missing referenced bytes/namespaces. No missing
mode can accidentally produce a complete point. Both modes refuse unsafe links,
foreign ownership, unknown names, corrupt present hashes, unsupported readers,
missing parser/native continuity or bounds violations without recreating state.
Existing FILE/GitHub component size/count/JSON bounds apply. Additional host-only
physical-identity metadata is bounded to 16 MiB; it never enters ordinary export.

Original observations expose frozen path-free `value`/`sha256`, present host-only
`sources`, separate frozen `entries` containing original physical identities and
strict `assertCurrent()`. Entries distinguish absent/file/directory; file identity
pins inode/owner/mode/link/size/mtime/ctime, directory identity pins inode/owner/mode.
Strict original revalidation additionally retains directory attributes, absences,
complete namespace, current rows/references and all present hashes. An addition,
same-byte inode substitution, WAL-only metadata change or repaired missing member
invalidates that original observation. A future independent plan must explicitly
account for each legitimate transition; hash equality or these identity records
alone cannot grant ownership of a new target/temp/parent.

The actual current parent supplies original sources and genuine exclusion. Only
its complete live writer cut can be passed through the public parent methods;
forged/partial/released cuts and unrelated source transactions refuse. A cut-scoped
observation expires when that cut releases. Closed/retired parent observations
refuse. No archive constructs a live observation. Complete SQL, actual public
native ancestry, helper/external facts, package identity and service/client
lifecycle still require independent aggregate validation.
