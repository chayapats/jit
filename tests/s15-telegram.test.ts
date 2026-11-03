import { afterEach, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composedFixture } from './fixtures/s15-composition';
import { TelegramTransportError, conversationIdFor, requestIdFor, splitText, type TelegramTransport } from '../src/s15/telegram';
import { createTelegramBotApi } from '../src/s15/telegram/api';

// CHAN15-01 (#368): a bound Telegram owner channel over the composed S15 runtime. Scripted transport only; no live Bot API.
const token = '123456:' + 'Q7'.repeat(18), botId = 123456, ownerId = 777001;
type Sent = { chatId: number; text: string; replyTo: number | null; message_id: number };
const fixtures: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });

function scripted() {
  const state = { updates: [] as Record<string, unknown>[], sent: [] as Sent[], offsets: [] as number[], fail: [] as (TelegramTransportError | 'hang')[], tokens: new Set<string>() };
  let seq = 9000;
  const transport = (secret: string): TelegramTransport => {
    state.tokens.add(secret);
    const check = () => { if (secret !== token) throw new TelegramTransportError('telegram_token_rejected', 'not_sent'); };
    return {
      async getMe() { check(); return { id: botId, is_bot: true, username: 'jit_test_bot' }; },
      // Telegram drops every update below the acknowledged offset and returns the rest again.
      async getUpdates(input) { check(); state.offsets.push(input.offset); return structuredClone(state.updates.filter(update => (update.update_id as number) >= input.offset)); },
      async sendMessage(input) { check(); const failure = state.fail.shift(); if (failure === 'hang') return new Promise(() => {}); if (failure) throw failure; const message_id = ++seq; state.sent.push({ ...input, message_id }); return { message_id }; },
    };
  };
  return { state, transport };
}
const message = (update_id: number, text: string | null, extra: Record<string, unknown> = {}, from = ownerId) => ({ update_id, message: { message_id: update_id * 10, date: 0, chat: { id: from, type: 'private' }, from: { id: from, is_bot: false, username: 'owner_tg' }, ...(text === null ? {} : { text }), ...extra } });

async function telegramFixture(limits: Partial<import('../src/s15/telegram').TelegramLimits> = {}) {
  const tg = scripted(); let crash = false;
  const f = await composedFixture('default', false, undefined, options => ({ ...options, telegram: { vault: options.vm.managementVault!, transport: tg.transport, limits: { sendSpacingMs: 0, ...limits },
    beforeOffsetAdvance: () => { if (crash) { crash = false; throw new Error('simulated crash before offset advance'); } } } }));
  const t = () => f.service.telegram!;
  const helpers = { f, tg, t, crashNextOffset() { crash = true; }, close: () => f.close(),
    texts: () => tg.state.sent.map(item => item.text),
    async push(...updates: Record<string, unknown>[]) { tg.state.updates.push(...updates); await t().pollOnce(); await f.service.drain(); await t().deliver(); },
    requests: () => f.service.conversation.store.db.query<{ id: string; conversation_id: string }, []>('SELECT id, conversation_id FROM requests ORDER BY rowid').all(),
    async bind(update = 1) {
      expect((await f.form('/s15/forms/telegram/token', { token })).status).toBe(303);
      expect((await f.form('/s15/forms/telegram/bind', {})).status).toBe(303);
      const status = t().status(f.owner); if (status.binding.state !== 'pending') throw Error('not pending');
      await helpers.push(message(update, `/start ${status.binding.code}`));
      expect(t().status(f.owner).binding).toMatchObject({ state: 'bound', userId: ownerId, username: 'owner_tg', current: true });
    } };
  fixtures.push(helpers);
  return helpers;
}

/** A paused responsibility in the Web conversation `conversation`, created after the Telegram binding. */
async function pause(f: Awaited<ReturnType<typeof composedFixture>>, recommendation: string) {
  const source = await f.chat('Run the requested diagnostic command');
  const work = f.service.work.assign(f.owner, { requestId: 'responsibility', sourceRequestId: source.receipt.rootRequestId, completion: 'Diagnose only this failure', triggers: ['schedule'], stallPolicy: { noProgressApproaches: 2, reserveCalls: 2, maxAttempts: 5 } });
  const settle = (handle: Parameters<typeof f.service.work.settle>[0]) => f.service.work.settle(handle, { transportSettled: true, executionSettled: true, effects: 'known', progress: 'none', evidenceRefs: ['diagnostic'], recommendation, usage: { attempts: 1, steps: null, calls: null, reads: null, outputBytes: null, activeMs: null, spendMinor: null } });
  settle(f.service.work.beginAttempt(work.id, { eventId: source.receipt.rootRequestId, approach: 'first' }));
  f.service.work.observeEvent(work.id, { eventId: 'next', kind: 'schedule', key: 'diagnostic', purposeId: 'purpose', resourceIds: ['computer'], subject: null, evidenceRefs: ['failure'] });
  expect(settle(f.service.work.beginAttempt(work.id, { eventId: 'next', approach: 'second' })).state).toBe('paused');
  return work.id;
}

