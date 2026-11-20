import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../../../errors';
import { registerSecretFingerprint } from '../../../security/secret-fingerprints';
import { vmPhysicalBinding } from '../binding';
import type { VmMachineState } from '../types';
import { vmCanonical, vmInteger, vmRecord } from '../validation';
import { firecrackerHostCommand, type FirecrackerHostCommand, type FirecrackerHostJob, type FirecrackerJobComputer } from './jobs';
import type { FirecrackerHostRuntime } from './runtime';

/** Protected one-computer RPC, not a model tool, public host service or authority-bearing export. */
export type FirecrackerRpcInput = { contract: 's16-firecracker-management/v1'; installationId: string } & (
  { operation: 'state' } | { operation: 'submit'; command: FirecrackerHostCommand } | { operation: 'receipt' | 'reconcile'; requestId: string }
);
/** Credential-free authenticated host facts. A fixture cannot be accepted as a native installation. */
export interface FirecrackerRpcState { computer: FirecrackerJobComputer; machine: VmMachineState | null; basis: 'protected_host' | 'protocol_fixture' }
export interface FirecrackerRpcScope { computerId: string; selectionSha256: string; basis: FirecrackerRpcState['basis'] }
function fail(): never { throw new AppError('vm_firecracker_management_unavailable', 503); }
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const same = (a: unknown, b: unknown) => vmCanonical(a) === vmCanonical(b);

/** Closed response validation before the controller can publish an authenticated host observation. */
export function firecrackerRpcState(value: unknown, scope: FirecrackerRpcScope): FirecrackerRpcState {
  const r = vmRecord(value, ['computer', 'machine', 'basis']), c = vmRecord(r.computer, ['id', 'selectionSha256', 'diskBytes', 'basis', 'revision', 'state', 'launchId', 'activeRequestId']);
  if (r.basis !== scope.basis || c.basis !== scope.basis || c.id !== scope.computerId || c.selectionSha256 !== scope.selectionSha256 || !['unverified', 'running', 'stopped', 'busy', 'uncertain'].includes(c.state as string) || c.launchId !== null && !uuid(c.launchId) || c.activeRequestId !== null && !uuid(c.activeRequestId)) return fail();
  vmInteger(c.revision); vmInteger(c.diskBytes, 64 * 1073741824, 128 * 1048576);
  if ((c.activeRequestId !== null) !== ['busy', 'uncertain'].includes(c.state as string) || r.machine === null && c.activeRequestId === null) return fail();
  if (r.machine !== null) {
    const m = vmRecord(r.machine, ['state', 'identity', 'boot', 'cpuCount', 'memoryBytes', 'diskBytes', 'network', 'binding'], ['sshEndpoint']);
    const binding = vmPhysicalBinding({ binding: m.binding as NonNullable<VmMachineState['binding']> });
    if (c.activeRequestId !== null || m.state !== c.state || !['running', 'stopped'].includes(m.state as string) || m.identity !== `firecracker:${scope.computerId}` || m.diskBytes !== c.diskBytes || binding?.kind !== 'firecracker-vsock' || binding.instanceId !== scope.computerId || binding.selectionSha256 !== scope.selectionSha256) return fail();
    vmInteger(m.cpuCount, 32); vmInteger(m.memoryBytes, 64 * 1073741824);
    if (m.state === 'stopped') { if (m.boot !== 'stopped' || m.network !== 'unproven' || m.sshEndpoint !== undefined) return fail(); }
    else {
      const endpoint = vmRecord(m.sshEndpoint, ['host', 'port']);
      if (c.launchId === null || m.network !== 'isolated' || typeof m.boot !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[1-9][0-9]{0,19}$/.test(m.boot) || endpoint.host !== '127.0.0.1') return fail(); vmInteger(endpoint.port, 65535);
    }
  }
  return structuredClone(value) as FirecrackerRpcState;
}
/** Original scope/command/revision and observation shape must agree before a client clears uncertainty. */
export function firecrackerRpcReceipt(value: unknown, scope: FirecrackerRpcScope, original?: FirecrackerHostCommand): FirecrackerHostJob {
  const r = vmRecord(value, ['command', 'revision', 'state', 'observation']), command = firecrackerHostCommand(r.command);
  if (command.computerId !== scope.computerId || command.selectionSha256 !== scope.selectionSha256 || original && !same(command, original) || r.revision !== command.expectedRevision + 1 || !['accepted', 'dispatched', 'unknown', 'committed', 'not_sent'].includes(r.state as string)) return fail();
  if (r.state === 'committed') {
    const o = vmRecord(r.observation, ['state', 'launchId', 'basis'], ['snapshot']);
    if (o.basis !== scope.basis || !['running', 'stopped'].includes(o.state as string) || o.launchId !== null && !uuid(o.launchId) || (command.kind === 'launch' || command.kind === 'checkpoint' && o.state === 'running' ? o.launchId !== command.requestId : o.launchId !== command.expectedLaunchId) || command.kind === 'launch' && o.state !== 'running' || ['stop', 'restore'].includes(command.kind) && o.state !== 'stopped') return fail();
    if (command.kind === 'checkpoint') { const s = vmRecord(o.snapshot, ['id', 'sha256', 'bytes']); if (s.id !== command.snapshotId || typeof s.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(s.sha256)) return fail(); vmInteger(s.bytes, 64 * 1073741824, 128 * 1048576); }
    else if (o.snapshot !== undefined) return fail();
  } else if (r.observation !== null) return fail();
  return structuredClone(value) as FirecrackerHostJob;
}

