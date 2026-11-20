import { afterEach, expect, test } from 'bun:test';
import { createServer as httpServer } from 'node:http';
import { createConnection, createServer, type Socket } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BoundFirecrackerComputer } from '../src/s15/vm/firecracker/bound';
import { firecrackerLaunchPlan } from '../src/s15/vm/firecracker/launch';
import { vmIdentityMatches } from '../src/s15/vm/binding';
import { VmSshTransport } from '../src/s15/vm/transport';
import { firecrackerHostFixture } from './fixtures/s15-firecracker-host';

// Actual Unix HTTP + Unix/TCP streaming composed with the protected-host fixture; not a native VM receipt.
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = mkdtempSync('/tmp/jit-fcb-'); cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const f = firecrackerHostFixture(directory), plan = firecrackerLaunchPlan(f.selected.profile, f.selected.host);
  mkdirSync(join(f.root, 'run'), { recursive: true, mode: 0o700 });
  let valid = true, badProfile = false; const requests: string[] = [], negotiations: string[] = [], sockets = new Set<Socket>();
  const api = httpServer((request, response) => {
    request.on('error', () => {}); response.on('error', () => {}); requests.push(`${request.method} ${request.url}`);
    if (request.method !== 'GET') { response.writeHead(405); response.end('{}'); return; }
    const config = JSON.parse(plan.configuration); if (badProfile) config['network-interfaces'] = [{ iface_id: 'unreviewed' }];
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/' ? { id: f.selected.profile.instanceId, app_name: 'Firecracker', vmm_version: '1.18.0', state: 'Running' } : request.url === '/version' ? { firecracker_version: '1.18.0' } : config));
  });
  const vsock = createServer(socket => {
    socket.on('error', () => {}); let input = '';
    const first = (chunk: Buffer) => {
      input += chunk.toString(); if (!input.includes('\n')) return;
      negotiations.push(input.slice(0, input.indexOf('\n') + 1)); socket.removeListener('data', first);
      socket.on('data', bytes => socket.write(bytes)); socket.write('OK 12345\nSSH-2.0-fixture\r\n');
    }; socket.on('data', first);
  });
  for (const server of [api, vsock]) {
    server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
    cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  }
  await Promise.all([new Promise<void>(resolve => api.listen(plan.apiSocket, resolve)), new Promise<void>(resolve => vsock.listen(plan.vsockSocket, resolve))]);
  const open = async (stopGuard?: () => void | Promise<void>) => {
    const computer = await BoundFirecrackerComputer.open({ selection: f.selected, guestPort: 22, listenPort: 0, fixture: f.host, guard() { if (!valid) throw Error('revoked'); }, ...(stopGuard ? { stopGuard } : {}) });
    cleanups.push(() => computer.close()); return computer;
  };
  const client = (endpoint: { host: string; port: number }) => {
    const socket = createConnection(endpoint), received = Promise.withResolvers<Buffer>(), closed = Promise.withResolvers<void>();
    socket.on('error', () => {}); socket.once('data', bytes => received.resolve(Buffer.from(bytes))); socket.once('close', () => closed.resolve());
    cleanups.push(() => { socket.destroy(); }); return { socket, received: received.promise, closed: closed.promise };
  };
  return { ...f, open, client, requests, negotiations, revoke: () => { valid = false; }, changeApi: () => { badProfile = true; } };
}

