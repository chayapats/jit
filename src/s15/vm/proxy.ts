import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { connect, createServer, isIP, type Socket } from "node:net";
import { registerSecretFingerprint } from "../../security/secret-fingerprints";
import { redactCredentials } from '../../security/credentials';
import { vmFail, vmId, vmInteger } from "./validation";

/** Editable exact destinations for anonymous dependency acquisition; GitHub publication APIs are absent. */
export const defaultVmRegistryHosts: readonly string[] = Object.freeze([
  "archive.ubuntu.com", "security.ubuntu.com", "ports.ubuntu.com", "deb.debian.org", "security.debian.org",
  // Docker Hub serves blobs from either CDN; live x64 evidence (2026-11-03) saw `production.cloudfront.docker.com`.
  "registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com", "production.cloudfront.docker.com",
  "ghcr.io", "pkg-containers.githubusercontent.com", "crates.io", "index.crates.io", "static.crates.io", "proxy.golang.org", "sum.golang.org",
  "objects.githubusercontent.com", "codeload.github.com",
]);
/** Destination-only network observation. Paths, queries, headers, payloads and proxy credentials are never logged. */
export interface VmProxyLog { sessionId: string; host: string; sentBytes: number; receivedBytes: number; state: "closed" | "denied" }
/** A per-session narrow proxy lease, not an account credential or a Jit control-plane capability. */
export interface VmProxyLease {
  environment: Readonly<Record<string, string>>; close(): void;
  /** Moves this lease's expiry (a standing lease is renewed while its VM runs); a closed lease stays closed. */
  renew?(expiresAt: number): void;
}
/** Per-lease rules beyond the proxy's shared host settings. */
export interface VmProxyLeaseRules {
  /**
   * DESK16-01 (ADR 0091 decision 5): hosts this lease must never reach, judged on the requested name before DNS for
   * every host (registry and public web alike). A refusal is logged as `denied`. A filter that throws refuses.
   */
  deny?: (host: string) => boolean;
}
/** Protected proxy settings and deterministic DNS/connect seams. No upstream credential injection exists. */
export interface VmRegistryProxyOptions {
  hostname: string; port: number; guestHostname: string; hosts?: readonly string[];
  /** Listen on this protected Unix socket instead of `hostname:port` (Jit-managed local VMs reach it by guest-forward). */
  socketPath?: string;
  /**
   * Mode of `socketPath` after listening (default 0600). A separate QEMU identity (VM15-03) connects through the
   * shared group, so that layout uses 0660 inside a setgid directory owned by the controller.
   */
  socketMode?: 0o600 | 0o660;
  /**
   * Serve an already-listening Unix socket inherited from systemd socket activation instead of binding
   * `socketPath` (VM15-03). The socket is then bound by the service manager in the host's root mount namespace,
   * so a confined guest-forward helper (AppArmor `nc.openbsd`) can reach it from outside the controller unit's
   * private mount namespace. Its owner, group and mode come from the socket unit; nothing is unlinked or chmodded.
   */
  socketFd?: number;
  /** Port the guest uses in its lease URL when it differs from the listener (fixed guest-forward port). */
  guestPort?: number;
  bytesPerSession?: number; maxConnections?: number; connectionMs?: number;
  /**
   * AUTH16-01 (S16-D09, ADR 0084): the working VM browser may reach the public web, so public and trusted-site work
   * functions. A public DNS name outside the registry list is then allowed on 443 (CONNECT) or 80 (GET/HEAD) after the
   * same public-address check, without a registry disclosure lease. Recorded residual: private data the guest already
   * holds can leave through such a site; Jit-mediated paths keep their disclosure gates. Off unless set.
   */
  publicWeb?: boolean;
  log: (entry: VmProxyLog) => void;
  resolve?: (host: string) => Promise<readonly { address: string; family: number }[]>;
  connect?: (address: string, port: number) => Socket;
}
/** Public-address guard used after DNS resolution and before pinning a connection to that exact address. */
export function vmPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return a > 0 && a < 224 && a !== 10 && a !== 127 && !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 0 || b === 168)) && !(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) && !(a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) === 6) {
    const first = parseInt(address.split(":")[0]!, 16);
    return first >= 0x2000 && first < 0x4000 && !/^2001:(?:db8|0|10|20):/i.test(address) && !/^2002:/i.test(address);
  }
  return false;
}
const nonPublicSuffixes = ["localhost", "local", "localdomain", "internal", "intranet", "lan", "home", "corp", "private", "test", "example", "invalid", "onion", "arpa", "alt"];
/** A public DNS name the public-web mode may resolve: no IP literal, single label or reserved/private suffix. */
export function vmPublicWebHost(host: string): boolean {
  const labels = host.split(".");
  return !isIP(host) && labels.length >= 2 && host.length <= 253 && labels.every(label => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label)) && /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels.at(-1)!)
    && !nonPublicSuffixes.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}