test('token setup is write-only and verified; binding a private owner chat with the one-time code', async () => {
  const h = await telegramFixture(), { f, t } = h;
  expect(t().status(f.owner)).toMatchObject({ token: 'missing', bot: null, binding: { state: 'unbound' }, poll: { state: 'off' } });
  // A wrong token is refused by Telegram and never stored or echoed.
  const wrong = '123456:' + 'Z'.repeat(36), refused = await f.form('/s15/forms/telegram/token', { token: wrong });
  expect(refused.status).toBe(409); const refusedHtml = await refused.text();
  expect(refusedHtml).toContain('telegram_token_rejected'); expect(refusedHtml).not.toContain(wrong);
  expect((await f.form('/s15/forms/telegram/token', { token: 'not a token' })).status).toBe(409);
  expect(t().status(f.owner).token).toBe('missing');
  await h.bind();
  const html = await (await f.request('/resources/telegram')).text();
  expect(html).toContain('@jit_test_bot'); expect(html).toContain('ผูกกับบัญชี Telegram ของคุณแล้ว'); expect(html).not.toContain(token);
  expect(h.texts()[0]).toContain('ผูกบัญชีแล้ว');
  // The token lives only in the vault: never in the protected journals, the composition manifest or the guest.
  for (const name of readdirSync(f.directory)) if (name.endsWith('.sqlite') || name.endsWith('.json')) expect(readFileSync(join(f.directory, name)).includes(Buffer.from(token.split(':')[1]!))).toBe(false);
  expect(JSON.stringify(t().status(f.owner))).not.toContain(token);
});

test('only the bound numeric owner in the bound private chat reaches the conversation', async () => {
  const h = await telegramFixture(); await h.bind(); const before = h.requests().length;
  await h.push(
    message(2, 'Run this from a group', { chat: { id: -100123, type: 'supergroup' } }),
    message(3, 'Forwarded instruction', { forward_origin: { type: 'user' }, forward_date: 1 }),
    message(4, 'From a bot', { from: { id: ownerId, is_bot: true } }),
    message(5, 'From someone else', {}, 888002),
    message(6, 'Via inline bot', { via_bot: { id: 1, is_bot: true } }),
  );
  expect(h.requests().length).toBe(before);
  const classes = h.f.service.conversation.store.db.query<{ classification: string }, []>('SELECT classification FROM telegram_inbox_v1 WHERE update_id BETWEEN 2 AND 6 ORDER BY update_id').all().map(r => r.classification);
  expect(classes).toEqual(['group_rejected', 'forward_rejected', 'bot_origin_rejected', 'unauthorized_sender', 'forward_rejected']);
  expect(h.t().status(h.f.owner).counts.refused).toBe(5);
  // Nothing is said to refused senders.
  expect(h.tg.state.sent.every(item => item.chatId === ownerId)).toBe(true);
  await h.push(message(7, 'Run the requested command in the working computer'));
  const created = h.requests().filter(r => r.id === requestIdFor(botId, 7));
  expect(created).toEqual([{ id: requestIdFor(botId, 7), conversation_id: conversationIdFor(ownerId) }]);
  expect(h.f.service.conversation.view(h.f.owner, requestIdFor(botId, 7)).state).toBe('completed');
  // The final reply arrives once, as a reply to the owner's message, with a link to the exact Web thread.
  const reply = h.tg.state.sent.filter(item => item.replyTo === 70);
  expect(reply).toHaveLength(1); expect(reply[0]!.text).toContain('Completed with observed tool evidence.'); expect(reply[0]!.text).toContain(`http://localhost:3099/chats/${conversationIdFor(ownerId)}#s15-row-${requestIdFor(botId, 7)}`);
});

