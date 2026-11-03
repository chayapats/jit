import { lookup } from 'node:dns/promises';
import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { connect, createServer, isIP, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vmPublicAddress } from '../vm/proxy';
import { BrowserError, browserUrl } from './validation';

/** One resolver answer, in the shape `dns.lookup(host, { all: true })` returns. */
export interface BrowserAddress { address: string; family: number }
/**
 * Controller-side DNS and dial seams (BROW15-03), for deterministic tests only; host composition leaves both
 * unset. Defaults: the system resolver, where an IP literal answers itself without a lookup, and a TCP socket
 * to the checked address literal. The public-address rule itself is not a seam and cannot be widened.
 */
export interface BrowserEgressPorts {
  resolve?(host: string): Promise<readonly BrowserAddress[]>;
  connect?(address: string, port: number): Socket;
}
/** The checked destination of one protected request: the URL's host and port, and the one address its socket dials. */
export interface BrowserDestination { host: string; port: number; address: string }
/**
 * One protected request's private route to its checked address. `fetch` runs Bun's fetch over a private Unix
 * socket whose only peer is a TCP connection to `destination.address`, so the hostname is never resolved again.
 * Proxy environment variables (`HTTP(S)_PROXY`, `ALL_PROXY`, `NO_PROXY`), keep-alive reuse and HTTP/2 or
 * HTTP/3 are not used; TLS stays end to end with the URL's host name for SNI and certificate checks.
 */
export interface BrowserRoute {
  readonly destination: Readonly<BrowserDestination>;
  /** Single use, for a URL with exactly this route's host and port. */
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** Stops accepting and destroys this route's sockets. Idempotent; call once the response is consumed. */
  close(): void;
}
/** Per-browser-incarnation egress: one private socket directory, closed with the browser. */
export interface BrowserEgress {
  /** Resolves the URL's host once and refuses before any byte is sent unless every answer is public. */
  route(url: string): Promise<BrowserRoute>;
  close(): void;
}

const resolveMs = 10_000, idleMs = 60_000, routeBytes = 8 * 1_048_576, connectionsPerRoute = 4, openRoutes = 128;
const systemResolve = (host: string): Promise<readonly BrowserAddress[]> =>
  isIP(host) ? Promise.resolve([{ address: host, family: isIP(host) }]) : lookup(host, { all: true, verbatim: true });

/** Canonical address text, so the public-address rule never sees an alternative IPv6 spelling. Null if not an address. */
function canonicalAddress(address: unknown): string | null {
  if (typeof address !== 'string') return null;
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6 || address.includes('%')) return null;
  try { return new URL(`http://[${address}]/`).hostname.slice(1, -1); } catch { return null; }
}

/**
 * Resolves a protected request's destination once and checks every answer with the registry proxy's public-address
 * rule ({@link vmPublicAddress}); the first answer is the one to dial. Loopback, private, shared, link-local and
 * metadata (`169.254.169.254`, `fd00:ec2::254`), unique-local, IPv4-mapped/NAT64 and documentation addresses refuse
 * with `website_address_not_public`, also when only one of several answers is non-public. A failed, empty or slow
 * lookup is `request_unavailable`. Nothing is sent in either case.
 */
export async function browserDestination(url: string, resolve: (host: string) => Promise<readonly BrowserAddress[]> = systemResolve): Promise<BrowserDestination> {
  const target = browserUrl(url), host = target.hostname.replace(/^\[(.*)\]$/, '$1');
  const port = target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80;
  let timer: ReturnType<typeof setTimeout> | undefined, answers: readonly BrowserAddress[];
  try {
    answers = await Promise.race([resolve(host), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), resolveMs); })]);
  } catch { throw new BrowserError('request_unavailable'); } finally { clearTimeout(timer); }
  if (!Array.isArray(answers) || !answers.length) throw new BrowserError('request_unavailable');
  const checked = answers.map(answer => canonicalAddress((answer as Partial<BrowserAddress> | null)?.address));
  if (checked.some(address => address === null || !vmPublicAddress(address))) throw new BrowserError('website_address_not_public');
  return { host, port, address: checked[0]! };
}

/**
 * Opens the protected browser's egress (BROW15-03). Chromium never reaches the network: its unhandled traffic hits
 * the deny-only proxy. The broker's requests leave only through routes from here, each a private Unix socket in a
 * fresh 0700 directory that relays to one checked address. Closing the egress destroys every route and the directory.
 */
export function openBrowserEgress(ports: BrowserEgressPorts = {}): BrowserEgress {
  const resolve = ports.resolve ?? systemResolve;
  const dial = ports.connect ?? ((address: string, port: number) => connect({ host: address, port }));
  // Unix socket paths are limited to about 100 bytes; a long TMPDIR falls back to /tmp.
  const base = Buffer.byteLength(tmpdir()) <= 64 ? tmpdir() : '/tmp';
  const directory = mkdtempSync(join(base, 'jit-egress-'));
  const own = lstatSync(directory);
  if (!own.isDirectory() || own.mode & 0o077 || (process.getuid && own.uid !== process.getuid())) { rmSync(directory, { recursive: true, force: true }); throw new BrowserError('engine_unavailable'); }
  const routes = new Set<BrowserRoute>();
  let serial = 0, closed = false;
  return {
    async route(url) {
      if (closed) throw new BrowserError('engine_unavailable');
      if (routes.size >= openRoutes) throw new BrowserError('request_unavailable');
      const destination = Object.freeze(await browserDestination(url, resolve));
      if (closed) throw new BrowserError('engine_unavailable');
      const path = join(directory, `${++serial}.sock`), sockets = new Set<Socket>();
      let accepted = 0, bytes = 0, used = false, done = false;
      const server = createServer(client => {
        if (done || ++accepted > connectionsPerRoute) { client.destroy(); return; }
        let remote: Socket;
        try { remote = dial(destination.address, destination.port); } catch { client.destroy(); return; }
        const drop = () => { client.destroy(); remote.destroy(); };
        for (const socket of [client, remote]) {
          sockets.add(socket); socket.on('close', () => { sockets.delete(socket); drop(); }); socket.on('error', drop);
          socket.setTimeout(idleMs, drop); socket.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > routeBytes) drop(); });
        }
        client.pipe(remote); remote.pipe(client);
      });
      try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve(); }); }); }
      catch { server.close(); rmSync(path, { force: true }); throw new BrowserError('request_unavailable'); }
      const route: BrowserRoute = {
        destination,
        fetch(target, init) {
          if (used || done) return Promise.reject(new BrowserError('request_unavailable'));
          used = true;
          const u = browserUrl(target), port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
          if (u.hostname.replace(/^\[(.*)\]$/, '$1') !== destination.host || port !== destination.port) return Promise.reject(new BrowserError('request_unavailable'));
          // `unix` replaces DNS and TCP; `proxy: false` ignores every proxy variable, including NO_PROXY.
          return fetch(target, { ...init, unix: path, proxy: false, keepalive: false, protocol: 'http1.1' });
        },
        close() {
          if (done) return; done = true; routes.delete(route);
          server.close(); for (const socket of sockets) socket.destroy(); rmSync(path, { force: true });
        },
      };
      routes.add(route);
      if (closed) { route.close(); throw new BrowserError('engine_unavailable'); }
      return route;
    },
    close() {
      if (closed) return; closed = true;
      for (const route of [...routes]) route.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
