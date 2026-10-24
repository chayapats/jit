---
status: accepted
scope: JBR01 engineering choices
---

# Concrete Schway bridge on the pinned host release

JBR01 implements FR-02, FR-03, FR-10, FR-13, FR-14, FR-15, FR-16, FR-17, FR-18
and NFR-01/02/03/05/08/10/12 against the landed Schway S02 contracts. The
confirmed product decisions remain in CONTEXT.md, the MVP spec and ADRs
0001–0004. The choices below define this implementation slice; they do not
select live account defaults, claim Pi readiness, or certify semantic quality.

## Pinning without an npm publish

Schway `1.0.0-rc.3` (the first npm publish carrying `schway.host.release/v1`)
is not published; publication needs repository authorization outside this
slice. Jit therefore vendors the exact tested tarball built from the merged
Schway main revision (`3c11d58`, suite green, #416 merged) at
`vendor/schway-1.0.0-rc.2-3c11d58.tgz` and depends on it via a `file:` reference,
so installs are reproducible offline and CI needs no registry credentials for
a private repository. The tarball SHA-256 is recorded in code, the contract
and a test; the runtime `releaseContract` gate rejects any other behavior set.
The upgrade path is a tarball swap (or `schway@^1.0.0-rc.3` once published).

Both repositories are private to the same owner, so vendoring moves no code
across trust boundaries. The tarball ships its own `dist/types`, so Jit
typechecks against the artifact's real declarations with no ambient shim.

## One native session per run

One Schway session backs one application run. Per-run sessions keep ancestry
independent without cross-run leases, make cancellation settlement local, and
let `schway_native_refs` (schema 21) correlate each run with its opaque native
reference durably. The session id never leaves the store; inspection,
retirement, deletion and snapshots resolve through it, and Jit never parses or
rewrites native records. Attempt ledgers record `adapter: "schway"` so JOB02
reconciliation matches by run and context exactly as it does for scripted runs.

Rejected alternatives: one session per managed context would serialize
concurrent specialist runs behind one lease and complicate fencing; deriving
session ids deterministically is unsupported by the host contract. The
remaining crash window (native creation before the correlation update) is
covered by a pending intent row that lifecycle calls treat as explicitly
unresolved — never acknowledged — plus an upstream proposal for atomic
create-with-correlation or session enumeration (chayapats/schway#414).

## Credential aliases and budget authority

The pinned host resolves one subscription identity per provider route, so Jit
preserves the owner alias end to end (effective config, request history,
committed evidence) but cannot execute two aliases on one provider as distinct
billing identities. A Schway change for per-alias credential binding is
proposed separately; until it exists the limitation is explicit here rather
than hidden behind a silent fallback.

Retry accounting maps `maxAttempts = retries + 1`: worst-case additional
calls/rounds are reserved before dispatch, single-output token accounting
stays as committed, and measured overrun across bounded internal retries is
reported in usage. The bridge executes bounded single-turn runs (`maxTurns:
1`), so multi-turn tool loops surface as `max_turns` instead of spending
unreserved calls. Usage records unreported token counters explicitly
(`tokensUnknown`) instead of persisting unknown consumption as zero. Fully
pre-reserving repeated outputs would make every normal job exceed its
remaining budget; the call-count dimension (admission and billing events) is
fully pre-reserved instead. Proposed upstream: chayapats/schway#413
(per-alias credential binding), chayapats/schway#414 (atomic
correlation/enumeration).

Accepted residual limitations (pending upstream contracts): a crash between
native creation and the correlation update can leave an orphan native session
that is discoverable only as an unaddressable intent; lifecycle calls on it
stay explicitly retryable and never report false success. Unknown token
counters are labeled, not zeroed. A single subscription identity serves all
aliases of one provider route until #413 lands.

Production adapter exceptions normalize to a production error that never
claims fixture evidence. Fixture-authorized work (role preview, schedule and
PR summaries, memory extraction) stays scripted; only specialist and
coordinator runs switch ports, matching their authorization boundary.

## Request-scoped host runtimes

`createHost` binds one fixed context, tool registry, limits and auth
selection, while Jit requests vary per run. The port therefore creates one
runtime per invocation with the request's strict context and closes it after
settlement; lifecycle operations (retire/delete/snapshot/gate) share a minimal
fixed-context runtime. This trades per-run setup cost for exact policy
isolation with no shared mutable host state. Serve keeps the scripted port by
default (`JIT_RUN_PORT=scripted`); `schway` mode fails startup when the gate
reports blocked, before any job is admitted.

## Validator and record modes

`normalizePortResult` accepts fixture and production outcomes with the same
shape and ceiling checks, keyed to the matching adapter identity. Work
executors (preview, specialist, coordinator, schedules, PR review) commit
through it and label evidence by mode; run records carry the actual outcome
mode. Fixture scripts stay fixture-strict. Memory extraction keeps its scripted
port: production memory inference is not part of this slice.
