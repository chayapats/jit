import type { TransactionStore } from "../store";
import type { ApplicationRunPort, ManagedContextOutcome, NativeRunInspection } from "../team/run-port";
import type { ManagedContextReference } from "../team/types";
import type { Job } from "./types";
import { invalidateJob, readAttempt, saveAttempt, type JobAttempt } from "./attempts";

/** Persisted cross-store observation; native completion never upgrades application state. */
export interface SessionReconciliation {
  id: string; kind: "attempt" | "orphan" | "context";
  nativeState: "missing" | "running" | "finished" | "unknown";
  appState: JobAttempt["state"] | "missing";
  context: ManagedContextReference;
  lifecycle: "not_requested" | "pending" | ManagedContextOutcome["state"];
  deleteRequested: boolean; nextAction: string;
}
/** Reads durable reconciliation blockers without reconnecting any worker or accepting native results. */
export function readReconciliations(store: TransactionStore): SessionReconciliation[] {
  return store.read(tx => tx.all<{ record_json: string }>("SELECT record_json FROM job_reconciliation ORDER BY id").map(r => JSON.parse(r.record_json)));
}
function save(store: TransactionStore, record: SessionReconciliation) {
  store.transaction(tx => tx.run("INSERT INTO job_reconciliation VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json", record.id, JSON.stringify(record)));
}
const same = (a: ManagedContextReference, b: ManagedContextReference) => a.id === b.id && a.generation === b.generation;
const peersFor = (store: TransactionStore, context: ManagedContextReference) =>
  readReconciliations(store).filter(record => same(record.context, context));
/** Deletion stays sticky across overlapping retire/delete calls until a successful deleted acknowledgment. */
const stickyDelete = (store: TransactionStore, context: ManagedContextReference, requested: boolean) =>
  requested || peersFor(store, context).some(record =>
    record.lifecycle !== "deleted" && (record.deleteRequested || record.lifecycle === "delete_failed"));
function nextActionFor(lifecycle: SessionReconciliation["lifecycle"], appState: SessionReconciliation["appState"]) {
  return lifecycle === "retire_failed" ? "retry_managed_retire" : lifecycle === "delete_failed" ? "retry_managed_delete"
    : appState === "committed" ? "inspect_committed_evidence" : "inspect_then_explicitly_resume_read_work";
}
/** Never let a weaker lifecycle erase delete_failed; a successful deleted ack clears that blocker. */
function mergeLifecycle(current: string, incoming: ManagedContextOutcome["state"] | "pending"): JobAttempt["contextState"] | ManagedContextOutcome["state"] | "pending" {
  if (incoming === "deleted" || current === "deleted") return "deleted";
  if (current === "delete_failed") return "delete_failed";
  return incoming;
}

