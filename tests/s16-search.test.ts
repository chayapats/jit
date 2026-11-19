import { equal } from '../src/s15/policy/validation';
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { composedFixture } from './fixtures/s15-composition';
import { routineFixture } from './fixtures/s16-routines';
import type { SearchLabelCommand, SearchLabelReceipt, SearchPage } from '../src/s16/search/contracts';
import { parseSearchQuery } from '../src/s16/search/query';
import { JitClient } from '../src/s16/client';
import { SearchDirectory } from '../src/s16/search/service';
import { ref } from './fixtures/s15-composition';
import type { ApprovedModelRoute } from '../src/s15/model';
import type { FileUpload } from '../src/s16/files/types';

type Fixture = Awaited<ReturnType<typeof composedFixture>>;
const all: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const f of all.splice(0)) await f.close(); });
async function fixture() { const f = await composedFixture(); all.push(f); f.interpretation = { intent: 'answer', purposeId: 'purpose', resourceIds: ['computer'], access: 'read', subject: null }; f.script = []; return f; }
async function page(f: Fixture, query = ''): Promise<SearchPage> { const response = await f.request('/api/s16/client/search' + query); expect(response.status).toBe(200); return response.json() as Promise<SearchPage>; }
const labels = (requestId: string, id: string, revision = 0, values = ['Research']): SearchLabelCommand => ({ contract: 's16-search-labels/v1', requestId, target: { kind: 'history', id }, revision, labels: values });

test('strict search filters refuse duplicate/unknown/bad cursors instead of widening scope', () => {
  for (const query of ['bot=a&bot=b', 'kind=unknown', 'q=ok&grant=all', 'from=-1', 'from=9&to=1', 'to=9007199254740992', 'q=%00', 'label=%E2%80%AEsecret', 'after=..']) expect(() => parseSearchQuery(new URLSearchParams(query))).toThrow();
  expect(parseSearchQuery(new URLSearchParams('q=report&bot=alice&from=0&to=100'))).toMatchObject({ q: 'report', bot: 'alice', from: 0, to: 100, after: null });
});

test('actual owning CHAT searches old history beyond the thread window and pages stably across restart', async () => {
  const f = await fixture();
  for (let i = 0; i < 36; i++) { f.advance(1); await f.chat(`Searchable telescope observation ${i}.`, `observation_${i}`); }
  expect((await f.request('/api/s16/client/conversations/conversation').then(r => r.json()) as any).conversation.rows.some((row: any) => row.requestId === 'observation_0')).toBe(false);
  const first = await page(f, '?q=telescope&kind=history'); expect(first.total).toBe(36); expect(first.items.length).toBe(25); expect(first.next).not.toBeNull();
  const identities = first.items.map(row => row.target.id), cursor = first.next!;
  await f.reopen();
  const second = await page(f, '?q=telescope&kind=history&after=' + cursor); expect(second.total).toBe(36); expect(second.items.length).toBe(11); expect(second.next).toBeNull();
  expect(new Set([...identities, ...second.items.map(row => row.target.id)]).size).toBe(36);
  expect(second.items.some(row => row.target.id === 'observation_0')).toBe(true);
  expect((await f.request('/api/s16/client/search/objects/history/observation_0')).status).toBe(200);
  expect((await f.request('/api/s16/client/search?q=different&kind=history&after=' + cursor)).status).toBe(409);
});

