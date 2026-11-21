import { createServer as httpServer } from 'node:http';
import { createServer, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FirecrackerHostRuntime, type FirecrackerRuntimeOptions } from '../../src/s15/vm/firecracker/runtime';
import { FirecrackerHostJournal, type FirecrackerHostCommand } from '../../src/s15/vm/firecracker/jobs';
import { firecrackerLaunchPlan } from '../../src/s15/vm/firecracker/launch';
import type { VmHostCommand } from '../../src/s15/vm/types';
import { firecrackerHostFixture } from './s15-firecracker-host';

/** Actual SQLite/raw files/Unix HTTP/vsock streams around a labelled root-host/systemd fixture. */
export async function firecrackerRuntimeFixture() {
  const directory = mkdtempSync('/tmp/jit-fcr-'), f = firecrackerHostFixture(directory), plan = firecrackerLaunchPlan(f.selected.profile, f.selected.host);
  mkdirSync(join(f.root, 'run'), { recursive: true, mode: 0o700 }); const recovery = join(directory, 'recovery'); mkdirSync(recovery, { mode: 0o700 });
  const disk = join(f.root, 'rootfs.ext4'); writeFileSync(disk, 'original working bytes', { mode: 0o600 }); truncateSync(disk, f.selected.disk.bytes);
  const raw = openSync(disk, 'r'), h = createHash('sha256'), buffer = Buffer.alloc(1048576);
  try { for (;;) { const n = readSync(raw, buffer); if (!n) break; h.update(buffer.subarray(0, n)); } } finally { closeSync(raw); }
  const stat = lstatSync(disk, { bigint: true }); f.selected.disk = { ...f.selected.disk, device: String(stat.dev), inode: String(stat.ino), initialSha256: h.digest('hex') };
  const metadata = f.host.metadata, read = f.host.read;
  f.host.metadata = (path, follow = false) => {
    const actual = follow ? f.links.get(path) ?? path : path;
    if (actual === disk) { const s = lstatSync(disk, { bigint: true }); return { ...metadata(actual), device: String(s.dev), inode: String(s.ino), bytes: Number(s.size) }; }
    return metadata(path, follow);
  };
  f.host.read = (path, maximum) => path === `${f.proc}/stat` && !f.alive() ? null : read(path, maximum);
  f.write(join(directory, '.jit-proc-misc'), Buffer.alloc(0), { mode: 0o444 }); f.exit();
  for (const name of ['api.sock', 'vsock.sock']) f.nodes.delete(join(f.root, 'run', name));
  let authorized = true, badApi = false, lostLaunch = false, starts = 0;
  const requests: string[] = [], commands: string[][] = [], peers = new Set<Socket>(), units = new Map<string, string>();
  let api: ReturnType<typeof httpServer> | null = null, vsock: ReturnType<typeof createServer> | null = null;
  function track(server: NonNullable<typeof api> | NonNullable<typeof vsock>) { server.on('connection', socket => { peers.add(socket); socket.on('error', () => {}); socket.once('close', () => peers.delete(socket)); }); }
  async function removeSocket(path: string) {
    for (const socket of peers) socket.destroy();
    const server = path === plan.apiSocket ? api : vsock;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (path === plan.apiSocket) api = null; else vsock = null;
    rmSync(path, { force: true }); f.nodes.delete(path);
  }
  async function start(request: string) {
    starts++; const invocation = starts.toString(16).padStart(32, '0'); units.set(request, invocation); f.start(String(12345 + starts));
    api = httpServer((request, response) => {
      request.on('error', () => {}); response.on('error', () => {}); requests.push(`${request.method} ${request.url}`);
      if (request.method !== 'GET') { response.writeHead(405); response.end('{}'); return; }
      const config = JSON.parse(plan.configuration); if (badApi) config['network-interfaces'] = [{ iface_id: 'unreviewed' }];
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(request.url === '/' ? { id: f.selected.profile.instanceId, app_name: 'Firecracker', vmm_version: '1.18.0', state: 'Running' } : request.url === '/version' ? { firecracker_version: '1.18.0' } : config));
    });
    vsock = createServer(socket => { socket.on('error', () => {}); let input = ''; const first = (bytes: Buffer) => { input += bytes.toString(); if (!input.includes('\n')) return; socket.removeListener('data', first); socket.on('data', bytes => socket.write(bytes)); socket.write('OK 12345\nSSH-2.0-runtime-fixture\r\n'); }; socket.on('data', first); });
    track(api); track(vsock);
    await Promise.all([new Promise<void>(resolve => api!.listen(plan.apiSocket, resolve)), new Promise<void>(resolve => vsock!.listen(plan.vsockSocket, resolve))]);
    for (const path of [plan.apiSocket, plan.vsockSocket]) f.add(path, 'socket', { uid: f.selected.host.uid, gid: f.selected.host.gid, mode: 0o700 });
  }
  const command: VmHostCommand = async (argv, options) => {
    commands.push([...argv]); options.beforeStart!();
    if (argv[0] === '/usr/bin/systemd-run') { const unit = argv.find(value => value.startsWith('--unit='))!.slice(7), request = /^jit-firecracker-([a-f0-9]{32})\.service$/.exec(unit)![1]!; await start(request); if (lostLaunch) { lostLaunch = false; throw Error('lost systemd reply'); } return { stdout: Buffer.alloc(0), exitCode: 0 }; }
    const unit = argv[4]!, request = /^jit-firecracker-([a-f0-9]{32})\.service$/.exec(unit)![1]!, invocation = units.get(request);
    if (!invocation) return { stdout: Buffer.from(`Id=${unit}\nLoadState=not-found\n`), exitCode: 4 };
    const active = f.alive() && invocation === starts.toString(16).padStart(32, '0');
    const fields = { Id: unit, LoadState: 'loaded', ActiveState: 'active', SubState: active ? 'running' : 'exited', MainPID: active ? String(f.selected.process.pid) : '0', InvocationID: invocation, Result: 'success', Type: 'exec', Restart: 'no', RemainAfterExit: 'yes', User: 'root', Group: 'root', PrivateMounts: 'yes', StandardInput: 'null', StandardOutput: 'null', StandardError: 'null' };
    return { stdout: Buffer.from(Object.entries(fields).map(([key, value]) => `${key}=${value}`).join('\n') + '\n'), exitCode: 0 };
  };
  const { process: _process, ...selection } = f.selected, path = join(directory, 'host.sqlite'); let journal = new FirecrackerHostJournal(path, { create: true });
  const options = () => ({ selection, journal, guestPort: 22, listenPort: 0, guard() { if (!authorized) throw Error('revoked'); }, fixture: { basis: 'protocol_fixture', host: f.host, command, cold: { rootDirectory: f.root, recoveryDirectory: recovery }, removeSocket } } satisfies FirecrackerRuntimeOptions);
  let runtime = new FirecrackerHostRuntime(options());
  function mutation(id: number, kind: FirecrackerHostCommand['kind'], snapshotId?: string): FirecrackerHostCommand {
    const c = runtime.current(), common = { contract: 's16-firecracker-host-command/v1' as const, requestId: id.toString(16).padStart(32, '0'), computerId: c.id, selectionSha256: c.selectionSha256, expectedRevision: c.revision, expectedLaunchId: c.launchId };
    return kind === 'launch' || kind === 'stop' ? { ...common, kind } : { ...common, kind, snapshotId: snapshotId! };
  }
  return { ...f, disk, recovery, path, commands, requests, mutation,
    runtime: () => runtime, journal: () => journal, starts: () => starts,
    lostLaunch() { lostLaunch = true; }, badApi(value: boolean) { badApi = value; }, authorize(value: boolean) { authorized = value; },
    async reopen() { await runtime.close(); journal.close(); journal = new FirecrackerHostJournal(path, { create: false }); journal.recover(); runtime = new FirecrackerHostRuntime(options()); return runtime; },
    async close() { authorized = true; await runtime.close(); for (const name of [plan.apiSocket, plan.vsockSocket]) await removeSocket(name); journal.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
