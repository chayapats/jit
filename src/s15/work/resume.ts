import { AppError } from '../../errors';
import { PolicyError } from '../policy/validation';
import type { ConversationCommand, ConversationReceipt, ConversationStore } from '../conversation';
import type { ResponsibilityProjection } from './types';

/** Owner identity and generation of the authenticated owner whose own message created a binding. */
export interface ResumeOwnerSnapshot { ownerId: string; generation: number }
/** `s15-resume-binding/v1`: one owner stall reply that waits for its own CHAT completion before WORK may resume. */
export interface ResumeBinding {
  contract: 's15-resume-binding/v1'; requestId: string; dutyId: string; conversationId: string; owner: ResumeOwnerSnapshot;
  createdAt: number; state: 'pending' | 'resumed' | 'refused'; code: string | null; settledAt: number | null;
}
/**
 * Protected composition seams. `principal` verifies a live owner actor and returns its identity; `owner`
 * re-establishes exactly that owner's authority for settlement without a Web session, or returns null once
 * the owner generation changed. Neither is ever given to a model, guest or channel message.
 */
export interface ResumeBindingOptions<Actor> {
  /** The protected S15 conversation journal; the binding commits in the same writer transaction as the reply. */
  store: ConversationStore;
  conversation: { submit(actor: Actor, command: ConversationCommand): ConversationReceipt };
  work: { project(actor: Actor, id: string): ResponsibilityProjection; resume(actor: Actor, id: string, sourceRequestId: string): void };
  principal(actor: Actor): ResumeOwnerSnapshot;
  owner(snapshot: ResumeOwnerSnapshot): Actor | null;
  now?: () => number;
  /** Settled rows kept for owner display; pending rows are never evicted. */
  retention?: number;
}
/**
 * WORK15-02 durable "resume after this owner request completes" port. Used by the Web composer. A binding never resumes from model output or quoted text: it only names the paused
 * responsibility, and WORK's own `resume` checks (after the pause, same scope, current authority, completed
 * owner message) decide. Settlement happens at most once per binding, after restart and without a page view.
 */
export interface ResumeBindingPort<Actor> {
  /** Accepts the owner's stall reply and records its binding in one protected step; a replay returns the original receipt. */
  submit(actor: Actor, command: ConversationCommand, dutyId: string): ConversationReceipt;
  /** One durable settlement pass over pending bindings whose request reached a terminal state. Idempotent. */
  settle(): { resumed: number; refused: number };
  /** Latest settled outcome for this responsibility: the refusal code, or null after a resume or when none. */
  refusal(actor: Actor, dutyId: string): string | null;
  /** Owner read of one binding by its request ID, or null when that request carried no binding. */
  binding(actor: Actor, requestId: string): ResumeBinding | null;
}

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const pendingLimit = 256;
const codeOf = (error: unknown) => error instanceof AppError || error instanceof PolicyError ? error.code : 'execution_not_authorized';
interface Row { request_id: string; duty_id: string; conversation_id: string; owner_id: string; owner_generation: number; created_at: number; state: ResumeBinding['state']; code: string | null; settled_at: number | null }
const project = (row: Row): ResumeBinding => ({ contract: 's15-resume-binding/v1', requestId: row.request_id, dutyId: row.duty_id, conversationId: row.conversation_id, owner: { ownerId: row.owner_id, generation: row.owner_generation }, createdAt: row.created_at, state: row.state, code: row.code, settledAt: row.settled_at });

/**
 * Opens the `resume_bindings_v1` table inside the protected conversation journal. It is created on first
 * use for an existing installation; it carries no credential, model text or authority beyond its names.
 */
