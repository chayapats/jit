import { afterEach, expect, test } from 'bun:test';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createS16EmptyRepairTemp, copyS16RepairPrefix, inspectS16RepairFile, publishS16RepairFile, type S16RepairFile, type S16RepairSource } from '../src/s16/operations/repair-files';
import { s16PointEntry, s16PointEntryIdentity } from '../src/s16/operations/point-files';

// These are actual local filesystem transition probes, not independent current-plan/restore authority.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const hash = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
function fixture(length = 262181) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-repair-files-'))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const parent = join(root, 'bytes'); mkdirSync(parent, { mode: 0o700 }); const bytes = Buffer.from(Array.from({ length }, (_, at) => at % 251)), sourcePath = join(root, 'immutable'); writeFileSync(sourcePath, bytes, { mode: 0o600 });
  const temp = join(parent, '.jit-recovery-original-0'), file: S16RepairFile = { target: join(parent, 'original.blob'), temp, parentIdentity: s16PointEntryIdentity(s16PointEntry(parent, true), true), tempIdentity: createS16EmptyRepairTemp(temp), bytes: bytes.length, sha256: hash(bytes) };
  const source: S16RepairSource = { path: sourcePath, identity: s16PointEntryIdentity(s16PointEntry(sourcePath)), bytes: bytes.length, sha256: hash(bytes) };
  return { root, bytes, source, file };
}
function killAt(f: ReturnType<typeof fixture>, boundary: 'chunk' | 'linked' | 'published') {
  const script = `import{copyS16RepairPrefix,publishS16RepairFile}from${JSON.stringify(join(import.meta.dir, '../src/s16/operations/repair-files.ts'))};const{file,source,boundary}=await Bun.stdin.json();if(boundary==='chunk')copyS16RepairPrefix(file,source,()=>{},()=>process.kill(process.pid,'SIGKILL'));else publishS16RepairFile(file,()=>{},at=>{if(at===boundary)process.kill(process.pid,'SIGKILL');});throw Error('fixture_not_killed');`;
  const child = Bun.spawnSync([process.execPath, '-e', script], { stdin: Buffer.from(JSON.stringify({ file: f.file, source: f.source, boundary })), stdout: 'pipe', stderr: 'pipe', timeout: 5000 });
  expect(child.stderr.toString()).toBe(''); expect(child.exitCode).not.toBe(0);
}

test.each([0, 262181])('local transition copies %i bytes and publishes only its original inode with stable idempotent readback', length => {
  const f = fixture(length); copyS16RepairPrefix(f.file, f.source, () => {}); expect(inspectS16RepairFile(f.file).state).toBe('temp');
  publishS16RepairFile(f.file, () => {}); const before = lstatSync(f.file.target, { bigint: true });
  expect(inspectS16RepairFile(f.file).state).toBe('target'); expect(readFileSync(f.file.target)).toEqual(f.bytes); expect(existsSync(f.file.temp)).toBe(false);
  publishS16RepairFile(f.file, () => {}); expect(lstatSync(f.file.target, { bigint: true }).ino).toBe(before.ino); expect(lstatSync(f.file.target, { bigint: true }).ctimeNs).toBe(before.ctimeNs);
});

test('actual SIGKILL while appending leaves an owned prefix that resumes without replacing or truncating its original inode', () => {
  const f = fixture(); killAt(f, 'chunk'); const before = lstatSync(f.file.temp, { bigint: true }), prefix = readFileSync(f.file.temp);
  expect(prefix.length).toBeGreaterThan(0); expect(prefix.length).toBeLessThan(f.bytes.length); expect(prefix).toEqual(f.bytes.subarray(0, prefix.length));
  copyS16RepairPrefix(f.file, f.source, () => {}); expect(lstatSync(f.file.temp, { bigint: true }).ino).toBe(before.ino); publishS16RepairFile(f.file, () => {}); expect(readFileSync(f.file.target)).toEqual(f.bytes);
});

