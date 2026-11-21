import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import type { Database } from 'bun:sqlite';
import { AppError } from '../../errors';
import { opsPath, opsRead } from '../../s14/ops-files';
import type { S15RuntimeConfig } from '../../s15/runtime-config';
import { vmCanonical, vmEndpoint, vmId, vmInteger, vmRecord } from '../../s15/vm/validation';
import { validateVmm, vmmLayout } from '../../s15/vm/vmm';
import { assertS16ExclusiveInstallationLease, type S16InstallationLease } from './installation-lease';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function refuse(code = 's16_ops_external_custody_invalid'): never { throw new AppError(code, 409); }
type RetainedEntry = Readonly<{ present: boolean; identity: string | null }>;
interface Manager { id: string; kind: 'qemu' | 'lima' | 'proxmox' | 'firecracker'; sha256: string }
interface Registration { id: string; generation: number; managerId: string | null; state: string; sha256: string; credentials: { identity: RetainedEntry; knownHosts: RetainedEntry } }
interface Local { managerId: string; name: string; stateSha256: string | null; stateIdentity: string | null; provisioned: boolean | null; controller: RetainedEntry; physical: RetainedEntry; disk: RetainedEntry; seed: RetainedEntry; client: RetainedEntry; knownHosts: RetainedEntry; physicalSettlement: 'unobserved' }
/** Current references only. Credentials, mutable disks, profiles and remote device storage remain separate. */
export interface S16ExternalCustody {
  contract: 's16-external-custody/v1'; installationId: string; configurationSha256: string;
  client: { contract: 's16-client-bootstrap/v1'; ownerIdentity: string; ownerGeneration: number | null; serviceOriginSha256: string; deviceStorage: 'retain_current_or_owner_reconnect' };
  retained: { vault: RetainedEntry; sshKeys: RetainedEntry; profiles: RetainedEntry; browserEngine: RetainedEntry; vapid: RetainedEntry; notificationSubscriptions: number; credentials: 'retain_current_or_owner_reconnect' };
  vm: { configurationSha256: string; configuredManager: { kind: 'remote' | 'lima'; sha256: string } | null; managers: readonly Readonly<Manager>[]; registrations: readonly Readonly<Registration>[]; snapshots: readonly Readonly<{ id: string; vmId: string; generation: number }>[]; roots: { controller: RetainedEntry; machines: RetainedEntry; vmm: RetainedEntry; physicalMachines: RetainedEntry }; local: readonly Readonly<Local>[]; physicalSettlement: 'unobserved'; workingDisks: 'retain_current_only' };
}
/** Revalidation retains the exact original hash; it cannot accept newer references as the old cut. */
export interface S16ExternalObservation { readonly value: Readonly<S16ExternalCustody>; readonly sha256: string; assertCurrent(): void }
/** Only trusted current-control composition supplies these paths, readers and actual exclusions. */
export interface S16ExternalCustodyOwner { config: S15RuntimeConfig; ownerIdentity: string; owner: Database; vm: Database; notifications?: Database; lease: S16InstallationLease; guard(): void }

