import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { composedFixture } from './fixtures/s15-composition';
import { binaryRuntime, launchPdf } from './fixtures/s16-binary';
import { JitClient } from '../src/s16/client';
import { fileCustodyPayloads, fileExpectedPayloads } from '../src/s16/files/maintenance';
import { captureS16PayloadSet, s16PayloadSetManifestHash, verifyS16PayloadSet } from '../src/s16/operations/payload-set';

type Fixture = Awaited<ReturnType<typeof composedFixture>>;
const cleanup: Fixture[] = [];
afterEach(async () => { for (const f of cleanup.splice(0)) await f.close(); });
const hash = (bytes: Uint8Array | string) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
async function fixture(binary = false) {
  const f = await composedFixture('default', false, undefined, options => ({ ...options, files: { memory: true, ...(binary ? { parserRuntime: binaryRuntime() } : {}) } })); cleanup.push(f);
  const client = new JitClient({ origin: 'http://localhost:3099', fetch: async request => {
    const path = new URL(request.url).pathname;
    return request.headers.get('content-type') === 'application/octet-stream' ? f.raw(path, await request.arrayBuffer()) : f.request(path, request.method, request.method === 'POST' ? await request.json() : undefined);
  } }); await client.bootstrap(); return { f, client };
}
const inventory = (f: Fixture) => fileCustodyPayloads(f.service.files!.journal.db, f.service.files!.directory, 'fixture', () => { f.service.policy.owner.current(f.owner); });
const expected = (f: Fixture) => fileExpectedPayloads(f.service.files!.journal.db, 'fixture', () => { f.service.policy.owner.current(f.owner); });
async function upload(client: JitClient, text: string, requestId: string) {
  const bytes = new TextEncoder().encode(text), pending = await client.createUpload({ requestId, conversationId: 'conversation', name: 'notes.txt', bytes: bytes.length, sha256: hash(bytes) });
  const ready = await client.uploadBytes(pending.id, bytes); expect(ready.state).toBe('ready'); return ready;
}

test('actual client upload, staged artifact and withdrawal retain protected exact bytes without publishing staged output or reviving withdrawn source', async () => {
  const { f, client } = await fixture(), ready = await upload(client, 'current private input\n', 'keep'), withdrawn = await upload(client, 'withdraw this input\n', 'withdraw');
  const staged = f.service.files!.stageArtifact(f.owner, { id: 'candidate', requestId: 'uncommitted', workId: 'work', conversationId: 'conversation', name: 'draft.md', text: '# Unpublished\n', inputs: [{ id: ready.id, sha256: ready.receipt!.sha256 }] });
  await client.withdrawUpload(withdrawn.id);
  const scope = inventory(f); expect(scope.pending).toEqual([]); expect(scope.untracked).toEqual([]);
  expect(scope.sources.map(row => row.name).sort()).toEqual([ready.id + '.blob', staged.id + '.blob'].sort());
  expect(scope.sources.some(row => row.name.startsWith(withdrawn.id))).toBe(false);
  const directory = join(f.parent, 'payload-points'); mkdirSync(directory, { mode: 0o700 });
  const guard = () => { f.service.policy.owner.current(f.owner); }, manifest = captureS16PayloadSet({ directory, installationId: 'fixture', id: 'a'.repeat(32), sources: scope.sources, guard });
  expect(verifyS16PayloadSet({ directory, installationId: 'fixture', id: manifest.id, manifestSha256: s16PayloadSetManifestHash(manifest), files: manifest.files })).toEqual(manifest);
  expect((await client.uploadStatus(withdrawn.id)).state).toBe('withdrawn');
  expect((await f.request(`/api/s16/client/requests/uncommitted/artifacts/${staged.id}`)).status).not.toBe(200);
  expect(f.modelPrompts).toHaveLength(0); expect(f.vmCalls).toHaveLength(0);
});

test('actual controlled PDF parser receipt includes original and exact derived bytes while inventory never starts another parser or model', async () => {
  const { f, client } = await fixture(true), bytes = launchPdf(), pending = await client.createUpload({ requestId: 'pdf', conversationId: 'conversation', name: 'notes.pdf', bytes: bytes.length, sha256: hash(bytes) });
  const ready = await client.uploadBytes(pending.id, bytes); expect(ready.receipt?.contract).toBe('s16-file-receipt/v2');
  const scope = inventory(f); expect(scope.sources.map(row => row.name).sort()).toEqual([ready.id + '.blob', ready.id + '.blob.derived']);
  for (const source of scope.sources) { const actual = readFileSync(source.path); expect(actual.length).toBe(source.bytes); expect(hash(actual)).toBe(source.sha256); }
  expect(readFileSync(scope.sources.find(row => row.name.endsWith('.derived'))!.path, 'utf8')).toContain('Launch: Friday.');
  expect(scope.pending).toEqual([]); expect(scope.untracked).toEqual([]); expect(f.modelPrompts).toHaveLength(0);
});