export function openResumeBindings<Actor>(options: ResumeBindingOptions<Actor>): ResumeBindingPort<Actor> {
  const { store } = options, now = options.now ?? Date.now, retention = Math.max(1, Math.min(options.retention ?? 256, 4096));
  store.db.exec(`CREATE TABLE IF NOT EXISTS resume_bindings_v1 (request_id TEXT PRIMARY KEY REFERENCES requests(id), duty_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      owner_id TEXT NOT NULL, owner_generation INTEGER NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','resumed','refused')), code TEXT, settled_at INTEGER);
    CREATE INDEX IF NOT EXISTS resume_bindings_v1_state ON resume_bindings_v1(state, created_at);
    CREATE INDEX IF NOT EXISTS resume_bindings_v1_duty ON resume_bindings_v1(duty_id, settled_at);`);
  const row = (requestId: string) => store.db.query<Row, [string]>('SELECT * FROM resume_bindings_v1 WHERE request_id=?').get(requestId);
  const finish = (requestId: string, state: 'resumed' | 'refused', code: string | null) => store.db.query('UPDATE resume_bindings_v1 SET state=?,code=?,settled_at=? WHERE request_id=? AND state=?').run(state, code, now(), requestId, 'pending');

  function settleOne(requestId: string): 'resumed' | 'refused' | null {
    return store.transaction(() => {
      const binding = row(requestId); if (!binding || binding.state !== 'pending') return null;
      const request = store.request(requestId);
      // Only a terminal owner request settles; queued or running work keeps the binding pending.
      if (request.state === 'queued' || request.state === 'running') return null;
      if (request.state !== 'completed' || request.code !== null || !request.authority) { finish(requestId, 'refused', 'execution_not_authorized'); return 'refused'; }
      // The authenticated owner request that created this binding is the authority; a newer owner generation is not that owner.
      if (request.owner.generation !== binding.owner_generation) { finish(requestId, 'refused', 'owner_changed'); return 'refused'; }
      const actor = options.owner({ ownerId: binding.owner_id, generation: binding.owner_generation });
      if (!actor) { finish(requestId, 'refused', 'owner_changed'); return 'refused'; }
      try {
        // A previous pass may have committed WORK's resume and lost this commit: WORK's own record decides.
        const duty = options.work.project(actor, binding.duty_id);
        if (duty.readyEventId !== requestId && !duty.attempts.some(attempt => attempt.eventId === requestId)) options.work.resume(actor, binding.duty_id, requestId);
        finish(requestId, 'resumed', null); return 'resumed';
      } catch (error) { finish(requestId, 'refused', codeOf(error)); return 'refused'; }
    });
  }
  function prune(): void {
    store.db.query(`DELETE FROM resume_bindings_v1 WHERE state<>'pending' AND request_id NOT IN (SELECT request_id FROM resume_bindings_v1 WHERE state<>'pending' ORDER BY settled_at DESC, rowid DESC LIMIT ?)`).run(retention);
  }
  return {
    submit(actor, command, dutyId) {
      // A stall reply is its own root owner message; a clarification continuation cannot carry a binding.
      if (!idPattern.test(dutyId) || !command || typeof command !== 'object' || !idPattern.test(command.requestId) || !idPattern.test(command.conversationId) || command.continuation !== null) throw new AppError('invalid_body');
      return store.transaction(() => {
        const owner = options.principal(actor), existing = row(command.requestId);
        if (existing) {
          if (existing.duty_id !== dutyId || existing.conversation_id !== command.conversationId) throw new AppError('request_id_conflict', 409);
          return options.conversation.submit(actor, command);
        }
        // An already accepted ordinary message cannot be relabelled later as a stall reply.
        if (store.db.query('SELECT 1 FROM commands WHERE id=?').get(command.requestId)) throw new AppError('request_id_conflict', 409);
        const duty = options.work.project(actor, dutyId);
        if (duty.conversationId !== command.conversationId || duty.state !== 'paused') throw new AppError('stale_revision', 409);
        if (store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM resume_bindings_v1 WHERE state='pending'").get()!.n >= pendingLimit) throw new AppError('continuity_capacity', 409);
        const receipt = options.conversation.submit(actor, command);
        store.db.query('INSERT INTO resume_bindings_v1 VALUES (?,?,?,?,?,?,?,?,?)').run(receipt.requestId, dutyId, command.conversationId, owner.ownerId, owner.generation, now(), 'pending', null, null);
        return receipt;
      });
    },
    settle() {
      let resumed = 0, refused = 0;
      // Only bindings whose owner request is terminal are candidates, so long-queued requests never starve later completed replies.
      const pending = store.db.query<{ request_id: string }, []>("SELECT b.request_id FROM resume_bindings_v1 b JOIN requests r ON r.id=b.request_id WHERE b.state='pending' AND r.state NOT IN ('queued','running') ORDER BY b.created_at, b.rowid LIMIT 64").all();
      for (const { request_id } of pending) { const result = settleOne(request_id); if (result === 'resumed') resumed++; else if (result === 'refused') refused++; }
      if (resumed || refused) store.transaction(prune);
      return { resumed, refused };
    },
    refusal(actor, dutyId) {
      if (!idPattern.test(dutyId)) return null;
      const owner = options.principal(actor);
      const latest = store.db.query<Row, [string, number]>("SELECT * FROM resume_bindings_v1 WHERE duty_id=? AND owner_generation=? AND state<>'pending' ORDER BY settled_at DESC, rowid DESC LIMIT 1").get(dutyId, owner.generation);
      return latest?.state === 'refused' ? latest.code : null;
    },
    binding(actor, requestId) {
      if (!idPattern.test(requestId)) return null;
      const owner = options.principal(actor), found = row(requestId);
      return found && found.owner_generation === owner.generation ? project(found) : null;
    },
  };
}