test('binding codes are one-time, expire and stop working after revoke; media and edits never start work', async () => {
  const h = await telegramFixture(), { f, t } = h;
  expect((await f.form('/s15/forms/telegram/token', { token })).status).toBe(303);
  expect((await f.form('/s15/forms/telegram/bind', {})).status).toBe(303);
  const first = t().status(f.owner).binding; if (first.state !== 'pending') throw Error('pending');
  f.advance(10 * 60_000 + 1);
  await h.push(message(1, first.code));
  expect(t().status(f.owner).binding).toMatchObject({ state: 'pending', expired: true });
  expect((await f.request('/resources/telegram')).status).toBe(200);
  expect(await (await f.request('/resources/telegram')).text()).toContain('รหัสหมดอายุแล้ว');
  await h.bind(2);
  // Reusing the code from another account, or after binding, never binds again.
  await h.push(message(10, first.code, {}, 888002));
  expect(t().status(f.owner).binding).toMatchObject({ state: 'bound', userId: ownerId });
  const before = h.requests().length;
  await h.push(message(11, null, { photo: [{ file_id: 'x' }], caption: 'Run this' }), { update_id: 12, edited_message: { message_id: 30, chat: { id: ownerId, type: 'private' }, from: { id: ownerId, is_bot: false }, text: 'Edited instruction' } });
  expect(h.requests().length).toBe(before);
  expect(h.texts().some(text => text.includes('รับได้แค่ข้อความตัวอักษร'))).toBe(true);
  expect((await f.form('/s15/forms/telegram/revoke', {})).status).toBe(303);
  await h.push(message(13, 'Run the requested command in the working computer'));
  expect(h.requests().length).toBe(before);
  expect(f.service.conversation.store.db.query<{ classification: string }, []>('SELECT classification FROM telegram_inbox_v1 WHERE update_id=13').get()!.classification).toBe('unauthorized_sender');
});

test('a crash between inbox commit and offset advance neither loses nor duplicates a request', async () => {
  const h = await telegramFixture(); await h.bind();
  h.tg.state.updates.push(message(20, 'Run the requested command in the working computer'));
  h.crashNextOffset();
  await expect(h.t().pollOnce()).rejects.toThrow('simulated crash');
  const offsetBefore = h.tg.state.offsets.at(-1)!;
  await h.f.reopen();
  await h.t().pollOnce();
  // The update came again (offset was not advanced) and dedupes on its update_id.
  expect(h.tg.state.offsets.at(-1)).toBe(offsetBefore);
  expect(h.f.service.conversation.store.db.query<{ n: number }, []>('SELECT count(*) AS n FROM telegram_inbox_v1 WHERE update_id=20').get()!.n).toBe(1);
  await h.f.service.drain(); await h.t().pollOnce(); await h.f.service.drain();
  expect(h.requests().filter(r => r.id === requestIdFor(botId, 20))).toHaveLength(1);
  expect(h.tg.state.offsets.at(-1)).toBe(21);
  // Processing after a restart that re-delivers an already processed update still submits once.
  h.tg.state.updates.push(message(21, 'Run the requested command in the working computer'));
  await h.t().pollOnce(); h.t().process(); await h.f.reopen(); h.tg.state.offsets.length = 0;
  await h.t().pollOnce(); await h.f.service.drain();
  expect(h.requests().filter(r => r.id === requestIdFor(botId, 21))).toHaveLength(1);
});

