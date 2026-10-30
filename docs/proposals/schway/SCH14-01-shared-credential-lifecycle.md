# [Frontier] [SCH14-01] Share subscription credential lifecycle across isolated host runs

Status: issue brief, not yet published. Parent: [Jit S14 #244](https://github.com/chayapats/jit/issues/244). Suggested Schway labels: needs-triage. Do not mark ready-for-agent before Schway confirms the contract and blockers.

## Problem and evidence

Jit creates a separate host for each run because context, tool registry, limits and cancellation differ. Its current src/config.ts refuses JIT_JOB_ROUTE_CONCURRENCY other than 1 in Schway mode. The supported host auth store is optional; defaultNativeStores in src/host/auth-routes.ts is memoized by selection object, and src/host/runtime.ts copies selection per runtime while preserving an explicitly supplied store identity. There is no exported production native-store/lifecycle factory for an embedder to share without implementing credential access itself.

Audit references: Schway main 98ba7f007a0ba382f1a26195ec7774559e25eab3, src/host/auth-routes.ts, src/host/runtime.ts, src/host/index.ts and api/host.api.md. Jit's pinned artifact remains vendor/schway-1.0.0-rc.2-2068b71.tgz; this brief does not upgrade it.

## Requested outcome

Expose a supported process-stable opaque native credential/lifecycle owner that multiple distinct createHost invocations can share. Schway chooses the smallest public shape. Preserve Jit's per-run context/tool/limit isolation and Schway ownership of secure storage, renewal, provider protocols and retries. Do not solve it by passing raw tokens to Jit, using ambient CLI credentials, or forcing all runs onto one mutable host/session.

## Acceptance criteria

- [ ] Two concurrently submitted independent hosts on the same configured route and native identity share renewal single-flight; no refresh races or stale credential overwrite.
- [ ] Different routes/identities do not share renewal accidentally. Same-provider account qualifiers remain separate scope (#413), not required for this ticket.
- [ ] Distinct context, tools, limits, workspaces, native sessions and cancellation signals remain independent.
- [ ] Cancelling/closing one host does not log out or cancel its sibling. Define handle ownership, close/dispose and active-run lifetime explicitly.
- [ ] Logout/revocation and credential write guards fence renewed writes correctly across all hosts. A stale attempt cannot re-store credentials after revocation; one attempt guard must not accidentally disable unrelated valid work.
- [ ] No raw secret appears in returned handles, readiness/outcomes, events, diagnostics or exported application records.
- [ ] Preserve exact route/model/billing selection and honest missing/blocked/quota outcomes. No fallback.
- [ ] Expose a versioned capability and document the supported lifecycle/identity semantics; packed consumer resolves only schway/host.
- [ ] Deterministic fake-store/fetch/clock barriers cover overlapping renewal, failure, cancellation, logout and disposal races. No live account required.

## Implementation boundary

Schway code only: public host/auth lifecycle and conformance. No Jit scheduler, Bot identity, approval framework, computer manager or app-owned retry loop.

## Contracts used/delivered

Existing schway.host.release/v2 and auth-route behavior; proposed additive lifecycle capability (name/version chosen by Schway owner). Update api/host.api.md and stability/conformance docs. Jit records the eventual artifact/version and must retain its concurrency guard until that evidence passes.

## Definition of done

Use Schway's current repository workflow and owned issue branch; Bun/TypeScript, exported-contract TSDoc, focused deterministic tests, full bun test and bun run typecheck. PR states Closes #<actual issue>; implementer does not merge. Human subscription smoke remains separately opt-in.