test('labels survive response loss/restart, bind exact original commands, preserve source and never start work', async () => {
  const f = await fixture(); const before = await f.chat('Inspect the telescope archive.', 'origin');
  const original = JSON.stringify(before), command = labels('label_once', 'origin');
  const response = await f.request('/api/s16/client/search/labels', 'POST', command); expect(response.status).toBe(200); // Deliberately discard reply body.
  await f.reopen();
  const recovered = await (await f.request('/api/s16/client/search/commands/label_once')).json() as SearchLabelReceipt;
  expect(recovered.appliedRevision).toBe(1); expect(recovered.current).toEqual({ revision: 1, labels: ['Research'] });
  expect((await f.request('/api/s16/client/search/labels', 'POST', command)).status).toBe(200);
  expect((await f.request('/api/s16/client/search/labels', 'POST', { ...command, labels: ['Changed'] })).status).toBe(409);
  expect((await f.request('/api/s16/client/search/labels', 'POST', labels('stale', 'origin', 0))).status).toBe(409);
  expect((await f.request('/api/s16/client/search/labels', 'POST', labels('move', 'origin', 1, ['Ready']))).status).toBe(200);
  expect((await page(f, '?label=Research')).total).toBe(0); const moved = await page(f, '?label=Ready'); expect(moved.total).toBe(1); expect(moved.labels).toEqual([{ name: 'Ready', count: 1 }]);
  expect(moved.items[0]!.source).toEqual({ kind: 'chat', conversationId: 'conversation', requestId: 'origin' });
  expect(JSON.stringify(f.service.conversation.view(f.owner, 'origin'))).toBe(original);
  const db = f.service.conversation.store.db;
  expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM requests').get()!.n).toBe(1);
  expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM search_label_commands').get()!.n).toBe(2);
  expect(JSON.stringify(db.query('SELECT * FROM search_labels').all())).not.toContain('telescope');
});

test('source withdrawal removes a formerly published match, counts, facets, old opens and receipt recovery', async () => {
  const f = await fixture();
  f.interpretation = { intent: 'execute', purposeId: 'purpose', resourceIds: ['computer'], access: 'reversible_write', subject: null };
  f.script = [{ type: 'tool_call', id: 'diagnostic_tool', name: 'bash', arguments: { command: 'printf composed' } }];
  const original = await f.chat('Run a private telescope diagnostic.', 'withdraw_me'); expect(original.result).not.toBeNull();
  expect((await f.request('/api/s16/client/search/labels', 'POST', labels('label_hidden', 'withdraw_me', 0, ['Private title']))).status).toBe(200);
  expect((await page(f, '?q=telescope')).total).toBe(1);
  f.dataSources[0]!.active = false;
  const hidden = await page(f); expect(hidden.total).toBe(0); expect(hidden.items).toEqual([]); expect(hidden.labels).toEqual([]);
  expect((await f.request('/api/s16/client/search/objects/history/withdraw_me')).status).toBe(409);
  expect((await f.request('/api/s16/client/search/commands/label_hidden')).status).toBe(409);
  expect((await f.request('/api/s16/client/search/labels', 'POST', labels('late', 'withdraw_me', 1))).status).toBe(409);
});

test('memory forget removes exact claim text and suppressed source history before matching or counting', async () => {
  const f = await fixture(); await f.chat('I prefer concise replies.', 'preference');
  const memory = await page(f, '?q=concise&kind=memory'); expect(memory.total).toBeGreaterThan(0);
  const id = memory.items[0]!.target.id, detail = await (await f.request('/api/s16/client/memory/' + id)).json() as any;
  const forgot = await f.request('/api/s16/client/memory/commands', 'POST', { contract: 's15-memory-command/v1', requestId: 'forget_search', kind: 'memory.forget', claim: { id, revision: detail.item.revision } }); expect(forgot.status).toBe(200);
  const hidden = await page(f, '?q=concise'); expect(hidden.total).toBe(0); expect(JSON.stringify(hidden)).not.toContain('I prefer concise');
  expect((await f.request('/api/s16/client/search/objects/memory/' + id)).status).toBe(409);
  await f.reopen(); expect((await page(f, '?q=concise')).total).toBe(0);
});

