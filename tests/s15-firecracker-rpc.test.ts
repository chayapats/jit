import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { FirecrackerVmManagement, type FirecrackerClientOptions } from '../src/s15/vm/firecracker/client';
import { createFirecrackerManagementRelay, firecrackerRpcState } from '../src/s15/vm/firecracker/rpc';
import { firecrackerRuntimeFixture } from './fixtures/s15-firecracker-runtime';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const credential = 'root_controller_only_' + 'a'.repeat(32), installationId = 'installation-firecracker-rpc';
async function fixture(custom?: (real: typeof fetch) => typeof fetch) {
  const f = await firecrackerRuntimeFixture(); cleanup.push(() => f.close());
  const relay = createFirecrackerManagementRelay(f.runtime(), { credential, installationId, port: 0 }); cleanup.push(() => relay.close());
  const calls: string[] = [];
  const real = (async (input, init) => { calls.push(JSON.parse(String(init?.body)).operation); return fetch(input, init); }) as typeof fetch;
  const options: FirecrackerClientOptions = { path: f.path + '.client', create: true, installationId, origin: relay.origin, computerId: f.runtime().computerId, selectionSha256: f.runtime().selectionSha256, credential: () => credential, fixture: { basis: 'protocol_fixture' }, fetch: custom ? custom(real) : real };
  let client = new FirecrackerVmManagement(options); cleanup.push(() => client.close());
  return { ...f, relay, calls, options, client: () => client,
    reopen(extra: Partial<FirecrackerClientOptions> = {}) { client.close(); client = new FirecrackerVmManagement({ ...options, create: false, ...extra }); return client; } };
}

test('actual VmManagement client crosses authenticated RPC into launch/work endpoint/checkpoint/restore/retire', async () => {
  const f = await fixture(), client = f.client(), tag = `jit-${'d'.repeat(32)}`;
  expect((await client.inspect()).state).toBe('stopped'); await client.start(); const first = await client.inspect(); expect(first.state).toBe('running'); expect(first.sshEndpoint).toBeDefined();
  await client.snapshot(tag); const resumed = await client.inspect(); expect(resumed.boot).not.toBe(first.boot); await client.restore(tag); expect((await client.inspect()).state).toBe('stopped');
  await client.retireSnapshot(tag); expect(f.starts()).toBe(2); expect(f.counters().signals).toBe(2);
  expect(f.calls.filter(call => call === 'submit')).toHaveLength(4); expect(readFileSync(f.options.path).includes(Buffer.from(credential))).toBe(false);
});

test('lost RPC reply survives actual client-journal restart and reads its original receipt without mutation replay', async () => {
  let lost = true; const f = await fixture(real => (async (input, init) => {
    const response = await real(input, init);
    if (lost && JSON.parse(String(init?.body)).operation === 'submit') { lost = false; await response.arrayBuffer(); throw Error('PRIVATE_TRANSPORT_DIAGNOSTIC'); }
    return response;
  }) as typeof fetch);
  await expect(f.client().start()).rejects.toMatchObject({ code: 'vm_reconciliation_required' }); expect(f.starts()).toBe(1);
  const client = f.reopen(); expect((await client.inspect()).state).toBe('running'); await client.start();
  expect(f.calls.filter(call => call === 'submit')).toHaveLength(1); expect(f.calls).toContain('receipt'); expect(f.starts()).toBe(1);
});

test('an idle remote state cannot clear a dispatched request that has not arrived yet', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), arrived = Promise.withResolvers<void>(); let delayed = true;
  const f = await fixture(real => (async (input, init) => {
    if (JSON.parse(String(init?.body)).operation === 'submit' && delayed) {
      delayed = false; entered.resolve(); await release.promise;
      const response = await real(input, { ...init, signal: null }); arrived.resolve(); return response;
    }
    return real(input, init);
  }) as typeof fetch);
  const client = f.reopen({ fixture: { basis: 'protocol_fixture', timeoutMs: 250 } }); const start = client.start(); await entered.promise;
  await expect(start).rejects.toMatchObject({ code: 'vm_reconciliation_required' }); expect(f.starts()).toBe(0);
  await expect(client.inspect()).rejects.toBeInstanceOf(Error); await expect(client.start()).rejects.toBeInstanceOf(Error); expect(f.starts()).toBe(0);
  release.resolve(); await arrived.promise;
  expect((await client.inspect()).state).toBe('running'); expect(f.starts()).toBe(1); expect(f.calls.filter(call => call === 'submit')).toHaveLength(1);
});