/**
 * Loopback-only authenticated root-helper listener. One installation and computer are fixed by source
 * composition. Four finite requests can observe one retained mutation; transport loss never cancels or
 * replays it. No root path, process selector, shell or private journal context is a protocol operation.
 */
export function createFirecrackerManagementRelay(runtime: FirecrackerHostRuntime, options: { credential: string; installationId: string; port: number }) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.credential) || !/^[A-Za-z0-9_-]{1,128}$/.test(options.installationId) || !Number.isSafeInteger(options.port) || options.port < (runtime.basis === 'protocol_fixture' ? 0 : 1) || options.port > 65535) return fail();
  const expected = Buffer.from(`Bearer ${options.credential}`), installationId = options.installationId; registerSecretFingerprint(options.credential); let active = 0;
  const response = (value: unknown, status = 200) => { const json = vmCanonical(value); if (Buffer.byteLength(json) > 16384) return fail(); return new Response(json, { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); };
  const server = Bun.serve({ hostname: '127.0.0.1', port: options.port, maxRequestBodySize: 4096, idleTimeout: 10, async fetch(request) {
    const supplied = Buffer.from(request.headers.get('authorization') ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return new Response(null, { status: 401 });
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/v1/firecracker' || url.search || request.headers.get('content-type') !== 'application/json') return new Response(null, { status: 400 });
    if (active >= 4) return new Response(null, { status: 409 }); active++;
    const reader = request.body?.getReader(), expired = Promise.withResolvers<never>(), timer = setTimeout(() => expired.reject(new AppError('vm_firecracker_management_unavailable', 503)), 5000);
    try {
      if (!reader) return fail(); const chunks: Uint8Array[] = []; let size = 0;
      for (;;) { const next = await Promise.race([reader.read(), expired.promise]); if (next.done) break; size += next.value.length; if (size > 4096) return fail(); chunks.push(next.value); }
      clearTimeout(timer);
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), r = vmRecord(value, ['contract', 'installationId', 'operation'], ['command', 'requestId']);
      if (r.contract !== 's16-firecracker-management/v1' || r.installationId !== installationId) return fail();
      let result: unknown;
      if (r.operation === 'state') {
        if (r.command !== undefined || r.requestId !== undefined) return fail();
        const machine = runtime.current().activeRequestId ? null : await runtime.inspect(); result = { computer: runtime.current(), machine, basis: runtime.basis };
      } else if (r.operation === 'submit') {
        if (r.requestId !== undefined || r.command === undefined) return fail(); result = await runtime.submit(firecrackerHostCommand(r.command));
      } else if (r.operation === 'receipt' || r.operation === 'reconcile') {
        if (r.command !== undefined || !uuid(r.requestId)) return fail(); result = r.operation === 'receipt' ? runtime.receipt(r.requestId) : await runtime.reconcile(r.requestId);
      } else return fail();
      return response({ contract: 's16-firecracker-management/v1', result });
    } catch { return response({ contract: 's16-firecracker-management/v1', error: 'vm_firecracker_management_unavailable' }, 503); }
    finally { clearTimeout(timer); if (reader) void reader.cancel().catch(() => {}); active--; }
  } });
  return { origin: server.url.origin, close: () => server.stop(true) };
}
