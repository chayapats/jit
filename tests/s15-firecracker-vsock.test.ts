import { afterEach, expect, test } from 'bun:test';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { connectFirecrackerVsock } from '../src/s15/vm/firecracker/vsock';

const fixtures: { server: Server; directory: string; sockets: Set<Socket> }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const socket of f.sockets) socket.destroy();
    await new Promise<void>(resolve => f.server.close(() => resolve()));
    rmSync(f.directory, { recursive: true, force: true });
  }
});
async function fixture(accept: (socket: Socket, command: string) => void) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'jit-fc-'))), path = join(directory, 'v.sock'), sockets = new Set<Socket>(), commands: string[] = [];
  const connected = Promise.withResolvers<void>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); connected.resolve();
    let text = '';
    socket.on('data', bytes => { text += bytes.toString('utf8'); if (text.includes('\n')) { const command = text.slice(0, text.indexOf('\n') + 1); commands.push(command); text = ''; accept(socket, command); } });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => resolve()); });
  fixtures.push({ server, directory, sockets }); return { path, commands, connected: connected.promise, sockets };
}
const bytes = (socket: Socket) => new Promise<Buffer>((resolve, reject) => { socket.once('data', value => { socket.pause(); resolve(Buffer.from(value)); }); socket.once('error', reject); socket.resume(); });

test('real Unix/vsock handshake preserves coalesced SSH bytes and accepts a distinct assigned HOST port', async () => {
  const f = await fixture((socket, command) => { expect(command).toBe('CONNECT 2222\n'); socket.write('OK 1073741825\nSSH-2.0-controlled-guest\r\n'); });
  let guards = 0; const channel = await connectFirecrackerVsock({ socketPath: f.path, guestPort: 2222, guard() { guards++; } });
  expect(guards).toBe(3); expect(channel.hostPort).toBe(1073741825); expect(channel.socket.isPaused()).toBe(true);
  expect((await bytes(channel.socket)).toString()).toBe('SSH-2.0-controlled-guest\r\n'); expect(f.commands).toEqual(['CONNECT 2222\n']);
  let closed = false; void channel.closed.then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false);
  channel.close(); channel.close(); await channel.closed; expect(closed).toBe(true);
});

test('fragmented acknowledgement is bounded and the first SSH packet remains intact', async () => {
  const sent = Promise.withResolvers<void>();
  const f = await fixture(socket => { socket.write('O'); void sent.promise.then(() => socket.write('K 72\nSSH-2.0-fixture\r\n')); });
  const waiting = connectFirecrackerVsock({ socketPath: f.path, guestPort: 52, guard() {} });
  await f.connected; sent.resolve(); const channel = await waiting;
  expect(channel.hostPort).toBe(72); expect((await bytes(channel.socket)).toString()).toBe('SSH-2.0-fixture\r\n'); channel.close(); await channel.closed;
});

test.each(['NO 2\n', 'OK 0\n', 'OK 01\n', 'OK 4294967295\n', 'OK 4294967296\n', 'OK -2\n', 'OK 2\r\n', 'OK 2 extra\n', 'A'.repeat(33), '\nOK 2\n'])('invalid acknowledgement refuses one original connection: %j', async reply => {
  const f = await fixture(socket => socket.end(reply));
  await expect(connectFirecrackerVsock({ socketPath: f.path, guestPort: 2222, guard() {} })).rejects.toMatchObject({ code: 'vm_vsock_protocol_invalid' });
  expect(f.commands).toEqual(['CONNECT 2222\n']);
});

test('high-bit bytes cannot become an ASCII OK acknowledgement through lossy decoding', async () => {
  const f = await fixture(socket => socket.end(Buffer.from([0xcf, 0xcb, 32, 50, 10])));
  await expect(connectFirecrackerVsock({ socketPath: f.path, guestPort: 52, guard() {} })).rejects.toMatchObject({ code: 'vm_vsock_protocol_invalid' });
});

test('EOF before a complete acknowledgement closes the original connection without retry', async () => {
  const f = await fixture(socket => socket.end('OK 7'));
  await expect(connectFirecrackerVsock({ socketPath: f.path, guestPort: 52, guard() {} })).rejects.toMatchObject({ code: 'vm_vsock_closed' }); expect(f.commands).toHaveLength(1);
});

