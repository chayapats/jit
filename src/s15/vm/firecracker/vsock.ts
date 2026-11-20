import { createConnection, type Socket } from 'node:net';
import { isAbsolute, normalize } from 'node:path';
import { AppError } from '../../../errors';

/** Trusted per-microVM host channel, before SSH. Neither a path nor this acknowledgement grants work. */
export interface FirecrackerVsockOptions {
  socketPath: string;
  guestPort: number;
  /** Complete preparation/connect/acknowledgement budget, independently shortened by the work deadline. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Recheck current owner/work/generation and protected socket/hypervisor custody after each wait. */
  guard(): void | Promise<void>;
}
/** A paused, opaque stream. Consumers retain SSH authentication and original operation publication guards. */
export interface FirecrackerVsockChannel {
  socket: Socket;
  /** Firecracker assigns this HOST port; it need not equal the selected guest port. */
  hostPort: number;
  /** Actual socket closure only, never evidence that guest execution or a hypervisor stopped. */
  closed: Promise<void>;
  /** Idempotent original channel cleanup. No reconnect or guest work retry is performed. */
  close(): void;
}

const aborted = () => new DOMException('Aborted', 'AbortError');
const port = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) < 0xffffffff;
const failure = (code: string) => new AppError(code, 503);

/** Validate trusted socket/port/deadline selection before binding or touching a private endpoint. */
export function validateFirecrackerVsock(options: FirecrackerVsockOptions): number {
  const timeoutMs = options.timeoutMs ?? 5000;
  if (typeof options.socketPath !== 'string' || !options.socketPath.isWellFormed() || !isAbsolute(options.socketPath) || normalize(options.socketPath) !== options.socketPath || Buffer.byteLength(options.socketPath) > 100 || /[\u0000-\u001f\u007f]/u.test(options.socketPath) || !port(options.guestPort) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000 || typeof options.guard !== 'function') throw new AppError('vm_vsock_invalid');
  return timeoutMs;
}

/**
 * One Firecracker v1.18 host-initiated Unix/vsock negotiation. The entire acknowledgement is bounded to
 * 32 ASCII bytes and one five-second budget, including asynchronous custody guards. A fragmented or
 * coalesced reply preserves all subsequent SSH bytes. Returned streams remain paused until consumed.
 * This is a transport primitive, not a VM identity proof, management API or protected-host shell.
 */
export async function connectFirecrackerVsock(options: FirecrackerVsockOptions): Promise<FirecrackerVsockChannel> {
  // Pin selection across asynchronous guards; a configuration reload must create a new channel.
  options = Object.freeze({ ...options });
  const timeoutMs = validateFirecrackerVsock(options);
  if (options.signal?.aborted) throw aborted();
  return new Promise<FirecrackerVsockChannel>((resolve, reject) => {
    let socket: Socket | null = null, done = false, transportClosed = false, state: 'preparing' | 'connecting' | 'negotiating' | 'checking' | 'ready' | 'closed' = 'preparing';
    let acknowledgement = Buffer.alloc(0);
    const closure = Promise.withResolvers<void>();
    const timer = setTimeout(() => fail(failure('vm_vsock_timeout')), timeoutMs);
    const close = () => { socket?.destroy(); };
    const detach = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); };
    function fail(error: unknown) {
      if (done) return;
      done = true; state = 'closed'; detach();
      if (socket && !transportClosed) {
        socket.removeListener('data', data);
        // Admission capacity may be released after rejection. Await the actual original descriptor's
        // close event rather than treating a destroy request as already settled transport.
        socket.once('close', () => reject(error)); socket.destroy();
      } else { closure.resolve(); reject(error); }
    }
    function onAbort() {
      if (!done) fail(aborted()); else if (state === 'ready') socket?.destroy(aborted());
    }
    async function checked(expected: typeof state, next: () => void) {
      try {
        await options.guard();
        if (done || state !== expected) return;
        if (options.signal?.aborted) { fail(aborted()); return; }
        next();
      } catch (error) { fail(error); }
    }
    function data(chunk: Buffer) {
      if (state !== 'negotiating' || !socket) { fail(failure('vm_vsock_protocol_invalid')); return; }
      const newline = chunk.indexOf(10), end = newline === -1 ? chunk.length : newline + 1;
      if (acknowledgement.length + end > 32) { fail(failure('vm_vsock_protocol_invalid')); return; }
      acknowledgement = Buffer.concat([acknowledgement, chunk.subarray(0, end)]);
      if (newline === -1) return;
      if (acknowledgement.some(byte => byte > 127)) { fail(failure('vm_vsock_protocol_invalid')); return; }
      const matched = /^OK ([1-9][0-9]{0,9})\n$/.exec(acknowledgement.toString('ascii')), hostPort = matched ? Number(matched[1]) : NaN;
      if (!port(hostPort)) { fail(failure('vm_vsock_protocol_invalid')); return; }
      socket.pause(); socket.removeListener('data', data); state = 'checking';
      const rest = chunk.subarray(end);
      if (rest.length) socket.unshift(rest);
      void checked('checking', () => {
        if (!socket || socket.destroyed || socket.readableEnded) { fail(failure('vm_vsock_closed')); return; }
        done = true; state = 'ready'; clearTimeout(timer);
        resolve({ socket, hostPort, closed: closure.promise, close });
      });
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) { fail(aborted()); return; }
    void checked('preparing', () => {
      state = 'connecting'; socket = createConnection({ path: options.socketPath });
      // Keep one error listener through handoff, so an error between resolution and consumer attachment
      // cannot become an uncaught process exception. Consumers still receive their own error event.
      socket.on('error', () => { if (!done) fail(failure('vm_vsock_unavailable')); });
      socket.once('end', () => { if (!done) fail(failure('vm_vsock_closed')); });
      socket.once('close', () => {
        transportClosed = true;
        closure.resolve();
        if (!done) fail(failure('vm_vsock_closed'));
        state = 'closed'; detach();
      });
      socket.on('data', data);
      socket.once('connect', () => { void checked('connecting', () => {
        state = 'negotiating'; socket!.write(`CONNECT ${options.guestPort}\n`);
      }); });
    });
  });
}