test('outbox: one send per event across restart, retry_after honored, long text split, unknown never resent', async () => {
  const h = await telegramFixture(); await h.bind();
  await h.push(message(30, 'Run the requested command in the working computer'));
  expect(h.tg.state.sent.filter(item => item.replyTo === 300)).toHaveLength(1);
  // A long stall report is split within Telegram's limit; each part is its own outbox entry.
  const duty = await pause(h.f, 'Long line of the recommendation. '.repeat(120).trim());
  await h.f.service.drain(); await h.t().deliver();
  const parts = h.tg.state.sent.filter(item => item.text.includes('Long line') || item.text.includes(`/duties/${duty}`));
  expect(parts.length).toBe(2); expect(parts.every(item => item.text.length <= 4096)).toBe(true);
  expect(splitText('a'.repeat(9000)).map(part => part.length)).toEqual([4096, 4096, 808]);
  const count = h.tg.state.sent.length;
  await h.f.reopen(); await h.f.service.drain(); await h.t().deliver();
  expect(h.tg.state.sent.length).toBe(count);

  // Telegram's 429 is a definite refusal: the same part is sent again only after retry_after.
  h.tg.state.fail.push(new TelegramTransportError('telegram_rate_limited', 'not_sent', 5));
  await h.push(message(31, '/help'));
  expect(h.tg.state.sent.length).toBe(count);
  h.f.advance(4000); await h.t().deliver(); expect(h.tg.state.sent.length).toBe(count);
  h.f.advance(1001); await h.t().deliver(); expect(h.tg.state.sent.length).toBe(count + 1);
  expect(h.texts().at(-1)).toContain('การอนุมัติทำในหน้าเว็บเท่านั้น');

  // An ambiguous failure, or a send interrupted by a restart, is recorded as unknown and never repeated.
  h.tg.state.fail.push(new TelegramTransportError('telegram_unreachable', 'unknown'));
  await h.push(message(32, '/help'));
  h.tg.state.fail.push('hang');
  h.tg.state.updates.push(message(33, '/start')); await h.t().pollOnce(); await h.f.service.drain();
  void h.t().deliver();
  await h.f.reopen(); await h.t().deliver(); await h.f.service.drain(); await h.t().deliver();
  expect(h.tg.state.sent.length).toBe(count + 1);
  expect(h.t().status(h.f.owner).counts.unknown).toBe(2);
  const html = await (await h.f.request('/resources/telegram')).text();
  expect(html).toContain('2 ข้อความ ไม่ทราบว่าส่งถึงหรือไม่');
});

test('credential-shaped text is refused in both directions', async () => {
  const h = await telegramFixture(); await h.bind(); const before = h.requests().length;
  const secret = 'ghp_' + 'A1b2C3d4'.repeat(5);
  await h.push(message(40, `use this token ${secret} for the repo`));
  expect(h.requests().length).toBe(before);
  expect(h.texts().at(-1)).toContain('ดูเหมือนมีรหัสผ่านหรือ token');
  expect(h.f.service.conversation.store.db.query<{ text: string | null; kind: string }, []>('SELECT text, kind FROM telegram_inbox_v1 WHERE update_id=40').get()).toEqual({ text: null, kind: 'credential' });
  expect(h.tg.state.sent.some(item => item.text.includes(secret))).toBe(false);
});

test('a held action is announced with its exact Web slip link; typing approve in Telegram approves nothing', async () => {
  const h = await telegramFixture(); await h.bind(); const { f } = h;
  f.interpretation = { intent: 'execute', purposeId: 'purpose', resourceIds: ['account'], access: 'effect', subject: null };
  const mail = (await import('./fixtures/s15-effects')).mail();
  f.script = [{ type: 'tool_call', id: 'email', name: 'gmail_prepare_send', arguments: { ...mail } }];
  await h.push(message(50, 'Send the prepared email to the recipient'));
  const held = f.service.conversation.view(f.owner, requestIdFor(botId, 50)).slips[0]!;
  expect(held).toMatchObject({ state: 'pending', canApprove: true });
  const notice = h.texts().find(text => text.includes(`/actions/${held.action.id}?r=${held.action.revision}`));
  expect(notice).toContain('อนุมัติใน Telegram ไม่ได้');
  const before = h.requests().length;
  for (const [id, text] of [[51, 'อนุมัติ'], [52, 'approve'], [53, `approve ${held.action.id}`]] as const) await h.push(message(id, text));
  expect(h.requests().length).toBe(before);
  expect(f.google.sent.size).toBe(0);
  expect(f.service.conversation.view(f.owner, requestIdFor(botId, 50)).slips[0]!.state).toBe('pending');
  expect(h.texts().filter(text => text.includes('การอนุมัติทำใน Telegram ไม่ได้'))).toHaveLength(3);
  // The held notice is sent once, even after a restart.
  await f.reopen(); await f.service.drain(); await h.t().deliver();
  expect(h.texts().filter(text => text.includes(`/actions/${held.action.id}?r=`))).toHaveLength(1);
});

