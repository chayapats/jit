import { AppError } from '../../../errors';
import type { VmMachineState } from '../types';
import { FirecrackerApi } from './api';
import { FirecrackerHostLease, type FirecrackerHostFacts, type FirecrackerHostFixture, type FirecrackerHostSelection } from './custody';
import { firecrackerLaunchPlan } from './launch';
import { FirecrackerProfile } from './profile';
import { openFirecrackerSshForwarder, type FirecrackerSshForwarder } from './ssh-forwarder';

const refuse = (): never => { throw new AppError('vm_firecracker_binding_unavailable', 503); };
/** Protected-helper composition, not an owner/model payload and not permission to launch a VM. */
export interface BoundFirecrackerOptions {
  selection: FirecrackerHostSelection; guestPort: number; listenPort: number;
  /** Current protected host/enrollment binding. Working calls still require the owning VM/POLICY guards. */
  guard(): void | Promise<void>;
  /** Original-instance protected cleanup authority; revoking work/enrollment must not authorize new work or strand cleanup. */
  stopGuard?(): void | Promise<void>;
  fixture?: FirecrackerHostFixture;
}
/**
 * Composes exact host custody, closed API profile and the actual guarded SSH/vsock lane for one original
 * running instance. The installed manager still owns durable launch/restore jobs and cold snapshots;
 * this component cannot be registered as a complete VmManagement adapter on its own.
 */
