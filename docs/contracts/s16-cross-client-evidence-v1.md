# s16-cross-client-evidence/v1

Status: selected evidence contract under
[ADR 0121](../adr/0121-s16-executable-cross-client-evidence-matrix.md).
The source-input validator/executor and integrated owning journey inputs are
implemented. Complete exact-build execution and artifact-digest import remain pending.

The reviewed matrix retains all S16-AC01–AC22, FR-01–FR-42 and NFR-01–NFR-14
identifiers. Each required scenario lists acceptance/requirement IDs, issue
owners, observable outcome assertions, negative cases, test profiles, evidence
basis and any missing owning driver. Current spec hashes bind the requirement
interpretation; ADR 0084/0085 amend the retained S15 baseline. The separate old
backlog JSON continues to mean historical ownership only.

Profiles contain fixed repository test paths, supported test-name selectors and
one explicit fixture classification. Profiles never contain an executable, shell
text, secret, network destination or arbitrary environment assignment. Paths stay
under reviewed repository tests, without traversal, symlinks or option injection.
The Bun executor constructs argv itself and supports only its finite allowlist
of existing fixture/browser flags. It does not drive a simulator/emulator, change
an account or run live tests implicitly. Native UI uses its separately observed
device evidence, not a headless protocol substitute.

An execution record binds the exact clean source, matrix, governing docs,
lock/dependencies and actual engine/vendor/package/client/parser digests available
to that run. Every digest includes its basis. Missing artifact evidence remains
unrecorded and blocks any claim requiring it. Per-profile private logs retain
original test names. Receipts retain name hashes, counts/assertions,
pass/fail/skip/timeout/unavailable outcomes and bounded private log hashes.
Public records contain metadata only; installation-specific
paths, credentials, private content and raw logs are excluded from repository data.

Complete deterministic acceptance requires every required scenario's actual
observable driver to execute successfully with its declared assertions and no
required skip/unavailable/unknown case. A process exit alone, source presence or
issue count is insufficient. Reusing a historical receipt requires the same exact
source/matrix/dependency/artifact pins; no automatic promotion across revisions.
Partial profiles produce partial receipts, retaining all omitted required rows.
Missing linked owning delivery, browser or composite journey blocks acceptance.
The integrated inputs include the selected service lifecycle and a native
dictation-to-mobile-Send journey that reads the original work from the web client
and recovers it after owning service restart. Native microphone, secure storage,
speech/model and VM ports are explicitly scripted; native UI stays independent.

Physical native clients, real Linux VM/isolation, subscription/provider/account
and owner-host acceptance retain independent owners/statuses. Their absence never
requires a credential for deterministic tests and never silently marks product
acceptance complete. Source/default/policy/private-state/unknown-effect preservation
checks remain required throughout. Evidence recording itself grants no execution,
approval, disclosure, publication or host-adoption authority.

The initial source executor deliberately reports only input execution. It cannot
import historical artifact/external receipts or conclude acceptance from passing
profiles. Unrecorded package/client/parser digests remain blockers even if all
source inputs pass. Exit 0 means static validation succeeded; execution exits 2
while required acceptance remains blocked and writes the partial receipt. Exit 1
means arguments, source cleanliness or another precondition refused execution.
