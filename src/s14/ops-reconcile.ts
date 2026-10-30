import { S14Application, record, save } from "./application";
import type { Effect, Work } from "./authority-types";
import type { Routine } from "./routine-types";
import { canonical } from "./validation";

/** Applies current lifecycle facts and fences every stale execution or delivery authority before native reconciliation. */
export function reconcileOpsImage(app: S14Application): void {
  app.store.transaction(tx => {
    app.botLifecycle.reconcile(tx);
    app.memory.fence(tx);
    app.sharing.fence(tx);
    app.recovery.reconcileReservations(tx);
    app.recovery.reconcileEffects(tx);
    tx.run("UPDATE grant_state SET generation=generation+1,revoked=1 WHERE revoked=0");
    tx.run("UPDATE work_queue SET state='blocked'");
    tx.run("DELETE FROM input_leases");
    tx.run("DELETE FROM artifact_staging");
    tx.run(`UPDATE capability_proposals SET record_json=json_set(record_json,'$.state','superseded') WHERE json_extract(record_json,'$.state')='proposed'`);
    for (const row of tx.all<{ id: string }>("SELECT id FROM work_items")) {
      const work = record<Work>(tx, "work_items", row.id);
      if (["queued", "running", "stopping"].includes(work.state)) {
        work.state = "blocked";
        work.reason = "restored_authority_requires_new_owner_start";
        work.revision++;
        save(tx, "work_items", work);
      }
    }
    for (const row of tx.all<{ id: string }>("SELECT id FROM effects")) {
      const effect = record<Effect>(tx, "effects", row.id);
      if (["pending", "approved", "executing"].includes(effect.state)) {
        effect.state = effect.state === "executing" ? "unknown" : "expired";
        effect.reason = "restored_effect_reconcile_only_no_retry";
        save(tx, "effects", effect);
        tx.run("INSERT OR REPLACE INTO effect_versions VALUES (?,?,?)", effect.id, effect.revision, canonical(effect));
      }
    }
    for (const row of tx.all<{ id: string; record_json: string }>("SELECT id,record_json FROM routines")) {
      const routine = JSON.parse(row.record_json) as Routine;
      if (["active", "paused"].includes(routine.state)) {
        routine.state = "blocked";
        routine.reason = "restored_routine_requires_new_owner_enable";
        routine.revision++;
        tx.run("UPDATE routines SET record_json=? WHERE id=?", canonical(routine), row.id);
      }
    }
    tx.run(`UPDATE reply_outbox SET record_json=json_set(record_json,'$.state','blocked','$.reason','restored_reply_no_auto_replay') WHERE json_extract(record_json,'$.state') IN ('queued','running')`);
    tx.run(`UPDATE attention_notices SET record_json=json_set(record_json,'$.state','unknown','$.remote','uncertain','$.retriesRemaining',0) WHERE json_extract(record_json,'$.state') IN ('queued','claimed')`);
    app.reports.reconcile(tx);
    app.routines.reconcile(tx);
  });
}
