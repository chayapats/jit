---
status: proposed
date: 2026-11-02
scope: POLICY15-01 (#320) step 1 preparation; FR-06/13/14/15/17/18/35/37/38; NFR-05/06/07/14
---

# Standing policy, opaque actors and prepared actions

## Confirmed inputs and bounded status

[S15](../specs/S15-conversational-autonomy.md) permits requested ordinary work under standing owner policy and requires protected human gates. Task acceptance, work authority and final approval remain distinct. Product-default GitHub publication/replies require approval; the personal exception is separately installed, merge authority is separate and production still waits. The interview chose no numeric allowance, provider/account availability, permanent-Bot policy change or administration tradeoff.

This ADR proposes only the architecture/logic contract for [#320](https://github.com/chayapats/jit/issues/320), not implementation admission. Inspected main is `64f3a94726fdbce2283aec0944884ca7406d9934`. [ADR 0065](0065-s15-state-preservation-and-policy-adoption.md) and [s15-state-transition/v1](../contracts/s15-state-transition-v1.md) are merged proposed audit contracts. #318's [PR #345](https://github.com/chayapats/jit/pull/345) at `c79aab9d098c902db0cdff7f3d649ca389fff08c` remains unmerged; its feasibility and ADR 0064 revisions are remote proposal evidence only. The [policy contract](../contracts/s15-standing-policy-v1.md) records exact blobs, source seams, signatures, schemas and reconciliation gates. The next ADR number 0066 was checked against the inspected main tree and #345 tree; neither occupied it. Recheck for concurrent additions before merge.

S14 remains the implemented default. No runtime/DDL, host/policy activation, real broker, VM/browser transport, migration, UX or live-account evidence is delivered. All #320 implementation criteria remain outstanding; this PR references rather than closes it.

## Proposed decisions

1. **Keep authority in protected services.** Reuse S14's private actor-registry and writer-locked reauthentication idea. Owner and work actors are separate opaque process identities, never JSON or exported bearer handles. The owner mutation port is unavailable to interpretation/model/guest code; source text and stored history cannot authenticate. Work authority binds a real execute request and current purpose, not merely an authenticated inspect message or accepted obligation.
2. **Version explicit ceilings and exact payloads.** Use immutable policy/rule refs and hashes with current revision/generation/revocation catalogs. Bind actual route/model/effort, Bot, purpose, resources, recipients, budget continuity, source lineage and any VM/input generation. Trusted adapters derive all applicable effect classes and prepare immutable final content/attachment/transaction/target bytes. Hash equality is identity evidence, never authorization.
3. **Separate hard constraints from human-required gates.** A current ordinary rule can permit reversible work. Exact approval or a narrowly matched installed exception may satisfy eligible human gates, but cannot widen hard ceilings or override withdrawal, denial, missing support or a stale generation. Unknown matches hold; unknown/unbindable effect semantics are unsupported. Default GitHub versus personal publication/merge remain independent. An explicit deny always wins.
4. **Claim once before I/O and recheck at the actual boundary.** Claim uniqueness is by protected logical effect key across revisions, not by a model's arbitrary retry ID. Reserve/claim/current continuity must commit before dispatch. A trusted adapter consumes a process-local permit only at the final bound I/O boundary, with conditional remote operations or proven broker serialization. A callback signature alone cannot supply this proof. Unknown outcomes remain reconcile-only; a statement of non-occurrence cannot make them retryable.
5. **Use conservative finite accounting.** Charge enforceable upper bounds before work/effects and keep actual measured/partial/unknown usage separately. This revision never automatically refunds charged upper bounds. Settlement releases actual concurrency capacity only; timeouts and snapshots release neither uncertain capacity nor consumed allowance. New policy IDs/periods cannot reset current consumption. No numeric budget is selected by examples.
6. **Preserve current knowledge through adoption and rollback.** Current request identity, claims, monotonic usage, withdrawals and policy revocations stay outside guest/ordinary images. Keep one current continuity authority and the old/new boot fence. Historical grants/approvals/routines do not dispatch; S14-private accounts/data stay restricted. Unsupported reverse compatibility refuses rather than restoring stale authority. Full schemas/materializers and maintenance worker-release ports remain MIG15 freeze obligations.

## Alternatives and consequences

- Structural actor fields, copied owner messages or a model-selected effect class are forgeable. They remain data, even with valid hashes or an authenticated transport nearby.
- Retrofitting standing authority into existing S14 `message.post`/`work.start` would change a live contract by interpretation. The proposed S15 ports are versioned separately; valid S14 durability algorithms can be reused without that semantic change.
- An unrestricted generic performer taking shell/browser/MCP arguments cannot bind actual effects. The finite adapter registry and final-byte/target contract cost integration work and leave unsupported flows unavailable until proved.
- Early approval over a draft, or combining push/PR/payment stages under an unconstrained retry, risks substituted content and duplicate effects. Immutable revisions and per-subaction claims require more durable state but preserve partial outcomes.
- Nonrefundable upper-bound charges can exhaust a budget earlier than actual costs. This explicit conservative proposal avoids an unproved refund mechanism. Owners may later approve a reviewed accounting refinement; agents cannot increase ceilings to compensate.
- Policy-only fixtures are useful review inputs but establish no guest-root, general-browser or external-network enforcement. RT15-01 and RF15-G01–G08 remain unproven. This ADR neither chooses option B nor invents a Schway blocker. Use only the supported public surface if implementation starts.

## Required evidence before freeze or activation

Reconcile the actual merged reviewed #318 blobs and verify #319/source drift; review/freeze current-catalog resolvers, actor issuance, exact mutation ports, complete policy/action validation and continuity journal/crash ordering. Turn the [synthetic scenarios](../contracts/fixtures/s15-standing-policy-v1.md) into deterministic Bun/TypeScript tests with fake clocks, two-process claim/reservation barriers and final-byte races. Their documentation status is not a passing test result.

Real adapters and protected VM/browser/disclosure/production paths need their own frozen contracts and independent bypass/settlement evidence. MIG15 needs complete target schema, request continuity, prior-build enforcement and conditional rollback; EVID15/CUT15 need exact-build host/policy/adoption evidence. No local fixture, green review or upstream issue closure supplies those proofs or makes #320 complete/ready. Claude-required UX remains separately blocked; this ADR authors no UI/UX.
