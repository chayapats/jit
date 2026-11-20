import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JitClient } from '../src/s16/client';
import { captureS16LedgerSet } from '../src/s16/operations/ledger-set';
import { s16SelectedRuntimeSources } from '../src/s16/operations/runtime-readers';
import { s16LedgerSetManifestHash, verifyS16LedgerSet } from '../src/s16/operations/verify-ledger-set';
import { operationsFixture } from './fixtures/s16-ops';

type Fixture = Awaited<ReturnType<typeof operationsFixture>>;
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const f = await operationsFixture();
  cleanup.push(() => f.close()); return f;
}
function point(f: Fixture, id = 'a'.repeat(32)) {
  const directory = join(f.parent, 'ops-points'); if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  const sources = f.service.maintenanceSources(f.owner);
  return { directory, id, installationId: 'fixture', sources, guard() { f.service.policy.owner.current(f.owner); }, now: () => f.now };
}
function image(path: string) { const db = new Database(path, { readonly: true, create: false, strict: true }); cleanup.push(() => db.close(true)); return db; }

test('all seventeen actual selected owning services capture current withdrawal, historical private custody, charges and unknown VM leases', async () => {
  const f = await fixture();
  const client = new JitClient({ origin: 'http://localhost:3099', fetch: async request => {
    const path = new URL(request.url).pathname;
    if (request.headers.get('content-type') === 'application/octet-stream') return f.raw(path, await request.arrayBuffer());
    return f.request(path, request.method, request.method === 'POST' ? await request.json() : undefined);
  } }); await client.bootstrap();
  const contents = new TextEncoder().encode('current withdrawn source\n'), upload = await client.createUpload({ requestId: 'ops_source', conversationId: 'conversation', name: 'source.txt', bytes: contents.length, sha256: new Bun.CryptoHasher('sha256').update(contents).digest('hex') });
  await client.uploadBytes(upload.id, contents); expect((await client.withdrawUpload(upload.id)).state).toBe('withdrawn');
  f.cleanupConfirmed = false; await f.chat('Run the requested command in the working computer');
  // Provisioning may retain a private reservation before enrollment; retirement never makes it shared.
  f.service.computerScopes!.assignPrivate('vm_pending', 'bot'); f.service.computerScopes!.retire('vm_pending');
  const leases = () => f.service.team.store.db.query<{ state: string }, []>('SELECT state FROM leases').all().map(row => row.state), charged = f.service.policy.control.usage();
  expect(leases()).toContain('unknown');
  const options = point(f), declared = JSON.parse(readFileSync(join(f.directory, 'composition.json'), 'utf8')) as { stores: string[] };
  expect(options.sources.map(source => source.name).sort()).toEqual([...declared.stores].sort()); expect(options.sources).toHaveLength(17);
  const manifest = captureS16LedgerSet(options), target = join(options.directory, options.id);
  expect(verifyS16LedgerSet({ ...options, readers: options.sources.map(({ name, reader }) => ({ name, reader })), manifestSha256: s16LedgerSetManifestHash(manifest) })).toEqual(manifest);
  expect(image(join(target, 'team.sqlite')).query<{ state: string }, []>('SELECT state FROM leases').all().map(row => row.state)).toEqual(leases());
  expect(image(join(target, 'vm.sqlite')).query('SELECT bot_id,retired_at FROM vm_scope WHERE vm_id=?').get('vm_pending')).toEqual({ bot_id: 'bot', retired_at: f.now });
  const rows = image(join(target, 'files.sqlite')).query<{ json: string }, []>('SELECT json FROM records').all().map(row => JSON.parse(row.json));
  expect(rows.find(row => row.kind === 'upload' && row.id === upload.id).state).toBe('withdrawn');
  expect(f.service.policy.control.usage()).toEqual(charged); expect((await client.uploadStatus(upload.id)).state).toBe('withdrawn');
  expect(image(join(target, 'policy.sqlite')).query<{ json: string }, []>("SELECT json FROM meta WHERE key='charged'").get()!.json).toBe(JSON.stringify(charged.charged));
});

test('source handles alone cannot bypass current owner revocation or publish a point', async () => {
  const f = await fixture(), options = point(f); f.generation = 2;
  expect(() => f.service.maintenanceSources(f.owner)).toThrow();
  expect(() => captureS16LedgerSet(options)).toThrow(); expect(existsSync(join(options.directory, options.id))).toBe(false);
});

test('a closed composition cannot supply maintenance handles', async () => {
  const f = await fixture(); await f.service.close();
  expect(() => f.service.maintenanceSources(f.owner)).toThrow(expect.objectContaining({ code: 'service_closed' }));
});

test('an incomplete, extra or unknown reader inventory cannot quietly become a smaller selected set', async () => {
  const f = await fixture(), sources = f.service.maintenanceSources(f.owner), names = sources.map(source => source.name), connections = new Map(sources.map(source => [source.name, source.database]));
  connections.delete('policy.sqlite');
  expect(() => s16SelectedRuntimeSources(names, connections)).toThrow(expect.objectContaining({ code: 's16_ops_source_unavailable' }));
  connections.set('extra.sqlite', f.service.vmStore.db);
  expect(() => s16SelectedRuntimeSources(names, connections)).toThrow(expect.objectContaining({ code: 's16_ops_inventory_changed' }));
  expect(() => s16SelectedRuntimeSources(['toString'], new Map([['toString', f.service.vmStore.db]]))).toThrow(expect.objectContaining({ code: 's16_ops_source_unavailable' }));
});
