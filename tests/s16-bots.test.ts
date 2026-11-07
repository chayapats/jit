import { afterEach, expect, test } from 'bun:test';
import type { Model } from 'schway/host';
import type { S15CompositionOptions } from '../src/s15/composition';
import type { BotProposal, BotReceipt, BotsView, BotDetail, BotExport } from '../src/s16/bots/types';
import { composedFixture } from './fixtures/s15-composition';

// BOT16-01 + DELEG16-01 under the real composition: exact proposals, team defaults, per-conversation Bots, archive and
// restore fences, credential-free duplicate/export/import, and bounded peer/temporary delegation with shared budget.
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
type Fixture = Awaited<ReturnType<typeof composedFixture>>;
const uid = () => crypto.randomUUID().replaceAll('-', '');

/** Scripted model: a parent with `delegate` calls it once; anything else runs one VM command and reports its result. */
function botModel(plan: { delegate?: () => unknown; gate?: Map<string, Promise<void>> }) {
  const prompts: string[] = [];
  const model: Model = { provider: 'codex-subscription', id: 'fixture-model', async *stream(request) {
    const text = JSON.stringify(request); prompts.push(text);
    const last = request.items.at(-1);
    const reply = (content: ({ type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> } | { type: 'text'; text: string })[]) => ({ type: 'message_complete' as const, message: { type: 'assistant' as const, id: uid(), content } });
    if (last?.type === 'tool_result') { yield reply([{ type: 'text', text: `Finished: ${last.content.slice(0, 400)}` }]); return; }
    if (plan.delegate && request.tools?.some(tool => tool.name === 'delegate')) { yield reply([{ type: 'tool_call', id: uid(), name: 'delegate', arguments: plan.delegate() as Record<string, unknown> }]); return; }
    for (const [marker, wait] of plan.gate ?? []) if (text.includes(marker)) await wait;
    const bash = request.tools?.some(tool => tool.name === 'bash');
    yield reply([bash ? { type: 'tool_call', id: uid(), name: 'bash', arguments: { command: 'printf child' } } : { type: 'tool_call', id: uid(), name: 'read', arguments: { path: 'notes.txt' } }]);
  } };
  return { model, prompts };
}
async function bots(model?: Model, tune?: (o: S15CompositionOptions) => S15CompositionOptions) {
  const f = await composedFixture('default', false, undefined, o => {
    const next: S15CompositionOptions = { ...o, bots: {}, computers: { idleStopMs: 30 * 60_000, sweepMs: 0 }, conversation: { ...o.conversation, limits: { ...o.conversation.limits, modelCalls: 12 } }, ...(model ? { model: { ...o.model, scripted: () => model } } : {}) };
    return tune ? tune(next) : next;
  });
  cleanups.push(() => f.close()); return f;
}
const json = async <T>(response: Response, status = 200): Promise<T> => { const text = await response.text(); expect({ status: response.status, text }).toMatchObject({ status }); return JSON.parse(text) as T; };
const draft = (name: string, extra: Partial<{ responsibility: string; excluded: string[]; assignments: boolean }> = {}) => ({ contract: 's16-bot-draft/v1' as const, name, responsibility: extra.responsibility ?? `${name} looks after the accounts.`, selection: null, excluded: extra.excluded ?? [], assignments: extra.assignments ?? true });
const command = (f: Fixture, value: Record<string, unknown>) => f.request('/api/s16/client/bots/commands', 'POST', { contract: 's16-bot-command/v1', requestId: uid(), ...value });
async function createBot(f: Fixture, name: string, extra: Parameters<typeof draft>[1] = {}) {
  const proposal = await json<BotProposal>(await f.request('/api/s16/client/bots/proposals', 'POST', { draft: draft(name, extra) }), 201);
  const receipt = await json<BotReceipt>(await command(f, { kind: 'bot.accept', proposalId: proposal.id, proposalHash: proposal.proposalHash }));
  return receipt.bot!;
}
async function say(f: Fixture, conversationId: string, text: string, requestId = uid()) {
  const response = await f.request(`/api/s16/client/conversations/${conversationId}/messages`, 'POST', { contract: 's15-conversation/v1', requestId, conversationId, text, continuation: null });
  return { response, requestId };
}
const run = async (f: Fixture, conversationId: string, text: string) => { const sent = await say(f, conversationId, text); expect(sent.response.status).toBe(202); await f.service.conversation.drain(); return f.service.conversation.view(f.owner, sent.requestId); };

