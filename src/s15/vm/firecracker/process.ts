import { closeSync, constants, openSync, readSync } from 'node:fs';
import { AppError } from '../../../errors';

/** Protected launch identity. Neither a guest PID/boot ID nor an API response supplies these values. */
export interface FirecrackerProcessIdentity { pid: number; startTicks: string; hostBootId: string }
/** Process observation only. This never certifies disk settlement, a jail, a VMM image or network isolation. */
export interface FirecrackerProcessExit {
  observation: 'process_exited'; basis: 'host_process' | 'protocol_fixture';
}
/** Safe transport/lifecycle failure; unknown never permits a replacement signal or releases a VM claim. */
export class FirecrackerProcessError extends AppError {
  constructor(code: string, readonly outcome: 'not_sent' | 'unknown') { super(code, 503); this.name = 'FirecrackerProcessError'; }
}
/** Deterministic host protocol seam. Supplying it always labels observations as fixtures. */
export interface FirecrackerProcessFixture {
  readonly basis: 'protocol_fixture';
  bootId(): string;
  startTicks(pid: number): string;
  open(pid: number): number;
  exited(fd: number): boolean;
  kill(fd: number): void;
  close(fd: number): void;
}
interface ProcessPort extends Omit<FirecrackerProcessFixture, 'basis'> { readonly basis: FirecrackerProcessExit['basis']; dispose(): void }
const invalid = (): never => { throw new FirecrackerProcessError('vm_firecracker_process_invalid', 'not_sent'); };
const unavailable = (): never => { throw new FirecrackerProcessError('vm_firecracker_process_unavailable', 'not_sent'); };

function boundedProc(path: string, maximum: number): string {
  // Node's filesystem descriptors are close-on-exec; pidfd_open independently sets FD_CLOEXEC.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(maximum + 1); let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maximum) return unavailable();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally { closeSync(fd); }
}
/** Parses kernel field 22 after the final comm delimiter; spaces and parentheses in comm are valid. */
export function firecrackerProcessStartTicks(stat: string, pid: number): string {
  if (typeof stat !== 'string' || Buffer.byteLength(stat) > 65536 || !stat.startsWith(`${pid} (`)) return unavailable();
  const end = stat.lastIndexOf(')'), fields = stat.slice(end + 2).trim().split(/\s+/);
  if (end < 0 || stat[end + 1] !== ' ' || !/^[A-Za-z]$/.test(fields[0] ?? '') || !/^[1-9][0-9]{0,19}$/.test(fields[19] ?? '')) return unavailable();
  return fields[19]!;
}

async function nativePort(): Promise<ProcessPort> {
  // The selected host profile is glibc Linux, x86_64/aarch64. Load no native library on a Mac,
  // and accept no library path, syscall number, signal, process group or fallback from configuration.
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) return unavailable();
  const { dlopen, ptr } = await import('bun:ffi');
  const library = dlopen(process.arch === 'x64' ? '/lib/x86_64-linux-gnu/libc.so.6' : '/lib/aarch64-linux-gnu/libc.so.6', {
    pidfd_open: { args: ['i32', 'u32'], returns: 'i32' },
    pidfd_send_signal: { args: ['i32', 'i32', 'ptr', 'u32'], returns: 'i32' },
    poll: { args: ['ptr', 'u64', 'i32'], returns: 'i32' },
  });
  let closed = false;
  return {
    basis: 'host_process',
    bootId: () => boundedProc('/proc/sys/kernel/random/boot_id', 128).trim(),
    startTicks: pid => firecrackerProcessStartTicks(boundedProc(`/proc/${pid}/stat`, 65536), pid),
    open(pid) { const fd = library.symbols.pidfd_open(pid, 0); if (fd < 0) return unavailable(); return fd; },
    exited(fd) {
      const row = Buffer.alloc(8); row.writeInt32LE(fd, 0); row.writeInt16LE(1, 4);
      const result = library.symbols.poll(ptr(row), 1, 0), events = row.readUInt16LE(6);
      if (result === 0 && events === 0) return false;
      // A pidfd becomes readable after the last thread exits; HUP covers a reaped process.
      if (result === 1 && events !== 0 && (events & ~(1 | 16)) === 0) return true;
      return unavailable();
    },
    kill(fd) { if (library.symbols.pidfd_send_signal(fd, 9, null, 0) !== 0) unavailable(); },
    close: closeSync,
    dispose() { if (!closed) { closed = true; library.close(); } },
  };
}

/**
 * Pins one exact host process through a Linux pidfd. Opening checks the protected launch's host boot
 * and start ticks on both sides of acquisition. All later signals use the retained descriptor, so
 * PID reuse cannot redirect them. This is an explicit whole-VMM primitive, never session cleanup.
 * The caller must independently bind executable/jail/config/disk/sockets and own a durable stop intent.
 */
