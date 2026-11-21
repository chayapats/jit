import { afterEach, expect, test } from 'bun:test';
import { composedFixture, ref } from './fixtures/s15-composition';
import { ownerExportLimits, parseOwnerExportRequest, validateOwnerExport, type OwnerExportRequest, type OwnerExportText, type OwnerExport, type OwnerExportConfiguration, type OwnerExportFile } from '../src/s16/export/contracts';
import { OwnerExportService } from '../src/s16/export/service';
import { AppError } from '../src/errors';

const all: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const f of all.splice(0)) await f.close(); });
const scope: OwnerExportRequest = { contract: 's16-owner-export-request/v1', sections: ['history'], conversationId: null, from: null, to: null };
const record: OwnerExportText = { kind: 'history', id: 'original', title: 'Current text', text: 'Full current content', state: 'completed', at: 10, conversationId: 'conversation', redacted: false };

function configRecord(value: OwnerExport, kind: OwnerExportConfiguration['kind']): OwnerExportConfiguration {
  const item = value.records.find(item => item.kind === kind);
  if (!item || !('configuration' in item)) throw Error('fixture_export_configuration_missing');
  return item;
}
function fileRecord(value: OwnerExport, kind: OwnerExportFile['kind']): OwnerExportFile {
  const item = value.records.find(item => item.kind === kind);
  if (!item || !('representation' in item)) throw Error('fixture_export_file_missing');
  return item;
}

test('export scope is closed, exact, finite and restricted to actual available sections', () => {
  for (const input of [{ ...scope, path: '/private' }, { ...scope, sections: [] }, { ...scope, sections: ['history', 'history'] }, { ...scope, sections: ['vault'] }, { ...scope, sections: ['file'] }, { ...scope, conversationId: '../outside' }, { ...scope, from: -1 }, { ...scope, from: 20, to: 10 }, { ...scope, to: Number.MAX_SAFE_INTEGER + 1 }]) expect(() => parseOwnerExportRequest(input, ['history'])).toThrow();
  expect(parseOwnerExportRequest(scope, ['history'])).toEqual(scope);
});

test('fresh export revalidates before release and never stores an old body or mints work', () => {
  let authenticated = true, visits = 0, releases = 0;
  const source = { sections: ['history' as const], owner(actor: object) { if (!authenticated || actor !== owner) throw Error('authentication_required'); }, visit(current: () => object, _scope: OwnerExportRequest, append: (record: OwnerExportText) => void) { current(); visits++; append(record); } }, owner = {};
  const service = new OwnerExportService(source, () => 10), first = service.publish(() => owner, scope, data => { releases++; return data; });
  expect(visits).toBe(2); expect(JSON.parse(Buffer.from(first.bytes).toString())).toMatchObject({ contract: 's16-owner-export/v1', counts: { history: 1 }, records: [record] }); expect(releases).toBe(1);
  authenticated = false; expect(() => service.publish(() => owner, scope, () => { releases++; })).toThrow('authentication_required'); expect(releases).toBe(1);
});

test('changed eligibility during final owning read releases no prepared body and a fresh retry only sees current content', () => {
  const owner = {}, source = { sections: ['history' as const], owner() {}, visit(_actor: () => object, _scope: OwnerExportRequest, append: (record: OwnerExportText) => void) { if (visits++ === 0) append(record); } }; let visits = 0, released = false;
  const service = new OwnerExportService(source, () => 10);
  expect(() => service.publish(() => owner, scope, () => { released = true; })).toThrow(expect.objectContaining({ code: 'owner_export_source_changed' })); expect(released).toBe(false);
  const empty = service.publish(() => owner, scope, data => JSON.parse(Buffer.from(data.bytes).toString())); expect(empty.counts).toEqual({ history: 0 }); expect(empty.records).toEqual([]);
});

test('capacity refuses the complete response instead of silently truncating selected content', () => {
  const owner = {}, service = new OwnerExportService({ sections: ['history'], owner() {}, visit(_actor, _scope, append) { append({ ...record, text: 'x'.repeat(ownerExportLimits.memberBytes) }); } }, () => 10); let released = false;
  expect(() => service.publish(() => owner, scope, () => { released = true; })).toThrow(expect.objectContaining({ code: 'owner_export_capacity' })); expect(released).toBe(false);
});

