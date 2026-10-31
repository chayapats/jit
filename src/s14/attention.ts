import { AppError } from "../errors";
import type { AppTransaction } from "../store";
import type { S14Application } from "./application";
import type { OwnerActor } from "./types";
import type { AttentionCommand, AttentionNotice, AttentionPort, AttentionReceipt, AttentionSetting } from "./routine-types";
import { canonical, exact, identity } from "./validation";

/** Project-free adaptation of delivery.outbox/v1 and attention notify-once, with no real channel adapter. */
export class S14Attention {
  #draining: Promise<void> | null = null;
  constructor(readonly app: S14Application, readonly port?: AttentionPort) {}

  private setting(tx: AppTransaction): AttentionSetting {
    return JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM attention_setting")!.record_json);
  }

  /** Applies exact owner policy without cancelling or retrospectively creating notices. */
  apply(tx: AppTransaction, command: AttentionCommand): AttentionReceipt {
    exact(command.payload, ["level"]);
    if (!["all", "needs-me"].includes(command.payload.level)) throw new AppError("invalid_attention");
    const setting = this.setting(tx);
    if (setting.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
    setting.level = command.payload.level;
    setting.revision++;
    tx.run("UPDATE attention_setting SET record_json=?", canonical(setting));
    return { kind: command.kind, requestId: command.requestId, setting };
  }

  /** Commits at most one logical notice per group and remembers filtered decisions across restarts. */
  commit(tx: AppTransaction, input: Pick<AttentionNotice, "groupId" | "class" | "reason" | "workId" | "proposalIds">): void {
    identity(input.groupId);
    if (tx.get("SELECT 1 FROM attention_decisions WHERE group_id=?", input.groupId)) {
      const row = tx.get<{ record_json: string }>("SELECT record_json FROM attention_notices WHERE group_id=?", input.groupId);
      if (row) {
        const notice = JSON.parse(row.record_json) as AttentionNotice;
        const added = input.proposalIds.some(id => !notice.proposalIds.includes(id));
        notice.proposalIds = [...new Set([...notice.proposalIds, ...input.proposalIds])];
        const newFailure = input.reason === "routine_failed" && notice.reason !== "routine_failed";
        if ((added || newFailure) && notice.resolvedAt !== null) {
          notice.resolvedAt = null;
          if (notice.state === "cancelled") notice.state = "queued";
        }
        notice.revision++;
        if (input.reason === "routine_failed" || notice.reason !== "routine_failed" && input.reason === "owner_decision") notice.reason = input.reason;
        this.save(tx, notice);
      }
      return;
    }
    const admitted = input.class === "needs_owner" || this.setting(tx).level === "all";
    tx.run("INSERT INTO attention_decisions VALUES (?,?)", input.groupId, admitted ? "created" : "filtered");
    if (!admitted) return;
    const notice: AttentionNotice = { id: crypto.randomUUID().replaceAll("-", ""), revision: 1, ...input,
      state: "queued", remote: "none", guarantee: "local_dedupe_only", retriesRemaining: 2,
      nextAttemptAt: this.app.now(), resolvedAt: null, createdAt: this.app.now() };
    tx.run("INSERT INTO attention_notices VALUES (?,?,?)", notice.id, notice.groupId, canonical(notice));
  }

  /** Resolves answered proposal groups without claiming withdrawal of sent or uncertain delivery. */
  resolve(tx: AppTransaction): void {
    for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM attention_notices")) {
      const notice = JSON.parse(row.record_json) as AttentionNotice;
      if (notice.resolvedAt !== null || notice.reason !== "owner_decision" || !notice.proposalIds.length) continue;
      if (notice.proposalIds.some(id => tx.get("SELECT 1 FROM work_items WHERE id=? AND json_extract(record_json,'$.state')='proposed'", id))) continue;
      notice.resolvedAt = this.app.now();
      notice.retriesRemaining = 0;
      if (notice.state === "queued") notice.state = "cancelled";
      notice.revision++;
      this.save(tx, notice);
    }
  }

  private save(tx: AppTransaction, notice: AttentionNotice): void {
    tx.run("UPDATE attention_notices SET record_json=? WHERE id=?", canonical(notice), notice.id);
  }

  /** Converts an interrupted optional send into unknown, never automatic retry. */
  recover(tx: AppTransaction): void {
    for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM attention_notices WHERE json_extract(record_json,'$.state') IN ('claimed','queued')")) {
      const notice = JSON.parse(row.record_json) as AttentionNotice;
      const claims = tx.all<{ mode: string }>("SELECT mode FROM lifecycle.withdrawals WHERE kind='attention_send' AND id=?", notice.id);
      if (notice.state !== "claimed" && !claims.some(row => Number(/^revision_([0-9]+)$/.exec(row.mode)?.[1]) >= notice.revision)) continue;
      notice.state = "unknown";
      notice.remote = "uncertain";
      notice.retriesRemaining = 0;
      notice.revision++;
      this.save(tx, notice);
    }
  }

  /** Returns durable grouped in-app attention without performing optional transport delivery. */
  view(actor: OwnerActor): { setting: AttentionSetting; items: AttentionNotice[] } {
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      return { setting: this.setting(tx), items: tx.all<{ record_json: string }>("SELECT record_json FROM attention_notices ORDER BY rowid DESC LIMIT 100").map(row => JSON.parse(row.record_json)) };
    });
  }

  /** Drains finite safe retries; thrown or uncertain remote outcomes are consumed permanently. */
  async drain(): Promise<void> {
    if (this.app.recovery.booting || this.app.backups.busy) return;
    if (this.#draining) return this.#draining;
    this.#draining = this.sendQueued();
    try { await this.#draining; }
    finally { this.#draining = null; }
  }

  private async sendQueued(): Promise<void> {
    for (let count = 0; count < 100; count++) {
      const notice = this.app.store.transaction(tx => {
        const row = tx.get<{ record_json: string }>(`SELECT record_json FROM attention_notices
          WHERE json_extract(record_json,'$.state')='queued' AND json_extract(record_json,'$.nextAttemptAt')<=? ORDER BY rowid LIMIT 1`, this.app.now());
        if (!row) return null;
        const notice = JSON.parse(row.record_json) as AttentionNotice;
        // Persist before handing control to any transport, including a fixture.
        notice.state = "claimed";
        notice.revision++;
        tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('attention_send',?,?)", notice.id, `revision_${notice.revision}`);
        this.save(tx, notice);
        return notice;
      });
      if (!notice) return;
      let result: "sent" | "unavailable" | "rejected" | "unknown" = "unknown";
      try { result = this.port ? await this.port.send(structuredClone(notice)) : "sent"; }
      catch { /* Transport error text is untrusted and may contain credentials. */ }
      this.app.store.transaction(tx => {
        const current = JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM attention_notices WHERE id=?", notice.id)!.record_json) as AttentionNotice;
        if (current.state !== "claimed") return;
        if (result === "unavailable" && current.retriesRemaining > 0 && current.resolvedAt === null) {
          current.state = "queued";
          current.retriesRemaining--;
          current.nextAttemptAt = this.app.now() + 1000;
        } else {
          current.state = result === "sent" ? "sent" : result === "unavailable" || result === "rejected" ? "failed" : "unknown";
          current.remote = !this.port ? "none" : result === "sent" ? "accepted" : current.state === "unknown" ? "uncertain" : "rejected";
          current.retriesRemaining = 0;
        }
        current.revision++;
        this.save(tx, current);
      });
    }
  }
}
