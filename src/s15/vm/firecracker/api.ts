import { request as httpRequest, type ClientRequest } from 'node:http';
import type { Socket } from 'node:net';
import { isAbsolute, normalize } from 'node:path';
import { AppError } from '../../../errors';
import { parseCommandJson } from '../../conversation/validation';

const operations = {
  instance: { method: 'GET', path: '/', body: null },
  version: { method: 'GET', path: '/version', body: null },
  configuration: { method: 'GET', path: '/vm/config', body: null },
  start: { method: 'PUT', path: '/actions', body: '{"action_type":"InstanceStart"}' },
} as const;
/** Closed host-management operations. No arbitrary path, method, body or model command is accepted. */
export type FirecrackerApiOperation = keyof typeof operations;
/** Transport observation only; even a complete HTTP reply does not prove execution or settlement. */
export type FirecrackerApiOutcome = 'not_sent' | 'unknown' | 'response';
/** Safe error without peer bodies, endpoint paths, credentials or request text. Never authorizes retry. */
export class FirecrackerApiError extends AppError {
  constructor(code: string, readonly outcome: FirecrackerApiOutcome, readonly httpStatus: number | null = null) {
    super(code, 503); this.name = 'FirecrackerApiError';
  }
}
/** Trusted control-plane selection. The guard must prove current process/socket custody and authority. */
export interface FirecrackerApiOptions {
  socketPath: string; timeoutMs?: number; maxInFlight?: number;
  guard(): void | Promise<void>;
}

/**
 * Bounded Firecracker v1.18 HTTP over one protected Unix socket. No DNS/TCP fallback, redirect, retry,
 * ambient credential or arbitrary API route exists. Preparation, connect, body and publication share
 * one deadline. Capacity and the caller's result remain held through actual original descriptor close.
 * Raw JSON is private, untrusted metadata; the owning adapter must validate its exact selected profile.
 */