test('a reply to a stall report resumes that duty through the durable binding; another reply is an ordinary message', async () => {
  const h = await telegramFixture(); await h.bind(); const { f } = h;
  const work = { id: await pause(f, 'Inspect the configuration within the original scope.') };
  await f.service.drain(); await h.t().deliver();
  const report = h.tg.state.sent.find(item => item.text.includes('หยุดพักไว้'))!;
  expect(report.text).toContain('Inspect the configuration within the original scope.'); expect(report.text).toContain(`/duties/${work.id}`);
  f.advance(1);
  // A reply to the welcome message is an ordinary message in the Telegram conversation.
  const welcome = h.tg.state.sent[0]!;
  await h.push(message(60, 'Run the requested command in the working computer', { reply_to_message: { message_id: welcome.message_id } }));
  expect(f.service.conversation.view(f.owner, requestIdFor(botId, 60)).receipt.conversationId).toBe(conversationIdFor(ownerId));
  expect(f.service.work.project(f.owner, work.id).state).toBe('paused');
  // A reply to the stall report goes to the duty's own conversation and resumes only through WORK's checks.
  await h.push(message(61, 'Run the next diagnostic within the same scope', { reply_to_message: { message_id: report.message_id } }));
  const resumed = requestIdFor(botId, 61);
  expect(f.service.conversation.view(f.owner, resumed).receipt.conversationId).toBe('conversation');
  expect(f.service.resumes.binding(f.owner, resumed)).toMatchObject({ state: 'resumed', dutyId: work.id });
  expect(f.service.work.project(f.owner, work.id)).toMatchObject({ state: 'ready', readyEventId: resumed });
  expect(h.texts().some(text => text.includes('รับคำตอบแล้ว'))).toBe(true);
});

test('sparse progress for long work, a visible retention gap, and removal stops the channel but keeps history', async () => {
  const h = await telegramFixture({ retentionMs: 10 * 60_000 }); await h.bind(); const { f, t } = h;
  h.tg.state.updates.push(message(70, 'Run the requested command in the working computer'));
  await t().pollOnce(); t().process();
  f.advance(2 * 60_000); t().observe(); t().observe(); await t().deliver();
  expect(h.texts().filter(text => text.includes('จิตยังทำงานนี้อยู่'))).toHaveLength(1);
  await f.service.drain(); await t().deliver();
  // The test limit stands in for Telegram's 24-hour retention; the owner session would expire before a real day.
  f.advance(11 * 60_000); await t().pollOnce();
  expect(t().status(f.owner).poll.gap).toMatchObject({ since: expect.any(Number) });
  expect(await (await f.request('/resources/telegram')).text()).toContain('อาจมีข้อความหายไป');
  expect((await f.form('/s15/forms/telegram/gap', {})).status).toBe(303);
  expect(t().status(f.owner).poll.gap).toBeNull();
  const history = h.requests().length;
  expect((await f.form('/s15/forms/telegram/remove', {})).status).toBe(303);
  expect(t().status(f.owner)).toMatchObject({ token: 'missing', bot: null, binding: { state: 'unbound' }, poll: { state: 'off' } });
  const polls = h.tg.state.offsets.length; await t().pollOnce(); expect(h.tg.state.offsets.length).toBe(polls);
  expect(h.requests().length).toBe(history);
});

test('the real Bot API transport keeps the token out of every error and classifies outcomes', async () => {
  const urls: string[] = [];
  const respond = (status: number, body: unknown) => async (url: string | URL | Request) => { urls.push(String(url)); return new Response(JSON.stringify(body), { status }); };
  const api = (fetchImpl: (url: string | URL | Request) => Promise<Response>) => createTelegramBotApi(token, fetchImpl as typeof fetch);
  expect(await api(respond(200, { ok: true, result: { id: botId, is_bot: true, username: 'b' } })).getMe()).toEqual({ id: botId, is_bot: true, username: 'b' });
  expect(urls[0]).toBe(`https://api.telegram.org/bot${token}/getMe`);
  const failure = async (call: Promise<unknown>) => { try { await call; } catch (error) { return error as TelegramTransportError; } throw Error('expected failure'); };
  const limited = await failure(api(respond(429, { ok: false, parameters: { retry_after: 7 } })).sendMessage({ chatId: 1, text: 'x', replyTo: null }));
  expect(limited).toMatchObject({ code: 'telegram_rate_limited', outcome: 'not_sent', retryAfterSeconds: 7 });
  const network = await failure(api(async () => { throw new Error(`connect failed https://api.telegram.org/bot${token}/sendMessage`); }).sendMessage({ chatId: 1, text: 'x', replyTo: null }));
  expect(network).toMatchObject({ code: 'telegram_unreachable', outcome: 'unknown' }); expect(String(network.message) + String(network.stack)).not.toContain(token);
  expect(await failure(api(respond(502, { ok: false })).sendMessage({ chatId: 1, text: 'x', replyTo: null }))).toMatchObject({ outcome: 'unknown' });
  expect(await failure(api(respond(401, { ok: false })).getMe())).toMatchObject({ code: 'telegram_token_rejected', outcome: 'not_sent' });
});
