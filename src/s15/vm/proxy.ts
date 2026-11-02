import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { connect, createServer, isIP, type Socket } from "node:net";
import { registerSecretFingerprint } from "../../security/secret-fingerprints";
import { vmFail, vmId, vmInteger } from "./validation";

/** Editable exact destinations for anonymous dependency acquisition; GitHub publication APIs are absent. */
export const defaultVmRegistryHosts: readonly string[] = Object.freeze([
  "archive.ubuntu.com", "security.ubuntu.com", "ports.ubuntu.com", "deb.debian.org", "security.debian.org",
  "registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com",
  "ghcr.io", "pkg-containers.githubusercontent.com", "crates.io", "index.crates.io", "static.crates.io", "proxy.golang.org", "sum.golang.org",
  "objects.githubusercontent.com", "codeload.github.com",
]);
/** Destination-only network observation. Paths, queries, headers, payloads and proxy credentials are never logged. */
export interface VmProxyLog { sessionId: string; host: string; sentBytes: number; receivedBytes: number; state: "closed" | "denied" }
/** A per-session narrow proxy lease, not an account credential or a Jit control-plane capability. */
export interface VmProxyLease { environment: Readonly<Record<string, string>>; close(): void }
/** Protected proxy settings and deterministic DNS/connect seams. No upstream credential injection exists. */
export interface VmRegistryProxyOptions {
  hostname: string; port: number; guestHostname: string; hosts?: readonly string[];
  bytesPerSession?: number; maxConnections?: number; connectionMs?: number;
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
/** Starts a protected finite CONNECT/HTTP proxy. TLS is passthrough: registries see metadata/content; this is not a disclosure firewall. */
export async function startVmRegistryProxy(options: VmRegistryProxyOptions): Promise<{
  port: number; lease(sessionId: string, expiresAt: number): VmProxyLease; close(): Promise<void>;
}> {
  const hosts = new Set(options.hosts ?? defaultVmRegistryHosts);
  if (!hosts.size || hosts.size > 128 || [...hosts].some(h => !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(h) || isIP(h))) vmFail("vm_invalid_setup");
  vmInteger(options.port, 65535, 0);
  const maxBytes = options.bytesPerSession ?? 536870912, maxConnections = options.maxConnections ?? 32, connectionMs = options.connectionMs ?? 300000;
  vmInteger(maxBytes, 1073741824); vmInteger(maxConnections, 128); vmInteger(connectionMs, 600000);
  const sessions = new Map<string, { auth: string; expiresAt: number; bytes: number; sockets: Set<Socket> }>(), sockets = new Set<Socket>();
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
      const denied = () => { options.log({ sessionId, host, sentBytes: 0, receivedBytes: 0, state: "denied" }); refuse(); };
      if (!hosts.has(host)) return denied();
      let addresses; try { addresses = await resolve(host); } catch { return refuse(502); }
      if (!addresses.length || addresses.some(a => !vmPublicAddress(a.address)) || !sessions.has(sessionId) || Date.now() >= session.expiresAt || client.destroyed) return denied();
      const remote = upstream(addresses[0]!.address, port); session.sockets.add(client); sockets.add(remote);
      let sentBytes = 0, receivedBytes = 0, logged = false;
      const record = () => { if (logged) return; logged = true; options.log({ sessionId, host, sentBytes, receivedBytes, state: "closed" }); };
      client.on("close", () => { remote.destroy(); session.sockets.delete(client); record(); });
      remote.on("close", () => { sockets.delete(remote); client.destroy(); record(); });
      remote.on("error", () => { refuse(502); remote.destroy(); }); remote.setTimeout(30000, () => remote.destroy());
      const charge = (count: number) => { session.bytes += count; if (session.bytes > maxBytes || Date.now() >= session.expiresAt || !sessions.has(sessionId)) { client.destroy(); remote.destroy(); return false; } return true; };
      client.on("data", b => { sentBytes += b.length; charge(b.length); }); remote.on("data", b => { receivedBytes += b.length; charge(b.length); });
      remote.once("connect", () => {
        if (!sessions.has(sessionId) || client.destroyed || Date.now() >= session.expiresAt) { remote.destroy(); return; }
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
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.hostname, resolve); });
  const address = server.address(); if (!address || typeof address === "string") vmFail("vm_proxy_unavailable");
  return { port: address.port,
    lease(sessionId, expiresAt) {
      vmId(sessionId); if (sessions.has(sessionId) || sessions.size >= 64 || expiresAt <= Date.now()) vmFail("vm_proxy_unavailable");
      const password = randomBytes(24).toString("hex"), auth = `Basic ${Buffer.from(`${sessionId}:${password}`).toString("base64")}`;
      registerSecretFingerprint(password); registerSecretFingerprint(auth);
      const session = { auth, expiresAt, bytes: 0, sockets: new Set<Socket>() }; sessions.set(sessionId, session);
      const url = `http://${sessionId}:${password}@${options.guestHostname}:${address.port}`;
      return { environment: Object.freeze(Object.fromEntries(["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].map(k => [k, url]))),
        close() { sessions.delete(sessionId); for (const s of session.sockets) s.destroy(); } };
    },
    close: () => new Promise<void>(resolve => { sessions.clear(); for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }),
  };
}