test('publisher refuses an accidental protected field from an owning projection before attachment release', () => {
  const owner = {}, service = new OwnerExportService({ sections: ['history'], owner() {}, visit(_actor, _scope, append) { append({ ...record, authority: { id: 'protected_grant' } } as OwnerExportText); } }, () => 10); let released = false;
  expect(() => service.publish(() => owner, scope, () => { released = true; })).toThrow(expect.objectContaining({ code: 'owner_export_invalid' })); expect(released).toBe(false);
});

test('actual CHAT content read never records action presentation or refreshes original action refs', async () => {
  const f = await composedFixture(); all.push(f); f.interpretation = { intent: 'execute', purposeId: 'purpose', resourceIds: ['account'], access: 'effect', subject: null };
  const mail = (await import('./fixtures/s15-effects')).mail(); f.script = [{ type: 'tool_call', id: 'email', name: 'gmail_prepare_send', arguments: { ...mail } }];
  const held = await f.chat('Send the prepared email to the recipient.', 'export_pending'); expect(held.slips[0]?.state).toBe('pending');
  const db = f.service.conversation.store.db; db.exec('DELETE FROM presentations'); const before = db.serialize(), policy = f.service.policy.control.maintenanceSource!().serialize();
  const content = f.service.conversation.readContent(f.owner, 'export_pending'); expect(content?.command.text).toBe('Send the prepared email to the recipient.'); expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM presentations').get()!.n).toBe(0); expect(db.serialize()).toEqual(before); expect(f.service.policy.control.maintenanceSource!().serialize()).toEqual(policy); expect(f.google.sent.size).toBe(0);
  expect(() => f.service.conversation.readContent({} as never, 'export_pending')).toThrow();
});

test('actual pure CHAT content read retains current publication/withdrawal and corrupt-record refusal', async () => {
  const f = await composedFixture(); all.push(f); f.interpretation = { intent: 'execute', purposeId: 'purpose', resourceIds: ['computer'], access: 'reversible_write', subject: null }; f.script = [{ type: 'tool_call', id: 'diagnostic', name: 'bash', arguments: { command: 'printf composed' } }];
  const original = await f.chat('Run a private telescope diagnostic.', 'export_current'); expect(original.result).not.toBeNull();
  expect(f.service.conversation.readContent(f.owner, 'export_current')?.result).toBe(original.result); f.dataSources[0]!.active = false;
  const db = f.service.conversation.store.db, before = db.serialize(); expect(f.service.conversation.readContent(f.owner, 'export_current')).toBeNull(); expect(db.serialize()).toEqual(before);
  db.query('UPDATE requests SET record_json=? WHERE id=?').run('{corrupt current row', 'export_current'); expect(() => f.service.conversation.readContent(f.owner, 'export_current')).toThrow();
});

test('actual composed owner endpoint exports full selected text instead of snippets and preserves CHAT/policy bytes', async () => {
  const f = await composedFixture(); all.push(f);
  f.interpretation = { intent: 'answer', purposeId: 'purpose', resourceIds: ['computer'], access: 'read', subject: null }; const reply = 'Full retained output. '.repeat(400) + 'export_tail_marker', message = 'What is the full retained reply for ' + 'x'.repeat(2500); f.script = [{ type: 'text', text: reply }];
  const original = await f.chat(message, 'export_long'); expect({ state: original.state, code: original.code }).toEqual({ state: 'completed', code: null }); expect(message.length + (original.result?.length ?? 0)).toBeGreaterThan(10000);
  const db = f.service.conversation.store.db, before = db.serialize(), policy = f.service.policy.control.maintenanceSource!().serialize();
  const response = await f.request('/api/s16/client/export', 'POST', scope); expect(response.status).toBe(200); expect(response.headers.get('content-disposition')).toBe('attachment; filename="jit-export.json"'); expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  const data = await response.json() as any; expect(data.contract).toBe('s16-owner-export/v1'); expect(data.records).toHaveLength(1); expect(data.records[0].text).toBe(message + '\n' + original.result); expect(data.records[0].text).toContain('export_tail_marker');
  expect(Object.keys(data.records[0]).sort()).toEqual(['at', 'conversationId', 'id', 'kind', 'redacted', 'state', 'text', 'title']); expect(JSON.stringify(data)).not.toContain('authority'); expect(db.serialize()).toEqual(before); expect(f.service.policy.control.maintenanceSource!().serialize()).toEqual(policy);
});

