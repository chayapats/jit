import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectionVault } from '../src/exec/connections';
import { opsDirectory } from '../src/s14/ops-files';
import { openS16ControlMaintenance } from '../src/s16/operations/control-maintenance';
import { pointFormatFixture } from './fixtures/s16-point';
import { NotificationService } from '../src/s16/notifications/service';
import { fakePushService } from './fixtures/s16-push';
import { VmStore } from '../src/s15/vm/store';
import { VmManagers } from '../src/s15/vm/managers';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() { const f = await pointFormatFixture(); cleanup.push(f.dispose); return f; }
async function local(kind: 'pending' | 'partial' | 'provisioned' = 'provisioned') {
  const f = await fixture(); f.context.close(); const path = join(f.directory, 'runtime/vm.sqlite'), db = new Database(path, { readwrite: true, create: false });
  // Explicit owning-format fixture; physical files are inert disposable bytes, never a hypervisor proof.
  const manager = { kind: 'qemu', name: 'jit-work-' + 'a'.repeat(12), architecture: 'aarch64', mac: '52:54:00:12:34:56', sshPort: 22000, resources: { cpus: 2, memoryMiB: 2048, diskGiB: 16 } };
  try { db.query('INSERT INTO vm_managers VALUES (?,?)').run('manager_original', JSON.stringify(manager)); } finally { db.close(); }
  const machine = join(f.directory, 'runtime/vm-local/machines', manager.name);
  if (kind !== 'pending') opsDirectory(machine);
  if (kind === 'provisioned') {
    writeFileSync(join(machine, 'state.json'), JSON.stringify({ provisioned: true, desired: 'stopped', pid: null, startTicks: null, appliedDiskGiB: 16 }), { mode: 0o600 });
    writeFileSync(join(machine, 'disk.qcow2'), 'Inert disk fixture.', { mode: 0o600 }); writeFileSync(join(machine, 'client'), 'PRIVATE_KEY_MARKER', { mode: 0o600 });
  }
  const ctx = openS16ControlMaintenance({ ...f.config, vm: { ...f.config.vm, local: true } }); cleanup.push(() => ctx.close()); return { f, ctx, machine, path };
}

test('actual selected empty custody binds current owner/client and never initializes a notification key or external state', async () => {
  const f = await fixture(), before = readFileSync(join(f.directory, 'operations/control.json')), cut = f.context.externalCustody(); cut.assertCurrent();
  expect(cut.value.client).toMatchObject({ contract: 's16-client-bootstrap/v1', ownerIdentity: f.context.ownerIdentity, ownerGeneration: null, deviceStorage: 'retain_current_or_owner_reconnect' });
  expect(cut.value.vm.managers).toEqual([]); expect(cut.value.vm.physicalSettlement).toBe('unobserved'); expect(cut.value.retained.vapid.present).toBe(false);
  expect(existsSync(join(f.directory, 'runtime/notifications-vapid.key'))).toBe(false); expect(readFileSync(join(f.directory, 'operations/control.json'))).toEqual(before);
  expect(JSON.stringify(cut.value)).not.toContain(f.directory); expect(Object.isFrozen(cut.value.vm.roots)).toBe(true);
  f.context.close(); expect(() => cut.assertCurrent()).toThrow();
});

test('secret and profile contents are not read, copied or included in metadata', async () => {
  const f = await fixture(), vapid = join(f.directory, 'runtime/notifications-vapid.key'); writeFileSync(vapid, Buffer.alloc(32, 65), { mode: 0o600 });
  opsDirectory(join(f.directory, 'runtime/profiles')); writeFileSync(join(f.directory, 'runtime/profiles/private-cookie'), 'PRIVATE_PROFILE_MARKER', { mode: 0o600 });
  const original = ConnectionVault.prototype.read, existing = ConnectionVault.prototype.readExisting; let reads = 0;
  const denied = () => { reads++; throw Error('unexpected_credential_read'); }; ConnectionVault.prototype.read = denied; ConnectionVault.prototype.readExisting = denied;
  try { const cut = f.context.externalCustody(); cut.assertCurrent(); const encoded = JSON.stringify(cut.value); expect(encoded).not.toContain('PRIVATE_PROFILE_MARKER'); expect(encoded).not.toContain(Buffer.alloc(32, 65).toString()); expect(reads).toBe(0); expect(cut.value.retained.vapid.present).toBe(true); }
  finally { ConnectionVault.prototype.read = original; ConnectionVault.prototype.readExisting = existing; }
});

test('actual retained owning subscriptions require the original key and metadata capture never generates a replacement', async () => {
  const f = await fixture(); f.context.close(); const push = fakePushService(), keyPath = join(f.directory, 'runtime/notifications-vapid.key');
  const service = new NotificationService<object>({ path: join(f.directory, 'runtime/notifications.sqlite'), installationId: f.config.installationId, create: true, keyPath, origin: f.config.origin,
    principal: () => ({ ownerId: 'owner', generation: 1 }), ownerCurrent: () => true, producers: [], fetch: push.fetch });
  try { service.subscribe({}, { publicKey: service.publicKey(), subscription: push.device().subscription }); } finally { await service.close(); }
  f.open(); const cut = f.context.externalCustody(); expect(cut.value.retained.notificationSubscriptions).toBe(1); expect(cut.value.retained.vapid.present).toBe(true); expect(push.received).toEqual([]);
  unlinkSync(keyPath); expect(() => f.context.externalCustody()).toThrow(expect.objectContaining({ code: 's16_ops_external_notification_key_missing' })); expect(existsSync(keyPath)).toBe(false); expect(push.received).toEqual([]);
});

