import { expect } from 'bun:test';
import { AppError } from '../../src/errors';
import { JitClient } from '../../src/s16/client';
import type { VmManagement, VmPhysicalBinding } from '../../src/s15/vm/types';
import { portableTreeHash, type PortableFile } from '../../src/s15/vm/portable-protocol';
import { vmCanonical, vmHash } from '../../src/s15/vm/validation';
import { composedFixture } from './s15-composition';

/** Real composed POLICY/TEAM/DATA15/VM/HTTP/client with an explicitly scripted guest and second VMM. */
export async function workingStateFixture() {
  let f!: Awaited<ReturnType<typeof composedFixture>>;
  const stages = new Map<string, { files: PortableFile[]; data: Map<string, Uint8Array>; committed: boolean }>();
  const binding: VmPhysicalBinding = { kind: 'firecracker-vsock', instanceId: 'jit-work-fixture', guestCid: 3, guestPort: 22, selectionSha256: 'a'.repeat(64) };
  const manager: VmManagement = { backend: { provider: 'firecracker', implementation: 'firecracker-offline-vsock/v1', apiVersion: '1.18.0', hypervisorVersion: '1.18.0', platform: null, basis: 'protocol_fixture', features: { shell: 'available', filesystem: 'available', sudo: 'available', externalNetwork: 'unavailable', browser: 'unavailable', desktop: 'unavailable', coldRecovery: 'available', strongStop: 'available' } }, async inspect() { return { state: 'running', identity: 'firecracker:fixture', boot: 'fixture-boot', cpuCount: 2, memoryBytes: 512 * 1048576, diskBytes: 128 * 1048576, network: 'isolated', binding, sshEndpoint: { host: '127.0.0.1', port: 22347 } }; }, async stop() {}, async snapshot() {}, async restore() {}, async retireSnapshot() {} };
  let hook: ((request: Record<string, unknown>, phase: 'before' | 'after') => void | Promise<void>) | null = null;
  f = await composedFixture('default', false, undefined, o => {
    const original = o.vm.transport!;
    return { ...o, files: { memory: true }, computers: { idleStopMs: 1800000, sweepMs: 0 }, vm: { ...o.vm, managers: new Map([...o.vm.managers, ['firecracker-fixture', manager]]), transport: row => {
      const transport = original(row), invoke = transport.invoke.bind(transport); Object.defineProperty(transport, 'endpoint', { value: row.endpoint });
      transport.invoke = async (request, settings) => {
        await hook?.(request, 'before'); settings.beforeStart();
        let result: Record<string, unknown>;
        if (request.op === 'spawn' && request.command === 'portable-fixture-task') {
          f.vmCalls.push('spawn'); f.files.set(`${request.root}/result.txt`, Buffer.from('portable result\n')); f.files.set(`${request.root}/src/note.md`, Buffer.from('reviewed note\n'));
          result = { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false, totalBytes: 0 };
        } else if (request.op === 'portable_read') {
          f.vmCalls.push('portable_read'); const bytes = f.files.get(String(request.path)); if (!bytes) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); result = { data: Buffer.from(bytes).toString('base64') };
        } else if (String(request.op).startsWith('portable_')) {
          const id = String(request.importId), files = request.files as PortableFile[], key = `${request.root}/restored-${id}`; f.vmCalls.push(String(request.op));
          if (portableTreeHash(files) !== request.treeSha256) throw new Error('fixture_manifest_changed');
          const stage = stages.get(id);
          if (request.op === 'portable_begin') { if (stage) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); stages.set(id, { files, data: new Map(), committed: false }); result = {}; }
          else if (request.op === 'portable_inspect') {
            const exact = !!stage?.committed && vmCanonical(stage.files) === vmCanonical(files) && files.every(file => { const bytes = f.files.get(key + '/' + file.path); return !!bytes && bytes.length === file.bytes && vmHash(bytes) === file.sha256; }); result = { path: exact ? key : null };
          } else {
            if (!stage || stage.committed || vmCanonical(stage.files) !== vmCanonical(files)) throw new Error('fixture_stage_changed');
            if (request.op === 'portable_put') { const path = String(request.relative), file = files.find(file => file.path === path), bytes = Buffer.from(String(request.data), 'base64'); if (!file || stage.data.has(path) || bytes.length !== file.bytes || vmHash(bytes) !== file.sha256) throw new Error('fixture_bytes_changed'); stage.data.set(path, bytes); result = {}; }
            else { if (!files.every(file => stage.data.has(file.path))) throw new Error('fixture_incomplete'); for (const file of files) f.files.set(key + '/' + file.path, stage.data.get(file.path)!); stage.committed = true; result = { path: key }; }
          }
        } else result = await invoke(request, settings);
        await hook?.(request, 'after'); return result;
      }; return transport;
    } } };
  });
  f.service.vmStore.enableVsockBindings(); const base = f.service.vmStore.registration('vm');
  const { bindingMac: _mac, ...withoutMac } = base;
  f.service.vmStore.save({ ...withoutMac, id: 'vm2', endpoint: { ...base.endpoint, host: '127.0.0.1', port: 22347 }, managerId: 'firecracker-fixture', machineIdentity: 'firecracker:fixture', boot: 'fixture-boot', binding });
  const client = new JitClient({ origin: 'http://localhost:3099', fetch: async request => f.request(new URL(request.url).pathname, request.method, request.method === 'POST' ? await request.json() : undefined) });
  await client.bootstrap();
  const source = async (requestId = 'portable_source') => { f.script = [{ type: 'tool_call', id: 'make', name: 'bash', arguments: { command: 'portable-fixture-task' } }]; const row = await f.chat('Create two ordinary result files on the working computer.', requestId); expect(row.state).toBe('completed'); return row.authority!.id; };
  return { f, client, source, stages, setHook(value: typeof hook) { hook = value; }, error: () => new AppError('vm_portable_fixture_unknown', 503) };
}