test('interrupted and untracked custody is reported without application boot, deletion or inferred completion', async () => {
  const { f, client } = await fixture(), ready = await upload(client, 'pending body\n', 'pending'), journal = f.service.files!.journal;
  const record = journal.get<Record<string, unknown>>(ready.id); journal.tx(() => journal.put(ready.id, { ...record, state: 'validating' }));
  writeFileSync(join(f.service.files!.directory, 'unknown.part'), 'unsettled', { mode: 0o600 });
  const scope = inventory(f); expect(scope.sources).toEqual([]); expect(scope.pending).toEqual([{ id: ready.id, state: 'validating' }]);
  expect(scope.untracked).toEqual([ready.id + '.blob', 'unknown.part'].sort()); expect(journal.get<Record<string, unknown>>(ready.id).state).toBe('validating');
  expect(existsSync(join(f.service.files!.directory, 'unknown.part'))).toBe(true);
});

test.each(['foreign', 'reader', 'receipt', 'bounds', 'owner'] as const)('invalid current owning %s metadata cannot resolve protected payloads', async kind => {
  const { f, client } = await fixture(), ready = await upload(client, 'bound source\n', 'input'), journal = f.service.files!.journal;
  if (kind === 'foreign') journal.db.exec("UPDATE identity SET installation='foreign'");
  if (kind === 'reader') journal.db.exec('PRAGMA user_version=99');
  if (kind === 'receipt') { const row = journal.get<Record<string, unknown>>(ready.id); journal.tx(() => journal.put(ready.id, { ...row, receipt: { ...(row.receipt as object), sha256: '0'.repeat(64) } })); }
  if (kind === 'bounds') journal.db.query('UPDATE records SET json=? WHERE id=?').run(JSON.stringify({ ...journal.get<Record<string, unknown>>(ready.id), extra: 'x'.repeat(131072) }), ready.id);
  if (kind === 'owner') f.generation = 2;
  expect(() => inventory(f)).toThrow(); expect(readFileSync(join(f.service.files!.directory, ready.id + '.blob'), 'utf8')).toBe('bound source\n');
  expect(() => expected(f)).toThrow();
});

test('current FILE references remain readable after payload loss without creating missing paths or making capture complete', async () => {
  const { f, client } = await fixture(), ready = await upload(client, 'exact current source\n', 'missing_bytes');
  const directory = f.service.files!.directory, before = f.service.files!.journal.db.serialize(), refs = expected(f);
  expect(refs.files).toEqual([{ name: ready.id + '.blob', rowId: ready.id, role: 'original', bytes: ready.bytes, sha256: ready.receipt!.sha256 }]);
  renameSync(directory, directory + '.retained');
  expect(expected(f)).toEqual(refs); expect(existsSync(directory)).toBe(false); expect(() => inventory(f)).toThrow();
  expect(f.service.files!.journal.db.serialize()).toEqual(before); expect(f.modelPrompts).toHaveLength(0); expect(f.vmCalls).toHaveLength(0);
  expect(Object.isFrozen(refs)).toBe(true); expect(Object.isFrozen(refs.files[0])).toBe(true); expect(JSON.stringify(refs)).not.toContain(f.directory);
});

test('current FILE metadata keeps staged artifact pins inert and excludes current withdrawn input from recovery references', async () => {
  const { f, client } = await fixture(), ready = await upload(client, 'withdraw current source\n', 'current_source');
  const artifact = f.service.files!.stageArtifact(f.owner, { id: 'current_staged', requestId: 'still_unpublished', workId: 'work', conversationId: 'conversation', name: 'draft.md', text: '# Inert staged bytes\n', inputs: [{ id: ready.id, sha256: ready.receipt!.sha256 }] });
  expect(expected(f).files).toHaveLength(2); await client.withdrawUpload(ready.id);
  const before = f.service.files!.journal.db.serialize(), refs = expected(f);
  expect(refs.files).toEqual([{ name: artifact.id + '.blob', rowId: artifact.id, role: 'artifact', bytes: artifact.bytes, sha256: artifact.sha256 }]);
  expect((await f.request(`/api/s16/client/requests/still_unpublished/artifacts/${artifact.id}`)).status).not.toBe(200); expect(f.service.files!.journal.db.serialize()).toEqual(before);
});

test('current FILE references include validated representations and preserve original pending uncertainty without byte reads', async () => {
  const { f, client } = await fixture(true), bytes = launchPdf(), created = await client.createUpload({ requestId: 'current_pdf', conversationId: 'conversation', name: 'notes.pdf', bytes: bytes.length, sha256: hash(bytes) });
  const ready = await client.uploadBytes(created.id, bytes), refs = expected(f);
  expect(refs.files.map(row => row.role)).toEqual(['original', 'representation']);
  const journal = f.service.files!.journal, row = journal.get<Record<string, unknown>>(ready.id); journal.tx(() => journal.put(ready.id, { ...row, state: 'validating', receipt: null }));
  const before = journal.db.serialize(); renameSync(f.service.files!.directory, f.service.files!.directory + '.retained');
  expect(expected(f)).toMatchObject({ files: [], pending: [{ id: ready.id, state: 'validating' }] }); expect(journal.db.serialize()).toEqual(before); expect(f.modelPrompts).toHaveLength(0);
});
