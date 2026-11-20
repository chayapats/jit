import { createServer, type Socket } from 'node:net';
import { AppError } from '../../../errors';
import { connectFirecrackerVsock, validateFirecrackerVsock, type FirecrackerVsockOptions } from './vsock';

/** Controller-only loopback listener over one fixed, guarded Firecracker guest SSH/vsock service. */
export interface FirecrackerSshForwarder {
  readonly endpoint: { host: '127.0.0.1'; port: number };
  /** Actual live client/negotiation transports; no guest execution settlement is implied. */
  active(): number;
  /** Closes listener and every original TCP/Unix channel; idempotent and does not stop a VM. */
  close(): Promise<void>;
}

/**
 * Lets the existing pinned-host-key SSH runner reach a NIC-free microVM without a new guest protocol.
 * Selection is trusted host configuration only. No public bind address, arbitrary upstream, retry,
 * shell, guest-to-host listener or management API is exposed. Capacity includes pending negotiations
 * and is retained until both original descriptors close. Pipe backpressure bounds opaque SSH buffers.
 */
export async function openFirecrackerSshForwarder(options: FirecrackerVsockOptions & { maxConnections?: number; listenPort?: number }): Promise<FirecrackerSshForwarder> {
  options = Object.freeze({ ...options });
  const maximum = options.maxConnections ?? 16;
  const listenPort = options.listenPort ?? 0;
  if (!Number.isSafeInteger(listenPort) || listenPort < 0 || listenPort > 65535) throw new AppError('vm_vsock_invalid');
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16) throw new AppError('vm_vsock_invalid');
  const timeoutMs = validateFirecrackerVsock(options);
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const connections = new Set<Promise<void>>(), sockets = new Set<Socket>(), aborts = new Set<AbortController>();
  let accepting = false, stopping = false, closure: Promise<void> | null = null;
  const server = createServer(client => {
    client.pause();
    client.on('error', () => {});
    // Refuse new admissions while earlier TCP/Unix descriptors are still settling, even after a
    // disconnected client vanished from the operating system's listener connection count.
    if (!accepting || stopping || client.remoteAddress !== '127.0.0.1' || connections.size >= maximum) { client.destroy(); return; }
    const abort = new AbortController(), clientClosed = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>();
    let upstream: Awaited<ReturnType<typeof connectFirecrackerVsock>> | null = null;
    connections.add(finished.promise); sockets.add(client); aborts.add(abort);
    client.on('error', () => { abort.abort(); upstream?.close(); });
    client.once('close', () => { clientClosed.resolve(); abort.abort(); upstream?.close(); });
    void (async () => {
      try {
        upstream = await connectFirecrackerVsock({ socketPath: options.socketPath, guestPort: options.guestPort,
          timeoutMs, signal: abort.signal, guard: options.guard });
        if (stopping || client.destroyed || abort.signal.aborted) { upstream.close(); return; }
        upstream.socket.on('error', () => client.destroy());
        upstream.socket.once('close', () => client.destroy());
        client.pipe(upstream.socket); upstream.socket.pipe(client);
        await upstream.closed;
      } catch { client.destroy(); }
      finally {
        client.destroy(); upstream?.close();
        if (upstream) await upstream.closed;
        await clientClosed.promise;
        aborts.delete(abort); sockets.delete(client); connections.delete(finished.promise); finished.resolve();
      }
    })();
  });
  // An individual failed socket never becomes an uncaught process error; listener errors during
  // initial bind still reject the startup promise below. No address is advertised before final guard.
  server.on('error', () => {});
  server.maxConnections = maximum;
  const close = (): Promise<void> => {
    if (closure) return closure;
    stopping = true; accepting = false;
    options.signal?.removeEventListener('abort', onAbort);
    closure = (async () => {
      const closed = new Promise<void>(resolve => { server.close(() => resolve()); });
      for (const abort of aborts) abort.abort();
      for (const socket of sockets) socket.destroy();
      await closed; await Promise.all([...connections]);
    })();
    return closure;
  };
  const interrupted = Promise.withResolvers<never>();
  const onAbort = () => { interrupted.reject(new DOMException('Aborted', 'AbortError')); void close(); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { interrupted.reject(new AppError('vm_vsock_timeout', 503)); void close(); }, timeoutMs);
  try {
    const prepared = (async (): Promise<FirecrackerSshForwarder> => {
      await options.guard();
      if (stopping || options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      await new Promise<void>((resolve, reject) => {
        const error = () => reject(new AppError('vm_vsock_unavailable', 503));
        server.once('error', error);
        server.listen({ host: '127.0.0.1', port: listenPort, exclusive: true }, () => { server.removeListener('error', error); resolve(); });
      });
      await options.guard();
      const address = server.address();
      if (!address || typeof address === 'string' || stopping || options.signal?.aborted) throw new AppError('vm_vsock_unavailable', 503);
      accepting = true;
      return { endpoint: { host: '127.0.0.1', port: address.port }, active: () => connections.size, close };
    })();
    if (options.signal?.aborted) onAbort();
    return await Promise.race([prepared, interrupted.promise]);
  } catch (error) { await close(); throw error; }
  finally { clearTimeout(timer); }
}
