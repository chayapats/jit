import { AppError } from '../../errors';
import { registerSecretFingerprint } from '../../security/secret-fingerprints';
import { ownerDecision } from '../conversation/decisions';
import type { ConversationRequest } from '../conversation';
import { s15CredentialKey } from '../credentials';
import type { OwnerActor } from '../policy';
import { PolicyError } from '../policy/validation';
import type { S15TelegramStatus } from '../web/types';
import { noticeText, type TelegramNotice } from './messages';
import { allowedUpdates, bindingCode, classify, conversationIdFor, credentialShaped, requestIdFor, splitText, tokenPattern, updateId } from './protocol';
import { TelegramTransportError, type TelegramBinding, type TelegramChannel, type TelegramChannelOptions, type TelegramLimits, type TelegramState } from './types';

const defaults: TelegramLimits = { codeTtlMs: 10 * 60_000, codeAttempts: 5, retentionMs: 24 * 3_600_000, progressAfterMs: 2 * 60_000, sendSpacingMs: 1000, pollTimeoutSeconds: 25, backoffMs: { min: 1000, max: 60_000 }, horizonMs: 7 * 24 * 3_600_000 };
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const refusedClasses = ['unauthorized_sender', 'unauthorized_chat', 'group_rejected', 'forward_rejected', 'bot_origin_rejected', 'stale_code'];
const codeOf = (error: unknown) => error instanceof AppError || error instanceof PolicyError || error instanceof TelegramTransportError ? error.code : 'conversation_unavailable';
interface InboxRow { sequence: number; bot_id: number; update_id: number; kind: string; classification: string; user_id: number | null; chat_id: number | null; message_id: number | null; reply_to: number | null; text: string | null; binding_revision: number; received_at: number; status: 'persisted' | 'processed'; request_id: string | null; duty_id: string | null; outbound: 'none' | 'open' | 'closed'; code: string | null; processed_at: number | null }
interface OutboxRow { sequence: number; id: string; event_id: string; chat_id: number; duty_id: string | null; reply_to: number | null; text: string; state: 'pending' | 'sending' | 'sent' | 'unknown' | 'failed' | 'cancelled'; attempts: number; next_at: number; message_id: number | null; code: string | null; created_at: number; settled_at: number | null }

/**
 * Opens the CHAN15-01 Telegram owner channel over the protected S15 conversation journal (versioned
 * `telegram_*_v1` tables beside the requests they feed). The token lives only in the {@link ConnectionVault};
 * the journal holds bot identity, binding, cursor, an inbox of classified updates and the outbox.
 * Nothing typed in Telegram approves an action, installs policy or widens scope.
 */