export class FirecrackerProcessLease {
  readonly #port: ProcessPort;
  readonly #fd: number;
  #closed = false;
  #stopping = false;
  #signalSent = false;
  private constructor(port: ProcessPort, fd: number) { this.#port = Object.freeze(port); this.#fd = fd; }
  /** Fixture observations cannot be promoted to host observations by a caller-supplied label. */
  get basis(): FirecrackerProcessExit['basis'] { return this.#port.basis; }
  /** Missing kernel/libc/permission/identity evidence refuses; no numeric-PID kill fallback exists. */
  static async open(identity: FirecrackerProcessIdentity, fixture?: FirecrackerProcessFixture): Promise<FirecrackerProcessLease> {
    identity = Object.freeze({ ...identity });
    if (!Number.isSafeInteger(identity.pid) || identity.pid < 2 || identity.pid > 0x7fffffff || typeof identity.startTicks !== 'string' || !/^[1-9][0-9]{0,19}$/.test(identity.startTicks) || typeof identity.hostBootId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(identity.hostBootId)) return invalid();
    if (fixture && fixture.basis !== 'protocol_fixture') return invalid();
    let port: ProcessPort | null = null, fd: number | null = null;
    try {
      // Copy methods before any caller-controlled asynchronous boundary. A fixture cannot upgrade basis.
      port = fixture ? { basis: 'protocol_fixture', bootId: fixture.bootId.bind(fixture), startTicks: fixture.startTicks.bind(fixture), open: fixture.open.bind(fixture), exited: fixture.exited.bind(fixture), kill: fixture.kill.bind(fixture), close: fixture.close.bind(fixture), dispose() {} } : await nativePort();
      if (port.bootId() !== identity.hostBootId || port.startTicks(identity.pid) !== identity.startTicks) return unavailable();
      fd = port.open(identity.pid);
      if (!Number.isSafeInteger(fd) || fd < 0) return unavailable();
      if (port.exited(fd) || port.bootId() !== identity.hostBootId || port.startTicks(identity.pid) !== identity.startTicks || port.exited(fd)) return unavailable();
      return new FirecrackerProcessLease(port, fd);
    } catch {
      try { if (port && fd !== null && Number.isSafeInteger(fd) && fd >= 0) port.close(fd); } catch { /* Safe failure below; no process authority was admitted. */ }
      try { port?.dispose(); } catch { /* Do not expose native loader details. */ }
      return unavailable();
    }
  }
  /** A failed/closed observation is not evidence of exit. Does not inspect a guest or release capacity. */
  exited(): boolean {
    if (this.#closed) throw new FirecrackerProcessError('vm_firecracker_process_closed', this.#signalSent ? 'unknown' : 'not_sent');
    try { return this.#port.exited(this.#fd); }
    catch { throw new FirecrackerProcessError('vm_firecracker_process_unavailable', this.#signalSent ? 'unknown' : 'not_sent'); }
  }
  /**
   * One SIGKILL to this exact descriptor after a current protected guard. A complete process exit is
   * weaker than vm_stopped: the owning manager still needs disk/access settlement. Deadline or abort
   * after dispatch leaves an unknown original operation and an open lease for independent read-back.
   */
  async stop(options: { guard(): void | Promise<void>; timeoutMs?: number; signal?: AbortSignal }): Promise<FirecrackerProcessExit> {
    const { guard, signal } = options, timeoutMs = options.timeoutMs ?? 10000;
    if (typeof guard !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 || signal !== undefined && !(signal instanceof AbortSignal)) return invalid();
    if (this.#stopping || this.#signalSent) throw new FirecrackerProcessError('vm_firecracker_stop_already_started', this.#signalSent ? 'unknown' : 'not_sent');
    if (this.#closed) throw new FirecrackerProcessError('vm_firecracker_process_closed', 'not_sent');
    if (signal?.aborted) throw new FirecrackerProcessError('aborted', 'not_sent');
    this.#stopping = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const canceled = Promise.withResolvers<never>();
    const fail = (code: string) => canceled.reject(new FirecrackerProcessError(code, this.#signalSent ? 'unknown' : 'not_sent'));
    const onAbort = () => fail('aborted');
    const deadline = performance.now() + timeoutMs;
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => fail('vm_firecracker_stop_unconfirmed'), timeoutMs);
    const check = () => { if (signal?.aborted) throw new FirecrackerProcessError('aborted', this.#signalSent ? 'unknown' : 'not_sent'); if (performance.now() >= deadline) throw new FirecrackerProcessError('vm_firecracker_stop_unconfirmed', this.#signalSent ? 'unknown' : 'not_sent'); };
    try {
      await Promise.race([Promise.resolve().then(guard), canceled.promise]); check();
      if (!this.exited()) {
        // Mark dispatch before entering the native boundary. Even a signal error cannot authorize replay.
        this.#signalSent = true;
        try { this.#port.kill(this.#fd); } catch { throw new FirecrackerProcessError('vm_firecracker_stop_unconfirmed', 'unknown'); }
        for (;;) {
          check();
          if (this.exited()) break;
          await Promise.race([new Promise<void>(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - performance.now())))), canceled.promise]);
        }
      }
      // Current authority is required for publication too; a late guard never publishes a stop receipt.
      await Promise.race([Promise.resolve().then(guard), canceled.promise]); check();
      return { observation: 'process_exited', basis: this.basis };
    } catch (error) {
      if (error instanceof FirecrackerProcessError) throw error;
      throw new FirecrackerProcessError('vm_firecracker_process_unavailable', this.#signalSent ? 'unknown' : 'not_sent');
    } finally { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', onAbort); this.#stopping = false; }
  }
  /** Releases only the observation descriptor. Closing never sends a signal or proves VM settlement. */
  close(): void {
    if (this.#stopping) throw new FirecrackerProcessError('vm_firecracker_process_busy', this.#signalSent ? 'unknown' : 'not_sent');
    if (this.#closed) return;
    this.#closed = true;
    try { this.#port.close(this.#fd); } finally { this.#port.dispose(); }
  }
}
