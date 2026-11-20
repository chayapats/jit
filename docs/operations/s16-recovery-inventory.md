# S16 operations and recovery inventory

Status: implementation audit for [OPS16-01](https://github.com/chayapats/jit/issues/429),
not an implemented backup protocol or release acceptance. Audited base:
`eeda821a1e611e598f5dac829bfc386d5d00912c`. The additional computer backend
and mobile delivery remain separately reviewed in PRs
[473](https://github.com/chayapats/jit/pull/473) and
[471](https://github.com/chayapats/jit/pull/471). Reconcile their final merged
revisions before freezing the aggregate format contract.

Scope: S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12.
The [S16 spec](../specs/S16-rakazo-experience.md), retained
[S15 authority](../adr/0064-conversational-authority-and-protected-control-plane.md)
and [default autonomy amendment](../adr/0084-s16-grok-style-default-autonomy.md)
continue to apply. No runtime default, installed policy, host or credential
changes follow from this audit.

## Actual selected state

`runS15` selects one explicit credential-free runtime config. Its state root
contains owner authentication, a protected vault, provisioned-browser state,
recipient continuity and the composed `runtime` directory. `composeS15` owns
`runtime/composition.json`, whose exact store list depends on selected features.
It refuses missing listed ledgers; optional additive stores cannot be treated
as empty merely because an older manifest omits them.

The following names are relative to the composed runtime directory. Every
listed database contains current protected continuity, rather than being a
guest snapshot or an ordinary user export.

| Store | Owning code | Recovery facts to preserve |
| --- | --- | --- |
| `conversation.sqlite` | `src/s15/conversation/store.ts` | Original commands/receipts, request states, evidence, decisions, steers, computer handoffs and search labels; CHAT reader depends on text/binary/file-memory/skill use. |
| `policy.sqlite` | `src/s15/policy/ledger.ts` | Installed revisions, owner/work authority, reservations, approvals, claims and unknown effects. |
| `model.sqlite` | `src/s15/model/service.ts` | Original model requests and conservative usage; no inference replay from a restored image. |
| `work.sqlite` | `src/s15/work/service.ts` | Responsibilities, original attempts, durable waits and stall-reply bindings. |
| `vm.sqlite` | `src/s15/vm/store.ts` | Computer generations, physical binding, scope, leases, screen ownership, preparation and settlement. |
| `team.sqlite` | `src/s15/team/store.ts`, `src/s15/team/service.ts` | Current resources, sources, withdrawals, fences, leases and transitive file/data ancestry. |
| `memory.sqlite` | `src/s15/memory/service.ts` | Private/source ceilings, correction, suppression, derivative identity and file/data reader fences. |
| `disclosure.sqlite` | `src/s15/disclosure/service.ts` | Original private ancestry, recipient releases and shared-VM contamination; never rewind with a guest disk. |
| `browser.sqlite` | `src/s15/browser/` | Protected browser operations, ownership and uncertain effects; the profile is separately sensitive. |
| `github.sqlite` | `src/s15/github/store.ts` | Original publication/merge commands and reconciliation; a missing reply never authorizes another write. |
| `files.sqlite` | `src/s16/files/store.ts` | Immutable original/representation/artifact hashes, withdrawals, private provenance, staged versus published state. |
| `routines.sqlite` | `src/s16/routines/service.ts` | Finite schedules/reactions, occurrence identities, coalescing, waits and retained charges. |
| `notifications.sqlite` | `src/s16/notifications/service.ts` | Subscriptions and original delivery dedupe/unknown results; opening a notice grants no authority. |
| `bots.sqlite` | `src/s16/bots/service.ts` | Accepted identities, revisions, route/resource pins and lifecycle state. |
| `connections.sqlite` | `src/s16/connections/service.ts` | Reviewed tool catalogs, generations, reconnect/revocation and original remote operations. |
| `skills.sqlite` | `src/s16/skills/service.ts` | Immutable package pins/reviews, availability, withdrawals and VM-copy ancestry. |
| `voice.sqlite` | `src/s16/voice/service.ts` | Metadata-only finite speech/call usage and original confirmed-turn identities; no audio/send replay. |

The owning reader's supported formats are conditional, not a single S16 schema
number. At this base, CHAT supports formats 1 through 5 only with the matching
composition; FILE supports 1/2/3; TEAM and MEM additionally distinguish file and
DATA15 ancestry. Record both the actual SQLite header and logical version after
settlement. Restoring `composition.json` alone cannot undo an adopted reader
fence. PR #473 additionally introduces VM physical/portable readers and
separate helper/controller journals; their final formats must join this matrix.

## State outside the composition manifest

The outer runtime also owns `owner/owner.sqlite`, its lifecycle/recovery
sidecars, `recipients.sqlite`, `browser-sites.sqlite`, protected browser-engine
state, `github-artifacts` and `native-github`. The composed runtime includes
`file-bytes`, model/native contexts and optional configured parser/skill state.
The selected runtime config and actual owning constructors, rather than a
recursive copy of an assumed directory, must enumerate these roots.

The vault, provider credentials, owner setup capabilities, sensitive-site
profiles, SSH identities and native client secure storage cannot enter an
ordinary export. A protected recovery point is a separate custody class,
never downloadable through the ordinary file/artifact route. Native package
and service-worker caches are replaceable only after package hash/provenance
verification; rebuilding a cache is not permission to replace a device's
service binding or credential store. Working VM disks and cold snapshots are
not control-plane backups.

Process-lock databases, WAL/journal files and retained parser/helper operations
are not independent artifacts that may be copied or deleted by suffix. Their
owning process must settle or provide an explicit compatible recovery result.
Unknown physical effects retain their original identity and custody across
maintenance.

## Existing operations and the missing aggregate contract

The S15 installer already stages a verified copied-source package, switches
the release, health-checks it and retains the previous release. Its failure
path restores the prior composition manifest while leaving additive stores on
disk. That preserves an important distinction: compatible code fallback is
not authority-state rollback. Existing reader fences may correctly refuse an
older release after feature adoption; the operator needs a compatible forward
recovery path in that case.

The S14/legacy backup and quarantined-restore contracts operate on their own
application stores. S14-to-S15 adoption preserves originals and refuses
unrepresentable post-activity rollback. None of those contracts currently
implements backup/restore of this selected multi-ledger S16 composition.

Before implementation, freeze a versioned aggregate contract covering:

1. An owning-service maintenance fence that also excludes offline installers
   and other maintenance writers, with explicit in-flight settlement.
2. A complete bounded manifest of selected roots, exact bytes/hashes/modes,
   installation/build/engine/parser/client identities and reader compatibility.
3. Separate secret-free ordinary export and protected recovery custody, with
   no session/credential import through the ordinary path.
4. A restore reconciliation protocol using independent **current** withdrawals,
   private scope, usage and original-effect/request continuity. Missing or
   corrupt current continuity refuses; it is never reconstructed as empty.
5. Quarantine validation before admission, durable activation intent and
   recoverable interruption at each filesystem/database boundary. No original
   mutation, speech, notification or scheduled occurrence is replayed merely
   because a backup predates its receipt.
6. Exact compatible-release fallback after adopted formats, including native
   packages and the separate computer helper; uninstall retains protected data.

Reusing the existing typed owner ingress, store locks, package verification and
owning service projections is the baseline candidate. A full upstream server
or generic tar copy would introduce another authority stack or omit the
reconciliation obligations. A unified storage migration is an alternative only
with a concrete preservation/operational comparison; this inventory does not
select that migration or declare the current split permanent.

## Required aggregate evidence

Use disposable installations with scripted models/transports and actual
resulting files, ledgers and receipts. Exercise clean install, feature adoption,
upgrade failure after each durable boundary, backup verification, quarantine
restore after source withdrawal/private retirement, unknown-effect response
loss/restart and uninstall retention. Substitute or remove each required
ledger/byte file and require refusal before admission. Restore an older manifest
after newer CHAT/FILE/TEAM/MEM/VM formats and verify compatible forward recovery
without lowering versions or refunding usage.

Run existing owner/client paths for observable outcomes; a manifest validator
or directory-copy test alone is insufficient. Verify shipped mixed licenses,
notices and immutable source provenance and absence of hosted/telemetry
requirements. Label browser, native device, Linux/KVM and account evidence
separately. #431/#432 retain actual live evidence and owner-host acceptance;
#429 remains open until its aggregate implementation and deterministic
acceptance pass.
