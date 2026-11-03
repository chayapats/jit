import { expect, test } from 'bun:test';
import { createVmManagementRelay, RemoteVmManagement } from '../src/s15/vm/remote';
import type { VmManagement } from '../src/s15/vm';
test('protected one-VM relay authenticates exact calls and cannot execute arbitrary commands or select another VM', async () => {
  const calls: string[] = [], credential = crypto.randomUUID().replaceAll('-', '');
  const state = { state: 'running' as const, identity: 'fixture', boot: 'boot', cpuCount: 2, memoryBytes: 1000, diskBytes: 1000, network: 'isolated' as const };
  const manager: VmManagement = { async inspect() { return state; }, async start() { calls.push('start'); }, async stop() { calls.push('stop'); }, async snapshot(name) { calls.push(name); }, async restore() {}, async retireSnapshot() {} };
  const relay = createVmManagementRelay(manager, credential);
  try {
    const remote = new RemoteVmManagement({ origin: relay.origin, credential: () => credential, allowLoopback: true });
    expect(await remote.inspect()).toEqual(state); await remote.snapshot('jit-' + 'a'.repeat(32)); expect(calls).toHaveLength(1);
    for (const input of [{ operation: 'exec', argv: ['sh'] }, { operation: 'stop', vm: 'other' }, { operation: 'snapshot', snapshot: '../../other' }]) {
      const response = await fetch(relay.origin + '/v1/management', { method: 'POST', headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' }, body: JSON.stringify(input) }); expect(response.ok).toBe(false);
    }
    expect((await fetch(relay.origin + '/v1/management', { method: 'POST', body: '{}' })).status).toBe(401);
    expect(calls).toHaveLength(1);
  } finally { relay.close(); }
});
