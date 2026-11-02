import { timingSafeEqual } from 'node:crypto';
import { vmFail, vmRecord } from './validation';
import type { VmMachineState, VmManagement } from './types';
import { registerSecretFingerprint } from '../../security/secret-fingerprints';

/** Fixed protected management relay. Transport authentication and firewalling are outside the working VM. */
export class RemoteVmManagement implements VmManagement {
  constructor(readonly options: { origin: string; credential(): string; fetch?: typeof fetch; allowLoopback?: boolean }) {
    const url = new URL(options.origin);
    if (url.origin !== options.origin || url.username || url.password || url.protocol !== 'https:' && !(options.allowLoopback && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) vmFail('vm_management_scope_denied');
  }
  private async call(operation: string, snapshot?: string): Promise<unknown> {
    const credential = this.options.credential(); registerSecretFingerprint(credential);
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(credential)) vmFail('vm_management_unavailable');
    const response = await (this.options.fetch ?? fetch)(this.options.origin + '/v1/management', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(360000), headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, ...(snapshot ? { snapshot } : {}) }) });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 16384) vmFail('vm_management_unavailable');
    const reader = response.body?.getReader(); if (!reader) vmFail('vm_management_unavailable'); let text = '';
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); if (Buffer.byteLength(text) > 16384) { await reader.cancel(); vmFail('vm_management_unavailable'); } } } finally { reader.releaseLock(); }
    try { const value = JSON.parse(text); vmRecord(value, ['result']); return value.result; } catch { vmFail('vm_management_unavailable'); }
  }
  /** Management facts originate at the actual hypervisor adapter; enrollment independently binds the SSH endpoint/NIC. */
  async inspect(): Promise<VmMachineState> { return await this.call('inspect') as VmMachineState; }
  async start(): Promise<void> { await this.call('start'); }
  async stop(): Promise<void> { await this.call('stop'); }
  async snapshot(name: string): Promise<void> { await this.call('snapshot', name); }
  async restore(name: string): Promise<void> { await this.call('restore', name); }
  async retireSnapshot(name: string): Promise<void> { await this.call('retire', name); }
}

/**
 * Loopback-only, one-VM relay for a protected SSH tunnel. No arbitrary argv, endpoint, VM selector,
 * credential read or guest input is accepted. Do not expose this listener on a working network.
 */
export function createVmManagementRelay(manager: VmManagement, credential: string) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(credential)) vmFail('vm_management_unavailable'); registerSecretFingerprint(credential);
  let busy = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    try {
      const supplied = request.headers.get('authorization') ?? '', expected = 'Bearer ' + credential;
      if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return new Response(null, { status: 401 });
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/management' || request.headers.get('content-type') !== 'application/json' || busy) return new Response(null, { status: 409 });
      busy = true;
      try {
        const reader = request.body?.getReader(); if (!reader) vmFail('vm_management_unavailable'); const chunks = []; let size = 0;
        try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 1024) { await reader.cancel(); vmFail('vm_management_unavailable'); } chunks.push(chunk.value); } } finally { reader.releaseLock(); }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8')); vmRecord(input, ['operation'], ['snapshot']);
        if (!['inspect', 'start', 'stop', 'snapshot', 'restore', 'retire'].includes(input.operation) || (['snapshot', 'restore', 'retire'].includes(input.operation) ? typeof input.snapshot !== 'string' || !/^jit-[a-f0-9]{32}$/.test(input.snapshot) : input.snapshot !== undefined)) vmFail('vm_management_scope_denied');
        const result = input.operation === 'inspect' ? await manager.inspect() : input.operation === 'start' ? await manager.start?.() : input.operation === 'stop' ? await manager.stop() : input.operation === 'snapshot' ? await manager.snapshot(input.snapshot) : input.operation === 'restore' ? await manager.restore(input.snapshot) : await manager.retireSnapshot(input.snapshot);
        return Response.json({ result: result ?? null }, { headers: { 'Cache-Control': 'no-store' } });
      } finally { busy = false; }
    } catch { return Response.json({ error: 'vm_management_unavailable' }, { status: 503 }); }
  } });
  return { origin: server.url.origin, close: () => server.stop(true) };
}
