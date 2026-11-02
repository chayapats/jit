import { afterEach, expect, test } from "bun:test";
import { connect, createServer, type Server } from "node:net";
import { defaultVmRegistryHosts, startVmRegistryProxy, vmPublicAddress, type VmProxyLog } from "../src/s15/vm/proxy";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function exchange(port: number, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1"), chunks: Buffer[] = []; socket.setTimeout(2000, () => socket.destroy(new Error("test timeout")));
    socket.on("connect", () => socket.write(input)); socket.on("data", b => chunks.push(typeof b === "string" ? Buffer.from(b) : b)); socket.on("end", () => { socket.destroy(); resolve(Buffer.concat(chunks).toString()); }); socket.on("error", reject);
  });
}
const auth = (url: string) => { const u = new URL(url); return `Basic ${Buffer.from(`${u.username}:${u.password}`).toString("base64")}`; };
const input = (target: string, authorization: string, method = "CONNECT") => `${method} ${target} HTTP/1.1\r\nHost: registry.test\r\nProxy-Authorization: ${authorization}\r\n\r\n`;

test("default registry set excludes publication targets and includes ordinary package ecosystems", () => {
  for (const h of ["registry.npmjs.org", "pypi.org", "registry-1.docker.io", "ports.ubuntu.com", "proxy.golang.org", "crates.io", "ghcr.io"]) expect(defaultVmRegistryHosts).toContain(h);
  for (const h of ["github.com", "api.github.com", "smtp.gmail.com"]) expect(defaultVmRegistryHosts).not.toContain(h);
});
test.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.5.2", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::ffff:127.0.0.1", "fe80::1", "2001:db8::1", "2002:7f00:1::"])("DNS guard rejects private/metadata/special address %s", address => { expect(vmPublicAddress(address)).toBe(false); });
test("unleased clients, unapproved destinations, malformed headers and DNS rebinding refuse before upstream I/O", async () => {
  let calls = 0; const logs: VmProxyLog[] = [];
  const proxy = await startVmRegistryProxy({ hostname: "127.0.0.1", guestHostname: "127.0.0.1", port: 0, hosts: ["registry.test"], log: e => logs.push(e), resolve: async () => [{ address: "127.0.0.1", family: 4 }], connect: () => { calls++; throw new Error("must not connect"); } }); cleanups.push(proxy.close);
  const lease = proxy.lease("session1", Date.now() + 10000), a = auth(lease.environment.HTTP_PROXY!);
  expect(await exchange(proxy.port, input("registry.test:443", "bad"))).toContain("407");
  expect(await exchange(proxy.port, input("github.com:443", a))).toContain("403");
  expect(await exchange(proxy.port, input("registry.test:443", a))).toContain("403");
  expect(await exchange(proxy.port, input("registry.test:22", a))).toContain("403");
  expect(await exchange(proxy.port, input("registry.test:443", a).replace("\r\n\r\n", "\r\nHost: duplicate\r\n\r\n"))).toContain("400");
  expect(calls).toBe(0); expect(logs.some(e => e.host === "github.com" && e.state === "denied")).toBe(true);
  lease.close(); expect(await exchange(proxy.port, input("registry.test:443", a))).toContain("407");
});
test("HTTP acquisition strips proxy authorization and logs only session/destination/counts", async () => {
  let request = "";
  const upstream = createServer(socket => { socket.once("data", b => { request = b.toString(); socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"); }); });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve)); cleanups.push(() => new Promise(resolve => upstream.close(() => resolve())));
  const port = (upstream.address() as { port: number }).port, logs: VmProxyLog[] = [];
  const proxy = await startVmRegistryProxy({ hostname: "127.0.0.1", guestHostname: "127.0.0.1", port: 0, hosts: ["registry.test"], log: e => logs.push(e),
    resolve: async () => [{ address: "93.184.216.34", family: 4 }], connect: (address, destinationPort) => { expect(address).toBe("93.184.216.34"); expect(destinationPort).toBe(80); return connect(port, "127.0.0.1"); } }); cleanups.unshift(proxy.close);
  const lease = proxy.lease("work_session", Date.now() + 10000);
  expect(await exchange(proxy.port, input("http://registry.test/package?version=1", auth(lease.environment.HTTP_PROXY!), "GET"))).toContain("ok");
  expect(request).toContain("GET /package?version=1 HTTP/1.1"); expect(request.toLowerCase()).not.toContain("authorization");
  expect(Object.keys(logs[0]!).sort()).toEqual(["host", "receivedBytes", "sentBytes", "sessionId", "state"]); expect(logs[0]?.receivedBytes).toBeGreaterThan(0);
});
test("a pending DNS lookup reserves the session connection slot and failure releases it", async () => {
  const entered = Promise.withResolvers<void>(), dns = Promise.withResolvers<readonly { address: string; family: number }[]>(); let lookups = 0, connects = 0;
  const upstream = createServer(socket => socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")));
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve)); cleanups.push(() => new Promise(resolve => upstream.close(() => resolve())));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const proxy = await startVmRegistryProxy({ hostname: "127.0.0.1", guestHostname: "127.0.0.1", port: 0, hosts: ["registry.test"], maxConnections: 1, log() {},
    resolve: async () => { if (++lookups === 1) { entered.resolve(); return dns.promise; } return [{ address: "93.184.216.34", family: 4 }]; },
    connect: () => { connects++; return connect(upstreamPort, "127.0.0.1"); } }); cleanups.unshift(proxy.close);
  const lease = proxy.lease("dns_session", Date.now() + 10000), request = input("http://registry.test/package", auth(lease.environment.HTTP_PROXY!), "GET");
  const first = exchange(proxy.port, request); await entered.promise;
  expect(await exchange(proxy.port, request)).toContain("403"); expect(lookups).toBe(1); expect(connects).toBe(0);
  dns.reject(new Error("DNS failure")); expect(await first).toContain("502");
  expect(await exchange(proxy.port, request)).toContain("ok"); expect(lookups).toBe(2); expect(connects).toBe(1);
});