test('BOT16-01: an exact accepted proposal creates a Bot with the team defaults; a changed proposal cannot reuse the acceptance', async () => {
  const f = await bots();
  const before = f.service.policy.owner.current(f.owner)!;
  // A running work of the main Bot keeps its authority across the install that adds a Bot (membership-only revision).
  const main = f.service.policy.owner.admit(f.owner, { requestId: 'main_work', intent: 'execute', access: 'reversible_write', purpose: f.policyInput.purposes[0]!, bot: f.policyInput.bots[0]!, resources: [f.policyInput.resources[0]!], recipients: [], selection: f.choice, selectionPin: null, expiresAt: 800000 }).work!;
  const actor = f.service.policy.control.bindWork(main.id);

  const first = await json<BotProposal>(await f.request('/api/s16/client/bots/proposals', 'POST', { draft: draft('Ledger') }), 201);
  expect(first.resources.map(r => r.id)).toEqual(['account', 'computer', 'repo']);
  const edited = await json<BotProposal>(await f.request('/api/s16/client/bots/proposals', 'POST', { draft: draft('Ledger', { excluded: ['account'] }) }), 201);
  expect(edited.proposalHash).not.toBe(first.proposalHash);
  // The first acceptance cannot be replayed against the edited proposal, and a wrong hash refuses.
  expect((await command(f, { kind: 'bot.accept', proposalId: edited.id, proposalHash: first.proposalHash })).status).toBe(409);
  const receipt = await json<BotReceipt>(await command(f, { kind: 'bot.accept', proposalId: edited.id, proposalHash: edited.proposalHash }));
  const bot = receipt.bot!;
  expect(bot).toMatchObject({ name: 'Ledger', origin: 'created', state: 'active', excluded: ['account'] });
  // The other pending proposal was reviewed against the previous policy revision, so it needs a fresh proposal now.
  expect(await (await command(f, { kind: 'bot.accept', proposalId: first.id, proposalHash: first.proposalHash })).json()).toEqual({ error: 'stale_proposal' });

  const after = f.service.policy.owner.current(f.owner)!;
  expect(after.revision).toBe(before.revision + 1);
  expect(after.bots.map(b => b.id)).toContain(bot.id);
  expect(after.rules.find(r => r.id === 'ordinary')!.bots.map(b => b.id)).toContain(bot.id);
  expect(() => f.service.policy.work.guard(actor)).not.toThrow();
  // Every other field of the policy is unchanged.
  const strip = (p: typeof after) => ({ ...p, revision: 0, bots: [], rules: p.rules.map(r => ({ ...r, bots: [] })) });
  expect(strip(after)).toEqual(strip(before));
  const view = await json<BotsView>(await f.request('/api/s16/client/bots'));
  expect(view.bots.map(b => [b.id, b.main])).toEqual([['bot', true], ['specialist', false], [bot.id, false]]);
  expect(view.proposals.map(p => p.id)).toEqual([first.id]);
});

test('BOT16-01: a conversation talks to its Bot with its route and responsibility, and the Bot never uses an excluded resource', async () => {
  const { model, prompts } = botModel({});
  const f = await bots(model), bot = await createBot(f, 'Ledger', { responsibility: 'Keeps the household ledger tidy.', excluded: ['repo'] });
  expect((await command(f, { kind: 'conversation.bind', conversationId: 'ledger_chat', botId: bot.id })).status).toBe(200);
  const row = await run(f, 'ledger_chat', 'Update the ledger folder');
  expect(row.state).toBe('completed');
  const work = f.service.policy.work.guard(f.service.policy.control.bindWork(row.authority!.id));
  expect(work.request.bot.id).toBe(bot.id);
  expect(prompts.some(p => p.includes('Keeps the household ledger tidy.'))).toBe(true);
  // A started conversation keeps its Bot; another Bot cannot take it over.
  expect((await command(f, { kind: 'conversation.bind', conversationId: 'ledger_chat', botId: 'specialist' })).status).toBe(409);
  expect((await command(f, { kind: 'conversation.bind', conversationId: 'conversation_started', botId: 'bot' })).status).toBe(200);
  // The excluded repository is not offered for interpretation and POLICY refuses it for this Bot.
  f.interpretation = { intent: 'execute', purposeId: 'purpose', resourceIds: ['repo'], access: 'reversible_write', subject: null };
  const refused = await run(f, 'ledger_chat', 'Update the repository');
  expect(refused.state).not.toBe('completed');
  const snapshot = await json<{ botId: string }>(await f.request('/api/s16/client/conversations/ledger_chat'));
  expect(snapshot.botId).toBe(bot.id);
  const boot = await json<{ conversations: { conversationId: string; botId: string }[]; bots: { id: string }[] }>(await f.request('/api/s16/client/bootstrap'));
  expect(boot.conversations.find(c => c.conversationId === 'ledger_chat')!.botId).toBe(bot.id);
  expect(boot.bots.map(b => b.id)).toContain(bot.id);
});