export function openTelegramChannel(options: TelegramChannelOptions): TelegramChannel {
  const limits: TelegramLimits = { ...defaults, ...options.limits, backoffMs: { ...defaults.backoffMs, ...options.limits?.backoffMs } };
  const { store, vault } = options, db = store.db, now = () => options.clock.now(), tokenKey = s15CredentialKey(options.installationId, 'telegram-bot');
  db.exec(`CREATE TABLE IF NOT EXISTS telegram_state_v1 (id INTEGER PRIMARY KEY CHECK (id=1), json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS telegram_inbox_v1 (sequence INTEGER PRIMARY KEY AUTOINCREMENT, bot_id INTEGER NOT NULL, update_id INTEGER NOT NULL, kind TEXT NOT NULL, classification TEXT NOT NULL,
      user_id INTEGER, chat_id INTEGER, message_id INTEGER, reply_to INTEGER, text TEXT, binding_revision INTEGER NOT NULL, received_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('persisted','processed')), request_id TEXT, duty_id TEXT, outbound TEXT NOT NULL DEFAULT 'none', code TEXT, processed_at INTEGER, UNIQUE(bot_id, update_id));
    CREATE INDEX IF NOT EXISTS telegram_inbox_v1_status ON telegram_inbox_v1(status, sequence);
    CREATE TABLE IF NOT EXISTS telegram_outbox_v1 (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, event_id TEXT NOT NULL, chat_id INTEGER NOT NULL, duty_id TEXT, reply_to INTEGER, text TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','sending','sent','unknown','failed','cancelled')), attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, message_id INTEGER, code TEXT, created_at INTEGER NOT NULL, settled_at INTEGER);
    CREATE INDEX IF NOT EXISTS telegram_outbox_v1_state ON telegram_outbox_v1(state, next_at, sequence);
    CREATE INDEX IF NOT EXISTS telegram_outbox_v1_message ON telegram_outbox_v1(chat_id, message_id);
    CREATE TABLE IF NOT EXISTS telegram_events_v1 (event_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);`);
  const read = (): TelegramState => JSON.parse(db.query<{ json: string }, []>('SELECT json FROM telegram_state_v1 WHERE id=1').get()!.json) as TelegramState;
  const write = (state: TelegramState) => { db.query('UPDATE telegram_state_v1 SET json=? WHERE id=1').run(JSON.stringify(state)); };
  const freshPoll = (): TelegramState['poll'] => ({ offset: 0, lastPollAt: null, code: null, failures: 0, gap: null });
  store.transaction(() => {
    if (!db.query('SELECT 1 FROM telegram_state_v1').get()) db.query('INSERT INTO telegram_state_v1 VALUES (1,?)').run(JSON.stringify({ contract: 's15-telegram-state/v1', bot: null, binding: { state: 'unbound', revision: 0 }, poll: freshPoll(), send: { notBefore: 0 } } satisfies TelegramState));
    // A send whose process was lost may have reached Telegram: it is recorded as unknown, never repeated.
    db.query("UPDATE telegram_outbox_v1 SET state='unknown', code='telegram_send_interrupted', settled_at=? WHERE state='sending'").run(now());
  });

  function token(): string | null {
    if (vault.inspect(tokenKey) !== 'present') return null;
    const value = vault.read(tokenKey); registerSecretFingerprint(value); return value;
  }
  const unbind = (state: TelegramState) => {
    state.binding = { state: 'unbound', revision: state.binding.revision + 1 };
    // Queued notices belong to the old binding; nothing is delivered to a chat that is no longer bound.
    db.query("UPDATE telegram_outbox_v1 SET state='cancelled', code='telegram_unbound', settled_at=? WHERE state='pending'").run(now());
  };
  const link = (path: string) => new URL(path, options.origin).toString();
  const owner = (binding: Extract<TelegramBinding, { state: 'bound' }>) => options.owner({ ownerId: binding.owner.ownerId, generation: binding.owner.generation, current: () => { const b = read().binding; return b.state === 'bound' && b.revision === binding.revision; } });
  const locale = (actor: OwnerActor) => { try { return options.locale?.(actor) ?? 'th'; } catch { return 'th' as const; } };

  /** Records one outbound event once; parts are queued under stable IDs. Returns false when it already exists. */
  function enqueue(eventId: string, chatId: number, text: string, extra: { dutyId?: string | null; replyTo?: number | null } = {}): boolean {
    if (db.query('SELECT 1 FROM telegram_events_v1 WHERE event_id=?').get(eventId)) return false;
    db.query('INSERT INTO telegram_events_v1 VALUES (?,?)').run(eventId, now());
    splitText(text).forEach((part, index) => db.query('INSERT INTO telegram_outbox_v1 (id,event_id,chat_id,duty_id,reply_to,text,state,attempts,next_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(`${eventId}#${index}`, eventId, chatId, extra.dutyId ?? null, index === 0 ? extra.replyTo ?? null : null, part, 'pending', 0, now(), now()));
    return true;
  }
  /** Renders and records a notice; credential-shaped content is replaced by a short pointer to the Web page. */
  function notify(actor: OwnerActor, eventId: string, chatId: number, notice: TelegramNotice, path: string, extra: { dutyId?: string | null; replyTo?: number | null } = {}): boolean {
    let text = noticeText(locale(actor), notice, link(path));
    if (credentialShaped(text)) text = noticeText(locale(actor), notice.kind === 'reply' ? { kind: 'reply_held' } : { kind: 'credential' }, link(path));
    return enqueue(eventId, chatId, text, extra);
  }
  const requireOwner = (actor: OwnerActor, requestId: string) => { if (!idPattern.test(requestId)) throw new AppError('invalid_body'); return options.principal(actor); };

  function processRow(sequence: number, cache: { actor?: OwnerActor | null }): void {
    store.transaction(() => {
      const row = db.query<InboxRow, [number]>('SELECT * FROM telegram_inbox_v1 WHERE sequence=?').get(sequence);
      if (!row || row.status !== 'persisted') return;
      const done = (code: string | null, requestId: string | null = null, dutyId: string | null = null) => db.query("UPDATE telegram_inbox_v1 SET status='processed', code=?, request_id=?, duty_id=?, outbound=?, processed_at=? WHERE sequence=?").run(code, requestId, dutyId, requestId ? 'open' : 'none', now(), sequence);
      const state = read(), binding = state.binding;
      if (row.classification === 'binding_code') {
        if (binding.state === 'bound' && binding.revision === row.binding_revision && binding.chatId === row.chat_id) { const actor = cache.actor ??= owner(binding); if (actor) notify(actor, `bound:${binding.revision}`, binding.chatId, { kind: 'bound' }, '/resources/telegram'); }
        return done(null);
      }
      if (row.classification !== 'authorized') return done(row.classification);
      // Authority is re-read at processing: a revoke or rebind after persistence refuses the earlier message.
      if (binding.state !== 'bound' || binding.revision !== row.binding_revision || binding.userId !== row.user_id || binding.chatId !== row.chat_id || state.bot?.id !== row.bot_id) return done('stale_binding');
      const actor = cache.actor ??= owner(binding), chatId = binding.chatId, event = `in:${row.bot_id}:${row.update_id}`;
      if (!actor) { enqueue(`${event}:rebind`, chatId, noticeText('th', { kind: 'rebind' }, link('/resources/telegram'))); return done('owner_changed'); }
      const say = (notice: TelegramNotice, path: string) => notify(actor, `${event}:notice`, chatId, notice, path, { replyTo: row.message_id });
      if (row.kind === 'edit' || row.kind === 'callback' || row.kind === 'other') return done('ignored');
      if (row.kind === 'unsupported') { say({ kind: 'unsupported' }, '/chats/new'); return done('unsupported'); }
      if (row.kind === 'credential' || row.text === null) { say({ kind: 'credential' }, '/resources/accounts'); return done('credential_content_refused'); }
      const text = row.text;
      if (/^\/(?:start|help)(?:@[A-Za-z0-9_]{1,64})?\s*$/i.test(text.trim())) { say({ kind: 'help' }, '/needs'); return done('help'); }
      // Approvals stay on the exact Web slip (S15 UX Q4, ADR 0072): typed decisions never reach CHAT from here.
      if (ownerDecision(text)) { say({ kind: 'approval_web_only' }, '/needs'); return done('approval_web_only'); }
      const requestId = requestIdFor(row.bot_id, row.update_id);
      try {
        // A reply to a delivered stall report names that responsibility; WORK15-02's binding and checks decide.
        const named = row.reply_to === null ? null : db.query<{ duty_id: string }, [number, number]>('SELECT duty_id FROM telegram_outbox_v1 WHERE chat_id=? AND message_id=? AND duty_id IS NOT NULL LIMIT 1').get(chatId, row.reply_to)?.duty_id ?? null;
        const duty = named ? (() => { try { return options.work.project(actor, named); } catch { return null; } })() : null;
        if (duty && duty.state === 'paused') {
          options.resumes.submit(actor, { contract: 's15-conversation/v1', requestId, conversationId: duty.conversationId, text, continuation: null }, duty.id);
          say({ kind: 'resume_received' }, `/duties/${duty.id}`);
          return done(null, requestId, duty.id);
        }
        options.conversation.submit(actor, { contract: 's15-conversation/v1', requestId, conversationId: conversationIdFor(chatId), text, continuation: null });
        return done(null, requestId);
      } catch (error) {
        const code = codeOf(error); say({ kind: 'refused', code }, `/chats/${conversationIdFor(chatId)}`);
        // Refused owner text is not kept in the inbox once handled.
        db.query('UPDATE telegram_inbox_v1 SET text=NULL WHERE sequence=?').run(sequence);
        return done(code);
      }
    });
  }

  const statusOf = (request: ConversationRequest): Extract<TelegramNotice, { kind: 'status' }>['state'] | null => {
    if (request.state === 'stopped') return 'stopped';
    if (request.state === 'reconcile_only') return 'unknown';
    if (request.state === 'accepted') return request.decision ? null : 'accepted';
    if (request.state === 'blocked' || (request.state === 'completed' && request.result === null)) return 'blocked';
    if (request.state === 'completed' && request.code === 'owner_start_required') return 'question';
    if (request.state === 'held' || request.state === 'proposed') return request.code === 'material_ambiguity' || request.code === 'approval_reference_required' ? 'question' : request.code === 'budget_exhausted' || request.code === 'finite_budget_required' ? 'budget_hold' : 'needs_you';
    return null;
  };

  let loops: { controller: AbortController; done: Promise<unknown> } | null = null, poll: AbortController | null = null, closed = false;
  const channel: TelegramChannel = {
    status(actor) {
      const owner = options.principal(actor), state = read(), t = now(), b = state.binding, horizon = t - limits.horizonMs;
      const tokenState = vault.inspect(tokenKey);
      const count = (sql: string, ...args: (string | number)[]) => db.query<{ n: number }, (string | number)[]>(sql).get(...args)!.n;
      return { contract: 's15-telegram-status/v1', token: tokenState === 'present' ? 'present' : tokenState === 'unsafe' ? 'unsafe' : 'missing', bot: state.bot,
        binding: b.state === 'pending' ? { state: 'pending', code: b.code, expiresAt: b.expiresAt, expired: t > b.expiresAt } : b.state === 'bound' ? { state: 'bound', userId: b.userId, username: b.username, boundAt: b.boundAt, current: b.owner.generation === owner.generation } : { state: 'unbound' },
        poll: { state: tokenState !== 'present' || !state.bot ? 'off' : state.poll.code ? 'trouble' : state.poll.lastPollAt === null ? 'starting' : 'receiving', lastPollAt: state.poll.lastPollAt, code: state.poll.code, gap: state.poll.gap },
        counts: { refused: count(`SELECT count(*) AS n FROM telegram_inbox_v1 WHERE classification IN (${refusedClasses.map(() => '?').join(',')}) AND received_at>=?`, ...refusedClasses, horizon),
          unknown: count("SELECT count(*) AS n FROM telegram_outbox_v1 WHERE state='unknown' AND created_at>=?", horizon), queued: count("SELECT count(*) AS n FROM telegram_outbox_v1 WHERE state IN ('pending','sending')") } } satisfies S15TelegramStatus;
    },
    async setToken(actor, requestId, input) {
      requireOwner(actor, requestId);
      const value = typeof input === 'string' ? input.trim() : '';
      if (!tokenPattern.test(value)) throw new AppError('telegram_token_invalid', 409);
      // Fingerprint first, so any later echo of the value (log, model text, delivery) is redacted.
      registerSecretFingerprint(value);
      let me: Awaited<ReturnType<ReturnType<TelegramChannelOptions['transport']>['getMe']>>;
      try { me = await options.transport(value).getMe(AbortSignal.timeout(15000)); } catch (error) { throw new AppError(error instanceof TelegramTransportError ? error.code : 'telegram_unreachable', 409); }
      if (!me || me.is_bot !== true || !Number.isSafeInteger(me.id) || String(me.id) !== value.slice(0, value.indexOf(':')) || typeof me.username !== 'string' || !/^[A-Za-z0-9_]{5,64}$/.test(me.username)) throw new AppError('telegram_token_rejected', 409);
      options.principal(actor);
      vault.write(tokenKey, value);
      store.transaction(() => {
        const state = read();
        // A different bot is a different channel: the old binding, cursor and queued notices do not carry over.
        if (state.bot?.id !== me.id) { unbind(state); state.poll = freshPoll(); }
        state.bot = { id: me.id, username: me.username! }; state.poll.code = null; state.poll.failures = 0; write(state);
      });
      poll?.abort();
    },
    removeToken(actor, requestId) {
      requireOwner(actor, requestId);
      vault.remove(tokenKey);
      store.transaction(() => { const state = read(); unbind(state); state.bot = null; state.poll = { ...state.poll, code: null, failures: 0 }; write(state); });
      poll?.abort();
    },
    startBinding(actor, requestId) {
      const principal = requireOwner(actor, requestId);
      store.transaction(() => {
        const state = read();
        if (!state.bot || vault.inspect(tokenKey) !== 'present') throw new AppError('telegram_token_required', 409);
        if (state.binding.state === 'bound' && state.binding.owner.generation === principal.generation) throw new AppError('telegram_already_bound', 409);
        state.binding = { state: 'pending', revision: state.binding.revision + 1, code: bindingCode(), expiresAt: now() + limits.codeTtlMs, failures: 0, owner: principal }; write(state);
      });
    },
    cancelBinding(actor, requestId) { requireOwner(actor, requestId); store.transaction(() => { const state = read(); if (state.binding.state === 'pending') { unbind(state); write(state); } }); },
    revoke(actor, requestId) { requireOwner(actor, requestId); store.transaction(() => { const state = read(); if (state.binding.state !== 'unbound') { unbind(state); write(state); } }); },
    acknowledgeGap(actor, requestId) { requireOwner(actor, requestId); store.transaction(() => { const state = read(); state.poll.gap = null; write(state); }); },

    async pollOnce(timeoutSeconds = 0, signal) {
      const start = read(), bot = start.bot, secret = token();
      if (!bot || !secret) return { received: 0 };
      store.transaction(() => {
        const state = read();
        // Telegram keeps undelivered updates for a bounded time; a longer silence is a visible gap, never invented history.
        if (state.poll.lastPollAt !== null && now() - state.poll.lastPollAt > limits.retentionMs && !state.poll.gap) { state.poll.gap = { since: state.poll.lastPollAt, noticedAt: now() }; write(state); }
      });
      let updates: unknown[];
      try { updates = await options.transport(secret).getUpdates({ offset: start.poll.offset, timeout: timeoutSeconds, allowedUpdates }, signal); if (!Array.isArray(updates)) throw new TelegramTransportError('telegram_protocol', 'not_sent'); }
      catch (error) { store.transaction(() => { const state = read(); if (state.bot?.id === bot.id) { state.poll.code = codeOf(error); state.poll.failures++; write(state); } }); throw error; }
      // Commit 1: every update's identity and classification, before Telegram is told it was received.
      const highest = store.transaction(() => {
        const state = read(); if (state.bot?.id !== bot.id) return null;
        let highest = -1;
        for (const update of updates) {
          const id = updateId(update); if (id === null) continue;
          highest = Math.max(highest, id);
          if (db.query('SELECT 1 FROM telegram_inbox_v1 WHERE bot_id=? AND update_id=?').get(bot.id, id)) continue;
          const c = classify(update, state.binding, now());
          const binding = state.binding;
          if (c.classification === 'binding_code' && binding.state === 'pending') state.binding = { state: 'bound', revision: binding.revision + 1, userId: c.userId!, chatId: c.chatId!, username: c.username, boundAt: now(), owner: binding.owner };
          else if (c.classification === 'stale_code' && binding.state === 'pending') { binding.failures++; if (binding.failures >= limits.codeAttempts) unbind(state); }
          db.query('INSERT INTO telegram_inbox_v1 (bot_id,update_id,kind,classification,user_id,chat_id,message_id,reply_to,text,binding_revision,received_at,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(bot.id, id, c.kind, c.classification, c.userId, c.chatId, c.messageId, c.replyTo, c.classification === 'authorized' ? c.text : null, state.binding.revision, now(), 'persisted');
        }
        write(state); return highest;
      });
      if (highest === null) return { received: 0 };
      options.beforeOffsetAdvance?.();
      // Commit 2: advance the cursor only past durably recorded updates.
      store.transaction(() => { const state = read(); if (state.bot?.id !== bot.id) return; if (highest >= 0) state.poll.offset = Math.max(state.poll.offset, highest + 1); state.poll.lastPollAt = now(); state.poll.code = null; state.poll.failures = 0; write(state); });
      return { received: updates.length };
    },
    process() {
      const rows = db.query<{ sequence: number }, []>("SELECT sequence FROM telegram_inbox_v1 WHERE status='persisted' ORDER BY sequence LIMIT 32").all(), cache: { actor?: OwnerActor | null } = {};
      for (const { sequence } of rows) processRow(sequence, cache);
      return rows.length;
    },
    observe() {
      const state = read(), binding = state.binding;
      if (binding.state !== 'bound' || !state.bot) return 0;
      const actor = owner(binding); if (!actor) return 0;
      const t = now(), horizon = t - limits.horizonMs, since = Math.max(binding.boundAt, horizon), chatId = binding.chatId;
      let added = 0;
      const once = (eventId: string, notice: TelegramNotice, path: string, extra: { dutyId?: string | null; replyTo?: number | null } = {}) => { if (notify(actor, eventId, chatId, notice, path, extra)) added++; };
      store.transaction(() => {
        // Owner messages that came from this chat (and stall replies sent from it): reply, status, sparse progress.
        for (const row of db.query<InboxRow, [number]>("SELECT * FROM telegram_inbox_v1 WHERE outbound='open' AND received_at>=? ORDER BY sequence DESC LIMIT 64").all(horizon)) {
          const request = (() => { try { return store.request(row.request_id!); } catch { return null; } })();
          const close = () => db.query("UPDATE telegram_inbox_v1 SET outbound='closed' WHERE sequence=?").run(row.sequence);
          if (!request) { close(); continue; }
          const thread = `/chats/${request.receipt.conversationId}#s15-row-${request.receipt.rootRequestId}`;
          if (row.duty_id) {
            const resume = (() => { try { return options.resumes.binding(actor, row.request_id!); } catch { return null; } })();
            if (resume?.state === 'refused') once(`resume:${row.request_id}`, { kind: 'resume_refused', code: resume.code ?? 'execution_not_authorized' }, `/duties/${row.duty_id}`, { replyTo: row.message_id });
          }
          if (request.state === 'queued' || request.state === 'running') { if (t - request.receipt.receivedAt >= limits.progressAfterMs) once(`progress:${row.request_id}`, { kind: 'progress' }, thread, { replyTo: row.message_id }); continue; }
          if (request.state === 'completed' && request.result !== null && request.code === null) {
            let text: string | null = null;
            try { options.conversation.publish(actor, row.request_id!, value => { text = value; }); } catch { text = null; }
            once(`reply:${row.request_id}`, text === null ? { kind: 'status', state: 'blocked', code: 'result_unavailable' } : { kind: 'reply', text }, thread, { replyTo: row.message_id });
            close(); continue;
          }
          const status = statusOf(request);
          if (status) once(`status:${row.request_id}:${status}:${request.code ?? ''}`, { kind: 'status', state: status, code: request.code }, thread, { replyTo: row.message_id });
          if (request.state === 'stopped' || request.state === 'completed' || request.state === 'blocked') close();
        }
        // Paused responsibilities: one report per pause, with the recommendation as labelled Jit text.
        let duties: ReturnType<TelegramChannelOptions['work']['list']> = [];
        try { duties = options.work.list(actor); } catch { duties = []; }
        for (const duty of duties) if (duty.state === 'paused' && duty.report && duty.report.at >= since) once(`stall:${duty.id}:${duty.report.at}`, { kind: 'stall', duty }, `/duties/${duty.id}`, { dutyId: duty.id });
        // Held actions: a notice that links to the exact Web slip. It carries no approve control.
        const candidates = db.query<{ id: string }, [number]>("SELECT id FROM requests WHERE json_array_length(json_extract(record_json,'$.actions'))>0 AND state<>'stopped' AND json_extract(record_json,'$.receipt.receivedAt')>=? ORDER BY rowid DESC LIMIT 64").all(horizon);
        for (const { id } of candidates) {
          let slips: ReturnType<TelegramChannelOptions['conversation']['slips']> = [];
          try { slips = options.conversation.slips(actor, store.request(id).actions); } catch { slips = []; }
          for (const slip of slips) if (slip.state === 'pending' && slip.action.createdAt >= since) once(`held:${slip.action.id}:${slip.action.revision}`, { kind: 'held', slip }, `/actions/${slip.action.id}?r=${slip.action.revision}`);
        }
        // Bounded retention: event identities outlive the observation window, so nothing is derived twice.
        const old = horizon - 24 * 3_600_000;
        db.query('DELETE FROM telegram_events_v1 WHERE created_at<?').run(old);
        db.query("DELETE FROM telegram_outbox_v1 WHERE state IN ('sent','failed','cancelled','unknown') AND created_at<?").run(old);
        db.query("DELETE FROM telegram_inbox_v1 WHERE status='processed' AND received_at<?").run(old);
      });
      return added;
    },
    async deliver(signal) {
      let sent = 0;
      for (let round = 0; round < 32; round++) {
        const state = read(), binding = state.binding, t = now();
        if (binding.state !== 'bound' || !state.bot || t < state.send.notBefore) break;
        const secret = token(); if (!secret) break;
        const row = db.query<OutboxRow, [number]>("SELECT * FROM telegram_outbox_v1 WHERE state='pending' AND next_at<=? ORDER BY sequence LIMIT 1").get(t);
        if (!row) break;
        if (row.chat_id !== binding.chatId) { db.query("UPDATE telegram_outbox_v1 SET state='cancelled', code='telegram_unbound', settled_at=? WHERE sequence=?").run(t, row.sequence); continue; }
        // The attempt commits before the network call; a crash now leaves `sending`, which reopens as unknown.
        store.transaction(() => { db.query("UPDATE telegram_outbox_v1 SET state='sending', attempts=attempts+1 WHERE sequence=? AND state='pending'").run(row.sequence); const s = read(); s.send.notBefore = t + limits.sendSpacingMs; write(s); });
        try {
          const result = await options.transport(secret).sendMessage({ chatId: row.chat_id, text: row.text, replyTo: row.reply_to }, signal);
          if (!result || !Number.isSafeInteger(result.message_id)) throw new TelegramTransportError('telegram_protocol', 'unknown');
          db.query("UPDATE telegram_outbox_v1 SET state='sent', message_id=?, code=NULL, settled_at=? WHERE sequence=?").run(result.message_id, now(), row.sequence); sent++;
        } catch (error) {
          const failure = error instanceof TelegramTransportError ? error : new TelegramTransportError('telegram_unreachable', 'unknown');
          store.transaction(() => {
            if (failure.outcome === 'unknown') db.query("UPDATE telegram_outbox_v1 SET state='unknown', code=?, settled_at=? WHERE sequence=?").run(failure.code, now(), row.sequence);
            else if (failure.retryAfterSeconds !== null || failure.code === 'telegram_token_rejected' || failure.code === 'telegram_unavailable') {
              // A definite refusal: the same part may go later, after Telegram's own retry_after.
              const later = now() + (failure.retryAfterSeconds ?? 30) * 1000;
              db.query("UPDATE telegram_outbox_v1 SET state='pending', next_at=?, code=? WHERE sequence=?").run(later, failure.code, row.sequence);
              const s = read(); s.send.notBefore = Math.max(s.send.notBefore, later); write(s);
            } else db.query("UPDATE telegram_outbox_v1 SET state='failed', code=?, settled_at=? WHERE sequence=?").run(failure.code, now(), row.sequence);
          });
          break;
        }
      }
      return sent;
    },
    start(wake) {
      if (loops || closed) return;
      const controller = new AbortController(), signal = controller.signal;
      const sleep = (ms: number) => options.clock.sleep(ms, signal).catch(() => {});
      const polling = (async () => {
        let backoff = limits.backoffMs.min;
        while (!signal.aborted) {
          if (!read().bot || vault.inspect(tokenKey) !== 'present') { await sleep(5000); continue; }
          poll = new AbortController();
          try { await channel.pollOnce(limits.pollTimeoutSeconds, AbortSignal.any([signal, poll.signal])); backoff = limits.backoffMs.min; await wake().catch(() => {}); }
          catch { if (signal.aborted) break; await sleep(backoff); backoff = Math.min(backoff * 2, limits.backoffMs.max); }
          finally { poll = null; }
        }
      })();
      const sending = (async () => {
        while (!signal.aborted) { try { await channel.deliver(signal); } catch { /* Recorded per part; the loop continues. */ } await sleep(limits.sendSpacingMs); }
      })();
      loops = { controller, done: Promise.allSettled([polling, sending]) };
    },
    async close() { closed = true; if (loops) { loops.controller.abort(); await loops.done; loops = null; } },
  };
  return channel;
}
