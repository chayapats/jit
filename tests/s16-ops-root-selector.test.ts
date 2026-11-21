import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RELEASE_CONTRACT } from 'schway/host';
import { buildPackage, installArtifactDependencies, readDependencyRecord, validateArtifact } from '../ops/package/bun-build';
import { openS16RootReleaseSelector, type S16RootReleaseSelector } from '../ops/package/installer/s16-release-selector';
import { spawnRunner } from '../src/ops/supervisor';
import { opsDirectory, opsWrite } from '../src/s14/ops-files';

let root: string, prefix: string, state: string;
const packages: { path: string; hash: string; lockHash: string; dependencyHash: string; dependencyFiles: number }[] = [], caps: S16RootReleaseSelector[] = [];
const env = { PATH: dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin' };
beforeAll(async () => {
  const receipt = process.env.JIT_S16_ROOT_SELECTOR_RECEIPT;
  if (receipt && (!isAbsolute(receipt) || existsSync(receipt))) throw Error('fixture_receipt_must_be_fresh_absolute_path');
  if (receipt) opsDirectory(dirname(receipt));
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-root-selection-'))); prefix = join(root, 'opt/jit-s15'); mkdirSync(join(prefix, 'releases'), { recursive: true });
  state = join(root, 'controller-state.fixture'); writeFileSync(state, 'Inert preservation witness, not a controller authority fixture.', { mode: 0o600 });
  for (const name of ['a', 'b']) {
    const staging = join(root, name), manifest = buildPackage({ srcDir: process.cwd(), outDir: staging, engineContract: RELEASE_CONTRACT, engineRevision: null });
    const dependencies = await installArtifactDependencies(staging, { bunPath: process.execPath, run: spawnRunner, env, timeoutMs: 120000 });
    const path = join(prefix, 'releases', manifest.artifactId); renameSync(staging, path); packages.push({ path, hash: manifest.contentHash, lockHash: manifest.lockHash, dependencyHash: dependencies.dependencyHash, dependencyFiles: dependencies.dependencyFiles });
  }
}, 180000);
afterEach(() => {
  for (const cap of caps.splice(0).reverse()) cap.close();
  if (prefix) for (const name of readdirSync(prefix)) if (name === 'current' || name.startsWith('.current.next-')) rmSync(join(prefix, name), { force: true });
  expect(readFileSync(state, 'utf8')).toBe('Inert preservation witness, not a controller authority fixture.');
});
afterAll(() => {
  try {
    for (const pkg of packages) { const checked = validateArtifact(pkg.path, { runtime: true }); expect(checked.ok && checked.manifest?.contentHash === pkg.hash && readDependencyRecord(pkg.path)?.dependencyHash === pkg.dependencyHash).toBe(true); }
    const receipt = process.env.JIT_S16_ROOT_SELECTOR_RECEIPT;
    if (receipt) {
      const source = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' }), status = Bun.spawnSync(['git', 'status', '--porcelain'], { stdout: 'pipe', stderr: 'ignore' });
      opsWrite(receipt, JSON.stringify({ contract: 's16-root-selector-artifact-evidence/v1', basis: 'actual_disposable_filesystem_and_process_leases_with_inert_preservation_witness', sourceCommit: source.stdout.toString().trim(), sourceState: source.exitCode === 0 && status.exitCode === 0 && !status.stdout.length ? 'clean' : 'unverified',
        packages: packages.map(({ path: _path, ...pkg }) => pkg), platform: process.platform, arch: process.arch, bunVersion: Bun.version, engineContract: RELEASE_CONTRACT, engineRevision: 'unverified',
        driverSha256: new Bun.CryptoHasher('sha256').update(readFileSync(import.meta.path)).digest('hex'), artifactsAfter: 'verified_unchanged', testOutcomes: 'separate_test_log_required', ownership: 'explicit_fixture_uid_boundary',
        controllerAuthority: 'not_exercised', serviceClientLifecycle: 'not_exercised', linuxAdoption: 'not_exercised', liveAccounts: false, nativeDevices: 'not_exercised' }));
    }
  } finally { if (root) rmSync(root, { recursive: true, force: true }); }
});
function fixture(initial = true) {
  if (initial) symlinkSync(packages[0]!.path, join(prefix, 'current'));
  const options = { prefix, pathPolicy: { root, uid: process.getuid!() } }, cap = openS16RootReleaseSelector(options); caps.push(cap); cap.acquire();
  return { cap, options, before: cap.read(), current: join(prefix, 'current'), target: packages[1]! };
}

for (const initial of [false, true]) test(`actual root filesystem selection from existing=${initial} reads back the desired path and retries without touching its inode`, () => {
  const f = fixture(initial), selected = f.cap.select(f.before.sha256, f.target.path, f.target.hash);
  expect(selected.targetDirectory).toBe(f.target.path); expect(readlinkSync(f.current)).toBe(f.target.path);
  const inode = lstatSync(f.current).ino; expect(f.cap.select(f.before.sha256, f.target.path, f.target.hash)).toEqual(selected); expect(lstatSync(f.current).ino).toBe(inode);
  expect(readdirSync(prefix).filter(name => name.startsWith('.current.next-'))).toEqual([]);
});

test.each(['stale', 'hash', 'outside_family', 'regular_current', 'writable_target'] as const)('root selector refuses %s without changing the current entry', mode => {
  const f = fixture(), targetFile = join(f.target.path, 'package.json'); let target = f.target.path, expected = f.before.sha256, content = f.target.hash;
  if (mode === 'stale') expected = '0'.repeat(64);
  if (mode === 'hash') content = '0'.repeat(64);
  if (mode === 'outside_family') target = resolve(prefix, '../outside');
  if (mode === 'regular_current') { unlinkSync(f.current); writeFileSync(f.current, 'Keep the unexpected current file.'); }
  if (mode === 'writable_target') chmodSync(targetFile, 0o666);
  try { expect(() => f.cap.select(expected, target, content)).toThrow(); }
  finally { if (mode === 'writable_target') chmodSync(targetFile, 0o644); }
  if (mode === 'regular_current') expect(readFileSync(f.current, 'utf8')).toBe('Keep the unexpected current file.');
  else expect(readlinkSync(f.current)).toBe(packages[0]!.path);
});

test('a substituted staged entry refuses before rename and preserves both unexpected custody and the original current', () => {
  const f = fixture(); let unknown = '';
  expect(() => f.cap.select(f.before.sha256, f.target.path, f.target.hash, boundary => {
    if (boundary !== 'staged') return;
    const name = readdirSync(prefix).find(name => name.startsWith('.current.next-'))!; unknown = join(prefix, name);
    renameSync(unknown, unknown + '.retained'); writeFileSync(unknown, 'Preserve substituted staged bytes.');
  })).toThrow('s16_root_selector_staging_changed');
  expect(readlinkSync(f.current)).toBe(packages[0]!.path); expect(readFileSync(unknown, 'utf8')).toBe('Preserve substituted staged bytes.'); expect(existsSync(unknown + '.retained')).toBe(true);
});

test('another root capability is excluded and unknown original close is retried without replacing lease evidence', () => {
  const f = fixture(), original = Database.prototype.close; let fail = true;
  Database.prototype.close = function(...args) {
    if (fail && this.filename.startsWith(join(prefix, '.s16-selector') + '/')) throw Error('fixture_close_unknown');
    return original.apply(this, args);
  };
  try {
    expect(() => f.cap.close()).toThrow(); expect(f.cap.released).toBe(false);
    const other = openS16RootReleaseSelector(f.options); caps.push(other); expect(() => other.acquire()).toThrow();
    fail = false; f.cap.close(); expect(f.cap.released).toBe(true);
  } finally { Database.prototype.close = original; }
  const next = openS16RootReleaseSelector(f.options); caps.push(next); next.acquire(); expect(next.read()).toEqual(f.before);
});

test('missing retained root coordination evidence refuses instead of creating an unrelated replacement lock', () => {
  const f = fixture(); f.cap.close(); const path = join(prefix, '.s16-selector/s16-operations.lock.sqlite'), retained = path + '.retained'; renameSync(path, retained);
  try {
    const next = openS16RootReleaseSelector(f.options); caps.push(next); expect(() => next.acquire()).toThrow(); expect(existsSync(path)).toBe(false); expect(readlinkSync(f.current)).toBe(packages[0]!.path);
  } finally { renameSync(retained, path); }
});

for (const boundary of ['staged', 'selected', 'synced'] as const) test(`actual SIGKILL after ${boundary} retains current path readback and never adopts an old temporary object`, async () => {
  const f = fixture(); f.cap.close();
  const module = pathToFileURL(resolve(import.meta.dir, '../ops/package/installer/s16-release-selector.ts')).href;
  const reached = join(root, 'reached-' + boundary + '.json');
  const code = `import{writeFileSync}from 'node:fs';import{openS16RootReleaseSelector}from ${JSON.stringify(module)};const c=openS16RootReleaseSelector(${JSON.stringify(f.options)});c.acquire();c.select(${JSON.stringify(f.before.sha256)},${JSON.stringify(f.target.path)},${JSON.stringify(f.target.hash)},at=>{if(at===${JSON.stringify(boundary)}){writeFileSync(${JSON.stringify(reached)},JSON.stringify({boundary:at}),{mode:0o600,flag:'wx'});process.kill(process.pid,'SIGKILL');}});`;
  const child = Bun.spawn([process.execPath, '--eval', code], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }), timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  try { const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]); expect(exit).not.toBe(0); expect(error).toBe(''); } finally { clearTimeout(timer); }
  expect(JSON.parse(readFileSync(reached, 'utf8'))).toEqual({ boundary });
  const orphaned = readdirSync(prefix).filter(name => name.startsWith('.current.next-')).map(name => ({ path: join(prefix, name), inode: lstatSync(join(prefix, name)).ino }));
  const next = openS16RootReleaseSelector(f.options); caps.push(next); next.acquire();
  expect(next.read().targetDirectory).toBe(boundary === 'staged' ? packages[0]!.path : f.target.path);
  expect(next.select(f.before.sha256, f.target.path, f.target.hash).targetDirectory).toBe(f.target.path);
  for (const old of orphaned) expect(lstatSync(old.path).ino).toBe(old.inode);
});