test('actual owning manager/registry writers retain original generations, snapshot refs and independent SSH credentials without backend calls', async () => {
  const f = await fixture(); f.context.close(); const store = new VmStore(join(f.directory, 'runtime/vm.sqlite')), vault = new ConnectionVault(join(f.directory, 'vault'), { forbidden: [join(f.directory, 'runtime')] });
  const managers = new VmManagers({ store, vault, requireOwner() {} }); const { managerId } = managers.register({}, { kind: 'lima', instance: 'jit-work-fixture' });
  const key = join(f.parent, 'private-key'), known = join(f.parent, 'known-hosts'); writeFileSync(key, 'PRIVATE_SSH_MARKER', { mode: 0o600 }); writeFileSync(known, 'PRIVATE_HOST_MARKER', { mode: 0o600 });
  try { store.save({ id: 'working', generation: 3, managerId, endpoint: { host: 'fixture.invalid', port: 22, user: 'jit', identityFile: key, knownHostsFile: known }, state: 'uncertain', networkCheckedAt: 1, networkIsolated: true, maxSessions: 1, reason: 'original_unknown', machineIdentity: 'lima:jit-work-fixture', boot: null });
    // A protected original reference fixture, not a claim of a cold image or hypervisor observation.
    store.db.query('INSERT INTO vm_snapshots VALUES (?,?,?)').run('snapshot_original', 'working', 2);
  } finally { managers.close(); store.close(); }
  f.open(); const cut = f.context.externalCustody(); expect(cut.value.vm.managers).toMatchObject([{ id: managerId, kind: 'lima' }]); expect(cut.value.vm.registrations).toMatchObject([{ id: 'working', generation: 3, state: 'uncertain', credentials: { identity: { present: true }, knownHosts: { present: true } } }]);
  expect(cut.value.vm.snapshots).toEqual([{ id: 'snapshot_original', vmId: 'working', generation: 2 }]); expect(JSON.stringify(cut.value)).not.toContain(key); expect(JSON.stringify(cut.value)).not.toContain('PRIVATE_SSH_MARKER'); cut.assertCurrent();
  unlinkSync(key); expect(() => cut.assertCurrent()).toThrow(expect.objectContaining({ code: 's16_ops_external_changed' }));
});

test.each(['vapid', 'profile', 'local-root'] as const)('original cut refuses changed %s custody rather than accepting a new expected digest', async kind => {
  const f = await fixture(), path = kind === 'vapid' ? join(f.directory, 'runtime/notifications-vapid.key') : join(f.directory, 'runtime', kind === 'profile' ? 'profiles' : 'vm-local');
  if (kind === 'vapid') writeFileSync(path, Buffer.alloc(32), { mode: 0o600 }); else opsDirectory(path);
  const cut = f.context.externalCustody(); renameSync(path, path + '.old'); if (kind === 'vapid') writeFileSync(path, Buffer.alloc(32), { mode: 0o600 }); else mkdirSync(path, { mode: 0o700 });
  expect(() => cut.assertCurrent()).toThrow(expect.objectContaining({ code: 's16_ops_external_changed' }));
});

test.each(['pending', 'partial'] as const)('a %s local preparation remains explicitly unobserved without inventing stopped/provisioned state', async kind => {
  const { ctx } = await local(kind), cut = ctx.externalCustody(); expect(cut.value.vm.local).toHaveLength(1);
  expect(cut.value.vm.local[0]).toMatchObject({ provisioned: null, stateSha256: null, physicalSettlement: 'unobserved', disk: { present: false } }); cut.assertCurrent();
});

test('current local disk metadata tolerates live byte growth but refuses equal-byte inode substitution and never exports key bytes', async () => {
  const { ctx, machine } = await local(), cut = ctx.externalCustody(), path = join(machine, 'disk.qcow2');
  expect(JSON.stringify(cut.value)).not.toContain('PRIVATE_KEY_MARKER'); expect(cut.value.vm.local[0]).toMatchObject({ provisioned: true, disk: { present: true }, client: { present: true }, physicalSettlement: 'unobserved' });
  writeFileSync(path, 'Different live disk bytes and length.', { mode: 0o600 }); cut.assertCurrent();
  renameSync(path, path + '.old'); writeFileSync(path, readFileSync(path + '.old'), { mode: 0o600 }); unlinkSync(path + '.old');
  expect(() => cut.assertCurrent()).toThrow(expect.objectContaining({ code: 's16_ops_external_changed' }));
});

test.each(['missing-disk', 'corrupt-state', 'missing-state', 'state-inode', 'unowned-machine', 'unsafe-mode'] as const)('incomplete or unsafe %s custody refuses without repair or effects', async kind => {
  const { ctx, machine } = await local(), cut = ctx.externalCustody();
  if (kind === 'missing-disk') unlinkSync(join(machine, 'disk.qcow2'));
  if (kind === 'corrupt-state') writeFileSync(join(machine, 'state.json'), '{}', { mode: 0o600 });
  if (kind === 'missing-state') { unlinkSync(join(machine, 'state.json')); const vm = ctx.runtime.sources.find(row => row.name === 'vm.sqlite')!.database; vm.query('INSERT INTO vm_registry VALUES (?,?)').run('working', JSON.stringify({ id: 'working', generation: 1, managerId: 'manager_original', state: 'ready' })); }
  if (kind === 'state-inode') { const path = join(machine, 'state.json'), bytes = readFileSync(path); renameSync(path, path + '.old'); writeFileSync(path, bytes, { mode: 0o600 }); unlinkSync(path + '.old'); }
  if (kind === 'unowned-machine') opsDirectory(join(machine, '..', 'unowned'));
  if (kind === 'unsafe-mode') chmodSync(join(machine, 'disk.qcow2'), 0o666);
  expect(() => cut.assertCurrent()).toThrow(); expect(existsSync(machine)).toBe(true);
});
