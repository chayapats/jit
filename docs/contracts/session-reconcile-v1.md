# Session reconciliation, v1

Owner: Jit #9 (JOB02). Contract: `jobs.session_reconcile/v1`. Implementation: `src/jobs/reconcile.ts`, `src/jobs/attempts.ts`, `src/jobs/queue.ts`, `src/team/run-port.ts`, `src/team/scripted-port.ts`; schema v5. FR-07/15/16/18 and NFR-05/10/12. Requires [attempt fencing](attempt-fence-v1.md) and the JOB02 extension of [app.run_port/v1](run-port-v1.md).

## Exact public surface

```ts
interface NativeRunInspection {
  adapter: string; runId: string; sessionId: string; context: ManagedContextReference;
  state: "running" | "finished";
  contextState: "active" | "retired" | "deleted" | "delete_failed";
}
ApplicationRunPort.inspectRuns(after?: number):
  Promise<{ items: NativeRunInspection[]; nextAfter: number | null }>;
// ManagedContextOutcome additionally includes:
// { state: "retire_failed"; context: ManagedContextReference;
//   nextAction: "retry_managed_retire" }

interface SessionReconciliation {
  id: string; kind: "attempt" | "orphan" | "context";
  nativeState: "missing" | "running" | "finished" | "unknown";
  appState: JobAttempt["state"] | "missing";
  context: ManagedContextReference;
  lifecycle: "not_requested" | "pending" | ManagedContextOutcome["state"];
  deleteRequested: boolean; nextAction: string;
}
readReconciliations(store: TransactionStore): SessionReconciliation[];
reconcileContext(store: TransactionStore, port: ApplicationRunPort,
  record: SessionReconciliation, now: number, afterFence?: () => void): Promise<SessionReconciliation>;
reconcileSessions(store: TransactionStore, port: ApplicationRunPort,
  now: number, afterFence?: () => void): Promise<SessionReconciliation[]>;
JobQueue.reconcile(port: ApplicationRunPort): Promise<SessionReconciliation[]>;
JobQueue.retireContext(port: ApplicationRunPort, context: ManagedContextReference,
  deleteRequested?: boolean): Promise<SessionReconciliation>;
```

Use the queue methods from trusted service composition; they require the scheduler owner and request cancellation only after persisted fences. Lower-level functions are internal reconciliation seams, not owner authorization or model tools. `inspectRuns` paginates stable positive numeric cursors with null at the end; scripted pages contain at most 100 runs. Identity matching requires adapter, run, session and context generation together.

## Separate stores and outcomes

`serve` acquires/reclaims local scheduler ownership and awaits reconciliation before opening the server or pumping work. Takeover preserves old attempts and fences interrupted admissions. Reconciliation inspects adapter-native references independently of app state. Native-only runs become inspectable orphan records and have their context retired; they never create jobs, application output, accepted obligations or delivery intent. App attempts with no native record are explicitly missing. Unowned/consumed app context references without attempts (including pre-v5 contexts) are retired without inventing historical attempts; initial contexts belonging to queued, undispatched jobs remain usable. Existing app delete_failed contexts retain deletion as a required lifecycle action. Native finished without app commit remains interrupted/unresolved. A committed app result with no retirement request records lifecycle not_requested and stays committed even if native evidence is missing; nextAction becomes inspect_app_commit_native_missing. Inspection does not dispatch work or copy native text into canonical history.

For interrupted attempts, retirement must be acknowledged before explicit read resume may create replacement context. Retirement first persists app context fencing, invalidates active attempts and writes a pending record; only then does the adapter receive retire/delete. Thrown/wrong-reference/failed acknowledgments remain blockers with retry_managed_retire or retry_managed_delete. A requested delete remains sticky across later retirement-only reconciliation and across overlapping in-flight retire calls, so a failed deletion cannot be silently downgraded to successful retirement by a late retire acknowledgment. Peer reconciliation rows and attempt `contextState` keep `delete_failed` until a matching `deleted` acknowledgment, which clears those peer blockers to `deleted`. Reopening retries durable pending/failed lifecycle requests once per reconciliation call; this is not an unbounded retry loop or renewed job budget. Active prepared/dispatched workers are not retired by ordinary inspection. Recovered native `finished` or `missing` settles that attempt's `transport` without promoting app success. Owner stop becomes `observed_stopped` only when every id in the stop's persisted `attemptIds` has settled transport evidence. Early yield/wait commits are not treated as terminal preserved output: their managed contexts are retired through the same lifecycle as interrupted attempts. Automatic unowned-context retirement rechecks current attempt/job ownership inside the fencing transaction so a preview admitted during concurrent reconciliation is not retired.

`retireContext` is the managed lifecycle seam for later memory/source policies; this slice does not choose those policies or erase application history. Successful retirement makes old contexts unusable. A replacement is a new context/run identity, never a reused old generation. Failed retirement/deletion is visible in attempt contextState and owner job reconciliation projections. Old workers cannot commit through the app fence even if transport retirement fails. Native finished can clarify stop transport evidence without granting app authority.

## Scripted artifact and limits

`ScriptedRunPort` implements the extension without a provider SDK, private Schway imports or native-session byte editing. `ScriptedNativeLedger` is a fixture-owned second SQLite store at `<app database>.scripted-native.sqlite`, mode 0600, synchronous FULL. It retains only opaque lifecycle references and retirement tombstones, never model text or credentials. It is distinct from the app transaction and is not a proposed Schway format. Each operation closes its connection. App result rollback cannot roll back a prior fixture native append. Late fixture completion preserves native retirement/deletion tombstones.

Schema v5 adds job_authority, job_attempts and job_reconciliation in the existing migration transaction with a private pre-upgrade snapshot. Existing job/team/source/receipt records remain byte-for-byte intact. No historical attempts or native success are invented for pre-v5 work. Registry fingerprints now include replay classification; an older queued/waiting work fingerprint is blocked as configuration_changed instead of assuming its replay safety. A later real bridge must support pre-dispatch opaque identity allocation, bounded inspection and managed retirement/deletion via Schway's public surface; the TEAM01-only run-port artifact lacks this extension. No production host/provider/deletion compatibility is certified here.

## Evidence

`tests/team.test.ts` reopens app storage and the independent native fixture store at before dispatch, after native append, before app commit and after app commit. Each case retains one committed output or an explicit interrupted state, including a late old callback. It also checks orphan native refs, missing refs, sticky delete failure and retirement failure/retry, new context/run after explicit read resume, stop uncertainty after restart and frozen TEAM01 v4 migration. `tests/jobs.test.ts` checks non-model commit fencing, competing schedulers, retry exhaustion and transaction failure. Reboot/live subscription/coding side-effect recovery remain outside JOB02.