test('BOT16-01: archive during work stops it and fences new sends; restore brings back the same identity with its history across restart', async () => {
  let release!: () => void;
  const gate = new Map([['HOLD', new Promise<void>(resolve => { release = resolve; })]]);
  const { model } = botModel({ gate });
  const f = await bots(model), bot = await createBot(f, 'Ledger');
  await json(await command(f, { kind: 'conversation.bind', conversationId: 'ledger_chat', botId: bot.id }));
  const done = await run(f, 'ledger_chat', 'Update the first task');
  expect(done.state).toBe('completed');
  const sent = await say(f, 'ledger_chat', 'Update HOLD this task'); expect(sent.response.status).toBe(202);
  const draining = f.service.conversation.drain();
  for (let i = 0; i < 400 && !f.service.conversation.store.request(sent.requestId).authority; i++) await new Promise(r => setTimeout(r, 5));
  const running = f.service.conversation.store.request(sent.requestId);
  expect(running.state).toBe('running');
  const workActor = f.service.policy.control.bindWork(running.authority!.id);

  const detail = await json<BotDetail>(await f.request(`/api/s16/client/bots/${bot.id}`));
  expect(detail.impact.running.map(r => r.requestId)).toEqual([sent.requestId]);
  expect((await command(f, { kind: 'bot.archive', botId: 'bot', expectedRevision: 0 })).status).toBe(409);
  const archived = await json<BotReceipt>(await command(f, { kind: 'bot.archive', botId: bot.id, expectedRevision: detail.bot.revision }));
  expect(archived).toMatchObject({ stopped: 1, bot: { state: 'archived' } });
  release(); await draining;
  expect(f.service.conversation.store.request(sent.requestId).state).toBe('stopped');
  expect(() => f.service.policy.work.guard(workActor)).toThrow();
  const fenced = await say(f, 'ledger_chat', 'Another task');
  expect(fenced.response.status).toBe(409); expect(await fenced.response.json()).toEqual({ error: 'bot_archived' });

  const restored = await json<BotReceipt>(await command(f, { kind: 'bot.restore', botId: bot.id, expectedRevision: archived.bot!.revision }));
  expect(restored.bot!.state).toBe('active');
  // The same identity returns without a policy change; the stopped (revoked) work never resumes.
  expect(f.service.bots!.catalog(bot.id)).toEqual({ ref: { id: bot.id, revision: 1, generation: 1 }, active: true });
  expect(() => f.service.policy.work.guard(workActor)).toThrow();
  await f.reopen();
  const after = await json<BotDetail>(await f.request(`/api/s16/client/bots/${bot.id}`));
  expect(after.bot).toMatchObject({ id: bot.id, name: 'Ledger', state: 'active' });
  expect(after.conversations.map(c => c.conversationId)).toEqual(['ledger_chat']);
  expect(f.service.conversation.view(f.owner, done.receipt.requestId).result).not.toBeNull();
  expect((await run(f, 'ledger_chat', 'Update the next task after restore')).state).toBe('completed');
});

