import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { readS15RuntimeConfig } from '../src/s15/runtime-config';
import { s15CredentialKey } from '../src/s15/credentials';
import { canonical } from '../src/s15/conversation/validation';
import { adoptS16Operations, type S16OperationsAdoptionOptions } from '../src/s16/operations/adoption';
import { bindS16OperationsLease, openS16InstallationLease, type S16InstallationLease } from '../src/s16/operations/installation-lease';
import { readS16OperationsControl } from '../src/s16/operations/operations-state';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function cli(entry: string, args: string[], input?: string) {
  const child = Bun.spawn([process.execPath, entry, ...args], { stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe' });
  cleanup.push(async () => { if (child.exitCode === null) { child.kill(); await child.exited; } });
  const [out, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); return { out, error, exit };
}
async function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-ops-adoption-'))); cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
  const directory = join(parent, 'state'), configPath = join(parent, 'config.json');
  writeFileSync(configPath, JSON.stringify(s15StageConfig(directory, 'http://localhost:3041')), { mode: 0o600 });
  const init = await cli('src/main.ts', ['init', '--s15', '--config', configPath]); expect({ exit: init.exit, error: init.error }).toEqual({ exit: 0, error: '' });
  const config = readS15RuntimeConfig(configPath), owner = join(directory, 'owner/owner.sqlite'), fence = owner + '.ops/fence.json', control = join(directory, 'operations/control.json');
  const files = [owner, owner + '.lifecycle.sqlite', ...['conversation', 'policy', 'model', 'work', 'vm', 'team', 'memory'].map(role => join(directory, 'runtime', role + '.sqlite'))];
  const before = files.map(path => readFileSync(path)), inode = lstatSync(join(directory, 's16-operations.lock.sqlite'), { bigint: true }).ino;
  const unchanged = () => { expect(files.map(path => readFileSync(path))).toEqual(before); expect(lstatSync(join(directory, 's16-operations.lock.sqlite'), { bigint: true }).ino).toBe(inode); };
  return { parent, directory, configPath, config, owner, fence, control, unchanged };
}
const options: S16OperationsAdoptionOptions = { now: () => 1234, id: () => 'a'.repeat(32) };
const adopt = (f: Awaited<ReturnType<typeof fixture>>, extra: S16OperationsAdoptionOptions = {}) => adoptS16Operations(f.config, 'adopt_once', { ...options, ...extra });
const opsCli = (f: Awaited<ReturnType<typeof fixture>>, command: string, extra: string[] = []) => cli('src/s16/operations-cli.ts', [command, '--s15', '--config', f.configPath, ...extra]);

test('actual operator CLI adopts current metadata and v2 binding once, without changing current owner/runtime data or the lock inode', async () => {
  const f = await fixture(), initial = await opsCli(f, 'status'); expect(JSON.parse(initial.out)).toEqual({ contract: 's16-operations-status/v1', state: 'not_adopted' });
  const adopted = await opsCli(f, 'adopt', ['--request-id', 'adopt_once']); expect({ exit: adopted.exit, error: adopted.error }).toEqual({ exit: 0, error: '' });
  const receipt = JSON.parse(adopted.out); expect(receipt).toMatchObject({ state: 'adopted', revision: 0, installationId: f.config.installationId }); expect(receipt.id).toMatch(/^[a-f0-9]{32}$/);
  const control = readS16OperationsControl(f.directory), binding = JSON.parse(readFileSync(join(f.directory, 's16-operations.lease.json'), 'utf8'));
  expect(binding).toMatchObject({ contract: 's16-installation-lease/v2', operations: { id: control.id, installationId: f.config.installationId, ownerIdentity: control.ownerIdentity } });
  expect(adopted.out).not.toContain(control.ownerIdentity); expect(existsSync(f.fence)).toBe(false); f.unchanged();
  expect(JSON.parse((await opsCli(f, 'status')).out)).toMatchObject({ state: 'adopted', id: receipt.id, revision: 0, retainedPoints: 0, active: null });
  const retry = await opsCli(f, 'adopt', ['--request-id', 'adopt_once']); expect(JSON.parse(retry.out)).toMatchObject({ id: receipt.id, state: 'already_adopted' });
  const shared = openS16InstallationLease({ directory: f.directory, mode: 'shared' });
  try {
    const result = await cli('src/main.ts', ['credential', '--s15', '--config', f.configPath, '--key', 'fixture_ops', '--secret-stdin'], 'fixture-private-marker\n');
    expect({ exit: result.exit, error: result.error }).toEqual({ exit: 0, error: '' }); expect(result.out).not.toContain('fixture-private-marker'); shared.assertCurrent();
  } finally { shared.close(); }
});

test.each(['fence', 'control', 'binding', 'cleared'] as const)('interruption after durable %s resumes only the original adoption and never creates a fresh identity', async boundary => {
  const f = await fixture();
  expect(() => adopt(f, { after(at) { if (at === boundary) throw Error('fixture-interruption'); } })).toThrow('fixture-interruption');
  expect(existsSync(f.fence)).toBe(boundary !== 'cleared');
  if (boundary !== 'cleared') {
    const status = await opsCli(f, 'status'); expect(JSON.parse(status.out)).toMatchObject({ state: 'adoption_pending', id: 'a'.repeat(32), requestId: 'adopt_once' });
    const refused = await cli('src/main.ts', ['credential', '--s15', '--config', f.configPath, '--key', 'not_stored', '--secret-stdin'], 'fixture-private-marker\n');
    expect(refused.exit).not.toBe(0); expect(refused.out + refused.error).not.toContain('fixture-private-marker'); expect(existsSync(join(f.directory, 'vault', s15CredentialKey(f.config.installationId, 'not_stored')))).toBe(false);
  }
  const result = adoptS16Operations(f.config, 'adopt_once', { id() { throw Error('must not allocate another identity'); }, now() { throw Error('must retain original time'); } });
  expect(result).toMatchObject({ id: 'a'.repeat(32), revision: 0, state: boundary === 'cleared' ? 'already_adopted' : 'adopted' });
  expect(existsSync(f.fence)).toBe(false); expect(readS16OperationsControl(f.directory).adoption.createdAt).toBe(1234); f.unchanged();
});

test.each(['missing', 'corrupt', 'future', 'foreign', 'mode', 'binding-owner'] as const)('an adopted %s journal fences normal CLI and cannot be reconstructed by adoption', async kind => {
  const f = await fixture(); adopt(f);
  if (kind === 'missing') unlinkSync(f.control);
  if (kind === 'corrupt') writeFileSync(f.control, '{');
  if (kind === 'future') { const state = readS16OperationsControl(f.directory); (state as { contract: string }).contract = 's16-operations-control/v99'; writeFileSync(f.control, canonical(state)); }
  if (kind === 'foreign') { const state = readS16OperationsControl(f.directory); (state as { id: string }).id = 'b'.repeat(32); writeFileSync(f.control, canonical(state)); }
  if (kind === 'mode') chmodSync(f.control, 0o644);
  if (kind === 'binding-owner') {
    const state = readS16OperationsControl(f.directory); (state as { ownerIdentity: string }).ownerIdentity = 'foreign-owner'; writeFileSync(f.control, canonical(state));
    const path = join(f.directory, 's16-operations.lease.json'), receipt = JSON.parse(readFileSync(path, 'utf8')); receipt.operations.ownerIdentity = 'foreign-owner'; writeFileSync(path, canonical(receipt));
  }
  const before = existsSync(f.control) ? readFileSync(f.control) : null;
  expect(() => adopt(f)).toThrow();
  const result = await cli('src/main.ts', ['credential', '--s15', '--config', f.configPath, '--key', 'not_stored', '--secret-stdin'], 'fixture-private-marker\n');
  expect(result.exit).not.toBe(0); expect(result.out + result.error).not.toContain('fixture-private-marker');
  if (before) expect(readFileSync(f.control)).toEqual(before); else expect(existsSync(f.control)).toBe(false);
  expect(JSON.parse(readFileSync(join(f.directory, 's16-operations.lease.json'), 'utf8')).contract).toBe('s16-installation-lease/v2'); f.unchanged();
});

test('conflicting request/configuration cannot replace an interrupted original bootstrap or its current journal', async () => {
  const f = await fixture(); expect(() => adopt(f, { after(at) { if (at === 'control') throw Error('fixture-interruption'); } })).toThrow('fixture-interruption');
  const fence = readFileSync(f.fence), control = readFileSync(f.control);
  expect(() => adoptS16Operations(f.config, 'different_request', options)).toThrow();
  expect(() => adoptS16Operations({ ...f.config, origin: 'http://localhost:3042' }, 'adopt_once', options)).toThrow();
  expect(readFileSync(f.fence)).toEqual(fence); expect(readFileSync(f.control)).toEqual(control); f.unchanged();
});

test('a missing owning ledger refuses adoption before a fence, journal or operations binding is created', async () => {
  const f = await fixture(); unlinkSync(f.owner + '.lifecycle.sqlite');
  expect(() => adopt(f)).toThrow(); expect(existsSync(f.control)).toBe(false); expect(existsSync(f.fence)).toBe(false);
  expect(JSON.parse(readFileSync(join(f.directory, 's16-operations.lease.json'), 'utf8')).contract).toBe('s16-installation-lease/v1');
});

test('structural lookalikes cannot mint an exclusive installation capability or publish a binding', async () => {
  const f = await fixture(), fake: S16InstallationLease = { mode: 'exclusive', operations: null, assertCurrent() {}, close() {} };
  expect(() => bindS16OperationsLease(fake, f.directory, { id: 'a'.repeat(32), installationId: f.config.installationId, ownerIdentity: 'not-an-owner' })).toThrow(); expect(existsSync(f.control)).toBe(false);
});

test('operator commands require exact explicit selection and reject unsupported commands/duplicate flags before opening config', async () => {
  for (const args of [['adopt'], ['status', '--s15'], ['status', '--s15', '--s15', '--config', '/absent'], ['restore', '--s15', '--config', '/absent']]) {
    const result = await cli('src/s16/operations-cli.ts', args); expect(result.exit).not.toBe(0); expect(result.out).toBe(''); expect(result.error).not.toContain('/absent');
  }
});