export class BoundFirecrackerComputer {
  readonly #selected: FirecrackerHostSelection;
  readonly #guestPort: number;
  readonly #owner: BoundFirecrackerOptions['guard'];
  readonly #cleanup: BoundFirecrackerOptions['guard'];
  readonly #host: FirecrackerHostLease;
  readonly #api: FirecrackerApi;
  readonly #lifecycle = new AbortController();
  #forwarder: FirecrackerSshForwarder | null = null;
  #phase: 'opening' | 'running' | 'stopping' | 'stopped' | 'uncertain' | 'closed' = 'opening';
  #last: FirecrackerHostFacts;
  #stopIssued = false;
  private constructor(selected: FirecrackerHostSelection, guestPort: number, guard: BoundFirecrackerOptions['guard'], cleanup: BoundFirecrackerOptions['guard'], host: FirecrackerHostLease) {
    this.#selected = selected; this.#guestPort = guestPort; this.#owner = guard; this.#cleanup = cleanup; this.#host = host; this.#last = host.inspect();
    this.#api = new FirecrackerApi({ socketPath: firecrackerLaunchPlan(selected.profile, selected.host).apiSocket, guard: () => this.#current() });
  }
  async #current(): Promise<void> {
    if (!['opening', 'running'].includes(this.#phase) || this.#lifecycle.signal.aborted) return refuse();
    const deadline = performance.now() + 5000, canceled = Promise.withResolvers<never>();
    const abort = () => canceled.reject(new AppError('vm_firecracker_binding_unavailable', 503));
    const timer = setTimeout(abort, 5000); this.#lifecycle.signal.addEventListener('abort', abort, { once: true });
    try {
      await Promise.race([Promise.resolve().then(this.#owner), canceled.promise]);
      if (!['opening', 'running'].includes(this.#phase) || this.#lifecycle.signal.aborted || performance.now() >= deadline) return refuse();
      this.#host.inspect(); if (performance.now() >= deadline) return refuse();
    } catch { return refuse(); }
    finally { clearTimeout(timer); this.#lifecycle.signal.removeEventListener('abort', abort); }
  }
  /** No launch or InstanceStart is issued: --config-file has already started the original instance. */
  static async open(options: BoundFirecrackerOptions): Promise<BoundFirecrackerComputer> {
    const { guestPort, listenPort, guard, fixture } = options, cleanup = options.stopGuard ?? guard, selected = structuredClone(options.selection);
    if (!Number.isSafeInteger(guestPort) || guestPort < 1 || guestPort >= 0xffffffff || !Number.isSafeInteger(listenPort) || listenPort < (fixture ? 0 : 1) || listenPort > 65535 || typeof guard !== 'function' || typeof cleanup !== 'function') return refuse();
    let host: FirecrackerHostLease | null = null, computer: BoundFirecrackerComputer | null = null;
    const abort = new AbortController(), deadline = performance.now() + 40000, timer = setTimeout(() => abort.abort(), 40000);
    try {
      host = await FirecrackerHostLease.open(selected, { guard, signal: abort.signal, ...(fixture ? { fixture } : {}) });
      computer = new BoundFirecrackerComputer(selected, guestPort, guard, cleanup, host);
      const facts = await new FirecrackerProfile(selected.profile).inspect(computer.#api, abort.signal);
      if (facts.state !== 'Running' || abort.signal.aborted) return refuse();
      const original = computer;
      computer.#forwarder = await openFirecrackerSshForwarder({ socketPath: firecrackerLaunchPlan(selected.profile, selected.host).vsockSocket, guestPort, listenPort, guard: () => original.#current(), signal: computer.#lifecycle.signal });
      await computer.#current(); if (abort.signal.aborted || performance.now() >= deadline) return refuse(); computer.#phase = 'running'; return computer;
    } catch (error) { if (computer) await computer.close(); else host?.close(); throw error; }
    finally { clearTimeout(timer); }
  }
  /** Exact installed loopback selection for pinned-host-key SSH; no private key or management socket is exposed. */
  endpoint(): { host: '127.0.0.1'; port: number } {
    if (this.#phase !== 'running' || !this.#forwarder) return refuse(); return { ...this.#forwarder.endpoint };
  }
  #machine(state: 'running' | 'stopped', facts: FirecrackerHostFacts): VmMachineState {
    const s = this.#selected;
    return { state, identity: `firecracker:${s.profile.instanceId}`, boot: state === 'running' ? `${s.process.hostBootId}:${s.process.startTicks}` : 'stopped',
      cpuCount: s.profile.cpuCount, memoryBytes: s.profile.memoryMiB * 1048576, diskBytes: s.disk.bytes, network: state === 'running' ? 'isolated' : 'unproven',
      binding: { kind: 'firecracker-vsock', instanceId: s.profile.instanceId, guestCid: s.profile.guestCid, guestPort: this.#guestPort, selectionSha256: facts.selectionSha256 },
      ...(state === 'running' ? { sshEndpoint: this.endpoint() } : {}) };
  }
  /** Revalidates both owners before publishing; stopped requires independent original disk settlement. */
  async inspect(): Promise<VmMachineState> {
    if (this.#phase === 'stopped') { this.#last = await this.#host.settled(this.#cleanup); return this.#machine('stopped', this.#last); }
    if (this.#phase !== 'running') return refuse();
    const facts = await new FirecrackerProfile(this.#selected.profile).inspect(this.#api, this.#lifecycle.signal);
    await this.#current(); if (facts.state !== 'Running') return refuse(); this.#last = this.#host.inspect(); return this.#machine('running', this.#last);
  }
  /** Safe last observation only; fixture basis never becomes native host certification. */
  evidence(): Readonly<FirecrackerHostFacts> { return { ...this.#last }; }
  /** Fences/settles original transports before one exact stop. Failure retains the original lease for read-back. */
  async stop(): Promise<void> {
    if (this.#phase !== 'running' || this.#stopIssued) return refuse();
    this.#stopIssued = true; this.#phase = 'stopping'; this.#lifecycle.abort();
    try {
      await Promise.all([this.#api.close(), this.#forwarder?.close()]);
      this.#last = await this.#host.stop({ guard: this.#cleanup }); this.#phase = 'stopped';
    } catch (error) { this.#phase = 'uncertain'; throw error; }
  }
  /** Original stop read-back only; neither uncertain state nor response loss creates a replacement signal. */
  async readStop(): Promise<VmMachineState> {
    if (!this.#stopIssued || !['stopped', 'uncertain'].includes(this.#phase)) return refuse();
    this.#last = await this.#host.settled(this.#cleanup); this.#phase = 'stopped'; return this.#machine('stopped', this.#last);
  }
  /** Releases observation and network transports only, never stops a VM or settles an owning work claim. */
  async close(): Promise<void> {
    if (this.#phase === 'stopping') return refuse();
    if (this.#phase === 'closed') return; this.#phase = 'closed'; this.#lifecycle.abort();
    await Promise.all([this.#api.close(), this.#forwarder?.close()]); this.#host.close();
  }
}
