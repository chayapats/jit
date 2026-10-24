---
status: accepted
scope: FEAS02 engineering choices
---

# Concrete service-context probe on the pinned Schway bridge

FEAS02 implements FR-13, FR-14, FR-15, FR-17 and NFR-04/06/07/10 for
deterministic service-context feasibility evidence. The confirmed product
decisions remain in CONTEXT.md, the MVP spec and ADRs 0001–0004. The choices
below define this implementation slice; they select no live account, prove no
Pi readiness, and run no inference by default.

## One bounded request per admitted attempt

Live probing reuses the existing `liveProbe` orchestration (persist-before-dispatch,
restart-to-interrupted, cancel-fenced commits, observation separation). Only
the transport changes: `bridgeProbePorts` builds the `ProbePorts` boundary on
the pinned `schway/host` release. Each `infer` call opens one runtime with a
strict context, an exact empty tool registry, single-turn/single-attempt
bounds and the live deadline, submits exactly one route-bound request with
the fixed non-sensitive prompt, then closes. The live loop bounds total
attempts; there is no outer retry beyond the stated budget, no API-key or
plaintext fallback, and the selected route/model never changes.

`maxTurns: 1` keeps one probe request to one model turn: anything needing
more turns surfaces as a bounded non-ready outcome instead of silently
spending unreserved calls. The worst-case admission (`maxAttempts = 1` per
call) is exact, so attempt accounting needs no reservation beyond the live
loop's own budget. Provider sends per admitted attempt are structurally
bounded on the pinned release (at most two inference sends: one Schway-owned
401 refresh plus its single replay, no loop) and counted exactly per send
through the transport wrapper; the bound is enforced fail-closed and the
confirmed counts surface in the renewal observation ledger and the self
sample. Exact per-request accounting beyond this bound awaits schway#415.

## Readiness is local; renewal is measured, not claimed

`readCredential` performs a local `checkAuthReadiness` only: configured
access without a live request stays `configured-unverified`, a missing or
unusable store maps to store states, and a missing login maps to
needs-login. Nothing here proves inference, and a successful login never
becomes renewal evidence — renewal observation belongs to FEAS04 with its
own opt-in and evidence, not to this command.

Every credential-store mutation runs through the fence — dispatch check
inside the lifecycle serialization, mutation racing the live signal outside
every lock — so a hung backend fails closed instead of wedging the deadline.
Production uses the supported Schway guard seam (schway#416, landed in the
pinned release): post-terminal writes are refused on Schway's own default
native store, so no key-scheme mirroring or unwrapped path remains.
Uncertainty is never understated in-process. The terminal compare-and-set
itself checks admitted-but-unresolved writes, failed cleanups and open
Schway guard windows, and reports `store-unavailable` for every writer. Cross-process cancel during an unresolved write and
crash-recovery overlap in the pinned Schway lock (schway#428) remain bounded,
declared residuals (see the contract).

## Evidence stays installation-local and bounded

Attempts persist as mode-0600 files under the ignored `.local/host-probe/`
directory; native session state lives beside them under
`.local/host-probe-host/` (mode 0700, symlink/permission-checked). Exports
are allowlisted projections with redacted route/model aliases. Self samples
report process heap, managed artifact bytes/count, duration and exact
provider-send counts only — bounded observations of the probe process
itself, never representative full-app capacity and never environment, token
or address material.
