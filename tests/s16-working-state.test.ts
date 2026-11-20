import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JitClient, JitClientError } from '../src/s16/client';
import { workingStateFixture } from './fixtures/s16-working-state';
import { vmHash } from '../src/s15/vm/validation';
import type { FileUpload } from '../src/s16/files/types';

const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const run of close.splice(0).reverse()) await run(); });
const fixture = async () => { const f = await workingStateFixture(); close.push(() => f.f.close()); return f; };
const id = (n: number) => n.toString(16).padStart(32, '0');

test.each([65_536, 1_048_576])('owning client recovers a %i-byte file through the large portable_put policy projection', async bytes => {
  const { f, client, source, setHook } = await fixture(), contents = Buffer.alloc(bytes, 0x52);
  // The scripted guest task creates the source bytes; capture and import use the owning service/client.
  setHook((request, phase) => { if (request.op === 'spawn' && phase === 'after') f.files.set(request.root + '/large.bin', contents); });
  const workId = await source(); setHook(null);
  const manifest = await client.captureWorkingState({ requestId: id(21), workId, paths: ['large.bin'] });
  expect(manifest.files).toEqual([{ path: 'large.bin', bytes, sha256: vmHash(contents) }]);
  const result = await client.importWorkingState({ requestId: id(22), packageId: manifest.id, manifestSha256: manifest.manifestSha256, vmId: 'vm2' });
  expect(result.state).toBe('committed'); expect(f.files.get(result.path + '/large.bin')).toEqual(contents);
});

test('owning owner client captures exact public-tool result bytes, reviews hashes, and recovers to a fresh second-backend workspace', async () => {
  const { f, client, source } = await fixture(), workId = await source(), sourceHolder = f.service.vmPool.holder(workId);
  const before = f.vmCalls.length; const view = await client.workingState(); expect(view.sources.map(s => s.workId)).toContain(workId); expect(f.vmCalls.length).toBe(before);
  const manifest = await client.captureWorkingState({ requestId: id(1), workId, paths: ['result.txt', 'src/note.md'] });
  expect(manifest.source.workId).toBe(workId); expect(manifest.source.privateBotId).toBeNull(); expect(manifest.files.map(f => f.path)).toEqual(['result.txt', 'src/note.md']);
  expect((await client.workingStatePackage(manifest.id)).manifestSha256).toBe(manifest.manifestSha256);
  const result = await client.importWorkingState({ requestId: id(2), packageId: manifest.id, manifestSha256: manifest.manifestSha256, vmId: 'vm2' });
  expect(result.state).toBe('committed'); expect(result.destination.workId).not.toBe(workId); expect(result.destination.attemptId).toBe('chat_' + result.destination.workId);
  expect(f.files.get(result.path + '/result.txt')).toEqual(Buffer.from('portable result\n')); expect(f.files.get(result.path + '/src/note.md')).toEqual(Buffer.from('reviewed note\n'));
  expect(f.service.vmPool.holder(workId)).toBe(sourceHolder); expect(f.service.vmPool.holder(result.destination.workId)).toBe('vm2');
  const actor = f.service.policy.control.bindWork(result.destination.workId), session = await f.service.workingVm.openAttempt(actor, { vmId: 'vm', workId: result.destination.workId, attemptId: result.destination.attemptId });
  const chunks: Uint8Array[] = []; for await (const chunk of session.backend.readFile(result.path + '/result.txt')) chunks.push(chunk); expect(Buffer.concat(chunks).toString()).toBe('portable result\n'); await session.close();
  expect(readFileSync(join(f.directory, 'vm.sqlite')).readUInt32BE(60)).toBe(3);
  const calls = f.vmCalls.length; expect((await client.importWorkingState({ requestId: id(2), packageId: manifest.id, manifestSha256: manifest.manifestSha256, vmId: 'vm2' })).state).toBe('committed'); expect(f.vmCalls.length).toBe(calls);
  const bytes = JSON.stringify(await client.workingState()); expect(bytes).not.toContain('portable result'); expect(bytes).not.toContain('identityFile');
});