test('actual export rechecks current source withdrawal at release and does not cache the prepared content', async () => {
  const f = await composedFixture(); all.push(f); f.interpretation = { intent: 'execute', purposeId: 'purpose', resourceIds: ['computer'], access: 'reversible_write', subject: null }; f.script = [{ type: 'tool_call', id: 'diagnostic', name: 'bash', arguments: { command: 'printf composed' } }]; await f.chat('Run a private telescope diagnostic.', 'export_withdraw');
  const original = f.service.conversation.readContent.bind(f.service.conversation); let reads = 0;
  f.service.conversation.readContent = (actor, id) => { const value = original(actor, id); if (++reads === 1) f.dataSources[0]!.active = false; return value; };
  const denied = await f.request('/api/s16/client/export', 'POST', scope); expect(denied.status).toBe(409); expect(await denied.json()).toEqual({ error: 'owner_export_source_changed' }); expect(denied.headers.get('content-disposition')).toBeNull();
  const fresh = await f.request('/api/s16/client/export', 'POST', scope); expect(fresh.status).toBe(200); const data = await fresh.json() as any; expect(data.records).toEqual([]); expect(data.counts).toEqual({ history: 0 }); expect(JSON.stringify(data)).not.toContain('telescope');
});

test('actual export screens newly registered credentials in retained content without reading protected secrets', async () => {
  const f = await composedFixture(); all.push(f); f.interpretation = { intent: 'answer', purposeId: 'purpose', resourceIds: ['computer'], access: 'read', subject: null }; f.script = [];
  const secret = 'fixture-only-new-export-credential'; await f.chat('Remember ' + secret + ' as a temporary label.', 'export_redact');
  const { registerSecretFingerprint } = await import('../src/security/secret-fingerprints'); registerSecretFingerprint(secret);
  const response = await f.request('/api/s16/client/export', 'POST', scope); expect(response.status).toBe(200); const data = await response.json() as any; expect(JSON.stringify(data)).not.toContain(secret); expect(data.records[0].redacted).toBe(true); expect(data.records[0].text).toContain('[credential-redacted]');
});

test('actual export requires the current same-origin owner and exact scope, with no content on refusal', async () => {
  const f = await composedFixture(); all.push(f);
  expect((await f.request('/api/s16/client/export', 'POST', scope, { cookie: '' })).status).toBe(401);
  expect((await f.request('/api/s16/client/export', 'POST', scope, { origin: 'https://foreign.example' })).status).toBe(403);
  expect((await f.request('/api/s16/client/export', 'POST', scope, { 'x-csrf-token': 'invalid' })).status).toBe(403);
  expect((await f.request('/api/s16/client/export', 'GET')).status).toBe(405);
  expect((await f.request('/api/s16/client/export', 'POST', { ...scope, sections: ['vault'] })).status).toBe(400);
  const bootstrap = await (await f.request('/api/s16/client/bootstrap')).json() as any; expect(bootstrap.capabilities.dataExport).toMatchObject({ available: true, contract: 's16-owner-export/v1', sections: ['history', 'memory', 'work'] });
});