test('actual API/profile and vsock lane publish one exact NIC-free SSH binding with truthful evidence basis', async () => {
  const f = await fixture(), computer = await f.open(), machine = await computer.inspect();
  expect(machine.state).toBe('running'); expect(machine.network).toBe('isolated'); expect(machine.nicMac).toBeUndefined();
  expect(machine.binding?.kind).toBe('firecracker-vsock'); expect(machine.sshEndpoint).toEqual(computer.endpoint());
  expect(computer.evidence().basis).toBe('protocol_fixture');
  const endpoint = { ...computer.endpoint(), user: 'jit', identityFile: '/protected/key', knownHostsFile: '/protected/known' };
  expect(await vmIdentityMatches(new VmSshTransport(endpoint), machine, endpoint)).toBe(true);
  const client = f.client(computer.endpoint());
  expect((await client.received).toString()).toBe('SSH-2.0-fixture\r\n'); expect(f.negotiations).toEqual(['CONNECT 22\n']);
  expect(f.requests).toEqual(Array(2).fill(['GET /', 'GET /version', 'GET /vm/config', 'GET /']).flat());
  expect(f.requests.some(request => request.startsWith('PUT'))).toBe(false);
  await computer.stop(); await client.closed;
  expect(f.counters()).toMatchObject({ signals: 1, syncs: 1 });
  expect((await computer.inspect()).state).toBe('stopped'); expect(computer.evidence().observation).toBe('process_and_disk_settled');
  expect(() => computer.endpoint()).toThrow('vm_firecracker_binding_unavailable');
});

test('valid API replies cannot bypass an independently changed original host disk', async () => {
  const f = await fixture(); f.nodes.get(join(f.root, 'rootfs.ext4'))!.inode = 'wrong';
  await expect(f.open()).rejects.toMatchObject({ code: 'vm_firecracker_custody_unproven' });
  expect(f.requests).toEqual([]); expect(f.counters()).toMatchObject({ signals: 0, closes: 1 });
});

test('valid host custody cannot hide an unreviewed API device profile or trigger a duplicate start', async () => {
  const f = await fixture(); f.changeApi();
  await expect(f.open()).rejects.toMatchObject({ code: 'vm_firecracker_profile_unproven' });
  expect(f.requests).toEqual(['GET /', 'GET /version', 'GET /vm/config']); expect(f.negotiations).toEqual([]);
  expect(f.counters()).toMatchObject({ signals: 0, closes: 1 });
});

test('revoked host binding refuses a new real SSH channel before any CONNECT or guest bytes', async () => {
  const f = await fixture(), computer = await f.open(); f.revoke();
  const client = f.client(computer.endpoint()); await client.closed;
  expect(f.negotiations).toEqual([]); expect(f.counters().signals).toBe(0);
  await expect(computer.inspect()).rejects.toBeInstanceOf(Error);
});

test('unknown original disk settlement keeps channels fenced and recovers by read-back without another signal', async () => {
  const f = await fixture(), computer = await f.open(); f.failSync();
  await expect(computer.stop()).rejects.toMatchObject({ code: 'vm_firecracker_custody_unproven' });
  expect(f.counters()).toMatchObject({ signals: 1, closes: 0 }); expect(() => computer.endpoint()).toThrow();
  await expect(computer.stop()).rejects.toMatchObject({ code: 'vm_firecracker_binding_unavailable' });
  f.recoverSync(); expect((await computer.readStop()).state).toBe('stopped'); expect(f.counters().signals).toBe(1);
});

test('separately held original cleanup authority can stop a revoked binding but never admits new work', async () => {
  const f = await fixture(), computer = await f.open(() => {}); f.revoke();
  const client = f.client(computer.endpoint()); await client.closed; expect(f.negotiations).toEqual([]);
  await computer.stop(); expect(f.counters().signals).toBe(1); expect((await computer.readStop()).state).toBe('stopped');
  expect(() => computer.endpoint()).toThrow('vm_firecracker_binding_unavailable');
});

test('closing helper observation settles real channels but cannot claim a VM stop', async () => {
  const f = await fixture(), computer = await f.open(), client = f.client(computer.endpoint()); await client.received;
  await computer.close(); await client.closed;
  expect(f.counters()).toMatchObject({ signals: 0, syncs: 0, closes: 1 });
  await expect(computer.readStop()).rejects.toMatchObject({ code: 'vm_firecracker_binding_unavailable' });
});
