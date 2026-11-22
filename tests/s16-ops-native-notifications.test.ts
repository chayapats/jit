import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NativePushProvider } from '../src/s16/native-notifications/types';
import { captureS16LedgerSet } from '../src/s16/operations/ledger-set';
import { openS16RuntimeMaintenance } from '../src/s16/operations/runtime-maintenance';
import { verifyS16LedgerSet, s16LedgerSetManifestHash } from '../src/s16/operations/verify-ledger-set';
import { operationsFixture } from './fixtures/s16-ops';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  let available = true, external = 0;
  const provider: NativePushProvider = { kind: 'apns', status: () => ({ provider: 'apns', available, code: available ? null : 'native_push_credentials_unavailable' }), async send() { external++; throw Error('unexpected_native_dispatch'); } };
  const f = await operationsFixture({ providers: [provider] }); cleanup.push(() => f.close());
  const native = f.service.nativeNotifications!, db = native.journal.db;
  native.subscribe(f.owner, { provider: 'apns', token: 'a'.repeat(64), locale: 'th' }); available = false;
  const device = db.query<{ owner_id: string; generation: number }, []>('SELECT owner_id,generation FROM native_devices_v1').get()!;
  native.record({ source: 'original_native_delivery', owner: { ownerId: device.owner_id, generation: device.generation }, kind: 'needs_you', path: '/s16/chat/native_ops' });
  native.journal.tx(() => db.exec("UPDATE native_deliveries_v1 SET state='sending',attempts=1"));
  const current = { devices: db.query('SELECT * FROM native_devices_v1').all(), notices: db.query('SELECT * FROM native_notices_v1').all(), deliveries: db.query('SELECT * FROM native_deliveries_v1').all() };
  const options = { directory: f.directory, installationId: 'fixture', browserResourceId: f.options(false).browser!.resource.id };
  return { f, db, options, current, get external() { return external; } };
}

test('all eighteen owning sources include native subscriptions and uncertain delivery without provider replay', async () => {
  const s = await fixture(); expect(s.f.service.maintenanceSources(s.f.owner)).toHaveLength(18);
  await s.f.service.close(); const context = openS16RuntimeMaintenance(s.options); cleanup.push(() => context.close());
  expect(context.sources).toHaveLength(18); expect(context.selected).toContain('native-notifications.sqlite');
  const root = join(s.f.parent, 'native-points'); mkdirSync(root, { mode: 0o700 });
  const point = captureS16LedgerSet({ directory: root, id: 'a'.repeat(32), installationId: 'fixture', sources: context.sources, guard: context.assertCurrent });
  expect(verifyS16LedgerSet({ directory: root, id: point.id, installationId: 'fixture', readers: context.sources, manifestSha256: s16LedgerSetManifestHash(point) })).toEqual(point);
  const image = new Database(join(root, point.id, 'native-notifications.sqlite'), { readonly: true, create: false }); cleanup.push(() => image.close(true));
  expect(image.query('SELECT * FROM native_devices_v1').all()).toEqual(s.current.devices);
  expect(image.query('SELECT * FROM native_notices_v1').all()).toEqual(s.current.notices);
  expect(image.query('SELECT * FROM native_deliveries_v1').all()).toEqual(s.current.deliveries);
  expect(s.current.deliveries[0]).toMatchObject({ state: 'sending', attempts: 1 });
  expect(s.external).toBe(0); expect(s.f.modelPrompts).toEqual([]); context.assertCurrent();
});

test('a disabled native feature retains its original owning journal without editing the composition manifest', async () => {
  const s = await fixture(); await s.f.service.close();
  const path = join(s.f.directory, 'composition.json'), manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.stores = manifest.stores.filter((name: string) => name !== 'native-notifications.sqlite'); writeFileSync(path, JSON.stringify(manifest));
  const before = readFileSync(path), context = openS16RuntimeMaintenance(s.options); cleanup.push(() => context.close());
  expect(context.retained).toEqual(['native-notifications.sqlite']); expect(context.sources).toHaveLength(18);
  expect(readFileSync(path)).toEqual(before); expect(s.external).toBe(0);
});

test.each(['missing', 'future', 'foreign', 'component'] as const)('invalid %s native journal refuses without reconstruction or dispatch', async kind => {
  const s = await fixture(); await s.f.service.close(); const path = join(s.f.directory, 'native-notifications.sqlite');
  if (kind === 'missing') unlinkSync(path);
  else { const db = new Database(path, { create: false, readwrite: true }); try {
    if (kind === 'future') db.exec('PRAGMA user_version=2');
    if (kind === 'foreign') db.exec("UPDATE identity SET installation='foreign'");
    if (kind === 'component') db.exec('DROP TABLE native_cursors_v1');
  } finally { db.close(true); } }
  expect(() => openS16RuntimeMaintenance(s.options)).toThrow();
  expect(existsSync(path)).toBe(kind !== 'missing'); expect(s.external).toBe(0); expect(s.f.modelPrompts).toEqual([]);
});