for (const change of ['session_loss', 'owner_generation'] as const) test('streamed export refuses ' + change + ' before visiting current content', async () => {
  let authenticated = true;
  const f = await composedFixture('default', false, undefined, options => ({ ...options, owner: { ...options.owner, authenticate(token) {
    if (!authenticated) throw new AppError('authentication_required', 401);
    return options.owner.authenticate(token);
  } } })); all.push(f);
  const before = f.service.conversation.store.db.serialize(), policy = f.service.policy.control.maintenanceSource!().serialize();
  let entered!: () => void, resume!: () => void, reads = 0;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), continued = new Promise<void>(resolve => { resume = resolve; });
  const originalRead = f.service.conversation.readContent.bind(f.service.conversation);
  f.service.conversation.readContent = (...args) => { reads++; return originalRead(...args); };
  const bytes = new TextEncoder().encode(JSON.stringify(scope)); let part = 0;
  const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
    if (part++ === 0) controller.enqueue(bytes.slice(0, 12));
    else { entered(); await continued; controller.enqueue(bytes.slice(12)); controller.close(); }
  } }, { highWaterMark: 0 });
  const pending = f.raw('/api/s16/client/export', stream, { 'content-type': 'application/json' }); await waiting;
  if (change === 'session_loss') authenticated = false; else f.generation = 2;
  resume(); const response = await pending;
  expect([401, 403]).toContain(response.status); expect(response.headers.get('content-disposition')).toBeNull(); expect(await response.json()).not.toHaveProperty('records'); expect(reads).toBe(0);
  expect(f.service.conversation.store.db.serialize()).toEqual(before); expect(f.service.policy.control.maintenanceSource!().serialize()).toEqual(policy);
});

test('actual DATA15 and TEAM withdrawal exclude retained memory before export counts without charging or changing journals', async () => {
  const f = await composedFixture('default', false, undefined, options => ({ ...options, skills: {} })); all.push(f);
  const work = f.service.policy.owner.admit(f.owner, { requestId: 'export_data_scope', intent: 'execute', access: 'reversible_write', purpose: ref('purpose'), bot: ref('bot'), resources: [ref('computer')], recipients: [], selection: f.choice, selectionPin: null, expiresAt: 800000 }).work!;
  const actor = f.service.policy.control.bindWork(work.id), context = f.service.team.bind(actor), pin = ref('export_derived_data');
  f.service.disclosure!.read(actor, f.dataSources[0]!.ref); f.service.disclosure!.derive(actor, pin, 'text');
  const retained = f.service.memory.retain(context, { id: 'export_private_claim', text: 'The test command is bun test.', origin: { kind: 'work', id: 'export_data_origin', conversationId: null, at: 1 }, scope: { kind: 'team' }, resources: [ref('computer')], parents: [], dataRefs: [pin] }); expect(retained).toHaveLength(1);
  const query: OwnerExportRequest = { ...scope, sections: ['memory'] };
  const exported = async () => {
    const db = f.service.policy.control.maintenanceSource!(), before = db.serialize(), calls = f.vmCalls.length;
    const response = await f.request('/api/s16/client/export', 'POST', query); expect(response.status).toBe(200);
    const value = await response.json() as any; validateOwnerExport(value, query); expect(db.serialize()).toEqual(before); expect(f.vmCalls.length).toBe(calls); return value;
  };
  expect((await exported()).counts).toEqual({ memory: 1 }); f.dataSources[0]!.active = false;
  const hidden = await exported(); expect(hidden.counts).toEqual({ memory: 0 }); expect(JSON.stringify(hidden)).not.toContain('The test command');
  f.dataSources[0]!.active = true; expect((await exported()).counts).toEqual({ memory: 1 });
  const resource = f.service.team.resources(f.owner).resources.find(row => row.id === 'computer')!, { whoCanUse: _, restrictions: __, ...registration } = resource;
  f.service.team.register(f.owner, 'export_withdraw_resource', resource.revision, { ...registration, revision: resource.revision + 1, active: false });
  expect((await exported()).counts).toEqual({ memory: 0 });
});

test('actual memory forget removes retained claim and suppressed source history from fresh exports, including after restart', async () => {
  const f = await composedFixture(); all.push(f); f.interpretation = { intent: 'answer', purposeId: 'purpose', resourceIds: ['computer'], access: 'read', subject: null }; f.script = [];
  await f.chat('I prefer concise replies.', 'export_preference');
  const query: OwnerExportRequest = { ...scope, sections: ['history', 'memory'] }, initial = await (await f.request('/api/s16/client/export', 'POST', query)).json() as OwnerExport;
  expect(initial.counts).toEqual({ history: 1, memory: 1 }); const claim = initial.records.find(item => item.kind === 'memory')!;
  const detail = await (await f.request('/api/s16/client/memory/' + claim.id)).json() as any;
  expect((await f.request('/api/s16/client/memory/commands', 'POST', { contract: 's15-memory-command/v1', requestId: 'forget_export', kind: 'memory.forget', claim: { id: claim.id, revision: detail.item.revision } })).status).toBe(200);
  for (const restart of [false, true]) {
    if (restart) await f.reopen(); const response = await f.request('/api/s16/client/export', 'POST', query); expect(response.status).toBe(200);
    const hidden = await response.json() as any; expect(hidden.counts).toEqual({ history: 0, memory: 0 }); expect(JSON.stringify(hidden)).not.toContain('I prefer concise');
  }
});