/** Persists replay fencing before touching native lifecycle; failed acknowledgments block replacement and remain retryable. */
export async function reconcileContext(store: TransactionStore, port: ApplicationRunPort, record: SessionReconciliation,
  now: number, afterFence: () => void = () => {}): Promise<SessionReconciliation> {
  record = { ...record, deleteRequested: stickyDelete(store, record.context, record.deleteRequested) };
  let skipped = false;
  store.transaction(tx => {
    // Recheck ownership only for automatic unowned cleanup; explicit retireContext must still fence.
    if (record.kind === "context" && record.nextAction === "inspect_unowned_app_context") {
      const owned = tx.all<{ record_json: string }>("SELECT record_json FROM job_attempts").some(row => {
        const attempt = JSON.parse(row.record_json) as JobAttempt;
        return !!attempt.native && same(attempt.native.context, record.context);
      }) || !!tx.get<{ state: string }>(
        `SELECT j.state AS state FROM team_contexts c
         LEFT JOIN team_runs r ON r.context_id = c.id
         LEFT JOIN jobs j ON j.id = r.job_id
         WHERE c.id = ? AND c.generation = ? AND j.state IN ('queued', 'admitted', 'waiting')`,
        record.context.id, record.context.generation);
      if (owned) { skipped = true; return; }
    }
    tx.run("UPDATE team_contexts SET state = 'retired' WHERE id = ? AND generation = ? AND state = 'active'", record.context.id, record.context.generation);
    for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM job_attempts")) {
      const attempt = JSON.parse(row.record_json) as JobAttempt;
      if (attempt.native && same(attempt.native.context, record.context)) {
        if (["prepared", "dispatched"].includes(attempt.state)) {
          invalidateJob(tx, attempt.jobId, "context_retired", now);
          const row = tx.get<{ record_json: string }>("SELECT record_json FROM jobs WHERE id = ?", attempt.jobId);
          if (row) {
            const job = JSON.parse(row.record_json) as Job;
            if (job.state === "admitted") {
              job.state = "blocked"; job.reason = "context_retired"; job.revision++; job.updatedAt = Math.max(job.updatedAt, now);
              job.nextAction = job.occupiesAdmission ? "wait_for_adapter_to_stop" : "inspect_reason_and_authorize_new_work";
              tx.run("UPDATE jobs SET state = ?, record_json = ? WHERE id = ?", job.state, JSON.stringify(job), job.id);
            }
          }
        }
        const current = readAttempt(tx, attempt.id);
        // Keep an established delete_failed visible while overlapping retirements await acknowledgment.
        if (current.contextState !== "delete_failed") { current.contextState = "pending"; saveAttempt(tx, current); }
      }
    }
    tx.run("INSERT INTO job_reconciliation VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json", record.id, JSON.stringify({ ...record, lifecycle: "pending" }));
  });
  if (skipped) return { ...record, lifecycle: "not_requested", nextAction: "inspect_owned_context" };
  afterFence();
  let outcome: ManagedContextOutcome, retired = false;
  const deleteRequested = () => stickyDelete(store, record.context, record.deleteRequested);
  try {
    outcome = await port.retire(record.context);
    if (outcome.state === "retired" || outcome.state === "deleted") {
      retired = same(outcome.context, record.context);
      if (!retired) throw new Error("invalid_lifecycle_ack");
      // Re-read sticky deletion after the await; a concurrent delete request must not be ignored.
      if (deleteRequested() && outcome.state !== "deleted") outcome = await port.delete(record.context);
    }
    if (!same(outcome.context, record.context) || !["retired", "deleted", "delete_failed", "retire_failed"].includes(outcome.state) ||
        (deleteRequested() && outcome.state === "retired")) throw new Error("invalid_lifecycle_ack");
  } catch { outcome = retired && deleteRequested()
    ? { state: "delete_failed", context: record.context, nextAction: "retry_managed_delete" }
    : { state: "retire_failed", context: record.context, nextAction: "retry_managed_retire" }; }
  // A late retirement that races a delete failure must still attempt deletion or preserve the blocker.
  if (deleteRequested() && outcome.state === "retired") {
    try {
      outcome = await port.delete(record.context);
      if (!same(outcome.context, record.context) || !["deleted", "delete_failed"].includes(outcome.state)) throw new Error("invalid_lifecycle_ack");
    } catch { outcome = { state: "delete_failed", context: record.context, nextAction: "retry_managed_delete" }; }
  }
  let next: SessionReconciliation = { ...record, deleteRequested: deleteRequested(), lifecycle: outcome.state,
    nextAction: nextActionFor(outcome.state, record.appState) };
  store.transaction(tx => {
    const peers = tx.all<{ record_json: string }>("SELECT record_json FROM job_reconciliation").map(row => JSON.parse(row.record_json) as SessionReconciliation)
      .filter(peer => same(peer.context, record.context));
    let lifecycle: SessionReconciliation["lifecycle"] = outcome.state;
    if (lifecycle !== "deleted") {
      if (peers.some(peer => peer.lifecycle === "delete_failed")) lifecycle = "delete_failed";
      const requested = next.deleteRequested || peers.some(peer => peer.deleteRequested || peer.lifecycle === "delete_failed");
      if (requested && lifecycle === "retired") lifecycle = "delete_failed";
      next = { ...next, deleteRequested: requested, lifecycle, nextAction: nextActionFor(lifecycle, record.appState) };
    } else {
      // Successful deletion clears peer delete_failed blockers for this context generation.
      next = { ...next, deleteRequested: true, lifecycle: "deleted", nextAction: nextActionFor("deleted", record.appState) };
    }
    for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM job_attempts")) {
      const attempt = JSON.parse(row.record_json) as JobAttempt;
      if (!attempt.native || !same(attempt.native.context, record.context)) continue;
      const current = readAttempt(tx, attempt.id);
      const merged = mergeLifecycle(current.contextState, next.lifecycle as ManagedContextOutcome["state"]);
      if (merged === "pending") continue;
      current.contextState = merged as JobAttempt["contextState"];
      saveAttempt(tx, current);
    }
    tx.run("INSERT INTO job_reconciliation VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json", next.id, JSON.stringify(next));
    for (const peer of peers.filter(peer => peer.id !== next.id)) {
      const merged: SessionReconciliation = {
        ...peer,
        deleteRequested: peer.deleteRequested || next.deleteRequested,
        lifecycle: peer.lifecycle,
        nextAction: peer.nextAction,
      };
      if (next.lifecycle === "deleted") {
        merged.lifecycle = "deleted";
        merged.deleteRequested = true;
        merged.nextAction = nextActionFor("deleted", peer.appState);
      } else if (next.lifecycle === "delete_failed" || peer.lifecycle === "delete_failed") {
        merged.lifecycle = "delete_failed";
        merged.deleteRequested = true;
        merged.nextAction = "retry_managed_delete";
      } else if (next.lifecycle === "retired" || next.lifecycle === "retire_failed") {
        const lifecycle = mergeLifecycle(peer.lifecycle, next.lifecycle);
        if (lifecycle !== "pending") {
          merged.lifecycle = lifecycle as SessionReconciliation["lifecycle"];
          merged.nextAction = nextActionFor(merged.lifecycle, peer.appState);
        }
      }
      tx.run("INSERT INTO job_reconciliation VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json", merged.id, JSON.stringify(merged));
    }
  });
  return next;
}

