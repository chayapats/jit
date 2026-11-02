# s15-state-transition/v1

## Executable MIG15-01 refinement — revision 2, 2026-11-03

`src/s15/adoption/index.ts` is the opt-in protected implementation; exported TSDoc is its API. The audit and proposed signatures below remain historical input. Requirements **FR-04/05/15/16/18/23/35; NFR-05/07/08/12; S15-AC16** are unchanged. S14 remains default. No live installation or owner-host acceptance is supplied.

The smaller implementation retains the original S14 schema-17 installation **in place**, sealed by the prior build's existing `<database>.ops/fence.json` and excluded by its OS-backed runtime lock. It never rewrites, renames, vacuums or deletes original application/lifecycle/config/native/volume/profile bytes. Existing sidecars, foreign installations, unreviewed full DDL, unfinished maintenance and unsettled transports/computers/native sessions refuse. Explicit additional custody roots are mandatory when deployment places originals outside the known native/control paths; no installation discovery occurs. Directory entries for the adoption fence and runtime-lock journal are expected control changes, separately tested from unchanged payload files. Credential-free history uses the existing S14 sanitizer **on in-memory copies only**. Original checkpoints remain private protected custody, never ordinary exports.

Application and ledger images retain the existing 64 MiB/200000-row bound. Original Bot volumes, profiles, native state and executable artifacts are checksummed in 1 MiB buffers, with explicit 64 TiB/4096-file custody bounds; they are never copied into the S15 store. Config-selected original computer/vault/scratch roots are included automatically. Additional external custody roots remain explicit. These storage/parser bounds grant no execution or spending allowance.

The separate `adoption.sqlite` uses reserved application ID `0x4a495432`, schema 1. Its complete DDL lives in `service.ts`: identity, metadata/journal, immutable restricted history, immutable continuity facts, source request reservations, command receipts and the before-I/O activity marker. Row serialization uses typed SQL cells, decimal integer strings and base64 BLOBs; historical JSON strings stay exact. Schema objects, source files and individual history rows are hashed. This archive has no team retrieval, policy, queue or materializer that could dispatch imported work. All old sources/shares/accounts/volumes remain restricted; exact future releases belong to TEAM, independently of adoption.

Current lifecycle rows, including orphans, are copied as protected continuity rather than an ordinary backup. Componentwise grant maxima become a nonrefundable aggregate POLICY reservation floor before any policy is installed. Monetary spend/active time absent from S14 are not fabricated; actual usage remains unknown. The floor's source digest is fixed across reopen. Effect claims dominate pending/approved cards; executing/claimed/unknown becomes reconcile-only, unclaimed pending cards expire, and contradictory newer revisions refuse. Git/personal outcomes and pending requests remain restricted original facts. Original request IDs are reserved at both the adoption and POLICY owner-command ingress: they can return a safe historical/no-replay result or conflict, never create fresh work.

`reportAdoption` performs no writes, locks or dispatch. `bun src/main.ts adoption --s15 --report --config <plan.json>` and installer `adoption-report --config <plan.json>` read `{directory,source,target}` for the **exact named installation**, return safe counts/build hashes/status, and explicitly report missing external host proof. Config omission remains legacy. Legacy→S15 continuity has no reviewed mapper and returns `transition_legacy_continuity_unsupported` without opening a writable store; it is never silently converted. This is an explicit supported refusal, not a legacy activation claim.

`openAdoptionService` requires protected host composition with current owner authentication and independently observed host/settlement/prior-build-fence evidence. A file/hash cannot supply those authorities. Durable commands are prepare, validate, activate, release, discard and rollback. Validation binds exact source/candidate/policy/build/host observations; activation selects S15 with workers fenced. POLICY starts empty, and only its authenticated `proposePolicy`/`installProposal` can install policy. Release requires that exact installed finite policy. POLICY admission/dispatch calls the coordinator's durable activity guard; non-policy consumers must use that same guard before I/O. Model/guest tools never receive these ports.

Before activity, rollback reselects the unchanged prior installation and removes only this stage's owned fence. Source/current-ledger equality is required; no continuity merge has modified either original. After any S15 activity, policy mutation/revocation or unknown target store, rollback returns `transition_rollback_unsupported`, fences both runtimes and names `transition_new_s15_facts_require_reverse_projection`. There is no untested reverse projection or claim that external actions were undone. Reopen and exact-request retry recover every recorded intent; SIGKILL fixtures cover source fencing, candidate commit, activation, release and rollback boundaries. The old proposed cross-file ledger switch is unnecessary for this constrained preserved-history path.

`tests/s15-adoption.test.ts` contains executable temp-directory/fake-clock/state/sidecar/unknown-schema/private-data/request/usage/effect/crash/restart/SIGKILL evidence. Real Linux storage/power loss, recorded production prior executable, protected guest/browser/egress enforcement and live adoption remain **#340/#341**. No tested local fixture certifies RF15-G01–G08 or authorizes cutover.

## Historical revision-1 audit and proposal