export class FirecrackerApi {
  readonly #active = new Set<{ cancel(): void; finished: Promise<void> }>();
  readonly #timeout: number;
  readonly #maximum: number;
  readonly #socketPath: string;
  readonly #guard: FirecrackerApiOptions['guard'];
  #closed = false;
  #closing: Promise<void> | null = null;
  constructor(options: FirecrackerApiOptions) {
    const { socketPath } = options;
    this.#timeout = options.timeoutMs ?? 5000; this.#maximum = options.maxInFlight ?? 4;
    if (typeof socketPath !== 'string' || !socketPath.isWellFormed() || !isAbsolute(socketPath) || normalize(socketPath) !== socketPath || Buffer.byteLength(socketPath) > 100 || /[\u0000-\u001f\u007f]/u.test(socketPath) || !Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 5000 || !Number.isSafeInteger(this.#maximum) || this.#maximum < 1 || this.#maximum > 4 || typeof options.guard !== 'function') throw new FirecrackerApiError('vm_firecracker_invalid', 'not_sent');
    this.#socketPath = socketPath; this.#guard = options.guard;
  }
  /** Pending guards and closing descriptors count as active, not just requests awaiting an HTTP reply. */
  active(): number { return this.#active.size; }
  /** Cancels these original metadata/control transports only. It never reports that a microVM stopped. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const active = [...this.#active];
    for (const operation of active) operation.cancel();
    this.#closing = Promise.all(active.map(operation => operation.finished)).then(() => {});
    return this.#closing;
  }
  /** One original operation. Mutations require the caller's durable intent/claim before invocation. */
  async call(operation: FirecrackerApiOperation, signal?: AbortSignal): Promise<unknown> {
    if (typeof operation !== 'string' || !Object.hasOwn(operations, operation)) throw new FirecrackerApiError('vm_firecracker_invalid', 'not_sent');
    if (this.#closed) throw new FirecrackerApiError('vm_firecracker_closed', 'not_sent');
    if (signal?.aborted) throw new FirecrackerApiError('aborted', 'not_sent');
    if (this.#active.size >= this.#maximum) throw new FirecrackerApiError('vm_firecracker_capacity', 'not_sent');
    const selection = operations[operation], finished = Promise.withResolvers<void>();
    let cancel = () => {};
    const entry = { cancel: () => cancel(), finished: finished.promise }; this.#active.add(entry);
    return new Promise<unknown>((resolve, reject) => {
      let request: ClientRequest | null = null, socket: Socket | null = null, requestClosed = true, socketClosed = true;
      let sent = false, bodyComplete = false, httpStatus: number | null = null, released = false;
      let terminal: { ok: true; value: unknown } | { ok: false; error: FirecrackerApiError } | null = null;
      const outcome = (): FirecrackerApiOutcome => !sent ? 'not_sent' : bodyComplete ? 'response' : 'unknown';
      const onAbort = () => fail('aborted');
      const timer = setTimeout(() => fail('vm_firecracker_timeout'), this.#timeout);
      const release = () => {
        if (!terminal || released || !requestClosed || !socketClosed) return;
        released = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
        this.#active.delete(entry); finished.resolve();
        if (terminal.ok) resolve(terminal.value); else reject(terminal.error);
      };
      const settle = (value: NonNullable<typeof terminal>) => {
        if (terminal) return;
        terminal = value; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
        if (!socket && request?.socket) observeSocket(request.socket);
        request?.destroy(); release();
      };
      function fail(code: string) { settle({ ok: false, error: new FirecrackerApiError(code, outcome(), httpStatus) }); }
      async function guard(next: () => void) {
        try {
          await thisGuard();
          if (terminal) return;
          if (signal?.aborted) { fail('aborted'); return; }
          next();
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(error.code) ? error.code : 'vm_firecracker_unavailable';
          fail(code);
        }
      }
      const thisGuard = () => this.#guard();
      function observeSocket(connected: Socket) {
        if (socket === connected) return;
        socket = connected; socketClosed = connected.closed;
        connected.once('close', () => { socketClosed = true; release(); });
      }
      cancel = onAbort; signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      void guard(() => {
        const headers: Record<string, string> = { Accept: 'application/json', Connection: 'close' };
        if (selection.body !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(selection.body)); }
        request = httpRequest({ socketPath: this.#socketPath, path: selection.path, method: selection.method, host: 'localhost', headers,
          agent: false, maxHeaderSize: 8192, insecureHTTPParser: false }, response => {
          response.once('error', () => fail('vm_firecracker_unavailable'));
          response.once('aborted', () => fail('vm_firecracker_unavailable'));
          httpStatus = response.statusCode ?? null;
          const expected = selection.body === null ? 200 : 204;
          if (httpStatus !== expected) { fail('vm_firecracker_api_refused'); return; }
          const raw = response.rawHeaders, names = new Set<string>();
          if (raw.reduce((size, value) => size + Buffer.byteLength(value, 'latin1') + 2, 2) > 8192) { fail('vm_firecracker_protocol_invalid'); return; }
          for (let i = 0; i < raw.length; i += 2) { const name = raw[i]!.toLowerCase(); if (names.has(name)) { fail('vm_firecracker_protocol_invalid'); return; } names.add(name); }
          const length = response.headers['content-length'];
          if (length !== undefined && (!/^(?:0|[1-9]\d{0,5})$/.test(length) || Number(length) > 32768)) { fail('vm_firecracker_protocol_invalid'); return; }
          if (response.headers['content-encoding'] !== undefined && response.headers['content-encoding'] !== 'identity' || selection.body === null && response.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') { fail('vm_firecracker_protocol_invalid'); return; }
          const chunks: Buffer[] = []; let size = 0;
          response.on('data', (chunk: Buffer) => {
            if (terminal) return;
            size += chunk.length;
            if (size > 32768 || selection.body !== null && size !== 0) { fail('vm_firecracker_protocol_invalid'); return; }
            chunks.push(Buffer.from(chunk));
          });
          response.once('end', () => {
            if (terminal) return;
            if (!response.complete) { fail('vm_firecracker_unavailable'); return; }
            bodyComplete = true;
            let value: unknown = null;
            try {
              if (selection.body === null) {
                value = parseCommandJson(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)), 32768);
                if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
              }
            } catch { fail('vm_firecracker_protocol_invalid'); return; }
            void guard(() => settle({ ok: true, value }));
          });
        });
        requestClosed = false;
        request.on('error', () => fail('vm_firecracker_unavailable'));
        request.once('close', () => { requestClosed = true; release(); });
        request.once('socket', connected => {
          observeSocket(connected);
          const dispatch = () => { void guard(() => {
            if (!request || request.destroyed || connected.destroyed) { fail('vm_firecracker_unavailable'); return; }
            sent = true; request.end(selection.body ?? undefined);
          }); };
          if (connected.connecting) connected.once('connect', dispatch); else dispatch();
        });
      });
    });
  }
}