test.each(['linked', 'published'] as const)('actual SIGKILL after %s resumes only original owned names/link counts and complete bytes', boundary => {
  const f = fixture(); copyS16RepairPrefix(f.file, f.source, () => {}); const original = lstatSync(f.file.temp, { bigint: true }); killAt(f, boundary);
  expect(inspectS16RepairFile(f.file).state).toBe(boundary === 'linked' ? 'linked' : 'target');
  if (boundary === 'linked') expect(lstatSync(f.file.target, { bigint: true }).nlink).toBe(2n);
  publishS16RepairFile(f.file, () => {}); expect(inspectS16RepairFile(f.file).state).toBe('target'); expect(lstatSync(f.file.target, { bigint: true }).ino).toBe(original.ino); expect(readFileSync(f.file.target)).toEqual(f.bytes); expect(existsSync(f.file.temp)).toBe(false);
});

test('same expected bytes in an occupied target do not prove ownership and are never overwritten or removed', () => {
  const f = fixture(); copyS16RepairPrefix(f.file, f.source, () => {}); writeFileSync(f.file.target, f.bytes, { mode: 0o600 }); const before = lstatSync(f.file.target, { bigint: true });
  expect(() => publishS16RepairFile(f.file, () => {})).toThrow('s16_ops_repair_file_changed'); expect(lstatSync(f.file.target, { bigint: true }).ino).toBe(before.ino); expect(readFileSync(f.file.target)).toEqual(f.bytes); expect(existsSync(f.file.temp)).toBe(true);
});

test('an unexpected target created immediately before atomic link refuses without replacing it', () => {
  const f = fixture(); copyS16RepairPrefix(f.file, f.source, () => {}); let checks = 0;
  expect(() => publishS16RepairFile(f.file, () => { if (++checks === 2) writeFileSync(f.file.target, 'unexpected current bytes', { mode: 0o600 }); })).toThrow();
  expect(readFileSync(f.file.target, 'utf8')).toBe('unexpected current bytes'); expect(readFileSync(f.file.temp)).toEqual(f.bytes);
});

test('wrong owned prefix refuses before any append and an unowned nonempty nonce cannot be adopted', () => {
  const f = fixture(); writeFileSync(f.file.temp, 'wrong original prefix', { mode: 0o600 }); const before = readFileSync(f.file.temp);
  expect(() => copyS16RepairPrefix(f.file, f.source, () => {})).toThrow('s16_ops_repair_prefix_changed'); expect(readFileSync(f.file.temp)).toEqual(before); expect(existsSync(f.file.target)).toBe(false);
  expect(() => createS16EmptyRepairTemp(f.file.temp)).toThrow('s16_ops_repair_unowned_temp'); expect(readFileSync(f.file.temp)).toEqual(before);
});

test('an extra hard link cannot be mistaken for the one planned publication link or cleaned away', () => {
  const f = fixture(); copyS16RepairPrefix(f.file, f.source, () => {}); linkSync(f.file.temp, f.file.target); const alias = join(f.root, 'unknown-alias'); linkSync(f.file.temp, alias);
  expect(() => publishS16RepairFile(f.file, () => {})).toThrow(); expect([f.file.temp, f.file.target, alias].every(existsSync)).toBe(true); expect(lstatSync(alias).nlink).toBe(3);
});

test('missing/substituted owned files and changed source identities refuse without reconstruction', () => {
  const f = fixture(); unlinkSync(f.file.temp); expect(() => copyS16RepairPrefix(f.file, f.source, () => {})).toThrow('s16_ops_repair_owned_file_missing'); expect(existsSync(f.file.temp)).toBe(false);
  const replaced = fixture(); renameSync(replaced.file.temp, join(replaced.root, 'retained-original-temp')); createS16EmptyRepairTemp(replaced.file.temp); expect(() => copyS16RepairPrefix(replaced.file, replaced.source, () => {})).toThrow('s16_ops_repair_file_changed');
  const other = fixture(); renameSync(other.source.path, other.source.path + '.retained'); writeFileSync(other.source.path, other.bytes, { mode: 0o600 }); expect(() => copyS16RepairPrefix(other.file, other.source, () => {})).toThrow('s16_ops_repair_source_changed'); expect(readFileSync(other.file.temp).length).toBe(0);
});