Status: proposed audit contract for [STATE15-01 #319](https://github.com/chayapats/jit/issues/319), 2026-11-02. [ADR 0065](../adr/0065-s15-state-preservation-and-policy-adoption.md) records the engineering choices. Requirements: **FR-04/05/15/16/18/23/35; NFR-05/07/08/12; S15-AC16**. Privacy and enforcement also depend on S15-AC04/07/08/10/13 and ADR 0064; this document does not certify those cases.

This is a static source inventory and a proposed transition/recovery plan. There is no S15 migration implementation, exported transition API, installed policy, accepted host or permission to modify an installation. S14 remains the implemented default. The S14 fresh-state permission in ADR 0045 never authorizes S15 erasure or import. The examples below are synthetic documentation fixtures, not executed tests or installation records.

## Inspected revision and prerequisite

| Item | Exact observation |
| --- | --- |
| Integration main and audit source | `bf59e4c42c182b8a9c8611bdc2b76c44918faa2b` |
| Prerequisite | DOC15-01 #317 closed by merged [PR #343](https://github.com/chayapats/jit/pull/343); merge commit equals the audit source |
| Published S15 planning source | `8ebeca79e0b724e14aa5685b7fe173eb7b675fb7`, included in the integration main |
| Earlier ticket inventory base | `17e5110daf1491f2d1e918fef4cb5b5aec8f8f1b`; rechecked at the audit source above |
| Ownership/work | No assignee, issue comments, related PR or other remote `*319*` branch found at admission; work uses `t3/address-issue-319` |
| Inspection method | Repository text, Git metadata, issue/PR metadata and static table classification; no live SQLite/native/vault/config files opened |
| Artifact revision | This file's Git blob and the containing PR commit identify the delivered audit; record both in the PR. They are distinct from the inspected implementation SHA. |

Source fingerprints (SHA-256 of tracked bytes) make a changed inventory detectable without opening a store:

| Source | SHA-256 |
| --- | --- |
| [S14 store](../../src/s14/store.ts) | `b5ae94e2b0883765360a1f4b0c067d5fa420b8ca774bf54b9cb14bd8c03a733d` |
| [Managed image classification](../../src/s14/ops-image.ts) | `fe6db93b3fb766e7cd556d86a5398034e468074724b06d624a05feca78572733` |
| [Runtime selection](../../src/runtime-selection.ts) | `b0c6603e11945e83bd95e6aab99e6104b2f135dc72009c2757fc05c5a452a4d2` |
| [Legacy store](../../src/store.ts) | `452a3185f1baa5444991309419494bcd08e5c896646d3d04acdd5ed4a4b3a1b5` |

## Implemented identities, stores and compatibility

| Class | Current identity/location | Transition disposition |
| --- | --- | --- |
| S14 main | SQLite header `application_id=0x4a495431`, `user_version=17`; `JIT_S14_DATABASE` or `.local/s14/application.sqlite` in [main.ts](../../src/s14/main.ts) | Only supported source for the proposed S14 history mapping. Preserve source bytes; separate quarantine target. |
| S14 installation | `memory_identity(id)` equals `lifecycle.identity(id)`; `installation(id=1,revision,profile_json)` is separate owner/profile configuration | Preserve installation and object identities; no new identity to evade withdrawals. Source namespace accompanies every imported key. |
| S14 lifecycle | `<database>.lifecycle.sqlite`, attached as `lifecycle`; nine tables below | Current independent ledger, never replaced from an image. Missing, mismatched or incomplete continuity refuses. |
| S14 maintenance | `<database>.ops/{control.json,fence.json,capture.json,online-backups.json}`, registered backups/stages; online journal in [backups.ts](../../src/s14/backups.ts) | Preserve control state/receipts outside images. An unfinished fence must be resolved through its owning protocol before transition. |
| Runtime lock | `<database>.runtime-lock.sqlite` in [runtime-lock.ts](../../src/s14/runtime-lock.ts) | Existing process ownership is not transferable by copying the lock file. Require exclusive source/target admission and actual transport settlement. |
| Native | Sibling `native/`: `contexts/<intent.id>`, `home/`, session storage selected by `<nativeRoot>.session-store.json` or `native/sessions` | Keep opaque references and fixed correlation workspace identity. No raw tree copy, native-byte rewrite, resumed conversation or invented cross-host relocation. |
| S14 computer | Bot/computer/workspace/profile/disk-slot identities and generations; actual paths selected by trusted runtime/service config | Keep private volume ownership and destructive withdrawals. No implicit merge into the shared VM or profile copy. Volumes are outside managed backup. |
| Credentials/owner setup | Protected vault/native credentials, `<database>.owner-setup.json`, transient login/sign-in state | Preserve installation-local custody through separately approved operations; never place them in a candidate image, prompt, guest, ordinary export or audit output. |
| Legacy | [Store](../../src/store.ts) `schemaVersion=45`; no separate application ID set by that store; service state `<stateDirectory>/app.sqlite` | Preserve and continue selecting legacy. No legacy→S15 data mapper is specified. Version number alone cannot identify S14 or grant conversion. |
| Legacy lifecycle | Installation-scoped `lifecycle_ledger`, `lifecycle_checkpoint` plus external `ledgerPath`; see [ops schema contract](ops-schema-migrations-v1.md) | Remains legacy authority; never attach as the S14 ledger or seed S15 policy. |
| Service configuration | [ServiceConfig](../../ops/package/service-config.ts) accepts omitted `runtime` (legacy) or `runtime:"s14"`; no `"s15"` value exists | Keep exact file, runtime and supported prior argv. Do not add a default runtime during parse/repair/upgrade. |

Runtime compatibility is [ADR 0061](../adr/0061-s14-default-selection-and-legacy-compatibility.md), not a new S15 selector: bare source `serve/setup/ops` uses S14, `--s14` remains its alias, explicit `--legacy` and validated `serve --service-config <legacy-config>` retain legacy. Unselected `JIT_DATABASE` refuses with `legacy_database_requires_explicit_runtime`; it never maps to `JIT_S14_DATABASE`. Existing omitted-runtime service config is not evidence that a new default may select S15. No installer/service/default selection changes are delivered here.

[inspectS14Store(path): "missing" | "s14"](../../src/s14/store.ts) reads the fixed header through ordinary file reads. It rejects foreign/old/new headers before SQLite opens. Constructing `S14Store`, `S14Maintenance` or `S14Application` is **not** a read-only audit: those paths can write, reconcile, attach/create state or chmod. Legacy `inspectStoreSchema` uses a readwrite SQLite connection and can create a WAL sidecar. Do not use it to claim untouched live-byte inspection. Future inventory operates on verified, quiesced private copies; this audit uses none of those constructors/helpers.

### Current backup boundary

Implemented contracts are [app.managed-backup/v1](app.managed-backup-v1.md) and [app.restore-activation/v1](app.restore-activation-v1.md), implemented by [ops.ts](../../src/s14/ops.ts), [ops-state.ts](../../src/s14/ops-state.ts), [ops-image.ts](../../src/s14/ops-image.ts), [ops-reconcile.ts](../../src/s14/ops-reconcile.ts) and [ops-ledger.ts](../../src/s14/ops-ledger.ts). They support schema **17→17**, build label `jit/0.1.0`, same installation and same native workspace. The label alone is not an exact executable digest. S14 1–16, future/legacy formats, foreign installations and relocation refuse. `upgrade.prepare {targetSchema:17}` is not an S15 upgrader.

A managed manifest uses `contract:"app.managed-backup/v1"`, `format:"jit.s14/v1"`, `state:"complete"`, `credentials:"excluded_reconnect_required"`; component and artifact sizes/hashes, installation ID, ledger digest/prefix positions and public native version are bound. Artifacts are SQLite BLOBs. Current bounds are 64 MiB application plus serialized native bytes, 1024 native snapshots, 200000 rows/ledger records, 2 MiB control/manifest, ten registered backups and 100 offline receipts. Online capture reserves one backup slot for recovery. These are S14 maintenance limits, not selected S15 execution/spend allowances; no silent unbounded replacement is permitted.

### Complete S14 table inventory

The following groups exactly partition the **81 main tables** declared by `store.ts`. Classification is the current `opsMainTables` backup behavior, not permission to execute or share retained records. Unknown tables, columns/schema objects or record versions require a revised inventory and mapping; an empty unknown table still refuses.

**Retained in credential-free managed images (67):**

```text
artifacts attempt_payload_deletions attempt_usage attention_decisions
attention_notices attention_setting audit bot_computers bot_lifecycle
bot_proposals bots capability_proposals coding_checks coding_jobs
coding_repositories coding_runs computer_activity computer_attempts
computer_operations conversations effect_versions effects external_evidence
git_connection_releases git_effects git_preload_releases grant_state grant_usage
installation memory_access memory_access_history memory_claims memory_contexts
memory_decisions memory_identity memory_shares memory_sources messages
native_intents parallel_settings personal_clients personal_connections
personal_draft_versions personal_drafts personal_effect_observations
personal_grants personal_reads personal_sources proposal_versions reply_outbox
report_reviews reports routine_occurrences routine_results routines
snapshot_shares web_reads work_attempts work_checkpoints work_defaults
work_grants work_graphs work_items work_payload_deletions work_queue
work_results work_steps
```

**Emptied in managed images (12):**

```text
artifact_staging attempt_transports command_receipts computer_inputs
git_reconciliations input_leases login_throttle parallel_connections
parallel_sessions personal_flows reply_transports sessions
```

**Redacted in managed images (2):** `owner` → `password_hash='[reconnect]',generation=0`; `git_connections` → `vault_id=NULL`, JSON `secret='empty'`. Additionally `parallel_settings` resets to anonymous/no connection/no billing acknowledgement. Retained personal connection metadata contains no vault credentials; restoration requires reauthentication. Every retained string/BLOB and public native envelope is scanned for registered/credential-shaped secrets; a hit refuses capture instead of rewriting immutable evidence. Secure deletion/VACUUM removes free-page copies. This does not claim detection of arbitrary unrecognized secrets in prose.

The **nine independent lifecycle tables** are never ordinary backup content:

| Table | Exact row shape / invariant |
| --- | --- |
| `identity` | `(id TEXT PRIMARY KEY)`; must match main `memory_identity` |
| `withdrawals` | `(kind TEXT,id TEXT,mode TEXT,PRIMARY KEY(kind,id,mode))`; immutable identity facts, including effect claims and retained-evidence facts |
| `bot_events` | `(bot_id TEXT,generation INTEGER,revision INTEGER,target TEXT,policy_hash TEXT,PRIMARY KEY(bot_id,generation))`; immutable accepted-generation history |
| `native_intents` | `(id TEXT PRIMARY KEY,record_json TEXT)`; immutable independent correlation catalog |
| `grant_usage` | `(grant_id TEXT PRIMARY KEY,attempts INTEGER,steps INTEGER,calls INTEGER,output_bytes INTEGER,reads INTEGER)`; componentwise monotonic, no delete |
| `routine_usage` | `(routine_id TEXT PRIMARY KEY,consumed INTEGER,last_instant INTEGER)`; componentwise monotonic, no delete |
| `effect_outcomes` | `(effect_id TEXT,action_hash TEXT,revision INTEGER,outcome TEXT,recorded_at INTEGER,PRIMARY KEY(effect_id,action_hash,revision))`; append-only owner statements |
| `git_connection_revisions` | `(connection_id TEXT,revision INTEGER,PRIMARY KEY(connection_id,revision))`; append-only reconnect high-water marks |
| `git_outcomes` | `(effect_id TEXT,action_hash TEXT,record_json TEXT,PRIMARY KEY(effect_id,action_hash))`; immutable Git progress/proof facts |

Current archives carry the digest of all nine tables and prefix count/digest positions for `withdrawals`, `bot_events`, `native_intents`, `effect_outcomes`, `git_connection_revisions`, `git_outcomes`. Usage reconciliation uses the **actual current** monotonic rows, not archived usage as a replacement ledger. Missing prefix, identity mismatch, unknown schema or ledger loss refuses; it is not repaired by trusting manifest-shaped data.

## Record mappings and refusals

All mappings below are requirements for a future implementation. Keep original source identities, historical revisions and byte hashes. A transformed execution/access projection is separate from original history; never edit an old immutable `WorkGrant`, `Attempt.snapshot`, report, artifact or approval action to pretend it was authored under S15.

| Record class and inspected shape | Preserved history | S15 candidate behavior / refusal |
| --- | --- | --- |
| Owner/profile/receipts: `owner.generation`, `installation.revision/profile_json`, `command_receipts(owner_id,request_id,payload_hash,result_json,committed_at)`, `audit` | Persona/preferences and command identity/outcome; verifier and transient sessions stay installation-local | New authenticated adoption binds current owner generation. No imported session, bootstrap link, model-authored persona or automatic replay. Managed archives omit receipts, so retain a protected request/hash continuity catalog separately; missing dedupe continuity blocks activation until accounted for. |
| Bots/proposals: [Bot](../../src/s14/types.ts) `{id,revision,generation,enabled,routeId,capabilities,...}`, proposal/version histories, capability proposals, `bot_lifecycle` | Stable identities and exact accepted ceilings, retirement/deletion/retained-evidence history | Disabled/deleted/retired stays so; deleted IDs never reuse. New S15 enabled generation needs current policy adoption. No old proposal acceptance, route widening or permanent Bot creation from imported text. |
| Conversations/messages/decisions | Conversation/Bot membership, message order, withdrawn-context flags, owner `MemoryDecision` refs/key/pinned status | Membership/owner-role text is history, never fresh authenticated ingress. Withdrawn messages stay excluded. Re-pin only still-current owner decisions; imported decisions are not approvals or executable instructions. |
| Work and graph: [Work](../../src/s14/authority-types.ts), [WorkStep/WorkGraph](../../src/s14/graph-types.ts), result/report pointers, graph dependencies | Purpose/completion rule, actual states/reasons, sibling results, source refs and evidence coverage | Never dispatch imported queue/graph. `proposed/accepted/rejected/stopped/ready` retain obligation meaning; `queued/running/stopping` park blocked after actual settlement; `waiting/blocked` retain reason with execution disabled. S14's cancellation state is `stopped`, not a fabricated `cancelled` enum. Legacy cancelled work remains in legacy. |
| Grants/reservations: `WorkGrant`, `grant_state(grant_id,generation,revoked)`, `grant_usage`, `attempt_usage` | Full immutable original grant, owner/Bot/route/scope snapshots, expiry and charged usage | Every imported grant has revoked execution projection and advanced fence generation. Componentwise max of current/application ledger reservations; unknown actual usage remains null/unknown. Old finite limits/work defaults are historical ceilings, never a fresh S15 budget or refund. Orphan usage rows stay in continuity even if their work payload was deleted. |
| Attempts/checkpoints/transports: [Attempt](../../src/s14/authority-types.ts), [WorkCheckpoint](../../src/s14/recovery-types.ts) | Inputs/config fingerprint/handler version, reservation ID, source/evidence refs and transport uncertainty | No auto-replay, even for an S14 `replay_safe` research step. Preserve unsettled capacity until public retirement/close evidence. Shell/computer/coding/effect and unknown handlers remain never-auto/reconcile-only. Missing original input/config or unrepresentable state refuses. |
| Memory sources/claims: [MemorySource/MemoryClaim](../../src/s14/memory-types.ts) `{id,revision,generation,botId,conversationId,source,derived/dependencies,access,...}` | Source time, attribution, fact/inference, quote/conflicts, producer attempt, transitive source/access/share/computer pins | Bot-private stays private. Filter current lifecycle/access before relevance/imported context. No text-only flattening or automatic re-extraction of forgotten material. Deleted payload stays absent; retain permitted identity/hash only. |
| Access/shares: `MemoryAccess {id,revision,shared,publishedBy,changedAt}`, `MemoryShare`, `snapshot_shares` | Exact publication/access history, receiver, work, expiry, snapshot hash and nontransitive lineage | Existing valid sharing remains at most its original scope. Team adoption cannot broaden a receiver-bound snapshot. Withdrawn/expired access/share and tombstoned resource slots remain unavailable. Already disclosed knowledge cannot be recalled. |
| Reports/artifacts/coding evidence: [report types](../../src/s14/report-types.ts), artifact BLOB/hash/type/size, review acceptance, `coding_*` | Actually-read citations, immutable revisions, check/diff/base/head evidence, limitations and separate owner acceptance | Revalidate original producer/access/computer lineage before inspection/download/context. Unknown/failed/unrun checks remain so. A retained-evidence exception permits authorized owner inspection only, not execution or team publication. Withdrawn descendants and raw duplicate check logs stay unavailable/scrubbed. No workspace-tree import. |
| Resources/accounts: `ScopeRef/ScopePolicy`, [PersonalGrant/PersonalConnection](../../src/s14/personal-types.ts), [GitConnection](../../src/s14/coding-git-types.ts), Parallel settings | Explicit resource/connection/consent revisions, account labels and verification status, repository/commit/registry pins, release audit | Preserve per-Bot/account restrictions unless exactly adopted otherwise. Reconnect/reauth through protected brokers at new revisions; a surviving vault is not renewed consent. Never enable billing/new routes/providers/recipients by import. Pending remote revocation stays unknown with no dispatch. Raw sessions/cookies/tokens are excluded. |
| Computers/input | [BotComputer](../../src/s14/computer-types.ts) generations, workspace/profile/disk-slot IDs, stopped/deleted state and operation/activity history | No imported active lease, input request, running volume, socket or shared profile. Destructive `through_generation_N` fences remain. Missing or different stopped/cleanup identities blocks; no invented stop acknowledgement or copying private disks into the working VM. |
| Routines/attention: [Routine/RoutineOccurrence/AttentionNotice](../../src/s14/routine-types.ts) | Captured command, owner/Bot/scope generations, timezone/recurrence/coalescing, occurrence IDs/results, consumption/cursor, acknowledgement and actual delivery outcome | Active/paused imports block pending new owner enable; revoked/exhausted stay terminal. No backlog replay or renewed occurrence allowance. Consume max high-water marks. Queued/claimed attention becomes unknown/no automatic retry; sent remains sent. No new purpose from a historical routine. |
| Native intents | [NativeIntent](../../src/s14/recovery-types.ts) `{id,attemptId,workId,grantId,botId,computer,contextId,route,reference,state,discovered,mode,reason}` | Exact opaque `HostSessionReference`, discovered identities, retire/delete mode, independent catalog even when absent from image | Metadata-only public inventory/retire/delete/snapshot validation; no submit/reopen/model/tools. Missing saved ref, live lease, partial import, ambiguous absence or failed close remains unresolved and blocks activation. Deleted/not-created only terminal under existing proof rules. |

### Effects: preserve uncertainty before expiring authority

The source [Effect](../../src/s14/authority-types.ts) is `{id,revision,workId,attemptId,botId,action,actionHash,expiresAt,state,resolution?,reason,supported,payloadState?}`. `action` is `{kind,destination,content}`; action revisions remain in `effect_versions`. Reconcile `lifecycle.withdrawals(kind='effect_claim',id,mode='revision_N')` and `effect_outcomes` **before** selecting a candidate state:

| Source/current continuity | Candidate projection |
| --- | --- |
| `pending` or `approved`, no dispatch claim | `expired`; no approval or execution authority survives adoption |
| `pending/approved/executing` with matching claim, or `executing` without conclusive settlement | `unknown`, reconcile-only, never eligible to claim/retry |
| `unknown`, with or without an owner statement | `unknown`; retain statement as `basis:'owner_statement'`, never remote verification |
| `succeeded/failed/denied/expired/changed` with no contradictory newer facts | Preserve terminal outcome and original action/hash/revision; no reissue |
| Conflicting action hashes/revisions/proof, missing required effect payload after deletion, or unknown record shape | Retain safe identity/outcome if provable; otherwise block with an explicit reason, never synthesize a successful/no-effect result |

For Git retain [GitAction/GitProgress](../../src/s14/coding-git-types.ts), including `prepared/verifying/push_dispatching/pushed/pr_dispatching/complete/failed/unknown`, exact old/new refs, connection revisions, optional PR fields and proof basis. `push_dispatching` or `pr_dispatching` cannot become retryable. A known push with uncertain PR remains partial/reconcile-only. `git_reconciliations` is an excluded queued intent, not remote proof. A new GitHub standing rule cannot consume an old exact approval or change its content/destination.

For Gmail/Calendar retain [draft and observation types](../../src/s14/personal-effect-types.ts), exact recipients/content/attachments or event identity/etag/timezone/attendees/notification fields, connection/resource revisions and provider-observation basis. Restored drafts cannot send. Reconnecting a broker or adopting immediate solo edits cannot replay an old held send/calendar action. Owner outcome statements remain distinct from provider read-back. No rollback asserts an email was unsent or a push reversed.

## Explicit owner adoption and policy versions

Policy adoption is independent from history preservation and installation activation. A proposed plan can exist without any authority. The protected service must authenticate the current owner and bind exact current plan/action hashes before a change is accepted; model output, imported receipts/configuration, source text and this contract cannot supply that acceptance.

Use the current installation's owner generation/verifier through the protected owner service, never the managed image's redacted `owner` placeholder. Existing sessions do not transfer. Source command continuity is a separate protected catalog of original request IDs, payload hashes and retained outcomes; no credential-bearing command payload or session token is copied into it. Managed images alone cannot supply this catalog. Old IDs stay reserved even when an outcome's private payload has been withdrawn: return a safe historical/withdrawn outcome or conflict instead of dispatching again.

Required adoption records:

| Field | Required meaning |
| --- | --- |
| `contract`, `revision`, `generation` | New versioned S15 policy; revision/generation never borrowed from an S14 grant or reset by restore |
| `ownerGeneration`, `requestId`, `proposalHash`, `acceptedAt` | Verified current owner ingress and idempotent exact proposal acceptance |
| `source`, `target`, `hostEvidenceHash` | Exact source build/schema/installation/checkpoint, tested target artifact/schema and protected host evidence. Repository SHA alone does not prove the installed binary. |
| `teamConversions` | Explicit resource/snapshot/access revisions, recipients, purpose and restriction treatment; empty by default. Existing private content/accounts stay restricted. |
| `memoryPolicyRevision` | New future retention/extraction policy only; no retrospective team publication or re-extraction of withdrawn content |
| `routePolicyRevision`, `budgetPolicyRevision` | Explicit approved routes/models/pins, finite limits/reservations, unknown usage semantics and no new billing/provider identity |
| `githubRuleRevision` | `null` by default. A separate accepted personal rule binds repositories, target refs, selected issue/start authority, action classes, checks/reviews/evidence, budgets, revocation and production behavior. |

Default GitHub behavior holds push, PR publication/update and review replies; implementation approval supplies no merge authority. Personal publication and eligible auto-merge require their separately captured rule. Production always waits, including before merge if merge would deploy without an enforceable production gate. Neither an old `effect_push` capability, approved exact action, repository `AGENTS.md` nor this owner's product interview installs a standing exception.

New team work can use adopted team resources without per-Bot repetition, while explicit narrower restrictions remain. Conversion of old private material is exact and prospective: new revision/projection records the accepted scope while old provenance/withdrawals remain. A recipient/resource/content revision change requires a new match; account consent and new private-data-recipient approvals remain independent. Do not create broad conversions for all existing and future Bot data.

## Proposed schema and migration seams

These names/shapes are **design deliverables**, not existing code. Proposed implementation locations are `src/s15/state-transition-types.ts`, `src/s15/state-transition.ts` and `tests/s15-state-transition.test.ts`; none exists in the audited base. MIG15-01 must freeze actual exported TSDoc, protocol fixtures and the full target DDL against reviewed POLICY15/TEAM15/MEM15/VM15 contracts before ready-for-agent.

Proposed format reservation: S15 `application_id=0x4a495432`, initial `user_version=1`, distinct from S14 17 and legacy 45. This reserves a proposed identity, not a supported header or instruction to set PRAGMA. The physical target must be a separate protected location chosen under ARCH15-01, not the administrable working guest. Do not introduce a live path/environment default or rewrite `ServiceConfig` in this audit. A different accepted target identity requires a new reviewed contract revision.

The transition-owned part of target schema 1 is proposed as:

```sql
CREATE TABLE transition_origin (
  id INTEGER PRIMARY KEY CHECK(id=1), record_json TEXT NOT NULL
);
CREATE TABLE transition_history (
  source_table TEXT NOT NULL, key_json TEXT NOT NULL,
  source_hash TEXT NOT NULL, row_json TEXT NOT NULL,
  PRIMARY KEY(source_table,key_json)
);
CREATE TABLE transition_projection (
  source_table TEXT NOT NULL, key_json TEXT NOT NULL,
  record_json TEXT NOT NULL, PRIMARY KEY(source_table,key_json),
  FOREIGN KEY(source_table,key_json)
    REFERENCES transition_history(source_table,key_json)
);
```

`transition_history` carries only validated credential-free source rows, including empty/redacted policies above. It is protected history, not a runtime queue or policy table. Projections are separate; original `record_json` strings/artifact bytes remain exact. These tables do not define the complete S15 runtime schema. Unknown target schema hash or missing typed domain materializer blocks staging/activation; do not label this partial DDL a working S15 store. Independent lifecycle/usage and transition/adoption receipts stay outside images under the continuity protocol below, never as replacement authority in `transition_history`.

Proposed pure mapping signatures and record shapes:

```ts
// Proposed types only. Existing source domain types retain their S14 meaning.
type Sha256 = string; // Exactly 64 lowercase hex characters, validated at ingress.
type SqlCell = null | { text: string } | { integer: string }
  | { real: string } | { blobBase64: string };
type RowKey = readonly SqlCell[]; // In declared primary-key column order.
interface SourceRowV1 {
  table: string; key: RowKey;
  cells: readonly (readonly [column: string, value: SqlCell])[];
  sha256: Sha256;
}
interface BuildV1 { commit: string; artifactSha256: Sha256 }
interface SourceV1 {
  runtime: 's14'; applicationId: 0x4a495431; schema: 17;
  installationId: string; build: BuildV1;
  schemaHash: Sha256; checkpointHash: Sha256; ledgerHash: Sha256;
}
interface TargetV1 {
  runtime: 's15'; applicationId: 0x4a495432; schema: 1;
  build: BuildV1; schemaHash: Sha256; contractsHash: Sha256;
}
interface AdoptionProposalV1 {
  ownerGeneration: number; policyRevision: number;
  hostEvidenceHash: Sha256;
  teamConversions: readonly {
    kind: 'resource' | 'claim' | 'source' | 'artifact'; id: string;
    revision: number; generation: number; snapshotHash: Sha256;
    receiverBotIds: readonly string[]; purpose: string;
  }[];
  memoryPolicyRevision: number; routePolicyRevision: number;
  budgetPolicyRevision: number; githubRuleRevision: number | null;
}
interface SnapshotV1 {
  source: SourceV1; rows: readonly SourceRowV1[];
  currentLedgerRows: readonly SourceRowV1[];
  requestContinuityHash: Sha256; nativeInventoryHash: Sha256;
}
type DispositionV1 = 'preserve_restricted' | 'history_only'
  | 'blocked' | 'revoked' | 'expired' | 'reconcile_only'
  | 'withdrawn' | 'excluded';
interface ProjectionV1 {
  table: string; key: RowKey; sourceHash: Sha256;
  disposition: DispositionV1; reason: string;
  // Hashes/IDs, no raw credential, payload or host path in public plans.
  dependencies: readonly { table: string; key: RowKey; hash: Sha256 }[];
}
interface TransitionPlanV1 {
  contract: 's15-state-transition/v1'; source: SourceV1; target: TargetV1;
  proposalHash: Sha256 | null; projections: readonly ProjectionV1[];
  requestContinuityHash: Sha256; nativeInventoryHash: Sha256;
  refusals: readonly { code: string; table: string | null; key: RowKey | null }[];
  planHash: Sha256;
}
interface ObservationV1 {
  sourceCheckpointHash: Sha256; currentLedgerHash: Sha256;
  candidateHash: Sha256; candidateLedgerHash: Sha256;
  nativeInventoryHash: Sha256; requestContinuityHash: Sha256;
  targetSchemaHash: Sha256; projectionsHash: Sha256;
  allTransportsSettled: boolean;
}
type ValidationV1 = { state: 'refused'; codes: readonly string[] }
  | { state: 'validated'; planHash: Sha256; observationHash: Sha256 };

/** Maps verified source rows without I/O, authority creation or worker dispatch. */
declare function planS14ToS15(
  snapshot: SnapshotV1, target: TargetV1,
  proposal: AdoptionProposalV1 | null
): TransitionPlanV1;
/** Rechecks exact source/candidate/continuity observations; grants no activation. */
declare function validateS15Transition(
  plan: TransitionPlanV1, observation: ObservationV1
): ValidationV1;
```

Serialization must be frozen with fixtures: finite safe-integer revisions/generations/timestamps; full Git commit IDs; exact known table/column order; typed canonical SQL cells (integers as canonical decimal strings, finite reals in one reviewed round-trip representation, canonical base64 BLOBs). Hash UTF-8 canonical JSON with sorted object keys and preserved array order, using [canonical/digest](../../src/s14/validation.ts) only within their existing per-record limits. Whole snapshots/plans can exceed that helper's 128 KiB/array bounds: freeze a bounded streaming serializer or chunked manifest with equivalent exact canonical bytes before implementation; do not raise the ordinary command/receipt limits. A row hash covers `{table,key,cells}`; verify key equality to declared PK cells. Sort table/key entries by a frozen byte ordering and reject duplicate keys. Schema hashes include tables/indexes/triggers/constraints, not just header/version. A plan hash covers all plan fields except itself. No lossy JS-number coercion, text normalization, JSON parse/restringify of historical `record_json`, missing dependency or unhashed BLOB is acceptable.

`transition_origin.record_json` is `{contract,source,target,planHash,proposalHash}`. `transition_history.row_json` is canonical `{cells: SourceRowV1['cells']}`; reconstruct the row with its separately stored table/key/hash and rehash before materialization. `transition_projection.record_json` is canonical `ProjectionV1`. Real payload never enters a public plan; IDs/hash manifests remain owner-only and subject to private-data rules.

The protected control journal is separately versioned, append/dedupe protected and not an archive authority:

```ts
interface TransitionStageV1 {
  contract: 's15-state-transition/v1'; id: string; revision: number;
  state: 'preparing' | 'validated' | 'activating' | 'active_fenced'
    | 'complete' | 'blocked' | 'discarded' | 'rolling_back';
  planHash: Sha256; sourceCheckpointHash: Sha256;
  currentLedgerHash: Sha256; candidateHash: Sha256 | null;
  candidateLedgerHash: Sha256 | null; actionHash: Sha256 | null;
  validatedObservationHash: Sha256 | null; hostEvidenceHash: Sha256;
  adoptionReceiptHash: Sha256 | null; rollbackActionHash: Sha256 | null;
  priorSelectionHash: Sha256; targetSelectionHash: Sha256;
  continuityGeneration: number; adoptedPolicyHash: Sha256 | null;
  workerReleaseRecorded: boolean; reason: string | null;
}
type TransitionCommandV1 =
  | { kind: 'transition.prepare'; requestId: string; expectedRevision: number;
      payload: { planHash: Sha256 } }
  | { kind: 'transition.validate' | 'transition.discard'; requestId: string;
      expectedRevision: number; payload: { stageId: string } }
  | { kind: 'transition.activate' | 'transition.rollback'; requestId: string;
      expectedRevision: number; payload: { stageId: string; actionHash: Sha256 } };
```

These command envelopes are proposed offline maintenance data, not owner actors or callable endpoints. POLICY15-01 must supply the supported opaque authenticated-owner contract and MIG15-01 must freeze the mutation-port signature and worker-release command/receipt before implementation admission. Structural JSON, a valid hash or pure `ValidationV1` cannot grant activation. `actionHash` must bind stage/revision, plan, source/target selections, both ledger states, candidate/native/request-continuity digests, adoption revision and actual tested host evidence. Every field is rechecked immediately before mutation. Worker release is a separate protected, durable barrier after activation/recovery; no omitted API may be filled by a model or shell script.

`transition.rollback` requires fresh current owner authentication and its own exact reverse-plan acceptance. Its payload `actionHash` must equal the stage's current `rollbackActionHash`, bound to the latest continuity and reverse projection; the original activation hash or adoption receipt is insufficient. Request IDs for transition/adoption remain protected across backup/restore/rollback, with changed payloads refused.

Proposed refusal vocabulary is separate from existing S14 error codes:

| Proposed code | Required refusal |
| --- | --- |
| `transition_source_unsupported` | Wrong/missing/malformed source identity/version, legacy import or unreviewed build |
| `transition_schema_unreviewed` | Changed/unknown schema object, column, table, record shape or incomplete target materializer |
| `transition_continuity_unavailable` | Missing/conflicting identity, ledger prefix, request catalog or current continuity generation |
| `transition_settlement_required` | Actual transport/native/computer cleanup not conclusively settled |
| `transition_adoption_required` | No exact current authenticated adoption, host proof or required finite policy |
| `transition_stale_validation` | Source, candidate, ledger, policy, schema, native or selection digest drift |
| `transition_integrity_failed` | Size/hash/row/FK/artifact/provenance invariant fails |
| `transition_rollback_unsupported` | Prior build cannot consume all current facts or honor the protected fence |

Return safe reasons and identities only; no raw provider error, credential or private payload. Existing S14 fences/errors keep their existing protocol rather than being cleared or reinterpreted as a transition stage.

## Continuity, checkpoints and recovery

Proposed ordering follows current receipt/fence/quarantine mechanisms, with a new reviewed cross-runtime coordinator. It must live beyond working-agent administration under ADR 0064. During prepare/validate/discard, source application/current ledger/native selection stay unchanged and candidate-derived facts stay private. A single authority pointer plus generation/fences must prevent S14 and S15 from independently becoming current. A ledger copy alone is not that protocol.

| Checkpoint | Required durable facts and evidence | Failure / recovery behavior |
| --- | --- | --- |
| C0 — admission | Exact source/target builds, schema object hashes, installation, named service config/argv, policy/host evidence; no unfinished owning maintenance fence | Unknown source/version/host or runtime selection refuses before writable open. No broad filesystem scan or secret inspection. |
| C1 — quiesced source | Stop admissions, fence both runtimes, settle actual transports/native leases, record main/ledger/native/config selections and complete bounded file/hash inventory | Busy/unknown settlement blocks. Timeout does not release capacity. No automatic cancel/kill success claim. |
| C2 — recovery points | Credential-free registered application/artifact/public-native backup plus independently protected current continuity; private prior build/config/state recovery point with exact sizes/hashes | Capture failure never publishes a complete point. Original database, journals, profiles/volumes, credential stores and legacy installation remain in custody, outside ordinary export. |
| C3 — candidate | Separate target; mapping/refusal manifest, private current-ledger copy, explicit adoption proposal; reconcile withdrawals/usage/outcomes/native cleanup | Failure/discard leaves source and actual ledger unchanged. Candidate rows never become a live source of policy or a replacement ledger. |
| C4 — validation | FK/integrity/schema/row/artifact hashes, provenance/restriction checks, request dedupe continuity, public native inventory/close, exact action hash | Drift/partial native import/missing cleanup stays fenced. Revalidate from immutable source with the latest ledger; do not reuse stale validation. |
| C5 — owner activation intent | Current protected owner accepts exact plan/host/policy; durable intent includes prior/target selections and continuity generation | Crash before durable intent cannot publish candidate facts. Same request/hash retries dedupe; changed payload conflicts. |
| C6 — ledger and selection handoff | Idempotently append/merge validated facts with usage maxima; verify prior/target ledger digest; atomically select target app/native/policy under external fence | Crash between ledger and application/native/policy switches stays fenced. Accept only exact recorded prior or target hashes; any third state refuses. Never replace current history with old ledger bytes. |
| C7 — active, workers fenced | Reconcile active target and verify exact selected build/schema/host/policy/continuity; write activation receipt | No model, chat, routine, effect, queue or notification pump before this barrier. Pre-release rollback must prove it can restore the recorded prior selection while retaining C6 facts. |
| C8 — worker release | Separate protected receipt binds fully reconciled current generation and finite current authority | Imported work stays disabled. First new work uses current owner request/policy. Post-release rollback needs current-knowledge reverse compatibility, below. |

Before C5, discard removes only stage-owned data, not source/ledger/registered recovery points. After C5, recovery resolves the recorded intent under fences; it does not silently choose whichever database opens. After C6, a rollback cannot restore an old independent ledger, even if no workers ran: quarantine may already have appended withdrawals or advanced usage. After C8, S15-only lifecycle/effect/usage/policy facts must also survive.

Prior-build rollback is supported only after a reviewed reverse projection demonstrates that the **actual previous executable** can safely consume the selected source format and current continuity state. Preserve source checkpoint bytes separately; apply any necessary monotonic reconciliation to a new rollback candidate, never overwrite the sealed original. Old receipts cannot become fresh dispatch, old private data cannot become readable, new/unknown effects cannot disappear, and disabling a new personal rule must not refund its usage. An unrepresentable S15 fact, unresolved external/native operation or old build unable to honor the boot fence returns proposed `transition_rollback_unsupported`; leave both runtimes fenced with an actionable recovery reason. Evidence-only access/recovery is not successful executable rollback. The rollback-before-worker-release path is a required MIG15-01 acceptance gate; unrestricted rollback after S15 activity is not currently promised.

Neither current S14 managed backup nor opaque-native snapshots cover working-volume/profile restoration or native-workspace relocation. If ARCH15 placement moves native state, require a supported Schway contract and exact adapter evidence, or keep those historical sessions retired at their original protected location. No internal parser or filesystem symlink trick supplies relocation support.

## Documentation fixtures: input → required output

Fields shown are exact source fragments or mapping observations, not complete insertable records. Omitted fields must be supplied by the eventual typed fixture builder; omission is not a production default. All IDs/limits are synthetic. Expected outputs describe candidate projections; source history bytes remain unchanged. None of these fixtures has been executed by this documentation change.

| ID | Input | Required output / observation |
| --- | --- | --- |
| ST15-F01 | Header `0x4a495431/17`, known schema, matching installation/current ledger, accepted work and no adoption proposal | Preserve restricted history; zero admitted work/effects; no standing team conversion/GitHub exception; activation blocked pending adoption/target contracts. |
| ST15-F02 | Valid legacy service config with `runtime` omitted; legacy schema 45 | Selection remains legacy; config bytes/argv unchanged; S14→S15 mapper returns `transition_source_unsupported` if asked to import it. No fresh-state erase/import. |
| ST15-F03 | S14 application IDs with schema 16 or 18; legacy header, malformed header or unknown empty table | `transition_source_unsupported` or `transition_schema_unreviewed` before writable candidate/control/lock creation. Original bytes and sidecars unchanged. |
| ST15-F04 | `MemoryAccess {id:'claim-a',revision:2,shared:false,publishedBy:null,...}`, source/claim Bot A; new team policy | Bot B cannot retrieve/download/use it. Only an exact separately accepted conversion of current eligible revisions can create a new broader projection. |
| ST15-F05 | Old image contains source/claim and report/file; current ledger has `('source','source-a','forgotten')` or `('claim','claim-a','deleted')` | Exclude withdrawn lineage from retrieval/re-extraction/handoff; deleted bytes remain absent; report acceptance and duplicate raw evidence invalidate. Original permitted owner inspection follows existing forget/delete distinction. |
| ST15-F06 | Old active access/share plus current `('access','claim-a','revision_2')` or `('snapshot_share','share-a','revoked')`; receiver-bound snapshot has a valid old hash | Share stays unavailable, slot identity cannot reuse, downstream sources/artifacts/native contexts stay fenced, no team default bypass. |
| ST15-F07 | Work `stopped`, grant revoked; or work only `accepted/proposed/rejected`; queued graph sibling with prior committed result | Retain obligation/result and actual state; no automatic start/retry/synthesis. Committed sibling evidence stays available only under current lineage. |
| ST15-F08 | `effects` is `approved` rev 1; current `withdrawals` has `('effect_claim','effect-a','revision_1')`; no verified outcome | Candidate `unknown/reconcile_only`, no send/push/PR/calendar calls, approval cannot be reused. Without claim, unexecuted approved card expires. |
| ST15-F09 | Unknown effect has outcome statement `{basis:'owner_statement',outcome:'did_not_occur',...}`; Git push known/PR uncertain | Remain unknown or known-partial with statement/proof basis preserved; no retry or assertion that remote action did not occur. |
| ST15-F10 | App usage `{attempts:1,steps:1,calls:3,output_bytes:100,reads:2}`; current ledger `{attempts:2,steps:1,calls:7,output_bytes:200,reads:5}` | Candidate minimum `{attempts:2,steps:1,calls:7,output_bytes:200,reads:5}`; actual usage unknown remains unknown. No reset under new grant/policy ID. |
| ST15-F11 | Routine captured ten occurrences; image consumed 2; current `routine_usage` consumed 6 and later `last_instant`; queued/claimed attention | At most four old occurrences remain as historical allowance, routine blocked pending fresh enable, current cursor/occurrence dedupe preserved; no backlog/send replay. New enable cannot refund prior consumption. |
| ST15-F12 | Archived enabled Bot gen 3 but later `bot_events` gen 4 retired/deleted, or computer withdrawal `through_generation_4` with no matching confirmed stopped/deleted identities | Bot remains disabled/deleted; old computer/lease cannot start. Missing cleanup evidence blocks activation; no generation/slot reuse. |
| ST15-F13 | Personal/Git metadata with surviving vault, old approved card; pending remote revocation; anonymous Parallel archive | Reauth/reconnect at new revisions; old cards expired/claimed unknown; pending remote revoke unknown/no dispatch; Parallel stays anonymous. Vault survival grants no access. |
| ST15-F14 | Null personal GitHub rule; then exact new scoped rule for repository/target/selected issue | First case holds publication and grants no merge. Second requires protected rule match/current checks and evidence; production-triggering merge still held without effective approved deployment gate. |
| ST15-F15 | Missing/mismatched ledger, missing archived append prefix, orphan usage/native identity, changed source/ledger between validate and activate | Missing/conflicting continuity refuses. Retain orphan identities/counters and unsettled capacity. Drift requires revalidation/new exact action hash; no empty-ledger bootstrap. |
| ST15-F16 | Native partial restore, changed snapshot, missing saved ref, failed close, new VM/path | Fenced with explicit native/relocation reason; no native rewrite, inference/tool execution or successful activation claim. |
| ST15-F17 | Crash at each C2–C8 boundary, including C6 ledger committed before application/native/policy pointer | Same authenticated request/hash resolves recorded prior/target only. Both runtimes stay fenced through mixed state; no dual writer or duplicate dispatch. Pre-intent discard leaves actual ledger unchanged. |
| ST15-F18 | Roll back before worker release, then attempt rollback after a new S15 withdrawal/unknown effect or rule revocation | First requires actual prior build plus current-ledger reconciliation and byte/config evidence. Second preserves every newer fact via tested reverse projection or returns `transition_rollback_unsupported`; no raw old-image boot. |
| ST15-F19 | Managed image omits `command_receipts`; repeated original owner request arrives at S15/new rollback candidate with same/different payload hash | Protected continuity returns original outcome or request conflict, never new work. Missing request continuity blocks admission; source receipt text never authenticates a new request. |

Example effect and usage projections (S14 snake-case usage column names are intentional):

```json
{
  "input": {
    "effect": {"id":"effect-a","revision":1,"state":"approved","actionHash":"<sha256>"},
    "withdrawal": {"kind":"effect_claim","id":"effect-a","mode":"revision_1"},
    "applicationUsage": {"calls":3,"reads":2},
    "currentLedgerUsage": {"calls":7,"reads":5}
  },
  "expected": {
    "effectState":"unknown",
    "disposition":"reconcile_only",
    "claimedAgain":false,
    "minimumUsage":{"calls":7,"reads":5},
    "actualUsage":null,
    "externalCalls":0
  }
}
```

`<sha256>` is a documentation placeholder, not valid production input. Real fixtures must use valid exact action hashes and complete typed records; malformed placeholders must refuse.

## Evidence required from implementation and adoption

Existing deterministic evidence locations were inspected as source, **not rerun** for this audit:

| Existing tests | Relevant seams; limits |
| --- | --- |
| [s14-ops.test.ts](../../tests/s14-ops.test.ts) | Complete table classification; credential-free images/public native round trip; stale-image deletion/forget/shares/Bot/computer/usage/effect reconciliation; quarantine/discard isolation; cutover kill/fault windows; current-ledger rollback; personal/Git reconnect; boot/capture fences. These prove only their named S14 cases when run. |
| [runtime-selection.test.ts](../../tests/runtime-selection.test.ts), [s14-service-installer.test.ts](../../tests/s14-service-installer.test.ts) | Default/alias/legacy and omitted-runtime compatibility, prior argv, refusal before state; no S15 selector evidence. |
| [s14-recovery.test.ts](../../tests/s14-recovery.test.ts), [s14-bot-lifecycle.test.ts](../../tests/s14-bot-lifecycle.test.ts), [s14-memory.test.ts](../../tests/s14-memory.test.ts), [s14-reports.test.ts](../../tests/s14-reports.test.ts) | Reservations/native/transport recovery, generation fences, withdrawal/private lineage, report/artifact gates; no S15 automatic memory/team adoption evidence. |
| [s14-coding-git.test.ts](../../tests/s14-coding-git.test.ts), [s14-personal-effects.test.ts](../../tests/s14-personal-effects.test.ts) | Exact-action/progress/proof-basis and no-blind-retry seams; not new standing GitHub or immediate-edit authority. |

MIG15-01 must turn ST15-F01–F19 into deterministic Bun/TypeScript fixtures using scripted models, protocol barriers and fake clocks. Verify complete known/unknown table/column/trigger classification, typed row round trips, every work/effect state, orphan ledger rows, both approval/claim ordering cases, stale adoption/owner/route/Bot generations, duplicate request conflicts, and absent/present/revoked personal rules. Run focused fixtures, `bun run typecheck`, `bun test`, and `git diff --check` on the final implementation commit. Paid/live/provider/host calls remain opt-in. A documentation fixture is not passing evidence.

Byte-preservation evidence must name all compared files, sizes and SHA-256 digests, consistent capture method, exact executable/artifact/config/argv and comparison windows. Verify the complete selected legacy installation and preserved S14 main/ledger/journals/native/volume/profile/control/config recovery set as appropriate to the operation, including SQLite sidecar existence and contents. Never hash an actively changing main file alone and claim a consistent store; quiesce/settle and capture the correct journal mode. Do not delete a WAL/journal to force equality. Separate expected owner-authentication/control-journal changes from unchanged payload bytes with complete inventories and reasons. Native management may intentionally retire/delete withdrawn sessions only under its recorded authority; that is not byte equality with the earlier native state.

At minimum compare source before/after prepare, failed/partial validation, discard, activation, first S15 result, interrupted-activation recovery and prior-build rollback. Preserve sealed original checkpoints throughout; rollback into a reconciled candidate may intentionally differ from the sealed original to retain newer lifecycle/usage facts. Prove both the preserved checkpoint equality and the exact allowed differences in the candidate. Rehearse the **recorded prior executable** with its original supported config/argv, observe actual health and retained evidence, then prove target reactivation under current continuity. A symlink change, HTTP success alone, snapshot availability or prior Pi S14 cutover is not S15 rollback acceptance.

Schway pin: [vendor artifact](../../vendor/schway-1.0.0-rc.2-697bf40.tgz), upstream `697bf406a84c8d1deb8d4a6d71876ea1003be5b3`, SHA-256 `1c9d83de46edddff58a0163452e7f5ec8357e656c90093990fa28fa606a0f41b`; public `schway/host` release/v2, credential-lifecycle/v1, session-inventory/v1, session-snapshot/v1, native format **4**. Inspected adapters: [ops-native.ts](../../src/s14/ops-native.ts), [native-recovery.ts](../../src/s14/native-recovery.ts). Snapshot/inventory/retire/delete/close do not authorize Jit to parse native storage or relocate workspaces. Verify the public contract again on the eventual target artifact; propose a Schway change for an actual missing host requirement.

Real Linux x64/arm64 storage/power-loss/VM-admin isolation, protected browser/effect/disclosure bypass resistance, target host/build acceptance and provider/account readiness are **not run or certified here**. Installation addresses, actual evidence inventories and any private hashes/IDs belong in ignored `.local/` records; public reports carry sanitized evidence references. Do not inspect or publish secret values to fill an inventory.

## Downstream freeze gates

| Gate | Required owner/delivery | Readiness effect |
| --- | --- | --- |
| Protected placement and old-build fence | [ARCH15-01 #318](https://github.com/chayapats/jit/issues/318), [VM15-01 #321](https://github.com/chayapats/jit/issues/321) | Current/target ledger custody, guest isolation, source/target single-writer enforcement and supported native placement must be accepted and tested. |
| Target policy/actor/adoption contract | [POLICY15-01 #320](https://github.com/chayapats/jit/issues/320), [GIT15-02 #329](https://github.com/chayapats/jit/issues/329) | Freeze actual policy versions/opaque owner authentication, finite budget/rule schemas, revocation, exact-action and worker-release contracts. No live defaults from this proposal. |
| Complete target data model/materializers | [TEAM15-01 #324](https://github.com/chayapats/jit/issues/324), [MEM15-01 #325](https://github.com/chayapats/jit/issues/325), [MIG15-01 #336](https://github.com/chayapats/jit/issues/336) | Full source→target typed record/DDL map, source/target schema hashes and supported migration/mutation signatures must exist, including private/restricted projections and continuity/receipt catalog. Proposed transition tables alone are insufficient. |
| Continuity and reverse compatibility | MIG15-01 | Freeze ledger handoff, command dedupe, journal/selection protocol, crash recovery and rollback-before-worker-release. Unsupported post-activity rollback must fail closed. |
| Exact-build adoption | [EVID15-01 #340](https://github.com/chayapats/jit/issues/340), [CUT15-01 #341](https://github.com/chayapats/jit/issues/341) | Tested build/artifact, policy, real host, complete preservation/rollback evidence and explicit owner cutover are required before activation. |

The source inventory, mapping/refusal rules and recovery requirements satisfy the scope of this read-only audit. None removes the gates above or makes a dependent ticket ready solely because #319 closes. UI/UX remains separately authored under UX15-00; no design or handoff is supplied here. Jod interoperability stays deferred. This contract changes no runtime, schema, default, FR/NFR identifier or live authority.
