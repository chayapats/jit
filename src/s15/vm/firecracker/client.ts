import { AppError } from '../../../errors';
import { registerSecretFingerprint } from '../../../security/secret-fingerprints';
import { DurableJournal } from '../../durable-journal';
import type { VmBackendProfile, VmMachineState, VmManagement } from '../types';
import { vmCanonical, vmInteger, vmRecord } from '../validation';
import { firecrackerHostCommand, type FirecrackerHostCommand, type FirecrackerHostJob } from './jobs';
import { firecrackerRpcReceipt, firecrackerRpcState, type FirecrackerRpcInput, type FirecrackerRpcScope, type FirecrackerRpcState } from './rpc';

/** Protected controller configuration. The credential is write-only setup data, never serialized here. */
export interface FirecrackerClientOptions {
  path: string; create: boolean; installationId: string; origin: string; computerId: string; selectionSha256: string;
  credential(): string; fetch?: typeof fetch;
  /** Test-only remote evidence allowance; never accepted from an owner/model setup payload. */
  fixture?: { basis: 'protocol_fixture'; timeoutMs?: number };
}
interface Intent { contract: 's16-firecracker-client-intent/v1'; command: FirecrackerHostCommand; state: 'accepted' | 'dispatched' | 'unknown' | 'committed' | 'not_sent'; receipt: FirecrackerHostJob | null }
function fail(code = 'vm_firecracker_management_unavailable'): never { throw new AppError(code, 503); }
const same = (a: unknown, b: unknown) => vmCanonical(a) === vmCanonical(b);

/**
 * Actual VmManagement adapter over the one-computer protected root RPC. A separate private journal
 * retains the exact original command before HTTP dispatch. Losing a reply or restarting the controller
 * permits only original receipt/read-back; it never sends the old mutation again. This does not bypass
 * ordinary Jit enrollment, current POLICY/session guards, SSH host-key pinning or private scope checks.
 */