test('BOT16-01: duplicate and export copy configuration only; import lists what this installation lacks', async () => {
  const f = await bots(), bot = await createBot(f, 'Ledger', { excluded: ['account'] });
  const exported = await json<BotExport>(await f.request(`/api/s16/client/bots/${bot.id}/export`));
  expect(exported).toEqual({ contract: 's16-bot-export/v1', name: 'Ledger', responsibility: 'Ledger looks after the accounts.', model: null, excluded: [{ id: 'account', label: 'account' }], assignments: true, exportedAt: f.now });
  expect(JSON.stringify(exported)).not.toMatch(/token|secret|password|history|memory/i);
  const copy = await json<BotProposal>(await f.request(`/api/s16/client/bots/${bot.id}/duplicate`, 'POST', { name: 'Ledger 2' }), 201);
  expect(copy.draft).toEqual({ ...draft('Ledger 2', { excluded: ['account'] }), responsibility: 'Ledger looks after the accounts.' });
  expect(copy.source).toEqual({ kind: 'duplicate', botId: bot.id });
  const imported = await json<BotProposal>(await f.request('/api/s16/client/bots/imports', 'POST', { export: { ...exported, excluded: [...exported.excluded, { id: 'gone', label: 'Old drive' }], model: { provider: 'other', modelId: 'missing', effort: 'high' } } }), 201);
  expect(imported.missing).toEqual(['Old drive', 'other · missing']);
  expect(imported.draft.excluded).toEqual(['account']);
  expect(imported.draft.selection).toBeNull();
  // An import is only a proposal: nothing is created until the owner accepts it.
  expect((await json<BotsView>(await f.request('/api/s16/client/bots'))).bots.length).toBe(3);
  expect((await f.request('/api/s16/client/bots/imports', 'POST', { export: { ...exported, contract: 'other' } })).status).toBe(400);
});

test('DELEG16-01: a peer and a temporary worker return results to the parent; budget exhaustion starts no further child', async () => {
  const { model } = botModel({ delegate: () => ({ assignments: [{ to: 'specialist', task: 'Count the files in the workspace.' }, { to: 'temporary', task: 'List the workspace.' }, { to: 'temporary', task: 'One more helper.' }] }) });
  const f = await bots(model);
  const parent = await run(f, 'conversation', 'Split this task between helpers');
  expect(parent.state).toBe('completed');
  const delegated = parent.evidence.find(e => e.tool === 'delegate')!;
  const output = JSON.parse(f.service.conversation.store.evidence(parent.receipt.requestId).find(e => e.tool === 'delegate')!.content) as { assignments: { to: string; state: string; code: string | null; result: string | null }[] };
  expect(delegated).toBeDefined();
  expect(output.assignments.map(a => [a.to, a.state, a.code])).toEqual([['specialist', 'completed', null], ['temporary', 'completed', null], ['temporary', 'not_started', 'budget_exhausted']]);
  expect(output.assignments[0]!.result).toContain('Finished');
  const view = (await json<{ conversation: { rows: { requestId: string; children?: { kind: string; botId: string; state: string; task: string }[] }[] } }>(await f.request('/api/s16/client/conversations/conversation'))).conversation.rows.at(-1)!;
  expect(view.children!.map(c => [c.kind, c.botId, c.state, c.task])).toEqual([['peer', 'specialist', 'done', 'Count the files in the workspace.'], ['temporary', 'bot', 'done', 'List the workspace.']]);
  // Children run inside the parent's scope with the parent-charged slice; their conversations are not top-level chats.
  const children = f.service.conversation.store.db.query<{ id: string }, []>("SELECT id FROM requests WHERE json_type(record_json,'$.delegation')='object'").all().map(r => f.service.conversation.store.request(r.id));
  expect(children.map(c => [c.delegation!.limits, c.authority!.limits.modelCalls, c.memory])).toEqual([[{ modelCalls: 4, toolCalls: 3 }, 4, undefined], [{ modelCalls: 4, toolCalls: 3 }, 4, undefined]]);
  const peerWork = f.service.policy.control.policyForWork(children[0]!.authority!.id);
  expect(peerWork).toBeDefined();
  expect(f.service.conversation.store.request(parent.receipt.requestId).modelCalls).toBe(1 + 4 + 4 + 1);
  const boot = await json<{ conversations: { conversationId: string }[] }>(await f.request('/api/s16/client/bootstrap'));
  expect(boot.conversations.map(c => c.conversationId)).toEqual(['conversation']);
  const childRow = (await json<{ conversation: { rows: { delegation?: { kind: string; fromBotId: string } }[] } }>(await f.request(`/api/s16/client/conversations/${children[0]!.receipt.conversationId}`))).conversation.rows[0]!;
  expect(childRow.delegation).toMatchObject({ kind: 'peer', fromBotId: 'bot' });
});