async function clientFixture() {
  const f = await composedFixture(); all.push(f); f.interpretation = { intent: 'answer', purposeId: 'purpose', resourceIds: ['computer'], access: 'read', subject: null }; f.script = []; await f.chat('What about current owner exports?', 'client_export_original'); return f;
}
test('shared client consumes the actual authenticated bounded attachment and never retries a lost download', async () => {
  const f = await clientFixture(), { JitClient } = await import('../src/s16/client'); let exports = 0, lose = false;
  const client = new JitClient({ origin: 'http://localhost:3099', fetch: async request => {
    const url = new URL(request.url), response = await f.request(url.pathname, request.method, request.method === 'POST' ? await request.json() : undefined, Object.fromEntries(request.headers));
    if (url.pathname.endsWith('/export')) { exports++; if (lose) throw Error('fixture_lost_download'); } return response;
  } }); await client.bootstrap();
  const result = await client.exportData(scope); expect(result.value.counts.history).toBe(1); expect(result.value.records[0]?.id).toBe('client_export_original'); expect(JSON.parse(Buffer.from(result.bytes).toString())).toEqual(result.value);
  lose = true; await expect(client.exportData(scope)).rejects.toMatchObject({ code: 'connection_lost', outcome: 'not_sent' }); expect(exports).toBe(2);
});

test.each(['hash', 'foreign_scope', 'extra_authority', 'count'] as const)('shared client refuses %s in an export even when transport succeeds', async corruption => {
  const f = await clientFixture(), { JitClient } = await import('../src/s16/client');
  const client = new JitClient({ origin: 'http://localhost:3099', fetch: async request => {
    const url = new URL(request.url), response = await f.request(url.pathname, request.method, request.method === 'POST' ? await request.json() : undefined, Object.fromEntries(request.headers)); if (!url.pathname.endsWith('/export')) return response;
    const value = await response.json() as any;
    if (corruption === 'foreign_scope') value.scope.conversationId = 'other'; if (corruption === 'extra_authority') value.records[0].authority = { granted: true }; if (corruption === 'count') value.counts.history++;
    const bytes = Buffer.from(JSON.stringify(value)), headers = new Headers(response.headers); headers.set('content-length', String(bytes.length)); headers.set('x-content-sha256', corruption === 'hash' ? '0'.repeat(64) : new Bun.CryptoHasher('sha256').update(bytes).digest('hex')); return new Response(bytes, { headers });
  } }); await client.bootstrap(); await expect(client.exportData(scope)).rejects.toMatchObject({ code: 'client_protocol_invalid' });
});

test('shared client cancels a partially streamed old-session export before returning bytes', async () => {
  const f = await clientFixture(), { JitClient } = await import('../src/s16/client'); let entered!: () => void, finish!: () => void, cancelled = false;
  const reading = new Promise<void>(resolve => { entered = resolve; }), released = new Promise<void>(resolve => { finish = resolve; });
  const client = new JitClient({ origin: 'http://localhost:3099', fetch: async request => {
    const url = new URL(request.url), response = await f.request(url.pathname, request.method, request.method === 'POST' ? await request.json() : undefined, Object.fromEntries(request.headers)); if (!url.pathname.endsWith('/export')) return response;
    const bytes = new Uint8Array(await response.arrayBuffer()), middle = Math.floor(bytes.length / 2); let first = true;
    return new Response(new ReadableStream({ async pull(controller) { if (first) { first = false; controller.enqueue(bytes.slice(0, middle)); } else { entered(); await released; controller.enqueue(bytes.slice(middle)); } }, cancel() { cancelled = true; } }, { highWaterMark: 0 }), { headers: response.headers });
  } }); await client.bootstrap(); const pending = client.exportData(scope); await reading; client.clear(); finish(); await expect(pending).rejects.toMatchObject({ code: 'client_response_stale' }); expect(cancelled).toBe(true);
});

