import { connect, createServer, type Server, type Socket } from "node:net";

/** Opens the upstream TLS-tunnel socket for an allowed `host:443` (injected by tests). */
export type UpstreamConnector = (host: string, port: number) => Socket;

/** Options of {@link startRegistryProxy}. */
export interface RegistryProxyOptions {
  /** The internal network gateway address the proxy binds to (`127.0.0.1` in tests). */
  hostname: string;
  /** 0 picks a free port. */
  port: number;
  /** `config.execution.registryHosts`: exact host names, compared case-insensitively. */
  hosts: readonly string[];
  /** Receives one line per refused request, naming only the refused host (no path, query or header). */
  log?: (line: string) => void;
  connectUpstream?: UpstreamConnector;
}

/** A running proxy and its `http://host:port` URL for the box `HTTP(S)_PROXY` variables. */
export interface RegistryProxy { readonly url: string; readonly port: number; close(): Promise<void> }

const maxHeaderBytes = 8192;
const headerMs = 10_000;

/**
 * The Jit-owned registry allowlist proxy of `workspace` boxes (EXE03, ADR 0036). It speaks only HTTP `CONNECT`
 * and tunnels a connection only to an allowlisted host on port 443; every other request — another host, another
 * port, an IP literal, a plain-HTTP method or a malformed head — gets `403` (or `400`/`405`) and is closed. The
 * proxy never sees TLS plaintext and stores nothing. Each refusal is logged by host name only.
 */
export async function startRegistryProxy(options: RegistryProxyOptions): Promise<RegistryProxy> {
  const allowed = new Set(options.hosts.map(host => host.toLowerCase()));
  const log = options.log ?? (line => console.error(line));
  const upstream = options.connectUpstream ?? ((host, port) => connect({ host, port }));
  const sockets = new Set<Socket>();
  const server: Server = createServer(client => {
    sockets.add(client); client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    client.setTimeout(headerMs, () => client.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) { if (head.length > maxHeaderBytes) refuse(client, 400); return; }
      client.off("data", onData);
      const rest = head.subarray(end + 4);
      const line = head.subarray(0, end).toString("latin1").split("\r\n")[0] ?? "";
      const match = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(line);
      if (!match) return refuse(client, 400);
      if (match[1] !== "CONNECT") { log(`registry proxy refused method ${match[1]}`); return refuse(client, 405); }
      const target = /^([A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(match[2]!);
      const host = target?.[1]?.toLowerCase().replace(/\.$/, "") ?? "";
      if (!target || target[2] !== "443" || !allowed.has(host)) {
        log(`registry proxy refused ${target ? host : "malformed-target"}`);
        return refuse(client, 403);
      }
      client.setTimeout(0);
      const remote = upstream(host, 443);
      sockets.add(remote); remote.on("close", () => sockets.delete(remote));
      remote.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) remote.write(rest);
        client.pipe(remote); remote.pipe(client);
      });
      remote.on("error", () => { if (!client.destroyed) refuse(client, 502); remote.destroy(); });
      client.on("close", () => remote.destroy());
    };
    client.on("data", onData);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.hostname, () => resolve()); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const hostPart = options.hostname.includes(":") ? `[${options.hostname}]` : options.hostname;
  return {
    url: `http://${hostPart}:${port}`, port,
    close: () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }),
  };
}

function refuse(client: Socket, status: 400 | 403 | 405 | 502): void {
  const text = { 400: "Bad Request", 403: "Forbidden", 405: "Method Not Allowed", 502: "Bad Gateway" }[status];
  client.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