test('DELEG16-01: stopping one child keeps its sibling result, and nothing attaches or charges again after a restart', async () => {
  let release!: () => void;
  const gate = new Map([['SLOW', new Promise<void>(resolve => { release = resolve; })]]);
  const { model } = botModel({ delegate: () => ({ assignments: [{ to: 'specialist', task: 'Quick check.' }, { to: 'temporary', task: 'SLOW check.' }] }), gate });
  const f = await bots(model);
  const sent = await say(f, 'conversation', 'Delegate both checks'); expect(sent.response.status).toBe(202);
  const draining = f.service.conversation.drain();
  const children = () => f.service.conversation.store.db.query<{ id: string }, []>("SELECT id FROM requests WHERE json_type(record_json,'$.delegation')='object' ORDER BY rowid").all().map(r => f.service.conversation.store.request(r.id));
  for (let i = 0; i < 400 && !(children().length === 2 && children()[0]!.state === 'completed' && children()[1]!.state === 'running'); i++) await new Promise(r => setTimeout(r, 5));
  expect(children().map(c => c.state)).toEqual(['completed', 'running']);
  const stop = await f.request(`/api/s16/client/requests/${children()[1]!.receipt.requestId}/stop`, 'POST', {});
  expect(stop.status).toBe(200);
  release(); await draining;
  const parent = f.service.conversation.store.request(sent.requestId);
  expect(parent.state).toBe('completed');
  const output = JSON.parse(f.service.conversation.store.evidence(sent.requestId).find(e => e.tool === 'delegate')!.content) as { assignments: { state: string; result: string | null }[] };
  expect(output.assignments.map(a => a.state)).toEqual(['completed', 'stopped']);
  expect(output.assignments[0]!.result).toContain('Finished');
  const before = { calls: parent.modelCalls, tools: parent.toolCalls, children: children().map(c => [c.receipt.requestId, c.state]) };
  const reservations = f.service.policy.control.reservations(children()[0]!.authority!.id).length;
  await f.reopen();
  const reopened = f.service.conversation.store.request(sent.requestId);
  expect({ calls: reopened.modelCalls, tools: reopened.toolCalls, children: children().map(c => [c.receipt.requestId, c.state]) }).toEqual(before);
  expect(f.service.policy.control.reservations(children()[0]!.authority!.id).length).toBe(reservations);
  expect(f.service.conversation.view(f.owner, children()[0]!.receipt.requestId).result).toContain('Finished');
  // A settled parent cannot start further children.
  expect(() => f.service.conversation.submitDelegation(f.owner, { parentRequestId: sent.requestId, kind: 'temporary', botId: 'bot', fromBotId: 'bot', task: 'Again', sourceId: null, bind: () => {} }, { perRequest: 6, concurrent: 3 })).toThrow('delegation_unavailable');
});

test('DELEG16-01: Bot-private context never reaches a peer, and a withdrawn assignment refuses the child at its next send', async () => {
  const { model } = botModel({ delegate: () => ({ assignments: [{ to: 'specialist', task: 'Use what I know.' }, { to: 'temporary', task: 'Helper with my context.' }] }) });
  const f = await bots(model, o => ({ ...o, team: { ...o.team!, retention: work => ({ kind: 'bot', botId: work.request.bot.id, origin: 's15' }) } }));
  const parent = await run(f, 'conversation', 'I prefer short private notes. Please delegate this');
  const output = JSON.parse(f.service.conversation.store.evidence(parent.receipt.requestId).find(e => e.tool === 'delegate')!.content) as { assignments: { to: string; state: string; code: string | null }[] };
  expect(output.assignments.map(a => [a.to, a.state, a.code])).toEqual([['specialist', 'not_started', 'private_context'], ['temporary', 'completed', null]]);

  // Withdrawal of the task's source after admission refuses the child before its next model send.
  let release!: () => void;
  const gate = new Map([['PAUSE', new Promise<void>(resolve => { release = resolve; })]]);
  const second = botModel({ delegate: () => ({ assignments: [{ to: 'temporary', task: 'PAUSE then continue.' }] }), gate });
  const g = await bots(second.model);
  const sent = await say(g, 'conversation', 'Delegate one paused helper'); expect(sent.response.status).toBe(202);
  const draining = g.service.conversation.drain();
  const child = () => { const row = g.service.conversation.store.db.query<{ id: string }, []>("SELECT id FROM requests WHERE json_type(record_json,'$.delegation')='object'").get(); return row ? g.service.conversation.store.request(row.id) : null; };
  for (let i = 0; i < 400 && child()?.state !== 'running'; i++) await new Promise(r => setTimeout(r, 5));
  for (let i = 0; i < 400 && !second.prompts.some(p => p.includes('PAUSE') && !p.includes('"delegate"')); i++) await new Promise(r => setTimeout(r, 5));
  g.service.team.withdraw(g.owner, child()!.delegation!.sourceId!);
  release(); await draining;
  expect(child()!.state).toBe('held');
  expect(child()!.code).toBe('lineage_withdrawn');
});