function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }
function stat(path: string, directory: boolean, uid: number, groupReadable = false): BigIntStats | null {
  opsPath(path); const value = lstatSync(path, { bigint: true, throwIfNoEntry: false }); if (!value) return null;
  const mask = directory ? groupReadable ? 0o5027n : 0o7077n : groupReadable ? 0o7137n : 0o7177n;
  if (value.uid !== BigInt(uid) || value.isSymbolicLink() || (directory ? !value.isDirectory() : !value.isFile() || value.nlink !== 1n) || value.mode & mask) refuse('s16_ops_external_path_untrusted'); return value;
}
function retained(path: string, directory: boolean, uid: number, groupReadable = false, mutable = false): RetainedEntry {
  const s = stat(path, directory, uid, groupReadable);
  return { present: s !== null, identity: s ? hash(JSON.stringify([String(s.dev), String(s.ino), String(s.uid), String(s.gid), String(s.mode), ...(!directory ? [String(s.nlink), ...(mutable ? [] : [String(s.size), String(s.mtimeNs), String(s.ctimeNs)])] : [])])) : null };
}
function jsonRows(db: Database, table: 'vm_managers' | 'vm_registry', count: number, bytes: number): { id: string; value: Record<string, unknown>; sha256: string }[] {
  if (!db.query("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?").get(table)) { if (table === 'vm_managers') return []; return refuse(); }
  const b = db.query<{ n: number; bytes: number; invalid: number }, []>(`SELECT count(*) n,coalesce(sum(length(CAST(data AS BLOB))),0) bytes,coalesce(sum(typeof(id)<>'text' OR length(CAST(id AS BLOB)) NOT BETWEEN 1 AND 128 OR typeof(data)<>'text' OR length(CAST(data AS BLOB))>131072 OR json_valid(data)=0),0) invalid FROM main.${table}`).get();
  if (!b || b.n > count || b.bytes > bytes || b.invalid) refuse('s16_ops_external_bounds');
  return db.query<{ id: string; data: Uint8Array }, []>(`SELECT id,CAST(data AS BLOB) data FROM main.${table} ORDER BY id LIMIT ${count + 1}`).all().map(row => {
    vmId(row.id); const raw = new TextDecoder('utf-8', { fatal: true }).decode(row.data), value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(); return { id: row.id, value, sha256: hash(row.data) };
  });
}
function managerKind(value: Record<string, unknown>): Manager['kind'] {
  if (value.kind === 'lima') { vmRecord(value, ['kind', 'instance']); if (typeof value.instance !== 'string' || !/^jit-work(?:-[a-z0-9-]+)?$/.test(value.instance)) refuse(); }
  else if (value.kind === 'proxmox') {
    vmRecord(value, ['kind', 'baseUrl', 'node', 'vmid', 'proxy']); const url = typeof value.baseUrl === 'string' ? new URL(value.baseUrl) : null;
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || typeof value.node !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.node)) refuse();
    vmInteger(value.vmid, 999999999); const proxy = vmRecord(value.proxy, ['address', 'port']); if (typeof proxy.address !== 'string' || !proxy.address || proxy.address.length > 253 || /[\s\x00-\x1f\x7f]/.test(proxy.address)) refuse(); vmInteger(proxy.port, 65535);
  } else if (value.kind === 'firecracker') {
    vmRecord(value, ['kind', 'origin', 'computerId', 'selectionSha256']); const url = typeof value.origin === 'string' ? new URL(value.origin) : null;
    if (!url || url.origin !== value.origin || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || typeof value.computerId !== 'string' || !/^jit-work(?:-[a-z0-9-]{1,54})?$/.test(value.computerId) || typeof value.selectionSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.selectionSha256)) refuse();
  } else if (value.kind === 'qemu') {
    vmRecord(value, ['kind', 'name', 'architecture', 'mac', 'sshPort', 'resources'], ['forVm']);
    if (typeof value.name !== 'string' || !/^jit-work-[a-f0-9]{12}$/.test(value.name) || !['x86_64', 'aarch64'].includes(value.architecture as string) || typeof value.mac !== 'string' || !/^52:54:00(?::[a-f0-9]{2}){3}$/.test(value.mac)) refuse();
    vmInteger(value.sshPort, 65535, 1024); const r = vmRecord(value.resources, ['cpus', 'memoryMiB', 'diskGiB']); for (const n of Object.values(r)) vmInteger(n, 4194304); if (value.forVm !== undefined) vmId(value.forVm);
  } else return refuse('s16_ops_external_backend_unsupported');
  return value.kind;
}
function state(path: string, uid: number): { sha256: string; identity: string; provisioned: boolean } | null {
  const before = retained(path, false, uid); if (!before.present) return null; const entry = stat(path, false, uid)!; if (entry.size > 4096n) refuse('s16_ops_external_bounds');
  const bytes = opsRead(path, 4096), value = vmRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), ['provisioned', 'desired', 'pid', 'startTicks'], ['appliedDiskGiB']);
  if (typeof value.provisioned !== 'boolean' || !['running', 'stopped'].includes(value.desired as string) || value.pid !== null && (!Number.isSafeInteger(value.pid) || Number(value.pid) < 1) || value.startTicks !== null && (typeof value.startTicks !== 'string' || !/^[0-9]{1,32}$/.test(value.startTicks)) || value.appliedDiskGiB !== undefined && value.appliedDiskGiB !== null && (!Number.isSafeInteger(value.appliedDiskGiB) || Number(value.appliedDiskGiB) < 1)) refuse();
  if (vmCanonical(before) !== vmCanonical(retained(path, false, uid))) refuse('s16_ops_external_changed'); return { sha256: hash(bytes), identity: before.identity!, provisioned: value.provisioned };
}
/** Reads the exact current backend/client/credential metadata without application recovery or physical effects. */
export function captureS16ExternalCustody(owner: S16ExternalCustodyOwner): S16ExternalObservation {
  const { config, vm } = owner, uid = process.getuid?.(); if (uid === undefined) refuse();
  const guard = () => { assertS16ExclusiveInstallationLease(owner.lease, config.directory); if ((owner.guard() as unknown) !== undefined) refuse('s16_ops_guard_invalid'); }; guard();
  const collect = (): S16ExternalCustody => {
    guard(); if (vm.inTransaction || owner.owner.inTransaction || owner.notifications?.inTransaction) refuse();
    const roots = join(config.directory, 'runtime'), managerRows = jsonRows(vm, 'vm_managers', 64, 8388608), registrationRows = jsonRows(vm, 'vm_registry', 256, 16777216);
    const managers = managerRows.map(row => ({ id: row.id, kind: managerKind(row.value), sha256: row.sha256 })), managerIds = new Set(managers.map(row => row.id));
    const configuredManager = config.vm.remote ? { kind: 'remote' as const, sha256: hash(vmCanonical(config.vm.remote)) } : config.vm.limaInstance ? { kind: 'lima' as const, sha256: hash(vmCanonical({ instance: config.vm.limaInstance })) } : null;
    if (configuredManager) { if (managerIds.has('working')) refuse(); managerIds.add('working'); }
    const registrations: Registration[] = registrationRows.map(row => {
      const v = row.value; if (v.id !== row.id || !Number.isSafeInteger(v.generation) || Number(v.generation) < 1 || v.managerId !== null && (typeof v.managerId !== 'string' || !managerIds.has(v.managerId)) || !['ready', 'unproven', 'uncertain', 'stopped'].includes(v.state as string)) refuse();
      const endpoint = vmEndpoint(v.endpoint as Parameters<typeof vmEndpoint>[0]);
      for (const path of [endpoint.identityFile, endpoint.knownHostsFile]) if (!isAbsolute(path) || normalize(path) !== path) refuse();
      return { id: row.id, generation: v.generation as number, managerId: v.managerId as string | null, state: v.state as string, sha256: row.sha256, credentials: { identity: retained(endpoint.identityFile, false, uid), knownHosts: retained(endpoint.knownHostsFile, false, uid) } };
    });
    if (vm.query('SELECT 1 FROM main.vm_sessions s LEFT JOIN main.vm_registry r ON r.id=s.vm_id WHERE r.id IS NULL OR s.generation<1 OR s.generation>json_extract(r.data,\'$.generation\') LIMIT 1').get()) refuse('s16_ops_external_continuity_missing');
    const bound = vm.query<{ n: number; invalid: number }, []>("SELECT count(*) n,coalesce(sum(typeof(id)<>'text' OR length(CAST(id AS BLOB)) NOT BETWEEN 1 AND 128 OR typeof(vm_id)<>'text' OR length(CAST(vm_id AS BLOB)) NOT BETWEEN 1 AND 128 OR typeof(generation)<>'integer' OR generation<1),0) invalid FROM main.vm_snapshots").get();
    if (!bound || bound.n > 4096 || bound.invalid) refuse('s16_ops_external_bounds');
    const registrationsById = new Map(registrations.map(row => [row.id, row]));
    const snapshots = vm.query<{ id: string; vmId: string; generation: number }, []>('SELECT id,vm_id vmId,generation FROM main.vm_snapshots ORDER BY id LIMIT 4097').all();
    for (const s of snapshots) { vmId(s.id); vmId(s.vmId); vmInteger(s.generation); if (!registrationsById.has(s.vmId) || s.generation > registrationsById.get(s.vmId)!.generation) refuse(); }
    const qemu = managerRows.filter(row => row.value.kind === 'qemu'); if (qemu.length && !config.vm.local) refuse('s16_ops_external_local_config_required');
    const localRoot = join(roots, 'vm-local'), machines = join(localRoot, 'machines'), vmm = config.vm.vmm ? validateVmm(config.vm.vmm) : undefined, physicalMachines = vmm ? vmmLayout(vmm.directory).machines : machines;
    const names = qemu.map(row => row.value.name as string); if (new Set(names).size !== names.length) refuse();
    const checkNames = (path: string, expectedUid: number, group = false) => { if (!stat(path, true, expectedUid, group)) return; const all = readdirSync(path); if (all.length > 64 || all.some(name => !names.includes(name))) refuse('s16_ops_external_inventory_changed'); };
    const controllerRoot = retained(localRoot, true, uid), machineRoot = retained(machines, true, uid); checkNames(machines, uid);
    if (vmm) { if (!stat(vmm.directory, true, 0, true) && qemu.length) refuse(); checkNames(physicalMachines, vmm.uid, true); }
    const local: Local[] = qemu.map(row => {
      const name = row.value.name as string, controllerPath = join(machines, name), physicalPath = join(physicalMachines, name), controller = retained(controllerPath, true, uid), physical = retained(physicalPath, true, vmm?.uid ?? uid, !!vmm);
      const saved = state(join(controllerPath, 'state.json'), uid), disk = retained(join(physicalPath, 'disk.qcow2'), false, vmm?.uid ?? uid, !!vmm, true), seed = retained(join(physicalPath, 'seed.img'), false, vmm?.uid ?? uid, !!vmm, true);
      const enrolled = registrations.some(reg => reg.managerId === row.id);
      if (physical.present && !controller.present || (enrolled || saved?.provisioned) && (!controller.present || !saved || !physical.present || !disk.present)) refuse('s16_ops_external_continuity_missing');
      return { managerId: row.id, name, stateSha256: saved?.sha256 ?? null, stateIdentity: saved?.identity ?? null, provisioned: saved?.provisioned ?? null, controller, physical, disk, seed, client: retained(join(controllerPath, 'client'), false, uid), knownHosts: retained(join(controllerPath, 'known_hosts'), false, uid), physicalSettlement: 'unobserved' };
    });
    // The local root is guarded even before a manager is registered; it never initializes missing state.
    if (vmCanonical(controllerRoot) !== vmCanonical(retained(localRoot, true, uid))) refuse('s16_ops_external_changed');
    const owners = owner.owner.query<{ generation: number }, []>('SELECT generation FROM owner LIMIT 2').all();
    if (owners.length > 1 || owners.some(row => !Number.isSafeInteger(row.generation) || row.generation < 1)) refuse();
    let subscriptions = 0;
    if (owner.notifications) { const n = owner.notifications.query<{ n: number }, []>('SELECT count(*) n FROM main.subscriptions_v1').get(); if (!n || n.n > 4096) refuse('s16_ops_external_bounds'); subscriptions = n.n; }
    const vapidPath = join(roots, 'notifications-vapid.key'), vapid = retained(vapidPath, false, uid); if (vapid.present && stat(vapidPath, false, uid)!.size !== 32n || subscriptions && !vapid.present) refuse('s16_ops_external_notification_key_missing');
    const value: S16ExternalCustody = { contract: 's16-external-custody/v1', installationId: config.installationId, configurationSha256: hash(vmCanonical(config)),
      client: { contract: 's16-client-bootstrap/v1', ownerIdentity: owner.ownerIdentity, ownerGeneration: owners[0]?.generation ?? null, serviceOriginSha256: hash(config.origin), deviceStorage: 'retain_current_or_owner_reconnect' },
      retained: { vault: retained(join(config.directory, 'vault'), true, uid), sshKeys: retained(join(roots, 'vm-keys'), true, uid), profiles: retained(join(roots, 'profiles'), true, uid), browserEngine: retained(join(config.directory, 'browser-engine'), true, uid), vapid, notificationSubscriptions: subscriptions, credentials: 'retain_current_or_owner_reconnect' },
      vm: { configurationSha256: hash(vmCanonical(config.vm)), configuredManager, managers, registrations, snapshots, roots: { controller: controllerRoot, machines: machineRoot, vmm: vmm ? retained(vmm.directory, true, 0, true) : { present: false, identity: null }, physicalMachines: retained(physicalMachines, true, vmm?.uid ?? uid, !!vmm) }, local, physicalSettlement: 'unobserved', workingDisks: 'retain_current_only' } };
    guard(); if (Buffer.byteLength(vmCanonical(value)) > 4194304) refuse('s16_ops_external_bounds'); return freeze(value);
  };
  const value = collect(), sha256 = hash(vmCanonical(value));
  return Object.freeze({ value, sha256, assertCurrent() { if (hash(vmCanonical(collect())) !== sha256) refuse('s16_ops_external_changed'); } });
}
