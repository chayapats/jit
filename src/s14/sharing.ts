import { AppError } from "../errors";
import type { AppTransaction } from "../store";
import { record, type S14Application } from "./application";
import type { Attempt, ScopePolicy, ScopeRef, Work } from "./authority-types";
import type { Bot, OwnerActor } from "./types";
import type { MemoryRef } from "./memory-types";
import type { FreeShareSlot, ShareView, SharingCommand, SharingReceipt, SnapshotShare } from "./sharing-types";
import { managedShareSlots, resourceConfigured, resourceSlotConflict, reservedResourceSlots } from "./share-slots";
import { canonical, digest, exact, identity, integer } from "./validation";
import { validateArtifact } from "./artifacts";

/** Revision-bound snapshot policy owner; it exposes bounded copies through the common artifact gateway. */
export class S14Sharing {
  constructor(readonly app: S14Application) {}

  /** Lists unused configured/built-in slots and current eligible receivers without reserving identities or changing authority. */
  freeSlots(actor: OwnerActor): FreeShareSlot[] {
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      const used = reservedResourceSlots(tx);
      const bots = tx.all<{ record_json: string }>("SELECT record_json FROM bots ORDER BY rowid").map(row => JSON.parse(row.record_json) as Bot);
      return [...new Set([...this.app.policy.resources, ...managedShareSlots])].filter(scopeId => !used.has(scopeId)).map(scopeId => ({
        scopeId, receiverBotIds: bots.filter(bot => bot.enabled && bot.capabilities.resources.includes(scopeId)).map(bot => bot.id),
      }));
    });
  }

  private load(tx: AppTransaction, key: string): SnapshotShare | null {
    const row = tx.get<{ record_json: string }>("SELECT record_json FROM snapshot_shares WHERE id=?", key);
    return row ? JSON.parse(row.record_json) as SnapshotShare : null;
  }

  /** Rechecks share expiry, independent revocation, exact revision and original source lineage. */
  current(tx: AppTransaction, ref: ScopeRef): boolean {
    const share = this.load(tx, ref.id);
    return !!share && ref.kind === "share" && share.active && share.revision === ref.revision && share.expiresAt > this.app.now() &&
      !tx.get("SELECT 1 FROM lifecycle.withdrawals WHERE kind='snapshot_share' AND id=?", ref.id) &&
      this.app.memory.sourceCurrent(tx, share.source);
  }

  /** Supplies the production share policy to the existing grant/Bot/work intersection. */
  scope(tx: AppTransaction, ref: ScopeRef): ScopePolicy | null {
    if (ref.kind !== "share" || !this.current(tx, ref)) return null;
    const share = this.load(tx, ref.id)!;
    return { ref, active: true, ownerBotId: share.ownerBotId, receiverBotId: share.receiverBotId, workId: share.workId,
      tools: [...this.app.policy.tools], snapshot: { id: share.target.id, revision: share.target.revision, hash: share.sha256 } };
  }

  /** Applies exact owner create/revoke commands under the shared authenticated receipt transaction. */
  apply(tx: AppTransaction, command: SharingCommand): SharingReceipt {
    if (command.kind === "snapshot.revoke") {
      exact(command.payload, ["shareId"]); identity(command.payload.shareId);
      const share = this.load(tx, command.payload.shareId);
      if (!share || share.revision !== command.expectedRevision || !share.active) throw new AppError("stale_revision", 409);
      tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('snapshot_share',?,'revoked')", share.id);
      share.active = false; share.revision++;
      tx.run("UPDATE snapshot_shares SET record_json=?,content=NULL WHERE id=?", canonical(share), share.id);
      this.fence(tx);
      return { kind: command.kind, requestId: command.requestId, share };
    }
    if (command.kind !== "snapshot.share") throw new AppError("unknown_command");
    const p = command.payload;
    exact(p, ["scopeId", "target", "receiverBotId", "workId", "expiresAt"]);
    identity(p.scopeId); identity(p.receiverBotId);
    exact(p.target, ["kind", "id", "revision", "generation"]);
    identity(p.target.id); integer(p.target.revision, 1); integer(p.target.generation, 1);
    integer(p.expiresAt, this.app.now() + 1, this.app.now() + 86400000);
    const receiver = record<Bot>(tx, "bots", p.receiverBotId);
    if (receiver.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
    if (!receiver.enabled || !resourceConfigured(this.app.policy, p.scopeId) || !receiver.capabilities.resources.includes(p.scopeId)) throw new AppError("snapshot_scope_denied", 403);
    if (p.workId !== null) { identity(p.workId); record<Work>(tx, "work_items", p.workId); }
    if (this.load(tx, p.scopeId) || resourceSlotConflict(tx, p.scopeId, "snapshot_share") || tx.get("SELECT 1 FROM lifecycle.withdrawals WHERE id=? AND kind IN ('snapshot_share','share')", p.scopeId)) throw new AppError("snapshot_share_exists", 409);
    const snapshot = this.app.artifacts.snapshot(tx, p.target);
    if (snapshot.ownerBotId === receiver.id) throw new AppError("snapshot_receiver_is_owner", 409);
    const share: SnapshotShare = { id: p.scopeId, revision: 1, target: structuredClone(p.target), ownerBotId: snapshot.ownerBotId,
      receiverBotId: receiver.id, workId: p.workId, expiresAt: p.expiresAt, active: true, source: snapshot.source,
      name: snapshot.name, mediaType: snapshot.mediaType, size: snapshot.size, sha256: snapshot.sha256 };
    tx.run("INSERT INTO snapshot_shares VALUES (?,?,?)", share.id, canonical(share), snapshot.bytes);
    return { kind: command.kind, requestId: command.requestId, share };
  }

  /** Checks every cross-Bot descendant against the receiver's original explicit share and resource ceiling. */
  permits(tx: AppTransaction, ref: ScopeRef, attempt: Attempt): boolean {
    const scope = this.scope(tx, ref);
    return !!scope && scope.receiverBotId === attempt.snapshot.bot.id &&
      (scope.workId === null || scope.workId === attempt.workId) && attempt.snapshot.bot.capabilities.resources.includes(ref.id) &&
      attempt.snapshot.scopes.some(s => canonical(s) === canonical(scope));
  }

  /** Pins share-dependent wrapper sources before context assembly so revoke fences all derived publications. */
  sources(tx: AppTransaction, attempt: Attempt, conversationId: string): MemoryRef[] {
    return attempt.snapshot.scopes.flatMap(scope => {
      const share = this.load(tx, scope.ref.id);
      if (!share) return [];
      if (!this.permits(tx, scope.ref, attempt)) throw new AppError("snapshot_scope_denied", 403);
      const source = this.app.memory.source(tx, { id: `snapshot_${digest(`${attempt.id}:${share.id}`)}`, botId: attempt.snapshot.bot.id,
        conversationId, attribution: "external", text: `Shared snapshot ${share.id}; sha256 ${share.sha256}`,
        derived: [share.source], access: [], snapshotShare: scope.ref });
      return [{ id: source.id, revision: source.revision, generation: source.generation }];
    });
  }

  /** Reads only exact captured copies for a live receiver attempt, never a filesystem/profile or forwarded grant. */
  context(tx: AppTransaction, attempt: Attempt): { share: SnapshotShare; content: string }[] {
    this.app.authority.guard(tx, attempt.id);
    let bytes = 0;
    return attempt.snapshot.scopes.flatMap(scope => {
      const share = this.load(tx, scope.ref.id);
      if (!share) return [];
      if (!this.permits(tx, scope.ref, attempt)) throw new AppError("snapshot_scope_denied", 403);
      bytes += share.size;
      if (bytes > 65536) throw new AppError("snapshot_context_budget_exhausted", 409);
      const row = tx.get<{ content: Uint8Array | null }>("SELECT content FROM snapshot_shares WHERE id=?", share.id);
      if (!row?.content) throw new AppError("snapshot_unavailable", 403);
      validateArtifact(row.content, share, 32768);
      return [{ share, content: new TextDecoder().decode(row.content) }];
    });
  }

  /** Fences affected packets and removes withdrawn copies before restored state or future calls can use them. */
  fence(tx: AppTransaction): void {
    for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM snapshot_shares")) {
      const share = JSON.parse(row.record_json) as SnapshotShare;
      if (!this.current(tx, { kind: "share", id: share.id, revision: share.revision })) tx.run("UPDATE snapshot_shares SET content=NULL WHERE id=?", share.id);
    }
    this.app.memory.fence(tx);
  }

  /** Returns owner-only metadata and honest revocation/expiry/lineage states without reading native sessions. */
  list(actor: OwnerActor): ShareView[] {
    return this.app.store.transaction(tx => {
      this.app.requireOwner(tx, actor); this.fence(tx);
      return tx.all<{ record_json: string }>("SELECT record_json FROM snapshot_shares ORDER BY rowid DESC").map(row => {
        const share = JSON.parse(row.record_json) as SnapshotShare;
        const revoked = !share.active || !!tx.get("SELECT 1 FROM lifecycle.withdrawals WHERE kind='snapshot_share' AND id=?", share.id);
        return { share, state: revoked ? "revoked" : share.expiresAt <= this.app.now() ? "expired" : this.current(tx, { kind: "share", id: share.id, revision: share.revision }) ? "active" : "unavailable", disclosedKnowledge: "cannot_recall" };
      });
    });
  }
}
