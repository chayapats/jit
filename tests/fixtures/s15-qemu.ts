import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vmHostCommand } from '../../src/s15/vm/host';
import { localVmImages, type LocalVmHostProbe, type LocalVmImage } from '../../src/s15/vm/local';
import type { QemuHostOptions, QemuProc } from '../../src/s15/vm/qemu';
import type { QmpCommand, QmpExchange } from '../../src/s15/vm/qmp';
import type { VmHostCommand } from '../../src/s15/vm/types';

const GiB = 1_073_741_824;
/** Base image bytes for deterministic verification; the pinned production hash is never faked. */
export const fixtureImageBytes = Buffer.from('fixture-ubuntu-cloud-image');
export const fixtureImages = Object.freeze({
  x86_64: Object.freeze({ ...localVmImages.x86_64, sha256: createHash('sha256').update(fixtureImageBytes).digest('hex') }),
  aarch64: Object.freeze({ ...localVmImages.aarch64, sha256: createHash('sha256').update(fixtureImageBytes).digest('hex') }),
}) as Readonly<Record<'x86_64' | 'aarch64', LocalVmImage>>;

/**
 * Deterministic controller host: fake systemd user manager, `/proc`, qemu-img, QMP, cloud-localds,
 * ssh-keyscan and SSH guest. Only `ssh-keygen` runs for real, so keys and pinning are genuine.
 */
