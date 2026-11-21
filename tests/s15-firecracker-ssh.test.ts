import { afterEach, expect, test } from 'bun:test';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFirecrackerSshForwarder, type FirecrackerSshForwarder } from '../src/s15/vm/firecracker/ssh-forwarder';

const fixtures: { server: Server; directory: string; sockets: Set<Socket>; forwarders: FirecrackerSshForwarder[]; clients: Socket[] }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const client of f.clients) client.destroy();
    await Promise.all(f.forwarders.map(forwarder => forwarder.close()));
    for (const socket of f.sockets) socket.destroy();
    await new Promise<void>(resolve => f.server.close(() => resolve())); rmSync(f.directory, { recursive: true, force: true });
  }
});
async function fixture(reply: (socket: Socket) => void = socket => socket.write('OK 12345\nSSH-2.0-guest\r\n')) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'jit-fcssh-'))), path = join(directory, 'v.sock'), sockets = new Set<Socket>(), commands: string[] = [], forwarders: FirecrackerSshForwarder[] = [], clients: Socket[] = [];
  const entered = Promise.withResolvers<void>(), data = Promise.withResolvers<Buffer>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    let negotiation = '';
    const first = (chunk: Buffer) => {
      negotiation += chunk.toString(); if (!negotiation.includes('\n')) return;
      commands.push(negotiation.slice(0, negotiation.indexOf('\n') + 1)); socket.removeListener('data', first);
      socket.on('data', chunk => { data.resolve(Buffer.from(chunk)); socket.write(chunk); }); entered.resolve(); reply(socket);
    };
    socket.on('data', first);
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const f = { server, directory, sockets, forwarders, clients }; fixtures.push(f);
  return { path, commands, entered: entered.promise, data: data.promise,
    async start(guard: () => void | Promise<void> = () => {}, maxConnections = 16, listenPort = 0) { const forwarder = await openFirecrackerSshForwarder({ socketPath: path, guestPort: 2222, guard, maxConnections, listenPort }); forwarders.push(forwarder); return forwarder; },
    async connect(forwarder: FirecrackerSshForwarder) { const client = createConnection(forwarder.endpoint); client.on('error', () => {}); clients.push(client); await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); }); return client; },
  };
}
const received = (socket: Socket) => new Promise<Buffer>(resolve => socket.once('data', chunk => resolve(Buffer.from(chunk))));
const closed = (socket: Socket) => new Promise<void>(resolve => socket.closed ? resolve() : socket.once('close', () => resolve()));

test('installed loopback selection is retained across restart and an occupied port never falls back', async () => {
  const f = await fixture(), first = await f.start(), port = first.endpoint.port; await first.close();
  const current = await f.start(() => {}, 16, port); expect(current.endpoint).toEqual({ host: '127.0.0.1', port });
  await expect(f.start(() => {}, 16, port)).rejects.toMatchObject({ code: 'vm_vsock_unavailable' });
  const client = await f.connect(current); expect((await received(client)).toString()).toBe('SSH-2.0-guest\r\n'); expect(f.commands).toEqual(['CONNECT 2222\n']);
});

test('invalid installed ports refuse before binding or checking a protected socket', async () => {
  let checks = 0;
  for (const listenPort of [-1, 65536, 1.5, NaN]) await expect(openFirecrackerSshForwarder({ socketPath: '/protected/vsock.sock', guestPort: 22, listenPort, guard() { checks++; } })).rejects.toMatchObject({ code: 'vm_vsock_invalid' });
  expect(checks).toBe(0);
});

test('real loopback-to-vsock lane preserves opaque bidirectional SSH bytes over the original channel', async () => {
  const f = await fixture(), forwarder = await f.start(), client = await f.connect(forwarder);
  expect(forwarder.endpoint.host).toBe('127.0.0.1'); expect((await received(client)).toString()).toBe('SSH-2.0-guest\r\n');
  const response = received(client), payload = Buffer.from([0, 255, 10, 32, 1, 2, 3]); client.write(payload);
  expect(await f.data).toEqual(payload); expect(await response).toEqual(payload); expect(f.commands).toEqual(['CONNECT 2222\n']); expect(forwarder.active()).toBe(1);
  await forwarder.close(); expect(forwarder.active()).toBe(0); await closed(client);
});

test('bounded capacity counts a silent pending negotiation and a second client opens no upstream', async () => {
  const f = await fixture(() => {}), forwarder = await f.start(() => {}, 1), first = await f.connect(forwarder);
  await f.entered; expect(forwarder.active()).toBe(1);
  const second = await f.connect(forwarder); await closed(second); expect(f.commands).toEqual(['CONNECT 2222\n']);
  await forwarder.close(); expect(forwarder.active()).toBe(0); await closed(first);
});

test('listener stop aborts a pending final guard, closes original transports and cannot publish late bytes', async () => {
  const pending = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let calls = 0;
  const f = await fixture();
  const forwarder = await f.start(async () => { if (++calls === 5) { pending.resolve(); await release.promise; } });
  const client = await f.connect(forwarder); let observed = Buffer.alloc(0); client.on('data', chunk => { observed = Buffer.concat([observed, Buffer.from(chunk)]); });
  await pending.promise;
  await forwarder.close(); release.resolve(); expect(forwarder.active()).toBe(0); await closed(client); expect(observed.length).toBe(0); expect(f.commands).toHaveLength(1);
  await forwarder.close();
});

test('a stale current-generation guard refuses new handoffs without fabricating a VM stop', async () => {
  let live = true;
  const f = await fixture(), forwarder = await f.start(() => { if (!live) throw Object.assign(new Error('stale'), { code: 'vm_fenced' }); });
  live = false; const client = await f.connect(forwarder); await closed(client); expect(f.commands).toEqual([]);
  await forwarder.close(); expect(forwarder.active()).toBe(0);
});

test('invalid capacity refuses before binding or reading a protected upstream', async () => {
  let guards = 0;
  for (const maximum of [0, 17, 1.5]) await expect(openFirecrackerSshForwarder({ socketPath: '/unused', guestPort: 52, maxConnections: maximum, guard() { guards++; } })).rejects.toMatchObject({ code: 'vm_vsock_invalid' });
  expect(guards).toBe(0);
});

test('listener preparation has a finite deadline and a late guard cannot bind an endpoint', async () => {
  const release = Promise.withResolvers<void>();
  await expect(openFirecrackerSshForwarder({ socketPath: '/unused', guestPort: 52, timeoutMs: 20, guard: () => release.promise })).rejects.toMatchObject({ code: 'vm_vsock_timeout' });
  release.resolve(); await Promise.resolve();
});

test('parent lifecycle abort closes already handed-off channels and listener exactly once', async () => {
  const abort = new AbortController(), f = await fixture();
  const forwarder = await openFirecrackerSshForwarder({ socketPath: f.path, guestPort: 2222, signal: abort.signal, guard() {} });
  const client = await f.connect(forwarder); await received(client); expect(forwarder.active()).toBe(1);
  abort.abort(); await forwarder.close(); await closed(client); expect(forwarder.active()).toBe(0); expect(f.commands).toHaveLength(1);
});