export class FirecrackerVmManagement implements VmManagement {
  readonly #journal: DurableJournal;
  readonly #scope: FirecrackerRpcScope;
  readonly #origin: string;
  readonly #installation: string;
  readonly #credential: () => string;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;
  #closed = false;
  #released = false;
  #busy = false;
  #recovering: Promise<Intent | null> | null = null;
  /** The initial native relay and controller are on the same verified Linux host. Fixtures say so explicitly. */
  get backend(): VmBackendProfile {
    return { provider: 'firecracker', implementation: 'firecracker-offline-vsock/v1', apiVersion: '1.18.0', hypervisorVersion: '1.18.0',
      platform: this.#scope.basis === 'protocol_fixture' ? null : { os: 'linux', architecture: process.arch === 'arm64' ? 'aarch64' : 'x86_64' },
      basis: this.#scope.basis === 'protocol_fixture' ? 'protocol_fixture' : 'host_verified',
      features: { shell: 'available', filesystem: 'available', sudo: 'available', externalNetwork: 'unavailable', browser: 'unavailable', desktop: 'unavailable', coldRecovery: 'available', strongStop: 'available' } };
  }
  constructor(options: FirecrackerClientOptions) {
    if (!options.fixture && (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) || !process.getuid?.() || !process.getgid?.())) fail('vm_host_unsupported');
    const url = new URL(options.origin);
    if (url.origin !== options.origin || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || !/^jit-work(?:-[a-z0-9-]{1,54})?$/.test(options.computerId) || !/^[a-f0-9]{64}$/.test(options.selectionSha256) || options.fixture && options.fixture.basis !== 'protocol_fixture') fail();
    this.#origin = url.origin; this.#installation = options.installationId; this.#credential = options.credential; this.#fetch = options.fetch ?? fetch; this.#timeout = options.fixture?.timeoutMs ?? 360000; vmInteger(this.#timeout, 360000);
    this.#scope = { computerId: options.computerId, selectionSha256: options.selectionSha256, basis: options.fixture ? 'protocol_fixture' : 'protected_host' };
    this.#journal = new DurableJournal(options.path, options.installationId, options.create, 0x4a46434a, { records: 256, bytes: 64 * 1048576 });
    try {
      const binding = { contract: 's16-firecracker-client-binding/v1', origin: this.#origin, ...this.#scope };
      if (options.create) { this.#journal.put('binding', binding); this.#journal.put('active', { requestId: null }); }
      else if (!same(this.#journal.get('binding'), binding)) fail();
      this.#journal.tx(() => {
        const active = this.#active(); if (!active) return; const intent = this.#intent(active);
        if (intent.state === 'accepted') { intent.state = 'not_sent'; this.#journal.put(active, intent); this.#journal.put('active', { requestId: null }); }
        else if (intent.state === 'dispatched') { intent.state = 'unknown'; this.#journal.put(active, intent); }
      });
    } catch (error) { this.#journal.close(); throw error; }
  }
  #current(): void { if (this.#closed) fail(); }
  #active(): string | null { const r = vmRecord(this.#journal.get('active'), ['requestId']); if (r.requestId !== null && (typeof r.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(r.requestId))) return fail(); return r.requestId as string | null; }
  #intent(id: string): Intent {
    const r = vmRecord(this.#journal.get(id), ['contract', 'command', 'state', 'receipt']), command = firecrackerHostCommand(r.command);
    if (r.contract !== 's16-firecracker-client-intent/v1' || command.requestId !== id || command.computerId !== this.#scope.computerId || command.selectionSha256 !== this.#scope.selectionSha256 || !['accepted', 'dispatched', 'unknown', 'committed', 'not_sent'].includes(r.state as string)) return fail();
    if (r.receipt !== null) firecrackerRpcReceipt(r.receipt, this.#scope, command); return structuredClone(r) as unknown as Intent;
  }
  async #call(operation: Omit<FirecrackerRpcInput, 'contract' | 'installationId'> | { operation: 'submit'; command: FirecrackerHostCommand } | { operation: 'receipt' | 'reconcile'; requestId: string }): Promise<unknown> {
    this.#current(); let credential: string; try { credential = this.#credential(); } catch { return fail(); } if (!/^[A-Za-z0-9_-]{32,256}$/.test(credential)) return fail(); registerSecretFingerprint(credential);
    const controller = new AbortController(), expired = Promise.withResolvers<never>(), timer = setTimeout(() => { controller.abort(); expired.reject(new AppError('vm_firecracker_management_unavailable', 503)); }, this.#timeout);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const body = vmCanonical({ contract: 's16-firecracker-management/v1', installationId: this.#installation, ...operation }); if (Buffer.byteLength(body) > 4096) return fail();
      const response = await Promise.race([this.#fetch(this.#origin + '/v1/firecracker', { method: 'POST', redirect: 'error', signal: controller.signal, headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' }, body }), expired.promise]);
      if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'application/json' || Number(response.headers.get('content-length') ?? 0) > 16384 || !response.body) return fail();
      reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      for (;;) { const next = await Promise.race([reader.read(), expired.promise]); if (next.done) break; size += next.value.length; if (size > 16384) return fail(); chunks.push(next.value); }
      this.#current(); const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), r = vmRecord(value, ['contract', 'result']); if (r.contract !== 's16-firecracker-management/v1') return fail(); return r.result;
    } catch { return fail(); }
    finally { clearTimeout(timer); controller.abort(); if (reader) void reader.cancel().catch(() => {}); }
  }
  #finish(intent: Intent, receipt: FirecrackerHostJob): void {
    this.#journal.tx(() => {
      this.#current(); const current = this.#intent(intent.command.requestId); if (!same(current.command, receipt.command) || this.#active() !== intent.command.requestId) fail();
      current.receipt = receipt; current.state = receipt.state === 'committed' ? 'committed' : receipt.state === 'not_sent' ? 'not_sent' : 'unknown';
      this.#journal.put(intent.command.requestId, current); if (['committed', 'not_sent'].includes(current.state)) this.#journal.put('active', { requestId: null });
    });
  }
  async #readOriginal(): Promise<Intent | null> {
    const id = this.#active(); if (!id) return null; const intent = this.#intent(id);
    let receipt = firecrackerRpcReceipt(await this.#call({ operation: 'receipt', requestId: id }), this.#scope, intent.command);
    if (receipt.state === 'unknown') receipt = firecrackerRpcReceipt(await this.#call({ operation: 'reconcile', requestId: id }), this.#scope, intent.command);
    this.#finish(intent, receipt); if (!['committed', 'not_sent'].includes(receipt.state)) return fail('vm_reconciliation_required'); return this.#intent(id);
  }
  async #recover(): Promise<Intent | null> {
    if (this.#recovering) return this.#recovering; this.#recovering = this.#readOriginal();
    try { return await this.#recovering; } finally { this.#recovering = null; }
  }
  async #state(): Promise<FirecrackerRpcState> {
    const state = firecrackerRpcState(await this.#call({ operation: 'state' }), this.#scope); if (state.computer.activeRequestId || !state.machine) return fail('vm_reconciliation_required'); return state;
  }
  /** Authenticated fresh host facts; a local unknown can never be hidden by a currently idle remote state. */
  async inspect(): Promise<VmMachineState> { this.#current(); await this.#recover(); return (await this.#state()).machine!; }
  async #mutate(kind: FirecrackerHostCommand['kind'], snapshotId?: string): Promise<void> {
    this.#current(); if (this.#busy) return fail('vm_reconciliation_required'); this.#busy = true;
    try {
      const recovered = await this.#recover();
      if (recovered && recovered.command.kind === kind && (!('snapshotId' in recovered.command) || recovered.command.snapshotId === snapshotId)) {
        if (recovered.state !== 'committed') return fail('vm_management_not_sent');
        const observed = recovered.receipt?.observation; if (!observed) return fail();
        const state = await this.#state(); if (state.machine?.state !== observed.state || state.computer.launchId !== observed.launchId) return fail('vm_reconciliation_required'); return;
      }
      const state = await this.#state(), c = state.computer;
      if (kind === 'launch' && state.machine!.state === 'running' || kind === 'stop' && state.machine!.state === 'stopped') return;
      // Prepared-but-never-launched disks have no original process settlement to checkpoint.
      // Refuse before retaining an intent; this must not fence the computer's first start.
      if (kind === 'checkpoint' && c.launchId === null) throw new AppError('vm_firecracker_snapshot_requires_launch', 409);
      const common = { contract: 's16-firecracker-host-command/v1' as const, requestId: crypto.randomUUID().replaceAll('-', ''), computerId: c.id, selectionSha256: c.selectionSha256, expectedRevision: c.revision, expectedLaunchId: c.launchId };
      const command = firecrackerHostCommand(kind === 'launch' || kind === 'stop' ? { ...common, kind } : { ...common, kind, snapshotId });
      const intent: Intent = { contract: 's16-firecracker-client-intent/v1', command, state: 'accepted', receipt: null };
      this.#journal.tx(() => { this.#current(); if (this.#active()) fail(); this.#journal.put(command.requestId, intent); this.#journal.put('active', { requestId: command.requestId }); });
      this.#journal.tx(() => { this.#current(); const original = this.#intent(command.requestId); if (original.state !== 'accepted' || this.#active() !== command.requestId) fail(); original.state = 'dispatched'; this.#journal.put(command.requestId, original); });
      try {
        const receipt = firecrackerRpcReceipt(await this.#call({ operation: 'submit', command }), this.#scope, command); this.#finish(intent, receipt);
        if (receipt.state !== 'committed') return fail('vm_reconciliation_required');
      } catch {
        if (!this.#closed) this.#journal.tx(() => { const current = this.#intent(command.requestId); if (current.state === 'dispatched') { current.state = 'unknown'; this.#journal.put(command.requestId, current); } });
        return fail('vm_reconciliation_required');
      }
    } finally { this.#busy = false; }
  }
  async start(): Promise<void> { await this.#mutate('launch'); }
  async stop(): Promise<void> { await this.#mutate('stop'); }
  async snapshot(name: string): Promise<void> { await this.#mutate('checkpoint', name); }
  async restore(name: string): Promise<void> { await this.#mutate('restore', name); }
  async retireSnapshot(name: string): Promise<void> { await this.#mutate('retire', name); }
  /** Protected local uncertainty only, never evidence that the remote machine is running/stopped. */
  pending(): boolean { this.#current(); return this.#active() !== null; }
  /** Closes controller metadata only. Root systemd/forwarding and unknown original receipts survive. */
  close(): void { if (this.#released) return; this.#closed = true; this.#journal.close(); this.#released = true; }
}