test('independent reader/ancestry stamp exists before the first destination dispatch, and later source sleep/expiry restores no old grant', async () => {
  const { f, client, source, setHook } = await fixture(), workId = await source(), manifest = await client.captureWorkingState({ requestId: id(13), workId, paths: ['result.txt'] });
  let observed = false;
  setHook((request, phase) => { if (request.op === 'portable_begin' && phase === 'before') {
    const row = f.service.vmStore.db.query<{ data: string; state: string }, [string]>('SELECT data,state FROM vm_working_imports WHERE id=?').get(id(14)); expect(row?.state).toBe('dispatched');
    const saved = JSON.parse(row!.data); expect(saved.packageId).toBe(manifest.id); expect(saved.manifestSha256).toBe(manifest.manifestSha256); f.service.vmStore.assertPortableState();
    expect(f.service.disclosure!.lineage(f.service.policy.control.bindWork(saved.destination.workId), manifest.dataRef).map(source => source.ref)).toEqual(f.service.disclosure!.ownerAncestry(f.owner, manifest.dataRef).map(source => source.ref)); observed = true;
  } });
  const result = await client.importWorkingState({ requestId: id(14), packageId: manifest.id, manifestSha256: manifest.manifestSha256, vmId: 'vm2' }); expect(observed).toBe(true); expect(result.state).toBe('committed'); setHook(null);
  // A complete immutable package survives ordinary source lifecycle, under a fresh current copy grant.
  const old = f.service.vmStore.registration('vm'); f.service.vmStore.save({ ...old, generation: old.generation + 1, state: 'stopped' });
  f.service.policy.owner.revoke(f.owner, 'old_grant_ends', { kind: 'work', id: workId });
  expect((await client.workingStatePackage(manifest.id)).manifestSha256).toBe(manifest.manifestSha256);
  const second = await client.importWorkingState({ requestId: id(15), packageId: manifest.id, manifestSha256: manifest.manifestSha256, vmId: 'vm2' }); expect(second.state).toBe('committed'); expect(second.destination.workId).not.toBe(workId);
  expect(() => f.service.policy.work.guard(f.service.policy.control.bindWork(workId))).toThrow();
});

test('current original file withdrawal fences already copied bytes and its independent ancestry survives controller restart', async () => {
  const { f, client } = await fixture(); f.service.computerScopes!.assignPrivate('vm2', 'bot');
  const text = 'original owner source\n', uploaded = await f.request('/api/s16/client/conversations/conversation/uploads', 'POST', { requestId: 'portable_upload', conversationId: 'conversation', name: 'source.txt', bytes: Buffer.byteLength(text), sha256: vmHash(text) }); expect(uploaded.status).toBe(201);
  const pending = await uploaded.json() as FileUpload, written = await f.raw('/api/s16/client/uploads/' + pending.id + '/bytes', text), file = (await written.json() as FileUpload).receipt!;
  f.script = [{ type: 'tool_call', id: 'derive', name: 'bash', arguments: { command: 'portable-fixture-task' } }];
  expect((await f.request('/api/s16/client/conversations/conversation/messages', 'POST', { contract: 's16-conversation/v2', requestId: 'file_source', conversationId: 'conversation', text: 'Use this source to create two work files.', continuation: null, files: [{ id: file.id, sha256: file.sha256 }] })).status).toBe(202);
  await f.service.conversation.drain(); const workId = f.service.conversation.view(f.owner, 'file_source').authority!.id;
  const manifest = await client.captureWorkingState({ requestId: id(16), workId, paths: ['result.txt'] }); expect(manifest.source.filePins.some(pin => pin.source.id === file.id)).toBe(true);
  const result = await client.importWorkingState({ requestId: id(17), packageId: manifest.id, manifestSha256: manifest.manifestSha256, vmId: 'vm2' }); expect(result.state).toBe('committed');
  expect((await f.request('/api/s16/client/uploads/' + file.id + '/withdraw', 'POST', {})).status).toBe(200);
  const open = async () => f.service.workingVm.openAttempt(f.service.policy.control.bindWork(result.destination.workId), { vmId: 'vm', workId: result.destination.workId, attemptId: result.destination.attemptId });
  await expect(open()).rejects.toMatchObject({ code: 'outside_scope' });
  await f.reopen(); await expect(open()).rejects.toMatchObject({ code: 'outside_scope' });
  expect(f.service.vmStore.db.query('SELECT id FROM vm_working_imports WHERE id=?').get(id(17))).not.toBeNull(); f.service.vmStore.assertPortableState();
});

