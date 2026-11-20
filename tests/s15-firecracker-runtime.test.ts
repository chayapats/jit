import { afterEach, expect, test } from 'bun:test';
import { createConnection } from 'node:net';
import { closeSync, lstatSync, openSync, readSync, writeSync } from 'node:fs';
import { firecrackerRuntimeFixture } from './fixtures/s15-firecracker-runtime';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() { const f = await firecrackerRuntimeFixture(); cleanup.push(() => f.close()); return f; }
function prefix(path: string) { const fd = openSync(path, 'r'), bytes = Buffer.alloc(22); try { readSync(fd, bytes); return bytes.toString(); } finally { closeSync(fd); } }

test('owning manager launches, binds real API/SSH and cold-restarts one original computer without duplicate effects', async () => {
  const f = await fixture(), r = f.runtime(); expect((await r.inspect()).state).toBe('stopped');
  const first = f.mutation(1, 'launch'), receipt = await r.submit(first); expect(receipt.state).toBe('committed'); expect(receipt.observation).toMatchObject({ state: 'running', basis: 'protocol_fixture' });
  const machine = await r.inspect(); expect(machine.binding?.kind).toBe('firecracker-vsock'); expect(machine.sshEndpoint).toBeDefined();
  const client = createConnection(machine.sshEndpoint!), received = Promise.withResolvers<string>(); client.on('error', received.reject); client.once('data', bytes => received.resolve(bytes.toString()));
  expect(await received.promise).toBe('SSH-2.0-runtime-fixture\r\n'); client.destroy();
  expect(await r.submit(first)).toEqual(receipt); expect(f.starts()).toBe(1);
  expect((await r.submit(f.mutation(2, 'stop'))).state).toBe('committed'); expect((await r.inspect()).state).toBe('stopped'); expect(f.counters().signals).toBe(1);
  expect((await r.submit(f.mutation(3, 'launch'))).state).toBe('committed'); const next = await r.inspect(); expect(next.boot).not.toBe(machine.boot); expect(f.starts()).toBe(2);
  expect(f.commands.filter(argv => argv[0] === '/usr/bin/systemd-run')).toHaveLength(2); expect(f.requests.every(value => value.startsWith('GET '))).toBe(true);
});

test('lost launch reply survives actual journal restart and binds the original unit without another launch', async () => {
  const f = await fixture(); await f.runtime().inspect(); f.lostLaunch(); const command = f.mutation(1, 'launch');
  expect((await f.runtime().submit(command)).state).toBe('unknown'); expect(f.starts()).toBe(1); await expect(f.runtime().inspect()).rejects.toBeInstanceOf(Error);
  const runtime = await f.reopen(); expect((await runtime.submit(command)).state).toBe('unknown');
  expect((await runtime.reconcile(command.requestId)).state).toBe('committed'); expect((await runtime.inspect()).state).toBe('running'); expect(f.starts()).toBe(1);
});

test('checkpoint/restore/retire use actual immutable disk bytes and preserve stop/restart identities', async () => {
  const f = await fixture(), r = f.runtime(), tag = `jit-${'a'.repeat(32)}`; await r.inspect(); await r.submit(f.mutation(1, 'launch'));
  const before = await r.inspect(), capture = await r.submit(f.mutation(2, 'checkpoint', tag)); expect(capture.state).toBe('committed'); expect(capture.observation?.snapshot?.bytes).toBe(128 * 1048576);
  const after = await r.inspect(); expect(after.state).toBe('running'); expect(after.boot).not.toBe(before.boot); expect(f.starts()).toBe(2); expect(f.counters().signals).toBe(1);
  const fd = openSync(f.disk, 'r+'); writeSync(fd, Buffer.from('changed after capture!')); closeSync(fd); const inode = lstatSync(f.disk).ino;
  const restore = await r.submit(f.mutation(3, 'restore', tag)); expect(restore.state).toBe('committed'); expect((await r.inspect()).state).toBe('stopped'); expect(lstatSync(f.disk).ino).not.toBe(inode); expect(prefix(f.disk)).toBe('original working bytes');
  expect((await r.submit(f.mutation(4, 'retire', tag))).state).toBe('committed'); expect(f.starts()).toBe(2); expect(f.counters().signals).toBe(2);
  await expect(r.submit(f.mutation(5, 'restore', tag))).rejects.toBeInstanceOf(Error);
});