export class FakeQemuHost {
  /** Short root: QMP and proxy Unix socket paths must fit `sun_path` (macOS TMPDIR is long). */
  readonly root = realpathSync(mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'jq-')));
  readonly directory = join(this.root, 'vm-local');
  readonly units = new Map<string, { active: boolean; pid: number }>();
  readonly processes = new Map<number, { argv: string[]; ticks: string }>();
  readonly disks = new Map<string, { virtualSize: number; snapshots: string[]; backing: string; locked: boolean }>();
  readonly launches: string[][] = [];
  readonly qmpLog: QmpCommand[] = [];
  readonly commands: string[][] = [];
  readonly guestCommands: string[] = [];
  readonly seeds: string[] = [];
  readonly downloads: string[] = [];
  /** Mutable fault injection. */
  imageBytes: Uint8Array = fixtureImageBytes;
  keyscanOverride: string | null = null;
  stuck = false;
  guestDocker = false;
  guestReachable = false;
  guestMac: string | null = null;
  qmpDown = false;
  /** Guest logins refused (pam_nologin) for this many SSH attempts after each boot. */
  bootingLogins = 0;
  #refused = 0;
  time = 0;
  #pid = 4000;
  /** Host facts used by detection and sizing. */
  facts = { arch: 'x64', kvm: true, cpus: 10, memoryBytes: 20 * GiB, total: 200 * GiB, free: 150 * GiB };
  readonly probe: LocalVmHostProbe = { arch: () => this.facts.arch, kvm: () => this.facts.kvm, executable: () => true, readable: () => true, cpus: () => this.facts.cpus, memoryBytes: () => this.facts.memoryBytes, disk: () => ({ total: this.facts.total, free: this.facts.free }) };
  readonly proc: QemuProc = { cmdline: pid => this.processes.get(pid)?.argv ?? null, startTicks: pid => this.processes.get(pid)?.ticks ?? null };
  readonly qmp: QmpExchange = async (socket, commands) => {
    if (this.qmpDown) throw Object.assign(new Error('vm_management_unavailable'), { code: 'vm_management_unavailable' });
    const unit = [...this.units.entries()].find(([name]) => socket.includes(`/${name.replace('.service', '')}/`));
    if (!unit || !unit[1].active) throw new Error('vm_management_unavailable');
    const argv = this.processes.get(unit[1].pid)?.argv ?? [];
    const disk = this.diskOf(argv);
    return commands.map(command => {
      this.qmpLog.push(command);
      if (command.execute === 'query-status') return { status: 'running', running: true };
      if (command.execute === 'query-name') return { name: argv[argv.indexOf('-name') + 1] };
      if (command.execute === 'blockdev-snapshot-internal-sync') { disk!.snapshots.push(String(command.arguments!.name)); return {}; }
      if (command.execute === 'blockdev-snapshot-delete-internal-sync') { disk!.snapshots = disk!.snapshots.filter(n => n !== command.arguments!.name); return {}; }
      if (command.execute === 'quit') { if (!this.stuck) this.kill(unit[0]); return {}; }
      throw new Error('unsupported');
    });
  };
  readonly run: VmHostCommand = async (argv, options) => {
    this.commands.push([...argv]);
    const ok = (stdout = '') => ({ exitCode: 0, stdout: Buffer.from(stdout) }), fail = () => ({ exitCode: 1, stdout: Buffer.alloc(0) });
    const [tool] = argv;
    if (tool === 'ssh-keygen') return vmHostCommand(argv, options);
    if (tool === 'systemctl') {
      const [, , verb, ...rest] = argv, name = verb === 'kill' ? rest.at(-1)! : rest[0]!, unit = this.units.get(name);
      if (verb === 'show') return ok(`LoadState=${unit ? 'loaded' : 'not-found'}\nActiveState=${unit?.active ? 'active' : 'inactive'}\nMainPID=${unit?.active ? unit.pid : 0}\n`);
      if ((verb === 'stop' || verb === 'kill') && !this.stuck) this.kill(name);
      return ok();
    }
    if (tool === 'systemd-run') {
      const unitName = argv.find(a => a.startsWith('--unit='))!.slice(7).replace(/(?:\.service)?$/, '.service'), qemu = argv.slice(argv.indexOf('--') + 1), pid = ++this.#pid;
      this.launches.push(qemu); this.processes.set(pid, { argv: qemu, ticks: String(9000 + pid) }); this.units.set(unitName, { active: true, pid }); this.#refused = 0;
      const disk = this.diskOf(qemu); if (disk) disk.locked = true;
      return ok();
    }
    if (tool === '/usr/bin/qemu-img') return this.image(argv.slice(1), ok, fail);
    if (tool === '/usr/bin/cloud-localds') {
      const files = argv.slice(1).filter(a => !a.startsWith('--')), network = argv.find(a => a.startsWith('--network-config='))!.slice(17);
      const content = [readFileSync(files[1]!, 'utf8'), readFileSync(files[2]!, 'utf8'), readFileSync(network, 'utf8')].join('\n---\n');
      this.seeds.push(content); writeFileSync(files[0]!, content, { mode: 0o644 }); return ok();
    }
    if (tool === 'ssh-keyscan') {
      const port = argv[argv.indexOf('-p') + 1], active = [...this.units.values()].some(u => u.active);
      if (!active) return ok();
      const pub = this.keyscanOverride ?? this.hostKey(port!);
      return ok(pub ? `[127.0.0.1]:${port} ${pub}\n` : '');
    }
    if (tool === 'ssh') return this.guest(argv, options.input);
    return fail();
  };
  /** Host options for `QemuVmManagement`/`VmManagers`. */
  options(proxySocket = join(this.directory, 'proxy.sock')): QemuHostOptions {
    return { directory: this.directory, proxySocket, run: this.run, qmp: this.qmp, proc: this.proc, probe: this.probe, images: fixtureImages, uid: 1000,
      download: async (url, file) => { this.downloads.push(url); writeFileSync(file, this.imageBytes, { mode: 0o600, flag: 'wx' }); },
      now: () => this.time, sleep: async ms => { this.time += ms; } };
  }
  private diskOf(argv: readonly string[]) { const file = /file=([^,]+\/disk\.qcow2),/.exec(argv.join(' '))?.[1]; return file ? this.disks.get(file) : undefined; }
  private kill(unitName: string): void {
    const unit = this.units.get(unitName); if (!unit) return;
    const disk = this.diskOf(this.processes.get(unit.pid)?.argv ?? []); if (disk) disk.locked = false;
    this.processes.delete(unit.pid); this.units.delete(unitName);
  }
  private hostKey(port: string): string | null {
    for (const [, unit] of this.units) {
      const argv = this.processes.get(unit.pid)?.argv; if (!argv?.join(' ').includes(`127.0.0.1:${port}-:22`)) continue;
      const directory = /file=([^,]+)\/disk\.qcow2,/.exec(argv.join(' '))![1]!;
      return readFileSync(join(directory, 'hostkey.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ');
    }
    return null;
  }
  private image(args: string[], ok: (s?: string) => { exitCode: number; stdout: Uint8Array }, fail: () => { exitCode: number; stdout: Uint8Array }) {
    const file = args.at(-1)!, [verb] = args;
    if (verb === 'create') {
      const size = Number(/^([0-9]+)G$/.exec(args.at(-1)!)![1]) * GiB, target = args.at(-2)!, base = args[args.indexOf('-b') + 1]!;
      if (!existsSync(base)) return fail();
      this.disks.set(target, { virtualSize: size, snapshots: [], backing: base, locked: false }); writeFileSync(target, 'qcow2'); return ok();
    }
    if (verb === 'resize') { const disk = this.disks.get(args[1]!); if (!disk || disk.locked) return fail(); disk.virtualSize = Number(/^([0-9]+)G$/.exec(args[2]!)![1]) * GiB; return ok(); }
    const disk = this.disks.get(file); if (!disk) return fail();
    if (verb === 'info') {
      if (!args.includes('--force-share') && disk.locked) return fail();
      return ok(JSON.stringify({ 'virtual-size': disk.virtualSize, format: 'qcow2', 'backing-filename': disk.backing, ...(disk.snapshots.length ? { snapshots: disk.snapshots.map(name => ({ name })) } : {}) }));
    }
    if (verb === 'snapshot') {
      if (disk.locked) return fail();
      const [, flag, name] = args;
      if (flag === '-c') disk.snapshots.push(name!);
      else if (flag === '-a') { if (!disk.snapshots.includes(name!)) return fail(); }
      else if (flag === '-d') disk.snapshots = disk.snapshots.filter(n => n !== name);
      return ok();
    }
    return fail();
  }
  private guest(argv: readonly string[], input?: Uint8Array) {
    const port = argv[argv.indexOf('-p') + 1], unit = [...this.units.values()].find(u => u.active && this.processes.get(u.pid)?.argv.join(' ').includes(`127.0.0.1:${port}-:22`));
    if (!unit || this.#refused++ < this.bootingLogins) return { exitCode: 255, stdout: Buffer.alloc(0) };
    const remote = argv.at(-1)!, qemu = this.processes.get(unit.pid)!.argv, mac = this.guestMac ?? /mac=([0-9a-f:]{17})/.exec(qemu.join(' '))![1]!;
    this.guestCommands.push(remote);
    const out = (s: string) => ({ exitCode: 0, stdout: Buffer.from(s) });
    if (remote.includes('cloud-init')) return out('jit-cloud-init:0\n');
    if (remote.includes('docker.io')) { const proxy = JSON.parse(Buffer.from(input ?? []).toString()).proxy; this.guestDocker = typeof proxy === 'string' && proxy.includes('@192.168.5.100:3128'); return out(this.guestDocker ? 'jit-docker-ready-v1\n' : 'jit-docker-missing-v1\n'); }
    if (remote.includes('platform.machine')) return out(JSON.stringify({ architecture: 'x86_64', os: 'ubuntu:26.04', cpuCount: Number(qemu[qemu.indexOf('-smp') + 1]), memoryBytes: 8 * GiB, diskBytes: 60 * GiB, sudo: true, docker: this.guestDocker, basis: 'guest_reported' }));
    if (remote.includes('nicMacs')) return out(JSON.stringify({ nicMacs: [mac] }));
    if (remote.includes('reachable')) return out(JSON.stringify({ reachable: [this.guestReachable, false, false, false, false, false] }));
    if (remote.includes('jit-vm-ready-v1')) return out('jit-vm-ready-v1\n');
    return out('');
  }
  cleanup(): void { rmSync(this.root, { recursive: true, force: true }); }
}