test('WORK responsibilities and routine configuration are searchable through their real owning services', async () => {
  const f = await routineFixture(); all.push(f); f.replies.push({ tools: [{ name: 'read', arguments: { path: 'status.txt' } }], text: 'Observed telescope results.' });
  const request = await f.chat('Inspect the computer and report telescope observations.', 'responsibility_origin'); expect({ state: request.state, code: request.code }).toEqual({ state: 'completed', code: null });
  const responsibility = f.service.work.assign(f.owner, { requestId: 'assign_search', sourceRequestId: request.receipt.rootRequestId, completion: 'Keep telescope review current.', triggers: ['assigned'], stallPolicy: { noProgressApproaches: 2, reserveCalls: 1, maxAttempts: 4 } });
  const routine = await f.create(f.draft({ name: 'Telescope digest', instruction: 'Inspect the telescope archive every morning.' }));
  const work = await page(f, '?kind=work&q=telescope'); expect(work.items.some(row => row.target.id === responsibility.id)).toBe(true);
  const routines = await page(f, '?kind=routine&q=telescope'); expect(routines.items.map(row => row.target.id)).toContain(routine.id);
  expect((await f.request('/api/s16/client/search/objects/routine/' + routine.id)).status).toBe(200);
  await f.reopen(); expect((await page(f, '?kind=work&q=telescope')).items.map(row => row.target.id)).toContain(responsibility.id);
  expect((await page(f, '?kind=routine&q=telescope')).items.map(row => row.target.id)).toContain(routine.id);
});

test('committed artifacts disappear from search and original download after input withdrawal', async () => {
  const f = await composedFixture('default', false, undefined, options => {
    for (const rule of options.proposedPolicy!.rules) { rule.adapters.push('s16_files'); rule.operations.push('artifact_create'); }
    return { ...options, files: {} };
  }); all.push(f);
  const text = 'The telescope launch is on Friday.', sha256 = createHash('sha256').update(text).digest('hex');
  const created = await (await f.request('/api/s16/client/conversations/conversation/uploads', 'POST', { requestId: 'upload_search', conversationId: 'conversation', name: 'notes.txt', bytes: Buffer.byteLength(text), sha256 })).json() as FileUpload;
  const input = await (await f.raw(`/api/s16/client/uploads/${created.id}/bytes`, text)).json() as FileUpload; expect(input.state).toBe('ready');
  f.script = [{ type: 'tool_call', id: 'read_search', name: 'file_read', arguments: { id: input.id, offset: 0 } }, { type: 'tool_call', id: 'create_search', name: 'file_create', arguments: { name: 'telescope.md', text: 'Telescope launch: Friday.' } }];
  const sent = await f.request('/api/s16/client/conversations/conversation/messages', 'POST', { contract: 's16-conversation/v2', requestId: 'artifact_search', conversationId: 'conversation', text: 'Summarize these notes and create a downloadable Markdown brief.', continuation: null, files: [{ id: input.id, sha256 }] }); expect(sent.status).toBe(202);
  await f.service.conversation.drain();
  const artifact = f.service.conversation.view(f.owner, 'artifact_search').artifacts![0]!;
  const found = await page(f, '?kind=artifact&q=telescope'); expect(found.items.map(row => row.target.id)).toContain(artifact.id);
  expect((await f.request('/api/s16/client/search/objects/artifact/' + artifact.id)).status).toBe(200);
  const withdrawn = await f.request(`/api/s16/client/uploads/${input.id}/withdraw`, 'POST', {}); expect(withdrawn.status).toBe(200);
  expect((await page(f, '?q=telescope')).total).toBe(0);
  expect((await f.request('/api/s16/client/search/objects/artifact/' + artifact.id)).status).toBe(409);
  expect((await f.request(`/api/s16/client/requests/${artifact.requestId}/artifacts/${artifact.id}`)).status).not.toBe(200);
});