test('unknown original commit survives controller restart and client rejects a changed review manifest', async () => {
  const { f, client, source, setHook } = await fixture(), workId = await source(), manifest = await client.captureWorkingState({ requestId: id(18), workId, paths: ['result.txt'] });
  setHook((request, phase) => { if (request.op === 'portable_commit' && phase === 'after') throw Object.assign(new Error('EIO'), { code: 'EIO' }); });
  expect((await client.importWorkingState({ requestId: id(19), packageId: manifest.id, manifestSha256: manifest.manifestSha256, vmId: 'vm2' })).state).toBe('unknown'); setHook(null); const commits = f.vmCalls.filter(op => op === 'portable_commit').length;
  await f.reopen(); expect((await client.inspectWorkingState(id(19))).state).toBe('committed'); expect(f.vmCalls.filter(op => op === 'portable_commit').length).toBe(commits);
  const changed = new JitClient({ origin: 'http://localhost:3099', fetch: async request => { const response = await f.request(new URL(request.url).pathname, request.method); const value = await response.json(); if (request.url.includes('/packages/')) value.files[0].path = 'changed.txt'; return Response.json(value, { status: response.status }); } });
  await expect(changed.workingStatePackage(manifest.id)).rejects.toMatchObject({ code: 'client_protocol_invalid' });
});

test('interrupted import keeps independent ancestry and partial staging; original inspection never puts or commits again', async () => {
  const { f, client, source, stages, setHook } = await fixture(), workId = await source(); const manifest = await client.captureWorkingState({ requestId: id(3), workId, paths: ['result.txt', 'src/note.md'] });
  let count = 0; setHook(request => { if (request.op === 'portable_put' && ++count === 2) throw Object.assign(new Error('EIO'), { code: 'EIO' }); });
  const result = await client.importWorkingState({ requestId: id(4), packageId: manifest.id, manifestSha256: manifest.manifestSha256, vmId: 'vm2' }); expect(result.state).toBe('unknown');
  expect(stages.get(id(4))?.committed).toBe(false); expect(stages.get(id(4))?.data.size).toBe(1);
  expect(f.service.vmStore.db.query('SELECT id FROM vm_working_imports WHERE id=?').get(id(4))).not.toBeNull();
  setHook(null); const writes = f.vmCalls.filter(op => ['portable_begin', 'portable_put', 'portable_commit'].includes(op)).length;
  expect((await client.inspectWorkingState(id(4))).state).toBe('unknown'); expect((await client.inspectWorkingState(id(4))).state).toBe('unknown');
  expect(f.vmCalls.filter(op => ['portable_begin', 'portable_put', 'portable_commit'].includes(op)).length).toBe(writes);
  expect([...f.files.keys()].some(p => p.includes('/restored-' + id(4)))).toBe(false);
});

test('lost original commit response can read back complete bytes without another mutation', async () => {
  const { f, client, source, setHook } = await fixture(), workId = await source(), manifest = await client.captureWorkingState({ requestId: id(5), workId, paths: ['result.txt'] });
  setHook((request, phase) => { if (request.op === 'portable_commit' && phase === 'after') throw Object.assign(new Error('EIO'), { code: 'EIO' }); });
  expect((await client.importWorkingState({ requestId: id(6), packageId: manifest.id, manifestSha256: manifest.manifestSha256, vmId: 'vm2' })).state).toBe('unknown'); setHook(null);
  const writes = f.vmCalls.filter(op => op === 'portable_commit').length, result = await client.inspectWorkingState(id(6)); expect(result.state).toBe('committed'); expect(f.files.get(result.path + '/result.txt')).toEqual(Buffer.from('portable result\n')); expect(f.vmCalls.filter(op => op === 'portable_commit').length).toBe(writes);
});