test('actual owning FILE/artifact and Bot configuration export preserves original stores and drops withdrawn descendants before counts', async () => {
  const f = await composedFixture('default', false, undefined, options => {
    for (const rule of options.proposedPolicy!.rules) { rule.adapters.push('s16_files'); rule.operations.push('artifact_create'); }
    return { ...options, files: {}, bots: {} };
  }); all.push(f);
  const text = 'Launch: Friday.\nCurrent source details.\n', hash = (value: string) => new Bun.CryptoHasher('sha256').update(value).digest('hex');
  const pending = await (await f.request('/api/s16/client/conversations/conversation/uploads', 'POST', { requestId: 'export_upload', conversationId: 'conversation', name: 'notes.txt', bytes: Buffer.byteLength(text), sha256: hash(text) })).json() as any;
  const upload = await (await f.raw('/api/s16/client/uploads/' + pending.id + '/bytes', text)).json() as any; expect(upload.state).toBe('ready');
  f.script = [{ type: 'tool_call', id: 'read_export', name: 'file_read', arguments: { id: upload.id, offset: 0 } }, { type: 'tool_call', id: 'create_export', name: 'file_create', arguments: { name: 'brief.md', text: '# Brief\nLaunch: Friday.\n' } }];
  const sent = await f.request('/api/s16/client/conversations/conversation/messages', 'POST', { contract: 's16-conversation/v2', requestId: 'export_file_message', conversationId: 'conversation', text: 'Summarize these notes and create a downloadable Markdown brief.', continuation: null, files: [{ id: upload.id, sha256: upload.receipt.sha256 }] }); expect(sent.status).toBe(202); await f.service.conversation.drain(); const row = f.service.conversation.view(f.owner, 'export_file_message'); expect(row.state).toBe('completed');
  const databases = [f.service.conversation.store.db, f.service.policy.control.maintenanceSource!(), f.service.files!.journal.db, f.service.bots!.store.db], before = databases.map(db => db.serialize()), calls = f.vmCalls.length;
  const query: OwnerExportRequest = { ...scope, sections: ['history', 'file', 'artifact', 'bot'], conversationId: 'conversation' }, response = await f.request('/api/s16/client/export', 'POST', query); const value = await response.json() as any; expect({ status: response.status, error: value.error ?? null }).toEqual({ status: 200, error: null });
  validateOwnerExport(value, parseOwnerExportRequest(query, query.sections));
  expect(value.counts).toEqual({ history: 1, artifact: 1, file: 1, bot: 1 }); expect(fileRecord(value, 'file').text).toBe(text); expect(fileRecord(value, 'artifact').text).toBe('# Brief\nLaunch: Friday.\n'); expect(configRecord(value, 'bot').configuration.name).toBe('Jit');
  expect(databases.map(db => db.serialize())).toEqual(before); expect(f.vmCalls.length).toBe(calls);
  expect((await f.request('/api/s16/client/uploads/' + upload.id + '/withdraw', 'POST', {})).status).toBe(200);
  const withdrawn = await (await f.request('/api/s16/client/export', 'POST', query)).json() as any; expect(withdrawn.counts).toEqual({ history: 0, artifact: 0, file: 0, bot: 1 }); expect(JSON.stringify(withdrawn)).not.toContain('Launch: Friday'); expect(JSON.stringify(withdrawn)).not.toContain('notes.txt'); expect(f.vmCalls.length).toBe(calls);
});

