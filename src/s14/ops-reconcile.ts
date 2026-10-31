import { S14Application, record, save } from "./application";
import type { Effect, Work } from "./authority-types";
import type { Routine } from "./routine-types";
import { canonical } from "./validation";
import { AppError } from "../errors";
import type { S14Store } from "./store";
import type { BotComputer } from "./computer-types";
import type { AppTransaction } from "../store";

function resetComputerLeases(tx: AppTransaction): void {
  tx.run("DELETE FROM input_leases");
  for (const row of tx.all<{ id: string; record_json: string }>("SELECT id,record_json FROM bot_computers")) {
    const computer = JSON.parse(row.record_json) as BotComputer;
    tx.run("INSERT INTO input_leases VALUES (?,?)", row.id, canonical({ computerId: row.id, generation: computer.generation, revision: 0, actor: null, attemptId: null, expiresAt: 0 }));
  }
}

/** Keeps later destructive computer generations/volume identities installation-local; old images cannot recreate them. */
export function reconcileOpsComputers(live: S14Store, candidate: S14Store): void {
  candidate.transaction(tx => {
    for (const row of tx.all<{ id: string; record_json: string }>("SELECT id,record_json FROM bot_computers")) {
      const archived = JSON.parse(row.record_json) as BotComputer;
      const withdrawals = tx.all<{ mode: string }>("SELECT mode FROM lifecycle.withdrawals WHERE kind='computer' AND id=?", row.id);
      const generations = withdrawals.map(entry => Number(/^through_generation_([0-9]+)$/.exec(entry.mode)?.[1]));
      if (generations.some(value => !Number.isSafeInteger(value) || value < 0)) throw new AppError("s14_lifecycle_ledger_conflict", 409);
      const withdrawn = Math.max(-1, ...generations);
      if (archived.generation > withdrawn) continue;
      const current = live.read(l => l.get<{ bot_id: string; record_json: string }>("SELECT bot_id,record_json FROM bot_computers WHERE id=?", row.id));
      const computer = current ? JSON.parse(current.record_json) as BotComputer : null;
      if (!computer || current!.bot_id !== archived.botId || computer.generation <= withdrawn || !["stopped", "deleted"].includes(computer.state)) throw new AppError("s14_ops_computer_cleanup_evidence_required", 409);
      tx.run("UPDATE bot_computers SET record_json=? WHERE id=?", canonical(computer), row.id);
    }
    resetComputerLeases(tx); // Fresh empty records satisfy the computer contract; no archived lease is restored.
  });
}

/** Applies current lifecycle facts and fences every stale execution or delivery authority before native reconciliation. */
export function reconcileOpsImage(app: S14Application): void {
  app.store.transaction(tx => {
    // A surviving installation vault cannot reactivate archived consent or replay a queued remote revoke.
    tx.run(`UPDATE personal_connections SET record_json=json_set(record_json,
      '$.revision',json_extract(record_json,'$.revision')+1,'$.state','reauth_required','$.verifiedAt',null)
      WHERE json_extract(record_json,'$.state') NOT IN ('reauth_required','revoked')`);
    // Archive metadata never reconnects a surviving Git vault or reissues a requested read-back.
    for (const row of tx.all<{ id: string; record_json: string }>("SELECT id,record_json FROM git_connections")) {
      const connection = JSON.parse(row.record_json);
      const latest = tx.get<{ revision: number }>("SELECT max(revision) AS revision FROM lifecycle.git_connection_revisions WHERE connection_id=?", row.id)?.revision ?? 0;
      connection.revision = Math.max(connection.revision, latest) + 1;
      connection.secret = "empty";
      tx.run("UPDATE git_connections SET vault_id=NULL,record_json=? WHERE id=?", canonical(connection), row.id);
      tx.run("INSERT OR IGNORE INTO lifecycle.git_connection_revisions VALUES (?,?)", row.id, connection.revision);
    }
    tx.run("DELETE FROM git_reconciliations");
    app.coding.recover(tx);
    app.git.recover(tx);
    app.personal.recover(tx);
    tx.run(`UPDATE personal_connections SET record_json=json_set(record_json,'$.revocation','unknown')
      WHERE json_extract(record_json,'$.revocation')='pending' OR
      (json_extract(record_json,'$.state')='revoked' AND json_extract(record_json,'$.revocation')='none')`);
    app.botLifecycle.reconcile(tx);
    app.memory.fence(tx);
    app.sharing.fence(tx);
    app.personal.reconcile(tx);
    app.recovery.reconcileReservations(tx);
    app.recovery.reconcileEffects(tx);
    tx.run("UPDATE grant_state SET generation=generation+1,revoked=1 WHERE revoked=0");
    tx.run("UPDATE work_queue SET state='blocked'");
    resetComputerLeases(tx);
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