/** Inspects both stores after scheduler takeover; it neither invokes work nor promotes native finished events to app success. */
export async function reconcileSessions(store: TransactionStore, port: ApplicationRunPort, now: number,
  afterFence: () => void = () => {}): Promise<SessionReconciliation[]> {
  const native: NativeRunInspection[] = [], handled = new Set<string>();
  const key = (context: ManagedContextReference) => `${context.id}:${context.generation}`;
  let after = 0;
  for (;;) {
    const page = await port.inspectRuns(after); native.push(...page.items);
    if (page.nextAfter === null) break;
    if (!Number.isSafeInteger(page.nextAfter) || page.nextAfter <= after) throw new Error("invalid_native_cursor");
    after = page.nextAfter;
  }
  const attempts = store.read(tx => tx.all<{ record_json: string }>("SELECT record_json FROM job_attempts").map(r => JSON.parse(r.record_json) as JobAttempt));
  const matched = new Set<NativeRunInspection>();
  for (const attempt of attempts) {
    if (!attempt.native) continue;
    const ref = attempt.native;
    const run = native.find(n => n.adapter === ref.adapter && n.runId === ref.runId && n.sessionId === ref.sessionId && same(n.context, ref.context));
    if (run) matched.add(run);
    store.transaction(tx => {
      const current = readAttempt(tx, attempt.id); current.nativeState = run?.state ?? "missing"; saveAttempt(tx, current);
      // Finish observation uses the persisted stopped attempt identity, not the retained interrupt reason.
      const authority = tx.get<{ stop_json: string | null }>("SELECT stop_json FROM job_authority WHERE job_id = ?", attempt.jobId);
      if (run?.state === "finished" && authority?.stop_json) {
        const stop = JSON.parse(authority.stop_json);
        const watched = Array.isArray(stop.attemptIds) && stop.attemptIds.includes(attempt.id);
        if (watched && stop.transport !== "not_dispatched") {
          stop.transport = "observed_stopped";
          tx.run("UPDATE job_authority SET stop_json = ? WHERE job_id = ?", JSON.stringify(stop), attempt.jobId);
        }
      }
    });
    // An active worker is never retired by a concurrent inspection.
    if (["prepared", "dispatched"].includes(attempt.state)) continue;
    const record: SessionReconciliation = { id: `attempt:${attempt.id}`, kind: "attempt", context: ref.context,
      nativeState: run?.state ?? "missing", appState: attempt.state, lifecycle: "pending", deleteRequested: false,
      nextAction: attempt.state === "committed" ? "inspect_committed_evidence" : "inspect_interrupted_attempt" };
    if (attempt.state === "committed") {
      // Keep accepted app output intact even if native append/deletion evidence is missing.
      record.lifecycle = ["none", "pending"].includes(attempt.contextState) ? "not_requested" : attempt.contextState as SessionReconciliation["lifecycle"];
      if (!run) record.nextAction = "inspect_app_commit_native_missing";
      save(store, record);
    } else { handled.add(key(record.context)); await reconcileContext(store, port, record, now, afterFence); }
  }
  for (const run of native.filter(n => !matched.has(n))) {
    handled.add(key(run.context));
    await reconcileContext(store, port, { id: `orphan:${run.adapter}:${run.runId}`, kind: "orphan", context: run.context,
      nativeState: run.state, appState: "missing", lifecycle: "pending", deleteRequested: false, nextAction: "inspect_native_orphan" }, now, afterFence);
  }
  // Pre-v5/native-free app references have no attempt to match. Preserve queued initial
  // contexts, but retire unowned or consumed contexts without fabricating attempt evidence.
  // Re-read after awaits so a preview admitted during orphan retirement is not misclassified.
  const appContexts = store.read(tx => tx.all<{ id: string; generation: number; state: string; job_state: string | null }>(
    "SELECT c.id, c.generation, c.state, j.state AS job_state FROM team_contexts c LEFT JOIN team_runs r ON r.context_id = c.id LEFT JOIN jobs j ON j.id = r.job_id"));
  const liveAttempts = store.read(tx => tx.all<{ record_json: string }>("SELECT record_json FROM job_attempts").map(r => JSON.parse(r.record_json) as JobAttempt));
  const knownContexts = new Set(liveAttempts.flatMap(a => a.native ? [`${a.native.context.id}:${a.native.context.generation}`] : []));
  for (const run of native) knownContexts.add(`${run.context.id}:${run.context.generation}`);
  for (const context of appContexts) {
    if (knownContexts.has(`${context.id}:${context.generation}`) || ["queued", "admitted", "waiting"].includes(context.job_state ?? "") || context.state === "deleted") continue;
    handled.add(key(context));
    await reconcileContext(store, port, { id: `context:${context.id}:${context.generation}`, kind: "context",
      context: { id: context.id, generation: context.generation }, nativeState: "missing", appState: "missing",
      lifecycle: "pending", deleteRequested: context.state === "delete_failed", nextAction: "inspect_unowned_app_context" }, now, afterFence);
  }
  // Retry durable explicit retire/delete requests left by a crash or a failed adapter acknowledgment.
  for (const record of readReconciliations(store).filter(r => r.kind === "context" && !handled.has(key(r.context)) && !["retired", "deleted"].includes(r.lifecycle))) {
    await reconcileContext(store, port, record, now, afterFence);
  }
  return readReconciliations(store);
}