test('protected HTTP keeps Host/Origin/session/CSRF and current owner generation mandatory', async () => {
  const f = await fixture(); await f.chat('Inspect the telescope.', 'auth_origin'); const command = labels('auth_command', 'auth_origin');
  for (const headers of [{ host: 'other.test' }, { 'sec-fetch-site': 'cross-site' }, { cookie: '' }]) expect((await f.request('/api/s16/client/search', 'GET', undefined, headers)).status).toBeGreaterThanOrEqual(400);
  for (const headers of [{ origin: 'https://other.test' }, { 'x-csrf-token': 'wrong' }]) expect((await f.request('/api/s16/client/search/labels', 'POST', command, headers)).status).toBe(403);
  const bytes = readFileSync(f.service.conversation.store.path); expect(bytes.includes(Buffer.from('search_labels'))).toBe(true);
  f.generation = 2; expect((await page(f)).total).toBe(0);
  expect((await f.request('/api/s16/client/search/objects/history/auth_origin')).status).toBe(409);
});

test('actual retained S14-private memory and descendants are excluded before Bot-filtered counts and label facets', async () => {
  const f = await fixture();
  const work = f.service.policy.owner.admit(f.owner, { requestId: 'private_memory_scope', intent: 'execute', access: 'reversible_write', purpose: f.policyInput.purposes[0]!, bot: ref('bot'), resources: [ref('computer')], recipients: [], selection: f.choice, selectionPin: null, expiresAt: 800000 }).work!;
  const context = f.service.team.bind(f.service.policy.control.bindWork(work.id));
  const root = f.service.memory.retain(context, { id: 'historical_private', text: 'My timezone is Asia/Bangkok.', origin: { kind: 'historical', id: 'original_s14', conversationId: null, at: 1 }, scope: { kind: 'bot', botId: 'bot', origin: 's14' }, resources: [ref('computer')], parents: [] })[0]!;
  const child = f.service.memory.retain(context, { id: 'private_descendant', text: 'The test command is bun test.', origin: { kind: 'work', id: 'derived_private', conversationId: null, at: 2 }, scope: { kind: 'team' }, resources: [ref('computer')], parents: [root.id] })[0]!;
  expect(child.provenance.scope).toEqual({ kind: 'bot', botId: 'bot', origin: 's14' });
  expect((await f.request('/api/s16/client/search/labels', 'POST', { ...labels('private_label', root.id), target: { kind: 'memory', id: root.id }, labels: ['Original private label'] })).status).toBe(200);
  expect((await page(f, '?kind=memory&bot=bot')).total).toBe(2);
  const hidden = await page(f, '?kind=memory&bot=specialist'); expect(hidden.total).toBe(0); expect(hidden.labels).toEqual([]); expect(hidden.items).toEqual([]);
  expect(JSON.stringify(hidden)).not.toContain('Asia/Bangkok');
  await f.reopen(); expect((await page(f, '?kind=memory&bot=specialist')).total).toBe(0);
  expect(f.service.memory.view(f.owner).claims.find(claim => claim.id === root.id)!.provenance.scope).toEqual(root.provenance.scope);
});

test('simultaneous label edits have one exact revision winner and retain original lineage', async () => {
  const f = await fixture(); await f.chat('What about telescope observations?', 'race_target');
  const results = await Promise.all([f.request('/api/s16/client/search/labels', 'POST', labels('race_a', 'race_target', 0, ['A'])), f.request('/api/s16/client/search/labels', 'POST', labels('race_b', 'race_target', 0, ['B']))]);
  expect(results.map(response => response.status).sort()).toEqual([200, 409]);
  const current = await page(f); expect(current.items[0]!.organization.revision).toBe(1);
  expect(f.service.conversation.store.db.query<{ n: number }, []>('SELECT count(*) AS n FROM search_label_commands').get()!.n).toBe(1);
});

