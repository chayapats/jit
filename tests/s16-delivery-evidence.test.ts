import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { inspectS16DeliveryTree, qualifyS16MobileSource, verifyS16DeliveryLogs } from '../ops/evidence/s16-delivery';
import { observeS16BunTests, type runS16CrossClientEvidence } from '../ops/evidence/s16-cross-client';
import { readS16EvidenceMatrix } from '../ops/evidence/s16-matrix';
import { sealMobileArtifact } from '../ops/mobile/artifact';

const repository = resolve(import.meta.dir, '..'), roots: string[] = [];
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function fixture() { const root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-delivery-check-'))); roots.push(root); mkdirSync(join(root, '.local')); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test.each(['linked-parent', 'linked-file', 'hard-link', 'oversized', 'depth', 'outside', 'noncanonical'] as const)('delivery preflight refuses %s before reading payload bytes', mode => {
  const root = fixture(), directory = join(root, '.local/artifact'); mkdirSync(directory); writeFileSync(join(directory, 'payload'), 'owned');
  let target = directory;
  if (mode === 'linked-parent') { symlinkSync('artifact', join(root, '.local/alias')); target = join(root, '.local/alias'); }
  if (mode === 'linked-file') symlinkSync('payload', join(directory, 'alias'));
  if (mode === 'hard-link') linkSync(join(directory, 'payload'), join(directory, 'alias'));
  if (mode === 'oversized') truncateSync(join(directory, 'payload'), 512 * 1048576 + 1);
  if (mode === 'depth') { let at = directory; for (let i = 0; i < 33; i++) { at = join(at, 'nested'); mkdirSync(at); } }
  if (mode === 'outside') target = root;
  if (mode === 'noncanonical') target = directory + '/../artifact';
  expect(() => inspectS16DeliveryTree(root, target)).toThrow('s16_delivery_evidence_mismatch');
});

// These accounting fixtures never execute the delivery pipeline or produce an acceptance receipt.
async function logFixture() {
  const root = fixture(), testPath = join(root, 'observed.test.ts');
  writeFileSync(testPath, "import{test,expect}from'bun:test';test('first observation',()=>expect(1).toBe(1));test('second observation',()=>expect(2).toBe(2));");
  const child = Bun.spawn([process.execPath, 'test', testPath], { stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', NO_COLOR: '1' } });
  const [exit, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); expect(exit).toBe(0);
  const log = out + error, observed = observeS16BunTests(log)!; expect(observed.pass).toBe(2);
  const matrix = readS16EvidenceMatrix(repository), directory = join(root, '.local/matrix'); mkdirSync(directory);
  const profiles = matrix.profiles.map(profile => {
    mkdirSync(join(directory, profile.id));
    return { id: profile.id, basis: profile.basis, reused: profile.reused, state: 'passed' as const, suites: profile.suites.map((suite, index) => {
      writeFileSync(join(directory, profile.id, `${index}.log`), log);
      return { suite, state: 'passed' as const, exitCode: 0, observations: observed, logBytes: Buffer.byteLength(log), logSha256: hash(log) };
    }) };
  });
  const receipt = { sourceAfter: 'verified_unchanged', execution: { profiles: matrix.profiles.map(row => row.id), profileResults: profiles } } as Awaited<ReturnType<typeof runS16CrossClientEvidence>>;
  return { root, matrix, directory, receipt, log };
}

test('log qualification observes actual Bun counts without promoting accounting fixtures to artifact acceptance', async () => {
  const f = await logFixture(), result = verifyS16DeliveryLogs(f.matrix, f.receipt, f.directory);
  expect(result.deterministicInputs).toBe('passed'); expect(result.deterministicAcceptance).toBe('blocked'); expect(result.productAcceptance).toBe('blocked');
});

test.each(['tampered-log', 'forged-count', 'omitted-profile', 'duplicate-profile', 'wrong-order', 'changed-source', 'driver-gap'] as const)('delivery join refuses %s despite green profile labels', async mode => {
  const f = await logFixture();
  if (mode === 'tampered-log') writeFileSync(join(f.directory, 'bots/0.log'), f.log + 'changed');
  if (mode === 'forged-count') f.receipt.execution.profileResults[0]!.suites[0]!.observations = { ...f.receipt.execution.profileResults[0]!.suites[0]!.observations!, pass: 999 };
  if (mode === 'omitted-profile') f.receipt.execution.profileResults.pop();
  if (mode === 'duplicate-profile') f.receipt.execution.profileResults.push(f.receipt.execution.profileResults[0]!);
  if (mode === 'wrong-order') f.receipt.execution.profiles.reverse();
  if (mode === 'changed-source') f.receipt.sourceAfter = 'changed';
  if (mode === 'driver-gap') f.matrix.scenarios[0]!.requiredDriverGaps.push('required_driver_missing');
  expect(() => verifyS16DeliveryLogs(f.matrix, f.receipt, f.directory)).toThrow();
});

function nativeFixture() {
  const root = fixture(), directory = join(root, '.local/mobile'); mkdirSync(directory);
  const paths = { rootLockSha256: 'bun.lock', clientLockSha256: 'clients/mobile/bun.lock', podLockSha256: 'clients/mobile/native-inputs/Podfile.lock', appleInputsSha256: 'clients/mobile/native-inputs/apple.json', androidInputsSha256: 'clients/mobile/native-inputs/android.json', verificationSha256: 'clients/mobile/native-inputs/gradle-verification-metadata.xml', noticesSha256: 'clients/mobile/notices/index.json' };
  const source: Record<string, string> = { commit: 'a'.repeat(40) };
  for (const [key, path] of Object.entries(paths)) { mkdirSync(dirname(join(root, path)), { recursive: true }); copyFileSync(join(repository, path), join(root, path)); source[key] = hash(readFileSync(join(root, path))); }
  const archive = { archiveSha256: 'b'.repeat(64), files: 1, bytes: 1 };
  writeFileSync(join(directory, 'build-source.json'), JSON.stringify({ contract: 's16-mobile-build-source/v1', commit: source.commit, ...archive, nativeProject: 'fresh-cng', prebuildClean: true }));
  writeFileSync(join(directory, 'Jit-arm64-unsigned.apk'), 'binding fixture, not a native build');
  const metadata = { contract: 's16-mobile-artifact/v1' as const, platform: 'android' as const, architecture: 'arm64' as const, acceptance: 'build-only' as const, source: source as any, toolchain: { bun: '1.4.2', nodeVersion: 'v24.22.3', nodeSha256: 'c'.repeat(64), native: ['manifest binding fixture only'] } };
  return { root, directory, metadata, archive, source };
}

test.each(['commit', 'lock', 'native-input', 'archive', 'platform', 'payload'] as const)('native source qualification refuses changed %s even with a freshly recomputed integrity seal', mode => {
  const f = nativeFixture();
  if (mode === 'commit') f.metadata.source.commit = 'd'.repeat(40);
  if (mode === 'lock') f.metadata.source.rootLockSha256 = 'd'.repeat(64);
  if (mode === 'native-input') f.metadata.source.appleInputsSha256 = 'd'.repeat(64);
  if (mode === 'archive') writeFileSync(join(f.directory, 'build-source.json'), '{}');
  if (mode === 'payload') rmSync(join(f.directory, 'Jit-arm64-unsigned.apk'));
  sealMobileArtifact(f.directory, f.metadata);
  expect(() => qualifyS16MobileSource(f.root, f.directory, mode === 'platform' ? 'ios-simulator' : 'android', 'a'.repeat(40), f.archive)).toThrow('s16_delivery_evidence_mismatch');
});
