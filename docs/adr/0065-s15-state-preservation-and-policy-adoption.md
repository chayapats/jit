---
status: proposed
date: 2026-11-02
scope: STATE15-01 (#319); S15-AC16; FR-04/05/15/16/18/23/35; NFR-05/07/08/12
---

# Preserve state separately from S15 policy adoption

## Confirmed inputs and inspected implementation

[S15](../specs/S15-conversational-autonomy.md) requires explicit adoption with preserved S14/legacy data, private scopes and rollback. It does not authorize conversion, deletion, team publication or installation of the personal GitHub exception. [ADR 0064](0064-conversational-authority-and-protected-control-plane.md) still requires protected authority, browser and guest-administration proofs.

The read-only source audit for [#319](https://github.com/chayapats/jit/issues/319) inspected main `bf59e4c42c182b8a9c8611bdc2b76c44918faa2b`. DOC15-01 [PR #343](https://github.com/chayapats/jit/pull/343) is merged in that base. S14 is application ID `0x4a495431`, schema 17, with 81 main tables and nine independent lifecycle tables. Legacy is schema 45 with its separate installation-scoped lifecycle contract. Current managed S14 restore supports 17→17 in the same installation/native workspace; it provides no S15 migration or relocation contract.

The [transition inventory and recovery contract](../contracts/s15-state-transition-v1.md) records exact source paths, record mappings, proposed signatures, illustrative fixtures and implementation gates. No store was opened, secret inspected, probe added or installation changed in this audit.

## Proposed engineering

1. **Copy into quarantine; preserve the source.** Reserve a distinct S15 format and protected target. Do not mutate an S14 header, route legacy into S14/S15, or use an S14 fresh-state refusal as permission to erase/import. Preserve original files and prior executable/configuration independently of credential-free managed images. A source copy is evidence, not a second running installation.
2. **Carry history without carrying execution authority.** Preserve record identities, immutable input/evidence bytes, privacy/access revisions, lineage, charged reservations and terminal/reconcile-only outcomes. Imported obligations and grants do not dispatch. Pending approvals expire; previously claimed/uncertain effects remain reconcile-only. New execution requires current S15 owner authority and standing policy. No numeric S15 budget is inherited as a new allowance.
3. **Adopt scope explicitly.** Default adoption retains existing private material and narrow account/Bot restrictions. Team conversions bind exact resources/content revisions and recipients. Enabling future automatic team memory does not publish old private claims. A personal GitHub rule is an independent, bounded, revisioned opt-in; absence means product-default publication holds and no merge authority.
4. **Keep one current continuity authority.** A protected transition coordinator fences both runtimes and records which ledger generation is authoritative. During validation the current S14 ledger remains authoritative and candidate facts stay private. A future ledger handoff must preserve its complete prefix, monotonic counters and newly appended facts. After handoff the prior ledger is a checkpoint, never an alternate current ledger. S15-only facts and transition receipts remain outside ordinary backup images. The exact placement, handoff protocol and old-build boot fence need ARCH15/POLICY15/MIG15 implementation proof.
5. **Make rollback conditional on current knowledge.** Before activation intent, discard can select the preserved prior runtime after verifying source/ledger/configuration equality and native settlement. After activation intent, including before worker release, rollback must retain any continuity facts already committed by cutover. Once S15 records activity, a raw database or executable switch is insufficient. A reviewed reverse projection must preserve all newer withdrawals, usage, effect/delivery outcomes and policy revocations, and the prior build must enforce them. If any fact is unrepresentable or a native/effect outcome is unsettled, executable rollback refuses and both runtimes remain fenced. Recoverable files do not prove that external effects were undone.

These are reviewable choices, not implemented S15 APIs or an accepted physical control-plane design. The proposed target identity and transition-owned record shapes are specified in the contract; the complete S15 runtime schema and protected maintenance actor/ports remain explicit downstream freeze gates. Closing #319 alone does not make MIG15-01 ready-for-agent.

## Alternatives and consequences

- In-place S14 schema/header rewriting loses an independently usable prior format and risks changing authority by interpretation. It is excluded from this proposal.
- Importing old grants, approvals, account bindings or repository defaults as standing S15 policy silently widens authority. Historical records remain evidence; owner adoption creates new policy revisions.
- Copying an old lifecycle ledger back during rollback refunds reservations and revives withdrawn data. Current continuity facts must win in both directions; an unsupported reverse transition stays blocked.
- Rebuilding native records or moving native workspaces by editing their bytes violates Schway ownership. Use the pinned public snapshot/inventory/lifecycle APIs only. A new VM does not establish native relocation support.
- A separate candidate costs bounded storage and requires an explicit single-writer handoff. This cost is preferable to claiming rollback or privacy preservation without evidence. Actual capacity, limits and platform evidence must be frozen before implementation admission.

## Required evidence and limits

MIG15-01 must exercise the contract fixtures and every durable cutover boundary, including independent-ledger changes and prior-build rollback before worker release. EVID15-01/CUT15-01 must name actual build/artifact hashes, policy revisions and host, verify complete byte-preservation windows and demonstrate the recorded previous executable/configuration. Post-activity rollback requires additional reverse-compatibility evidence; otherwise report the precise refusal.

This ADR supplies no UX design, host acceptance, live policy, migration implementation, credential transfer or permission to merge/deploy. Requirements and S15-AC16 remain unchanged.