test('source revocation rejects late capture and leaves no complete package or retained file bytes', async () => {
  const { f, client, source, setHook } = await fixture(), workId = await source();
  setHook((request, phase) => { if (request.op === 'portable_read' && phase === 'after') f.service.policy.owner.revoke(f.owner, 'withdraw_source', { kind: 'work', id: workId }); });
  await expect(client.captureWorkingState({ requestId: id(7), workId, paths: ['result.txt'] })).rejects.toBeInstanceOf(JitClientError);
  expect(f.service.vmStore.db.query('SELECT state FROM vm_working_packages WHERE id=?').get(id(7))).toEqual({ state: 'failed' }); expect(f.service.vmStore.db.query('SELECT path FROM vm_working_files WHERE package_id=?').all(id(7))).toHaveLength(0);
});

test('private computer ancestry cannot be recovered to a shared computer and a changed reviewed hash never dispatches', async () => {
  const { f, client, source } = await fixture(); f.service.computerScopes!.assignPrivate('vm2', 'bot'); const workId = await source();
  const session = await f.service.workingVm.openAttempt(f.service.policy.control.bindWork(workId), { vmId: 'vm', workId, attemptId: 'chat_' + workId, access: 'inspect' });
  expect(session.definitions.every(tool => tool.description.includes('firecracker-offline-vsock/v1') && tool.description.includes('"externalNetwork":"unavailable"') && tool.description.includes('protocol_fixture'))).toBe(true); await session.close();
  const manifest = await client.captureWorkingState({ requestId: id(8), workId, paths: ['result.txt'] }); expect(manifest.source.privateBotId).toBe('bot'); const before = f.vmCalls.length;
  await expect(client.importWorkingState({ requestId: id(9), packageId: manifest.id, manifestSha256: manifest.manifestSha256, vmId: 'vm' })).rejects.toMatchObject({ code: 'vm_portable_scope' });
  await client.bootstrap();
  await expect(client.importWorkingState({ requestId: id(10), packageId: manifest.id, manifestSha256: 'f'.repeat(64), vmId: 'vm' })).rejects.toMatchObject({ code: 'vm_portable_changed' }); expect(f.vmCalls.length).toBe(before);
  f.service.computerScopes!.retire('vm2');
  await expect(client.importWorkingState({ requestId: id(20), packageId: manifest.id, manifestSha256: manifest.manifestSha256, vmId: 'vm2' })).rejects.toMatchObject({ code: 'vm_portable_scope' }); expect(f.vmCalls.length).toBe(before);
});

test('client HTTP response loss recovers the original receipt, and owner CSRF/origin checks precede VM I/O', async () => {
  const { f, client, source } = await fixture(), workId = await source(), manifest = await client.captureWorkingState({ requestId: id(11), workId, paths: ['result.txt'] }); let lost = false;
  const remote = new JitClient({ origin: 'http://localhost:3099', fetch: async request => { const result = await f.request(new URL(request.url).pathname, request.method, request.method === 'POST' ? await request.json() : undefined); if (!lost && request.url.endsWith('/working-state/imports')) { lost = true; throw new TypeError('connection lost'); } return result; } });
  await remote.bootstrap();
  await expect(remote.importWorkingState({ requestId: id(12), packageId: manifest.id, manifestSha256: manifest.manifestSha256, vmId: 'vm2' })).rejects.toMatchObject({ outcome: 'unknown', requestId: id(12) });
  const writes = f.vmCalls.length; expect((await client.inspectWorkingState(id(12))).state).toBe('committed'); expect(f.vmCalls.length).toBe(writes);
  expect((await f.request('/api/s16/client/computers/working-state/receipts/' + id(12), 'POST', { command: 'commit' })).status).toBe(400); expect(f.vmCalls.length).toBe(writes);
  expect((await f.request('/api/s16/client/computers/working-state/capture', 'POST', {}, { 'x-csrf-token': 'wrong' })).status).toBe(403);
  expect((await f.request('/api/s16/client/computers/working-state/capture', 'POST', {}, { origin: 'http://other.invalid' })).status).toBe(403); expect(f.vmCalls.length).toBe(writes);
});