test('candidate overflow refuses the whole response, while exact fresh object opening remains independent', async () => {
  const f = await fixture(); await f.chat('What about bounded search?', 'capacity_target');
  const document = { target: { kind: 'history' as const, id: 'capacity_target' }, title: 'Current title', text: 'Current content', state: 'completed', at: 1, botId: null, source: { kind: 'chat' as const, conversationId: 'conversation', requestId: 'capacity_target' } };
  const service = new SearchDirectory({ store: f.service.conversation.store, owner: () => ({ id: 'owner', generation: 1 }), documents: () => Array.from({ length: 10001 }, (_, i) => ({ ...document, target: { ...document.target, id: 'entry_' + i } })), resolve: () => document });
  expect(() => service.search(f.owner, new URLSearchParams())).toThrow('search_capacity');
  expect(service.object(f.owner, document.target).target).toEqual(document.target);
});

test('browser/native-safe JitClient validates search and recovers a lost original label command after restart', async () => {
  const f = await fixture(); await f.chat('What about telescope observations?', 'client_target');
  let lose = true;
  const c = new JitClient({ origin: 'http://localhost:3099', fetch: async request => {
    const url = new URL(request.url), response = await f.request(url.pathname + url.search, request.method, request.method === 'POST' ? await request.json() : undefined, Object.fromEntries(request.headers));
    if (lose && url.pathname.endsWith('/search/labels')) { lose = false; throw new Error('controlled_response_loss'); }
    return response;
  } }); await c.bootstrap();
  const query = parseSearchQuery(new URLSearchParams('q=telescope')); expect((await c.search(query)).total).toBe(1);
  const command = labels('client_original', 'client_target'); await expect(c.setSearchLabels(command)).rejects.toMatchObject({ outcome: 'unknown', requestId: command.requestId });
  await f.reopen(); expect((await c.searchLabelReceipt(command.requestId)).appliedRevision).toBe(1);
  expect((await c.setSearchLabels(command)).current.revision).toBe(1);
  expect((await c.searchObject(command.target)).organization.labels).toEqual(['Research']);
});

test('current DATA15 ancestry and TEAM resource withdrawal filter memory before counts and old object opening', async () => {
  const f = await composedFixture('default', false, undefined, options => ({ ...options, skills: {} })); all.push(f);
  const work = f.service.policy.owner.admit(f.owner, { requestId: 'data_memory_scope', intent: 'execute', access: 'reversible_write', purpose: ref('purpose'), bot: ref('bot'), resources: [ref('computer')], recipients: [], selection: f.choice, selectionPin: null, expiresAt: 800000 }).work!;
  const actor = f.service.policy.control.bindWork(work.id), context = f.service.team.bind(actor), pin = ref('search_derived_data');
  f.service.disclosure!.read(actor, f.dataSources[0]!.ref); f.service.disclosure!.derive(actor, pin, 'text');
  const claim = f.service.memory.retain(context, { id: 'private_data_claim', text: 'The test command is bun test.', origin: { kind: 'work', id: 'data_origin', conversationId: null, at: 1 }, scope: { kind: 'team' }, resources: [ref('computer')], parents: [], dataRefs: [pin] })[0]!;
  expect((await page(f, '?kind=memory')).total).toBe(1);
  const reservations = f.service.policy.control.reservations().length;
  expect(f.service.disclosure!.ownerAncestry(f.owner, pin).map(source => source.ref)).toEqual([f.dataSources[0]!.ref]);
  expect(f.service.policy.control.reservations().length).toBe(reservations);
  f.dataSources[0]!.active = false;
  expect((await page(f, '?kind=memory')).total).toBe(0);
  expect((await f.request('/api/s16/client/search/objects/memory/' + claim.id)).status).toBe(409);
  f.dataSources[0]!.active = true;
  const resource = f.service.team.resources(f.owner).resources.find(row => row.id === 'computer')!;
  const { whoCanUse: _, restrictions: __, ...registration } = resource;
  f.service.team.register(f.owner, 'withdraw_memory_resource', resource.revision, { ...registration, revision: resource.revision + 1, active: false });
  const hidden = await page(f, '?kind=memory'); expect(hidden.total).toBe(0); expect(hidden.labels).toEqual([]);
});