test('final current-generation guard can refuse after acknowledgement, withholding every guest byte', async () => {
  const final = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let generation = 1, calls = 0;
  const f = await fixture(socket => socket.write('OK 12\nSSH-2.0-unreleased\r\n'));
  const waiting = connectFirecrackerVsock({ socketPath: f.path, guestPort: 52, async guard() { calls++; if (calls === 3) { final.resolve(); await release.promise; } if (generation !== 1) throw Object.assign(new Error('stale'), { code: 'vm_fenced' }); } });
  await final.promise; generation = 2; release.resolve(); await expect(waiting).rejects.toMatchObject({ code: 'vm_fenced' }); expect(f.commands).toHaveLength(1);
});

test('abort during the final guard closes the original channel and a late guard cannot publish it', async () => {
  const final = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), abort = new AbortController(); let calls = 0;
  const f = await fixture(socket => socket.write('OK 12\n'));
  const waiting = connectFirecrackerVsock({ socketPath: f.path, guestPort: 52, signal: abort.signal, async guard() { if (++calls === 3) { final.resolve(); await release.promise; } } });
  await final.promise; abort.abort(); release.resolve(); await expect(waiting).rejects.toMatchObject({ name: 'AbortError' }); expect(f.commands).toHaveLength(1);
});

test('one deadline bounds a silent peer and there is no automatic reconnect', async () => {
  const f = await fixture(() => {});
  await expect(connectFirecrackerVsock({ socketPath: f.path, guestPort: 52, timeoutMs: 50, guard() {} })).rejects.toMatchObject({ code: 'vm_vsock_timeout' }); expect(f.commands).toHaveLength(1);
});

test('a preparation timeout prevents a late custody guard from even opening a socket', async () => {
  const release = Promise.withResolvers<void>(), f = await fixture(() => {});
  await expect(connectFirecrackerVsock({ socketPath: f.path, guestPort: 52, timeoutMs: 20, guard: () => release.promise })).rejects.toMatchObject({ code: 'vm_vsock_timeout' });
  release.resolve(); await Promise.resolve(); expect(f.commands).toEqual([]); expect(f.sockets.size).toBe(0);
});

test('abort before admission and invalid trusted selections start no channel', async () => {
  const abort = new AbortController(); abort.abort(); let guards = 0;
  const f = await fixture(() => {}), options = { socketPath: f.path, guestPort: 52, guard() { guards++; } };
  await expect(connectFirecrackerVsock({ ...options, signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
  for (const patch of [{ guestPort: 0 }, { guestPort: 0xffffffff }, { guestPort: 1.5 }, { timeoutMs: 5001 }, { timeoutMs: 0 }, { socketPath: '/tmp/../tmp/socket' }, { socketPath: 'relative' }, { socketPath: '/tmp/x\n' }]) await expect(connectFirecrackerVsock({ ...options, ...patch })).rejects.toMatchObject({ code: 'vm_vsock_invalid' });
  expect(guards).toBe(0); expect(f.commands).toEqual([]);
});

test('abort after handoff closes the exact transport, independently of guest or hypervisor settlement', async () => {
  const abort = new AbortController(), f = await fixture(socket => socket.write('OK 12\n'));
  const channel = await connectFirecrackerVsock({ socketPath: f.path, guestPort: 52, signal: abort.signal, guard() {} });
  abort.abort(); await channel.closed; expect(channel.socket.destroyed).toBe(true); expect(f.commands).toHaveLength(1);
});

test('a mutable configuration reload cannot change the selected socket, port or guard during negotiation', async () => {
  const f = await fixture(socket => socket.write('OK 12\n')), other = await fixture(socket => socket.write('OK 99\n')); let guards = 0;
  const options = { socketPath: f.path, guestPort: 52, guard() { guards++; options.socketPath = other.path; options.guestPort = 99; options.guard = () => {}; } };
  const channel = await connectFirecrackerVsock(options);
  expect(guards).toBe(3); expect(f.commands).toEqual(['CONNECT 52\n']); expect(other.commands).toEqual([]); channel.close(); await channel.closed;
});
