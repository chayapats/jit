# [Frontier] Refine #414 for correlated restart recovery

Status: follow-up brief for existing [Schway #414](https://github.com/chayapats/schway/issues/414), which is open. Do not create a duplicate issue. Parent: [Jit S14 #244](https://github.com/chayapats/jit/issues/244).

## Existing gap

A native session can persist before Jit commits its returned reference. A crash in that window leaves an unaddressable application intent and a native session that the supported host cannot enumerate. Current Jit lifecycle correctly remains unresolved rather than reporting deletion success.

S14 permits automatic recovery only after native work is discovered/reconciled and the original authority and budget remain valid. It does not authorize Schway to resume application jobs.

## Acceptance refinement to apply to #414

- [ ] Provide either validated caller correlation at creation plus lookup/idempotent recovery, or scoped metadata enumeration sufficient to identify all service-owned sessions, including creation-before-app-commit orphans.
- [ ] Define collision, duplicate create, pagination, store/workspace scope and retired/deleted identity behavior. No metadata read starts a model or executes tools.
- [ ] Discovery exposes only opaque native metadata; no transcript, credential or unrelated workspace enumeration is needed.
- [ ] Existing exclusive leases, retire/delete idempotency and snapshot quarantine remain intact. Discovery does not bypass a still-live lease.
- [ ] A deleted/forgotten app context can retire/delete a newly discovered orphan; discovery must not resurrect permission or retained content after lifecycle revocation.
- [ ] Fixtures crash before creation, after native persistence/before app correlation, after correlation and during retirement/deletion; reconcile converges or reports a precise unresolved state.
- [ ] Supported public declarations, capability/version, stability policy and packed-consumer conformance describe the exact behavior.

## Jit responsibilities

Persist the correlation intent before native creation; fence prior attempts on startup; verify current grant/source/config/remaining budgets; account unknown usage conservatively; run only trusted replay-safe handlers after reconciliation. Unknown external effects remain reconcile-only.

## Definition of done

The supported artifact/capability and deterministic conformance land; Jit pins them and proves discovery → fence/retire → replay-safe resume without private source access. A merged issue alone does not certify live reboot or external exactly-once behavior.