test('search identities and labels survive a real Bot model selection, computer generation and service restart', async () => {
  let high!: ApprovedModelRoute; const selected: string[] = [];
  const f = await composedFixture('default', false, undefined, options => {
    const base = options.model.registry.list()[0]!;
    high = { ...base, selection: { ...base.selection, model: ref('search_high_model'), effort: 'high' }, efforts: ['high'] };
    if (!options.proposedPolicy!.selections.some(row => row.model.id === high.selection.model.id)) { options.proposedPolicy!.selections.push(high.selection); for (const rule of options.proposedPolicy!.rules) rule.selections.push(high.selection); }
    const routes = [base, high];
    return { ...options, bots: {}, catalogs: { ...options.catalogs, current: (kind, id) => kind === 'model' && id === high.selection.model.id ? { ref: high.selection.model, active: true } : options.catalogs.current(kind, id) }, model: { ...options.model, registry: { ...options.model.registry, list: () => routes, current: selection => routes.find(row => equal(row.selection, selection)) ?? null }, scripted: route => ({ provider: 'codex-subscription', id: route.modelId, async *stream() { selected.push(route.selection.effort); yield { type: 'message_complete', message: { type: 'assistant', id: crypto.randomUUID(), content: [{ type: 'text', text: 'Preference retained.' }] } }; } }) } };
  }); all.push(f); f.interpretation = { intent: 'answer', purposeId: 'purpose', resourceIds: ['computer'], access: 'read', subject: null };
  await f.chat('I prefer concise replies.', 'before_model_change');
  const before = await page(f, '?q=concise'), identities = before.items.map(row => row.target);
  expect(identities.some(row => row.kind === 'memory')).toBe(true);
  expect((await f.request('/api/s16/client/search/labels', 'POST', labels('model_label', 'before_model_change'))).status).toBe(200);
  const profile = f.service.bots!.profile('bot')!;
  expect((await f.request('/api/s16/client/bots/commands', 'POST', { contract: 's16-bot-command/v1', requestId: 'choose_search_high', kind: 'bot.update', botId: 'bot', expectedRevision: profile.revision, name: 'Jit', responsibility: 'Retain useful context.', selection: high.selection, assignments: true })).status).toBe(200);
  const computer = f.service.vmStore.registration('vm'); f.service.vmStore.save({ ...computer, generation: computer.generation + 1, boot: 'replacement_fixture_boot' });
  await f.chat('What about continuity?', 'after_model_change'); expect(selected).toContain('high');
  await f.reopen();
  const after = await page(f, '?q=concise'); expect(after.items.map(row => row.target)).toEqual(identities);
  expect(after.items.find(row => row.target.kind === 'history')!.organization.labels).toEqual(['Research']);
});

test('installation search reaches conversations older than the 64-conversation bootstrap window', async () => {
  const f = await fixture(); f.script = [{ type: 'text', text: 'Recorded.' }];
  for (let i = 0; i < 67; i++) {
    const conversationId = 'retained_conversation_' + i, requestId = 'retained_message_' + i;
    const response = await f.request(`/api/s16/client/conversations/${conversationId}/messages`, 'POST', { contract: 's15-conversation/v1', requestId, conversationId, text: i === 0 ? 'What about oldestonly?' : `What about newer record ${i}?`, continuation: null });
    expect(response.status).toBe(202); await f.service.conversation.drain();
  }
  const boot = await (await f.request('/api/s16/client/bootstrap')).json() as { conversations: { conversationId: string }[] };
  expect(boot.conversations).toHaveLength(64); expect(boot.conversations.some(row => row.conversationId === 'retained_conversation_0')).toBe(false);
  const old = await page(f, '?kind=history&q=oldestonly'); expect(old.total).toBe(1); expect(old.items[0]!.target.id).toBe('retained_message_0');
  expect((await f.request('/api/s16/client/search/objects/history/retained_message_0')).status).toBe(200);
});
