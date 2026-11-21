# s16-delivery-evidence/v1

Selected under [ADR 0132](../adr/0132-s16-exact-source-delivery-evidence.md).
The [source contract](s16-cross-client-evidence-v1.md) retains blocked artifact
acceptance. All S16-AC01–AC22, FR-01–FR-42 and NFR-01–NFR-14 remain required.

The finite pipeline accepts fresh absolute output and existing iOS Simulator/
Android Release directories below the executing checkout's ignored `.local`.
It accepts no historical receipt, command, environment, endpoint or approval.
Both native artifacts must name the exact clean current commit, root/client
locks, native inputs and notices. A separately materialized byte/mode-checked
Git archive must match their build-source records. Preflight rejects links,
hard links, special nodes, noncanonical/outside paths, depth over 32, more than
60,000 nodes, files over 512 MiB or totals over 2 GiB. Full native inventory/seal
verification follows. These are locally observed build-only artifacts, not
external builder attestations, device UI or installation/signing authority.

The pipeline builds desktop and independently rebuilds its seal before passing
it to existing installed browser fixtures via `JIT_S16_DESKTOP_ARTIFACT`. Only
the lifecycle suite receives private capture destinations. It preserves the
actual tested current package/dependencies, never state, harnesses or cookies.
The internal `s16-cross-client-evidence/v2` source receipt retains v1's blocked
artifact acceptance, adding the actual desktop seal, unchanged verification and
requested lifecycle capture basis. There is no arbitrary v2 import command.

Every reviewed profile executes. Bounded log bytes, SHA-256 and re-observed Bun
counts/assertions must match. Any missing, skipped, failed, inconsistent,
unobserved case or required driver gap refuses the join. Lifecycle metadata
must bind the test/host/composition hashes, current source, runtime package and
dependency seals, and all four actual setup/upgrade/fallback/reinstall outcomes.
A fresh source package hashed with the tested package's manifest metadata must
match its content seal before any packaged module loads.

Only eight public content-addressed web assets, their release and worker are
observed. They must equal the source handler bytes used by browser fixtures;
private/authenticated access refuses. The receipt records each artifact's actual
basis: packaged lifecycle, bundled desktop fixtures, source browser plus public
byte equality, native build-only integrity and host parser fixtures. Host parser
pins do not certify a shipped parser image or isolation.

After execution, source/dependencies, logs and all artifact seals are rechecked.
Only a complete internal join sets `deterministicAcceptance: passed`.
`productAcceptance` remains `blocked` with native UI, Linux isolation, configured
local speech, live accounts and owner-host cutover independently pending.
Historical/cross-revision promotion is unsupported. The source-only executor
keeps reporting blocked artifact acceptance.

Private output is 0700 with 0600 receipts/logs; public code retains release
modes. Refusal leaves private diagnostics without a successful delivery receipt
and exits 1. A complete deterministic join exits 0. Raw logs, host paths and
installation data never enter tracked evidence. No evidence grants execution,
disclosure, policy, approval, publication, production or adoption authority.