test('actual routine export keeps reusable configuration without ticks, policy receipts, feeds or execution state', async () => {
  const { routineFixture } = await import('./fixtures/s16-routines'), f = await routineFixture(); all.push(f);
  const routine = await f.create(f.draft()), before = f.service.routines!.journal.db.serialize(), calls = f.vmCalls.length;
  const query: OwnerExportRequest = { ...scope, sections: ['routine'], conversationId: routine.draft.conversationId }, response = await f.request('/api/s16/client/export', 'POST', query); const value = await response.json() as any; expect({ status: response.status, error: value.error ?? null }).toEqual({ status: 200, error: null });
  validateOwnerExport(value, query); expect(value.counts).toEqual({ routine: 1 }); expect(configRecord(value, 'routine').configuration).toMatchObject({ name: routine.draft.name, instruction: routine.draft.instruction, requestedScope: { purposeId: 'purpose', resourceIds: ['computer'], access: 'read' } });
  expect(value.records[0]).not.toHaveProperty('policyRevision'); expect(value.records[0]).not.toHaveProperty('proposalHash'); expect(configRecord(value, 'routine').configuration).not.toHaveProperty('owner'); expect(configRecord(value, 'routine').configuration).not.toHaveProperty('secret'); expect(f.service.routines!.journal.db.serialize()).toEqual(before); expect(f.vmCalls.length).toBe(calls);
});

test('actual FILE export releases only current sanitized image copies and refuses corrupt bytes without empty repair', async () => {
  const { binaryRuntime, fixtureImage, imageProbes } = await import('./fixtures/s16-binary'), { JitClient } = await import('../src/s16/client');
  const f = await composedFixture('default', false, undefined, options => ({ ...options, files: { parserRuntime: binaryRuntime(), imageProbes } })); all.push(f);
  const original = fixtureImage('metadata-polyglot.png'), created = await (await f.request('/api/s16/client/conversations/conversation/uploads', 'POST', { requestId: 'image_export', conversationId: 'conversation', name: 'image.png', bytes: original.length, sha256: new Bun.CryptoHasher('sha256').update(original).digest('hex') })).json() as any;
  const readyResponse = await f.raw('/api/s16/client/uploads/' + created.id + '/bytes', new Uint8Array(original).buffer); expect(readyResponse.status).toBe(200); const ready = await readyResponse.json() as any; expect(ready.state).toBe('ready');
  expect((await f.request('/api/s16/client/conversations/conversation/messages', 'POST', { contract: 's16-conversation/v2', requestId: 'image_only', conversationId: 'conversation', text: '', files: [{ id: ready.id, sha256: ready.receipt.sha256 }], continuation: null })).status).toBe(202);
  const expected = f.service.files!.image(f.owner, 'conversation', { id: ready.id, sha256: ready.receipt.sha256 }).bytes, before = f.service.files!.journal.db.serialize();
  const client = new JitClient({ origin: 'http://localhost:3099', fetch: request => f.service.fetch(new Request(request, { headers: { ...Object.fromEntries(request.headers), cookie: f.ownerCookie, origin: 'http://localhost:3099' } })) }); await client.bootstrap();
  const query: OwnerExportRequest = { ...scope, sections: ['file'] }, output = await client.exportData(query), image = output.value.records[0]! as any;
  expect(output.value.counts).toEqual({ file: 1 }); expect(image.representation).toBe('base64'); expect(image.mime).toBe('image/png'); expect(Buffer.from(image.text, 'base64')).toEqual(Buffer.from(expected)); expect(Buffer.from(image.text, 'base64')).not.toEqual(Buffer.from(original)); expect(f.service.files!.journal.db.serialize()).toEqual(before);
  const { writeFileSync } = await import('node:fs'), { join } = await import('node:path'); writeFileSync(join(f.service.files!.options.directory, ready.id + '.blob.derived'), 'corrupt sanitized image');
  const failed = await f.request('/api/s16/client/export', 'POST', query); expect(failed.status).toBe(409); expect(failed.headers.get('content-disposition')).toBeNull(); expect(await failed.json()).toEqual({ error: 'file_integrity_failed' }); expect(f.service.files!.journal.db.serialize()).toEqual(before);
});

