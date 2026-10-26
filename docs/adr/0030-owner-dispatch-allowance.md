---
status: accepted
scope: S09 dispatch engineering choices; extends ADR 0010 and team dispatch
---

# Owner dispatch allowance as standing authorization for specialist runs

FR-21 lets Jit call existing specialists without a click when the owner has pre-authorized it. Authority comes from an owner-set allowance, not from model output.

## Selected implementation

- Each project has a revisioned `dispatchAllowance`: enabled flag and maximum roles per owner message. The product default is 3 (S09-D04). It is finite, and the operator ceiling from ADR 0010/NFR-06 still caps it. Only owner commands change it.
- A `dispatch` proposal from a Jit reply names enabled, routed specialists. The service validates names against configuration and drops unknown or disabled roles. If the count fits the allowance current at admission, the service starts a normal `team.discussion` through the existing router/dispatch path, attributed as `standing-allowance` with the allowance revision. Otherwise it stores a dispatch proposal that the owner can accept.
- Stop-all and per-role skip use the existing discussion controls and attempt fencing.
- The allowance never covers role creation, task acceptance, decisions, project promotion or anything outside read-only analysis.

## Alternatives and consequences

A confirmation on every dispatch would be safest but loses the Grok-like flow the owner chose. Unbounded automatic dispatch violates FR-14 and NFR-06. Auditing therefore records which allowance revision admitted each discussion.