test('unknown original stop holds capacity and recovers actual settlement without sending another signal', async () => {
  const f = await fixture(), r = f.runtime(); await r.inspect(); await r.submit(f.mutation(1, 'launch')); f.failSync(); const command = f.mutation(2, 'stop');
  expect((await r.submit(command)).state).toBe('unknown'); expect(f.counters().signals).toBe(1); await expect(r.submit(f.mutation(3, 'launch'))).rejects.toBeInstanceOf(Error);
  f.recoverSync(); expect((await r.reconcile(command.requestId)).state).toBe('committed'); expect((await r.inspect()).state).toBe('stopped'); expect(f.counters().signals).toBe(1);
});

test('a running unit with an unreviewed API profile stays unknown until the original actual profile is verified', async () => {
  const f = await fixture(), r = f.runtime(); await r.inspect(); f.badApi(true); const command = f.mutation(1, 'launch');
  expect((await r.submit(command)).state).toBe('unknown'); expect(f.starts()).toBe(1); f.badApi(false);
  expect((await r.reconcile(command.requestId)).state).toBe('committed'); expect(f.starts()).toBe(1);
});

test('foreign scope, stale original state and revoked host selection refuse before systemd effects', async () => {
  const f = await fixture(), r = f.runtime(); await r.inspect(); const command = f.mutation(1, 'launch');
  await expect(r.submit({ ...command, computerId: 'jit-work-other' })).rejects.toBeInstanceOf(Error);
  await expect(r.submit({ ...command, expectedRevision: command.expectedRevision + 1 })).rejects.toBeInstanceOf(Error);
  f.authorize(false); await expect(r.inspect()).rejects.toBeInstanceOf(Error); expect(() => r.submit(command)).toThrow(); expect(f.starts()).toBe(0);
});

test('lost checkpoint restart reply verifies the immutable snapshot while its new original VM is already running', async () => {
  const f = await fixture(); await f.runtime().inspect(); await f.runtime().submit(f.mutation(1, 'launch'));
  f.lostLaunch(); const command = f.mutation(2, 'checkpoint', `jit-${'b'.repeat(32)}`);
  expect((await f.runtime().submit(command)).state).toBe('unknown'); expect(f.starts()).toBe(2);
  const runtime = await f.reopen(), receipt = await runtime.reconcile(command.requestId);
  expect(receipt.state).toBe('committed'); expect(receipt.observation?.snapshot?.sha256).toBe(f.selected.disk.initialSha256); expect((await runtime.inspect()).state).toBe('running');
  expect(f.starts()).toBe(2); expect(f.counters().signals).toBe(1);
});

test('lost restore publication recovers its exact new disk inode after helper restart without another replacement', async () => {
  const f = await fixture(); await f.runtime().inspect(); await f.runtime().submit(f.mutation(1, 'launch'));
  const tag = `jit-${'c'.repeat(32)}`; await f.runtime().submit(f.mutation(2, 'checkpoint', tag));
  const before = lstatSync(f.disk).ino, sync = f.host.syncDisk; let lost = false;
  f.host.syncDisk = (...args) => { sync(...args); if (!lost && lstatSync(f.disk).ino !== before) { lost = true; throw Error('lost after atomic restore'); } };
  const command = f.mutation(3, 'restore', tag); expect((await f.runtime().submit(command)).state).toBe('unknown'); const replacement = lstatSync(f.disk).ino; expect(replacement).not.toBe(before);
  const runtime = await f.reopen(); expect((await runtime.reconcile(command.requestId)).state).toBe('committed'); expect((await runtime.inspect()).state).toBe('stopped');
  expect(lstatSync(f.disk).ino).toBe(replacement); expect(f.starts()).toBe(2); expect(f.counters().signals).toBe(2);
});
