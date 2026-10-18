# ADR 0012: Fence attempts and reconcile application/native stores

Status: accepted for JOB02 engineering choices (Jit #9). Requirements: FR-07, FR-15, FR-16, FR-18, NFR-05, NFR-10, NFR-12.

## Confirmed decisions and required behavior

CONTEXT.md, the MVP spec and ADRs 0001/0004/0006/0008/0010/0011 keep Jit application authority separate from Schway execution and native sessions. Owner task acceptance grants no execution permission. Cancelled, revoked, superseded or stale work cannot publish late output. A native append and an app result are separate commits. Managed context retirement must prevent replay; failed deletion must remain visible. These requirements do not authorize coding, shell tools, GitHub mutations, live provider access or a memory deletion policy.

## Selected implementation

Add durable generation authority and immutable per-admission snapshots in schema v5. Admission reserves finite usage and stores input/configuration/authorization references, lease and opaque native identities before dispatch. The scripted native ledger is a separate fixture store; no changes to Schway's format are proposed.

Use one synchronous application commit gate for the worker's producer callback, job evidence/state and attempt outcome. Recheck current scheduler/owner/job generations, lease, immutable inputs/configuration/authorization and source/context freshness inside that transaction. Preview output previously committed before queue success; it now uses this gate so crash recovery cannot see attributed app output without the corresponding committed attempt/job result. Native finished events cannot create accepted obligations or app success.

Invalidate authority in the same transaction as owner stop or trusted revocation/supersession/source/context state changes. Ask the transport to cancel only afterward. Persist cancellation requested/fenced separately from observed stopped; takeover preserves unknown remote termination. Local unsettled transports retain admission until settlement. Leases are finite (default 60 seconds, configurable through SchedulerOptions) and never renew automatically.

On startup, fence orphaned admissions and reconcile native identity observations before pumping. Preserve interrupted attempts and native orphans as evidence. Explicit owner resume may create a new attempt for declared read-only work with current inputs/configuration, successful old-context retirement/deletion and remaining budgets. Mutation/send/unspecified work requires manual resolution. No uncertain reservations are refunded and no automatic execution retry loop is added.

Expose pending/retire_failed/delete_failed outcomes through the managed run lifecycle and durable reconciliation records. Fence the old context before calling the adapter. Acknowledged retirement precedes replacement; a requested deletion remains sticky until acknowledged. Keep existing app commits even when native evidence is missing. Actual memory correction, deletion propagation, backup/restore policy and real Schway host compatibility are later slices.

## Alternatives and consequences

Transport cancellation alone cannot prevent delayed workers from committing, so authority lives in the application store. Publishing first and marking the job afterward leaves a crash gap; the shared transaction removes that gap for service-owned state. Treating native finished as app success would invent authorization/evidence, so reconciliation records uncertainty instead. Blindly replaying interrupted mutations or sends could duplicate effects, so only explicit declared-read resume is supported.

The run-port v1 artifact gains mandatory paginated inspection and a retirement-failure outcome; the TEAM01 artifact alone does not meet jobs.session_reconcile/v1. Registry fingerprints include replay policy, conservatively blocking old queued/waiting definitions rather than inferring safe replay. Schema migration preserves historical records without fabricating attempt evidence. Future real adapters must implement these lifecycle semantics on Schway's supported public surface; a missing host operation requires a Schway proposal, not private integration.

The exact surfaces and deterministic evidence are recorded in [attempt-fence-v1](../contracts/attempt-fence-v1.md) and [session-reconcile-v1](../contracts/session-reconcile-v1.md). Fixture checks do not certify physical reboot, live providers, external exactly-once effects or production native deletion.