test('credentials, installation and body bounds reject real HTTP requests before a native command is admitted', async () => {
  const f = await fixture(), url = f.relay.origin + '/v1/firecracker', body = { contract: 's16-firecracker-management/v1', installationId, operation: 'state' };
  const request = (value: unknown, token = credential) => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  expect((await request(body, 'x'.repeat(32))).status).toBe(401);
  expect((await request({ ...body, installationId: 'other-installation' })).ok).toBe(false);
  expect((await request({ ...body, operation: 'shell', argv: ['ignored'] })).ok).toBe(false);
  expect((await request({ ...body, padding: 'x'.repeat(5000) })).ok).toBe(false);
  expect(f.starts()).toBe(0); expect(f.journal().db.query('SELECT * FROM fc_jobs').all()).toHaveLength(0);
});

test('configured native client rejects fixture basis and changed host identity before acquiring mutation intent', async () => {
  const f = await fixture(), { fixture: _fixture, ...native } = f.options; const client = new FirecrackerVmManagement({ ...native, path: native.path + '.native' }); cleanup.push(() => client.close());
  await expect(client.start()).rejects.toBeInstanceOf(Error); expect(f.starts()).toBe(0);
  client.close(); const changed = new FirecrackerVmManagement({ ...f.options, path: f.options.path + '.changed', selectionSha256: 'f'.repeat(64) }); cleanup.push(() => changed.close());
  await expect(changed.start()).rejects.toBeInstanceOf(Error); expect(f.starts()).toBe(0);
});

test('client journal process lease refuses a second controller and immutable binding refuses retargeting on reopen', async () => {
  const f = await fixture();
  expect(() => new FirecrackerVmManagement({ ...f.options, create: false })).toThrow(expect.objectContaining({ code: 'runtime_already_open' }));
  f.client().close(); expect(() => new FirecrackerVmManagement({ ...f.options, create: false, computerId: 'jit-work-other' })).toThrow(); expect(f.starts()).toBe(0);
});

test('a changed successful receipt cannot clear the original intent, which recovers only from its exact authenticated command', async () => {
  let changed = false;
  const f = await fixture(real => (async (input, init) => {
    const response = await real(input, init);
    if (!changed && JSON.parse(String(init?.body)).operation === 'submit') {
      changed = true; const value = await response.json() as any; value.result.command.expectedRevision++;
      return Response.json(value);
    }
    return response;
  }) as typeof fetch);
  await expect(f.client().start()).rejects.toMatchObject({ code: 'vm_reconciliation_required' }); expect(f.starts()).toBe(1);
  expect((await f.client().inspect()).state).toBe('running'); expect(f.calls.filter(call => call === 'submit')).toHaveLength(1);
});

test('deadline includes an unfinished actual response body and preserves the committed original effect for read-back', async () => {
  let stalled = false;
  const f = await fixture(real => (async (input, init) => {
    const response = await real(input, init);
    if (!stalled && JSON.parse(String(init?.body)).operation === 'submit') {
      stalled = true; await response.arrayBuffer();
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('{"contract":')); } }), { headers: { 'Content-Type': 'application/json' } });
    }
    return response;
  }) as typeof fetch);
  const client = f.reopen({ fixture: { basis: 'protocol_fixture', timeoutMs: 250 } });
  await expect(client.start()).rejects.toMatchObject({ code: 'vm_reconciliation_required' }); expect(f.starts()).toBe(1);
  expect((await client.inspect()).state).toBe('running'); expect(f.calls.filter(call => call === 'submit')).toHaveLength(1);
});

test.skipIf(process.platform !== 'linux' || process.getuid?.() === 0 || process.getgid?.() === 0)('native same-host schema refuses a declared controller identity different from the actual nonroot client', async () => {
  const f = await fixture();
  const response = await fetch(f.relay.origin + '/v1/firecracker', { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ contract: 's16-firecracker-management/v1', installationId, operation: 'state' }) });
  const data = (await response.json() as any).result;
  // Parser-only synthetic native metadata: this is not a Linux/KVM host attestation.
  data.basis = data.computer.basis = 'protected_host'; data.controller = { uid: process.getuid!(), gid: process.getgid!() };
  const scope = { computerId: f.runtime().computerId, selectionSha256: f.runtime().selectionSha256, basis: 'protected_host' as const };
  expect(firecrackerRpcState(data, scope).machine?.state).toBe('stopped'); data.controller.uid++;
  expect(() => firecrackerRpcState(data, scope)).toThrow(); expect(f.starts()).toBe(0);
});