test('actual connection and reviewed skill settings export stays credential-free, inert and read-only', async () => {
  const { firstRunFixture } = await import('./fixtures/s15-first-run'), { ConnectionVault } = await import('../src/exec/connections');
  let networkCalls = 0;
  const network = { async resolve() { networkCalls++; throw Error('fixture_export_dns_unexpected'); }, connect() { networkCalls++; throw Error('fixture_export_dial_unexpected'); } };
  const f = await firstRunFixture(options => ({ ...options, skills: { network }, connections: { vault: options.githubWeb!.vault, network } })); all.push(f);
  const setup = await f.page('/setup', 'en'), hidden = (name: string) => new RegExp('name="' + name + '" value="([a-f0-9]{64})"').exec(setup.html)?.[1];
  expect((await f.form('/s15/forms/rules/install', { proposalHash: hidden('proposalHash')!, ...(hidden('listHash') ? { listHash: hidden('listHash')! } : {}), return: 'setup' })).status).toBeLessThan(400);
  const doc = JSON.stringify({ openapi: '3.0.3', info: { title: 'Items', version: '1' }, servers: [{ url: 'https://api.example.com/v1' }], paths: { '/items': { get: { operationId: 'listItems' } } } }), secret = 'fixture-only-config-export-secret';
  const added = await (await f.request('/api/s16/client/connections/commands', 'POST', { contract: 's16-connection-command/v1', requestId: 'export_source', kind: 'source.add', sourceKind: 'openapi', label: 'Items', endpoint: '', auth: { kind: 'bearer', secret }, document: doc, origin: null })).json() as any; expect(added.source?.state).toBe('needs_review');
  const encode = (path: string, text: string) => ({ path, base64: Buffer.from(text).toString('base64') });
  const imported = await (await f.request('/api/s16/client/skills/commands', 'POST', { contract: 's16-skill-command/v1', requestId: 'export_skill_import', kind: 'skill.import', input: { kind: 'folder', label: 'Owner notes', files: [encode('SKILL.md', '---\nname: notes\ndescription: Read selected notes.\n---\nInert private source content.\n'), encode('LICENSE', 'MIT License\nSelf-authored deterministic fixture.\n')] } })).json() as any;
  const detail = await (await f.request('/api/s16/client/skills/' + imported.skillId)).json() as any, preview = await (await f.request('/api/s16/client/skills/' + imported.skillId + '/review-preview', 'POST', { pin: detail.candidate.pin, dependencies: {} })).json() as any;
  const reviewed = await (await f.request('/api/s16/client/skills/commands', 'POST', { contract: 's16-skill-command/v1', requestId: 'export_skill_review', kind: 'skill.review', skillId: imported.skillId, expectedRevision: detail.record.revision, pin: detail.candidate.pin, availability: { kind: 'team' }, executable: false, dependencies: {}, recipientsHash: preview.hash })).json() as any; expect(reviewed.state).toBe('active');
  const databases = [f.service.connections!.store.db, f.service.skills!.store.db, f.service.policy.control.maintenanceSource!()], before = databases.map(db => db.serialize()), priorNetwork = networkCalls, priorVm = f.vmCalls.length;
  const read = ConnectionVault.prototype.read, existing = ConnectionVault.prototype.readExisting; let credentialReads = 0;
  const refuse = () => { credentialReads++; throw Error('fixture_export_read_secret'); };
  try {
    ConnectionVault.prototype.read = refuse; ConnectionVault.prototype.readExisting = refuse;
    const query: OwnerExportRequest = { ...scope, sections: ['connection', 'skill'] }, response = await f.request('/api/s16/client/export', 'POST', query), value = await response.json() as any; expect({ status: response.status, error: value.error ?? null }).toEqual({ status: 200, error: null }); validateOwnerExport(value, query);
    const connection = value.records.find(item => item.kind === 'connection' && item.id === added.source.id), skill = configRecord(value, 'skill');
    if (!connection || !('configuration' in connection)) throw Error('fixture_export_connection_missing');
    expect(connection.configuration).toMatchObject({ kind: 'openapi', endpoint: 'https://api.example.com/v1', authentication: 'reconnect_required' }); expect(skill.configuration).toMatchObject({ pin: detail.candidate.pin, name: 'notes', requestedExecutable: false });
    const text = JSON.stringify(value); for (const excluded of [secret, 'fingerprint', 'recipientsHash', 'ownerGeneration', 'policyRevision', 'Inert private source content.']) expect(text).not.toContain(excluded);
    expect(credentialReads).toBe(0); expect(networkCalls).toBe(priorNetwork); expect(f.vmCalls.length).toBe(priorVm); expect(databases.map(db => db.serialize())).toEqual(before);
  } finally { ConnectionVault.prototype.read = read; ConnectionVault.prototype.readExisting = existing; }
});