/** Starts a protected finite CONNECT/HTTP proxy. TLS is passthrough: registries see metadata/content; this is not a disclosure firewall. */
export async function startVmRegistryProxy(options: VmRegistryProxyOptions): Promise<{
  port: number; lease(sessionId: string, expiresAt: number, authorize?: (host: string) => void, rules?: VmProxyLeaseRules): VmProxyLease; setHosts(hosts: readonly string[]): void; close(): Promise<void>;
}> {
  const hosts = new Set(options.hosts ?? defaultVmRegistryHosts);
  const publicWeb = options.publicWeb === true;
  if (!hosts.size || hosts.size > 128 || [...hosts].some(h => !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(h) || isIP(h))) vmFail("vm_invalid_setup");
  vmInteger(options.port, 65535, 0); if (options.guestPort !== undefined) vmInteger(options.guestPort, 65535);
  if (options.socketPath !== undefined && (!options.socketPath.startsWith("/") || Buffer.byteLength(options.socketPath) > 100 || options.guestPort === undefined)) vmFail("vm_invalid_setup");
  const maxBytes = options.bytesPerSession ?? 536870912, maxConnections = options.maxConnections ?? 32, connectionMs = options.connectionMs ?? 300000;
  vmInteger(maxBytes, 1073741824); vmInteger(maxConnections, 128); vmInteger(connectionMs, 600000);
  const sessions = new Map<string, { auth: string; expiresAt: number; bytes: number; sockets: Set<Socket>; authorize?: (host: string) => void; deny?: (host: string) => boolean }>(), sockets = new Set<Socket>();
  const resolve = options.resolve ?? (host => lookup(host, { all: true, verbatim: true }));
  const upstream = options.connect ?? ((address, port) => connect({ host: address, port }));
  const server = createServer(client => {
    if (sockets.size >= 128) { client.destroy(); return; }
    sockets.add(client); client.on("close", () => sockets.delete(client)); client.on("error", () => client.destroy());
    const lifetime = setTimeout(() => client.destroy(), connectionMs); client.on("close", () => clearTimeout(lifetime));
    client.setTimeout(10000, () => client.destroy()); let head = Buffer.alloc(0);
    const refuse = (code = 403) => { client.end(`HTTP/1.1 ${code} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    const handle = async (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]); const end = head.indexOf("\r\n\r\n");
      if (end < 0) { if (head.length > 8192) { client.off("data", onData); refuse(400); } return; }
      client.off("data", onData); client.pause();
      if (end > 8192) return refuse(400);
      const raw = head.subarray(0, end).toString("latin1"), rest = head.subarray(end + 4), lines = raw.split("\r\n");
      const match = /^(CONNECT|GET|HEAD) (\S+) HTTP\/1\.[01]$/.exec(lines.shift() ?? ""); if (!match) return refuse(405);
      const headers = new Map<string, string>();
      for (const line of lines) {
        const h = /^([A-Za-z0-9-]+):[ \t]*([^\r\n]*)$/.exec(line);
        if (!h || headers.has(h[1]!.toLowerCase()) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(h[2]!)) return refuse(400);
        headers.set(h[1]!.toLowerCase(), h[2]!.trim());
      }
      const auth = headers.get("proxy-authorization") ?? "", found = [...sessions].find(([, s]) => auth.length === s.auth.length && timingSafeEqual(Buffer.from(auth), Buffer.from(s.auth)));
      if (!found) return refuse(407);
      const [sessionId, session] = found;
      if (Date.now() >= session.expiresAt || session.sockets.size >= maxConnections || session.bytes >= maxBytes) return refuse();
      let host: string, port: number, destination: URL | undefined;
      if (match[1] === "CONNECT") {
        const target = /^([a-zA-Z0-9.-]{1,253}):443$/.exec(match[2]!); if (!target) return refuse(); host = target[1]!.toLowerCase(); port = 443;
      } else {
        try { destination = new URL(match[2]!); } catch { return refuse(400); }
        if (destination.protocol !== "http:" || destination.username || destination.password || destination.hash || destination.port && destination.port !== "80" || rest.length || headers.has("transfer-encoding") || headers.has("content-length") && headers.get("content-length") !== "0") return refuse();
        host = destination.hostname.toLowerCase(); port = 80;
      }
      const denied = () => { options.log({ sessionId, host: redactCredentials(host), sentBytes: 0, receivedBytes: 0, state: "denied" }); refuse(); };
      if (session.deny) { let refused = true; try { refused = session.deny(host); } catch { /* A failing filter refuses. */ } if (refused) return denied(); }
      const registry = hosts.has(host), authorize = registry ? session.authorize : undefined;
      if (!registry && !(publicWeb && vmPublicWebHost(host))) return denied();
      try { authorize?.(host); } catch { return denied(); }
      // Reserve before asynchronous DNS so concurrent requests cannot all pass the same capacity check.
      session.sockets.add(client); client.once("close", () => session.sockets.delete(client));
      let addresses; try { addresses = await resolve(host); } catch { session.sockets.delete(client); return refuse(502); }
      if (!addresses.length || addresses.some(a => !vmPublicAddress(a.address)) || !sessions.has(sessionId) || Date.now() >= session.expiresAt || client.destroyed) { session.sockets.delete(client); return denied(); }
      try { authorize?.(host); } catch { return denied(); }
      const remote = upstream(addresses[0]!.address, port); sockets.add(remote);
      let sentBytes = 0, receivedBytes = 0, logged = false;
      const record = () => { if (logged) return; logged = true; options.log({ sessionId, host: redactCredentials(host), sentBytes, receivedBytes, state: "closed" }); };
      client.on("close", () => { remote.destroy(); session.sockets.delete(client); record(); });
      remote.on("close", () => { sockets.delete(remote); client.destroy(); record(); });
      remote.on("error", () => { refuse(502); remote.destroy(); }); remote.setTimeout(30000, () => remote.destroy());
      const charge = (count: number) => { let current = true; try { authorize?.(host); } catch { current = false; } session.bytes += count; if (!current || session.bytes > maxBytes || Date.now() >= session.expiresAt || !sessions.has(sessionId)) { client.destroy(); remote.destroy(); return false; } return true; };
      client.on("data", b => { sentBytes += b.length; charge(b.length); }); remote.on("data", b => { receivedBytes += b.length; charge(b.length); });
      remote.once("connect", () => {
        if (!sessions.has(sessionId) || client.destroyed || Date.now() >= session.expiresAt) { remote.destroy(); return; }
        try { authorize?.(host); } catch { remote.destroy(); return; }
        if (match[1] === "CONNECT") { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (rest.length && charge(rest.length)) { sentBytes += rest.length; remote.write(rest); } }
        else {
          const safe = ["user-agent", "accept", "range", "if-modified-since", "if-none-match", "cache-control"].flatMap(k => headers.has(k) ? [`${k}: ${headers.get(k)}`] : []);
          const request = `${match[1]} ${destination!.pathname}${destination!.search} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n${safe.length ? safe.join("\r\n") + "\r\n" : ""}\r\n`;
          if (charge(Buffer.byteLength(request))) { sentBytes += Buffer.byteLength(request); remote.write(request); }
        }
        client.setTimeout(30000); client.pipe(remote); remote.pipe(client); client.resume();
      });
    };
    const onData = (chunk: Buffer) => { void handle(chunk).catch(() => client.destroy()); }; client.on("data", onData);
  });
  if (options.socketFd !== undefined) {
    vmInteger(options.socketFd, 1024, 3);
    if (!options.socketPath || options.guestPort === undefined) vmFail("vm_invalid_setup");
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ fd: options.socketFd! }, resolve); });
  } else if (options.socketPath) {
    // A stale socket from an earlier controller process is replaced; any other file type is refused.
    const stale = lstatSync(options.socketPath, { throwIfNoEntry: false });
    if (stale && !stale.isSocket()) vmFail("vm_proxy_unavailable"); if (stale) unlinkSync(options.socketPath);
  }
  if (options.socketFd === undefined) await new Promise<void>((resolve, reject) => { server.once("error", reject); if (options.socketPath) server.listen(options.socketPath, resolve); else server.listen(options.port, options.hostname, resolve); });
  const address = server.address();
  if (options.socketFd !== undefined) { /* Inherited listener: the socket unit owns its path, owner, group and mode. */ }
  else if (options.socketPath) { if (address !== options.socketPath) vmFail("vm_proxy_unavailable"); chmodSync(options.socketPath, options.socketMode ?? 0o600); }
  else if (!address || typeof address === "string") vmFail("vm_proxy_unavailable");
  const listenerPort = typeof address === "object" && address ? address.port : 0, guestPort = options.guestPort ?? listenerPort;
  return { port: listenerPort,
    lease(sessionId, expiresAt, authorize, rules) {
      vmId(sessionId); if (sessions.has(sessionId) || sessions.size >= 64 || expiresAt <= Date.now()) vmFail("vm_proxy_unavailable");
      if (rules?.deny !== undefined && typeof rules.deny !== "function") vmFail("vm_invalid_setup");
      const password = randomBytes(24).toString("hex"), auth = `Basic ${Buffer.from(`${sessionId}:${password}`).toString("base64")}`;
      registerSecretFingerprint(password); registerSecretFingerprint(auth);
      const session = { auth, expiresAt, bytes: 0, sockets: new Set<Socket>(), ...(authorize ? { authorize } : {}), ...(rules?.deny ? { deny: rules.deny } : {}) }; sessions.set(sessionId, session);
      const url = `http://${sessionId}:${password}@${options.guestHostname}:${guestPort}`;
      return { environment: Object.freeze(Object.fromEntries(["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].map(k => [k, url]))),
        close() { sessions.delete(sessionId); for (const s of session.sockets) s.destroy(); },
        renew(next) { if (sessions.get(sessionId) !== session) return; if (!Number.isFinite(next) || next <= Date.now()) vmFail("vm_proxy_unavailable"); session.expiresAt = next; } };
    },
    setHosts(next) {
      if (!next.length || next.length > 128 || next.some(h => typeof h !== "string" || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(h) || isIP(h)) || new Set(next).size !== next.length) vmFail("vm_invalid_setup");
      // A changed allowlist closes existing tunnels before any new connection can use its narrowed scope.
      for (const socket of sockets) socket.destroy(); hosts.clear(); for (const host of next) hosts.add(host);
    },
    close: () => new Promise<void>(resolve => { sessions.clear(); for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }),
  };
}