test('BOT16-01: on a default-policy installation the next default proposal keeps every accepted Bot', async () => {
  const { firstRunFixture } = await import('./fixtures/s15-first-run');
  const f = await firstRunFixture(o => ({ ...o, bots: {} })); cleanups.push(() => f.close());
  const hashIn = (html: string, name: string) => new RegExp(`name="${name}" value="([a-f0-9]{64})"`).exec(html)?.[1];
  const install = async () => { const page = await f.page('/rules', 'en'); const listHash = hashIn(page.html, 'listHash'); return f.form('/s15/forms/rules/install', { proposalHash: hashIn(page.html, 'proposalHash')!, ...(listHash ? { listHash } : {}), return: 'rules' }); };
  expect([200, 303]).toContain((await install()).status);
  const owner = f.owner(), directory = f.service.bots!;
  const proposal = directory.propose(owner, draft('Writer'));
  const receipt = directory.command(owner, { contract: 's16-bot-command/v1', requestId: 'accept_writer', kind: 'bot.accept', proposalId: proposal.id, proposalHash: proposal.proposalHash });
  const accepted = f.service.policy.owner.current(owner)!;
  expect(accepted.bots.map(b => b.id)).toEqual(['jit', receipt.bot!.id]);
  expect(accepted.rules.filter(r => r.mode === 'ordinary' || r.mode === 'owner_named_send').every(r => r.bots.some(b => b.id === receipt.bot!.id))).toBe(true);
  // The default proposal now names the Bot too, so the rules page shows the installed rules as current, not a change.
  const page = await f.page('/rules', 'en');
  expect(hashIn(page.html, 'proposalHash')).toBeUndefined();
});

test('BOT16-01: POLICY keeps a work across an install that only adds other Bots, and refuses it when its own rules change', async () => {
  const f = await bots();
  const work = f.service.policy.owner.admit(f.owner, { requestId: 'kept', intent: 'execute', access: 'reversible_write', purpose: f.policyInput.purposes[0]!, bot: f.policyInput.bots[0]!, resources: [f.policyInput.resources[0]!], recipients: [], selection: f.choice, selectionPin: null, expiresAt: 800000 }).work!;
  const actor = f.service.policy.control.bindWork(work.id);
  await createBot(f, 'Ledger');
  expect(() => f.service.policy.work.guard(actor)).not.toThrow();
  const current = f.service.policy.owner.current(f.owner)!;
  const { contract: _c, revision, ownerGeneration: _g, ...input } = current;
  // Removing the work's own Bot from a rule is a change of its authority.
  f.service.policy.owner.install(f.owner, 'narrow', revision, { ...input, rules: input.rules.map(r => ({ ...r, bots: r.bots.filter(b => b.id !== 'bot') })) });
  expect(() => f.service.policy.work.guard(actor)).toThrow('stale_authority');
});

test('BOT16-01: an acceptance interrupted after its policy install records the same Bot when the owner retries it', async () => {
  const f = await bots(), directory = f.service.bots!;
  const proposal = directory.propose(f.owner, draft('Ledger'));
  const accept = { contract: 's16-bot-command/v1' as const, requestId: 'interrupted_accept', kind: 'bot.accept' as const, proposalId: proposal.id, proposalHash: proposal.proposalHash };
  // Simulate the crash: the directory record write fails once, after POLICY installed the revision.
  const save = directory.store.transaction.bind(directory.store); let fail = true;
  directory.store.transaction = (<T>(action: () => T): T => { if (fail) { fail = false; throw new Error('crash'); } return save(action); }) as typeof directory.store.transaction;
  expect(() => directory.command(f.owner, accept)).toThrow('crash');
  const installed = f.service.policy.owner.current(f.owner)!;
  expect(installed.bots.filter(b => b.id.startsWith('bot_')).length).toBe(1);
  const receipt = directory.command(f.owner, accept);
  expect(receipt.bot!.id).toBe(installed.bots.find(b => b.id.startsWith('bot_'))!.id);
  expect(f.service.policy.owner.current(f.owner)!.revision).toBe(installed.revision);
  expect(directory.command(f.owner, accept)).toEqual(receipt);
});
