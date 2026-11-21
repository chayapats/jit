import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppError } from '../../../errors';
import { vmHostCommand } from '../host';
import type { VmHostCommand } from '../types';
import { firecrackerLaunchPlan, type FirecrackerLaunchHost } from './launch';
import type { FirecrackerProfileSelection } from './profile';

/** Fixed root unit metadata only, never guest output or a VM/disk settlement certificate. */
export type FirecrackerUnitObservation = { state: 'missing'; unit: string; basis: 'host_manager' | 'protocol_fixture' } | {
  state: 'loaded'; unit: string; invocationId: string; mainPid: number; active: 'active' | 'activating' | 'deactivating' | 'inactive' | 'failed';
  sub: string; result: string; basis: 'host_manager' | 'protocol_fixture';
};
/** Safe original transport uncertainty; a lost submission never permits a second start. */
export class FirecrackerUnitError extends AppError {
  constructor(readonly outcome: 'not_sent' | 'unknown') { super('vm_firecracker_unit_unavailable', 503); }
}
/** Protected source only. Native calls require root Linux and the installed preflight/authority guards. */
export interface FirecrackerUnitOptions {
  profile: FirecrackerProfileSelection; host: FirecrackerLaunchHost;
  current(requestId: string, computerId: string): void;
  /** Verifies prepared immutable inputs, private original disk, empty old scope and current launch custody. */
  preflight(): void;
  /** Supplying this port always labels observations as fixtures, never native host evidence. */
  fixture?: VmHostCommand;
}
const properties = ['Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'InvocationID', 'Result', 'Type', 'Restart', 'RemainAfterExit', 'User', 'Group', 'PrivateMounts', 'StandardInput', 'StandardOutput', 'StandardError'] as const;
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
/** Unique original unit name, retained after exit so a lost launch reply remains independently observable. */
export function firecrackerUnitName(requestId: string): string { if (!id(requestId)) throw new FirecrackerUnitError('not_sent'); return `jit-firecracker-${requestId}.service`; }

/**
 * Closed root systemd submission/observation for the already recorded original launch. Systemd, rather
 * than a controller-owned child, retains the process across helper restarts. This never emits stop/kill,
 * arbitrary properties, a shell, daemonization or a duplicate Firecracker InstanceStart.
 */
export class FirecrackerLaunchUnits {
  readonly #run: VmHostCommand;
  readonly #current: FirecrackerUnitOptions['current'];
  readonly #preflight: FirecrackerUnitOptions['preflight'];
  readonly #argv: readonly string[];
  readonly #view: string;
  readonly #computer: string;
  readonly #fixture: boolean;
  readonly #submitted = new Set<string>();
  readonly #launching = new Set<string>();
  readonly #inspecting = new Set<string>();
  constructor(options: FirecrackerUnitOptions) {
    const profile = structuredClone(options.profile), host = structuredClone(options.host), plan = firecrackerLaunchPlan(profile, host);
    if (typeof options.current !== 'function' || typeof options.preflight !== 'function' || options.fixture !== undefined && typeof options.fixture !== 'function') throw new FirecrackerUnitError('not_sent');
    this.#run = options.fixture ?? vmHostCommand; this.#fixture = !!options.fixture; this.#current = options.current; this.#preflight = options.preflight; this.#argv = plan.argv;
    this.#view = join(host.jailerBase, '.jit-proc-misc');
    this.#computer = profile.instanceId;
  }
  #native(): void {
    if (this.#fixture) return;
    if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) || process.getuid?.() !== 0) throw new FirecrackerUnitError('not_sent');
    for (const file of ['/usr/bin/systemd-run', '/usr/bin/systemctl', '/usr/bin/env', this.#view]) {
      const s = lstatSync(file);
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== 0 || s.mode & 0o7022 || (file === this.#view ? s.size !== 0 || readFileSync(file).length !== 0 : !(s.mode & 0o100))) throw new FirecrackerUnitError('not_sent');
      for (let path = dirname(file);; path = dirname(path)) { const parent = lstatSync(path); if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || parent.mode & 0o7022) throw new FirecrackerUnitError('not_sent'); if (path === '/') break; }
    }
  }
  /**
   * One submission after the journal's durable dispatch marker. The effective jailer /proc/misc view is
   * an immutable empty file in this unit's private mount namespace, so optional host userfaultfd/Nitro
   * nodes are not auto-imported. The host's /proc and device nodes are unchanged. env -i closes inheritance.
   */
  async launch(requestId: string): Promise<{ observation: 'unit_start_submitted'; unit: string; basis: FirecrackerUnitObservation['basis'] }> {
    const unit = firecrackerUnitName(requestId); let dispatched = false;
    if (this.#submitted.has(requestId)) throw new FirecrackerUnitError('unknown');
    if (this.#launching.has(requestId) || this.#launching.size >= 4 || this.#submitted.size >= 4096) throw new FirecrackerUnitError('not_sent');
    this.#launching.add(requestId);
    try {
      this.#native(); this.#current(requestId, this.#computer); this.#preflight();
      const argv = ['/usr/bin/systemd-run', '--system', '--quiet', `--unit=${unit}`, '--service-type=exec',
        '--property=User=root', '--property=Group=root', '--property=Restart=no', '--property=RemainAfterExit=yes',
        '--property=StandardInput=null', '--property=StandardOutput=null', '--property=StandardError=null',
        '--property=LimitCORE=0', '--property=KillMode=control-group', '--property=TimeoutStopSec=10s',
        '--property=PrivateMounts=yes', `--property=BindReadOnlyPaths=${this.#view}:/proc/misc:norbind`,
        '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C', 'HOME=/nonexistent', ...this.#argv];
      const result = await this.#run(argv, { timeoutMs: 10000, maxBytes: 4096, env: { PATH: '/usr/bin:/bin', LANG: 'C', HOME: '/nonexistent' }, beforeStart: () => {
        this.#native(); this.#current(requestId, this.#computer); this.#preflight(); this.#submitted.add(requestId); dispatched = true;
      } });
      if (!dispatched || result.exitCode !== 0) throw new FirecrackerUnitError(dispatched ? 'unknown' : 'not_sent');
      this.#current(requestId, this.#computer); return { observation: 'unit_start_submitted', unit, basis: this.#fixture ? 'protocol_fixture' : 'host_manager' };
    } catch { throw new FirecrackerUnitError(dispatched ? 'unknown' : 'not_sent'); }
    finally { this.#launching.delete(requestId); }
  }
  /** One bounded original-unit read, not an automatic start and not a stopped-machine inference. */
  async inspect(requestId: string): Promise<FirecrackerUnitObservation> {
    const unit = firecrackerUnitName(requestId);
    if (this.#inspecting.size >= 4 || this.#inspecting.has(requestId)) throw new FirecrackerUnitError('not_sent');
    this.#inspecting.add(requestId);
    try {
      this.#native(); this.#current(requestId, this.#computer);
      const result = await this.#run(['/usr/bin/systemctl', '--system', '--no-pager', 'show', unit, ...properties.map(name => `--property=${name}`)], {
        timeoutMs: 5000, maxBytes: 16384, env: { PATH: '/usr/bin:/bin', LANG: 'C', HOME: '/nonexistent' }, beforeStart: () => { this.#native(); this.#current(requestId, this.#computer); },
      });
      this.#current(requestId, this.#computer); if (result.stdout.length > 16384) throw new FirecrackerUnitError('not_sent');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout), fields = new Map<string, string>();
      for (const line of text.trimEnd().split('\n')) { const separator = line.indexOf('='), name = line.slice(0, separator), value = line.slice(separator + 1); if (separator < 1 || !properties.includes(name as typeof properties[number]) || fields.has(name) || /[\u0000-\u001f\u007f]/u.test(value)) throw new FirecrackerUnitError('not_sent'); fields.set(name, value); }
      if (fields.get('Id') !== unit) throw new FirecrackerUnitError('not_sent');
      const basis = this.#fixture ? 'protocol_fixture' : 'host_manager';
      if (fields.get('LoadState') === 'not-found' && [0, 4].includes(result.exitCode)) return { state: 'missing', unit, basis };
      if (result.exitCode !== 0 || fields.size !== properties.length || fields.get('LoadState') !== 'loaded' || fields.get('Type') !== 'exec' || fields.get('Restart') !== 'no' || fields.get('RemainAfterExit') !== 'yes' || fields.get('User') !== 'root' || fields.get('Group') !== 'root' || fields.get('PrivateMounts') !== 'yes' || properties.slice(-3).some(name => fields.get(name) !== 'null')) throw new FirecrackerUnitError('not_sent');
      const invocationId = fields.get('InvocationID')!, pid = fields.get('MainPID')!, active = fields.get('ActiveState')!, sub = fields.get('SubState')!, state = fields.get('Result')!;
      if (!id(invocationId) || !/^(?:0|[1-9][0-9]{0,9})$/.test(pid) || Number(pid) > 0x7fffffff || !['active', 'activating', 'deactivating', 'inactive', 'failed'].includes(active) || !/^[a-z-]{1,40}$/.test(sub) || !/^[a-z-]{1,40}$/.test(state)) throw new FirecrackerUnitError('not_sent');
      return { state: 'loaded', unit, invocationId, mainPid: Number(pid), active: active as Extract<FirecrackerUnitObservation, { state: 'loaded' }>['active'], sub, result: state, basis };
    } catch { throw new FirecrackerUnitError('not_sent'); }
    finally { this.#inspecting.delete(requestId); }
  }
}
