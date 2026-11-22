import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RELEASE_CONTRACT } from 'schway/host';
import { buildNativeDesktop } from '../desktop/build';
import { verifyNativeDesktop } from '../../src/s16/desktop/installation';
import { artifactContentHash, buildPackage, manifestMetadata, readDependencyRecord, validateArtifact } from '../package/bun-build';
import { verifyMobileArtifact, type MobileArtifact } from '../mobile/artifact';
import { prepareMobileBuildSource } from '../mobile/source';
import { verifyMobilePublicSuffixNotices } from '../mobile/notices';
import { assessS16MatrixEvidence, createS16EvidenceOutput, observeS16BunTests, observeS16EvidenceSource, runS16CrossClientEvidence } from './s16-cross-client';
import { readS16EvidenceMatrix, type S16EvidenceMatrix } from './s16-matrix';

const root = realpathSync(resolve(import.meta.dir, '../..'));
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const require = (value: unknown): void => { if (!value) throw Error('s16_delivery_evidence_mismatch'); };
const fileHash = (path: string) => hash(readFileSync(path));

/** Reject links, hard links, special nodes and oversized trees before an artifact reader traverses them. */
export function inspectS16DeliveryTree(checkout: string, directory: string): { files: number; bytes: number } {
  require(isAbsolute(directory) && resolve(directory) === directory && directory.startsWith(join(checkout, '.local') + '/') && !/[\u0000-\u001f\u007f]/.test(directory));
  let at = checkout;
  for (const part of directory.slice(checkout.length + 1).split('/')) {
    at = join(at, part); const info = lstatSync(at);
    require(info.isDirectory() && !info.isSymbolicLink());
  }
  let nodes = 0, files = 0, bytes = 0;
  const walk = (path: string, depth: number) => {
    require(depth <= 32 && ++nodes <= 60000);
    const info = lstatSync(path); require(!info.isSymbolicLink());
    if (info.isDirectory()) {
      for (const name of readdirSync(path).sort()) { require(!/[\\\u0000-\u001f\u007f]/.test(name)); walk(join(path, name), depth + 1); }
    } else {
      require(info.isFile() && info.nlink === 1 && info.size <= 512 * 1048576 && (bytes += info.size) <= 2 * 1073741824); files++;
    }
  };
  walk(directory, 0); require(files > 0); return { files, bytes };
}
function json(path: string, limit = 1048576): any {
  const info = lstatSync(path); require(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size <= limit);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Re-observe private logs; a profile label, summary or exit code cannot replace actual assertions. */
export function verifyS16DeliveryLogs(matrix: S16EvidenceMatrix, receipt: Awaited<ReturnType<typeof runS16CrossClientEvidence>>, directory: string) {
  require(equal(receipt.execution.profiles, matrix.profiles.map(row => row.id)) && receipt.sourceAfter === 'verified_unchanged');
  for (const profile of receipt.execution.profileResults) {
    const declared = matrix.profiles.find(row => row.id === profile.id); require(declared && profile.suites.length === declared.suites.length);
    for (const [index, suite] of profile.suites.entries()) {
      require(suite.suite === declared!.suites[index]);
      const path = join(directory, profile.id, `${index}.log`), info = lstatSync(path);
      require(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size < 65536);
      const log = readFileSync(path, 'utf8');
      require(info.size === suite.logBytes && hash(log) === suite.logSha256 && equal(observeS16BunTests(log), suite.observations));
    }
  }
  const assessment = assessS16MatrixEvidence(matrix, receipt.execution.profileResults);
  require(assessment.deterministicInputs === 'passed' && assessment.scenarios.every(row => row.state === 'source_inputs_passed'));
  return assessment;
}

const mobilePins = {
  rootLockSha256: 'bun.lock', clientLockSha256: 'clients/mobile/bun.lock', podLockSha256: 'clients/mobile/native-inputs/Podfile.lock',
  appleInputsSha256: 'clients/mobile/native-inputs/apple.json', androidInputsSha256: 'clients/mobile/native-inputs/android.json',
  verificationSha256: 'clients/mobile/native-inputs/gradle-verification-metadata.xml', noticesSha256: 'clients/mobile/notices/index.json',
} as const;
/** Exact build source qualification only. Native seals never establish signing or device UI acceptance. */
export function qualifyS16MobileSource(checkout: string, directory: string, platform: MobileArtifact['platform'], commit: string, archive: { archiveSha256: string; files: number; bytes: number }): MobileArtifact {
  inspectS16DeliveryTree(checkout, directory);
  const artifact = verifyMobileArtifact(directory);
  require(artifact.platform === platform && artifact.source.commit === commit && artifact.toolchain.bun === Bun.version);
  for (const [key, path] of Object.entries(mobilePins)) require(artifact.source[key as keyof typeof mobilePins] === fileHash(join(checkout, path)));
  require(equal(json(join(directory, 'build-source.json')), { contract: 's16-mobile-build-source/v1', commit, ...archive, nativeProject: 'fresh-cng', prebuildClean: true }));
  require(platform === 'android' ? artifact.files.some(row => row.path === 'Jit-arm64-unsigned.apk' && row.bytes > 0) : artifact.files.some(row => row.path === 'Jit.app/Jit' && row.bytes > 0 && row.executable));
  const expectedNotices = verifyMobilePublicSuffixNotices(join(checkout, 'clients/mobile')), shippedNotices = verifyMobilePublicSuffixNotices(directory);
  require(Object.entries(expectedNotices.pin).every(([key, value]) => shippedNotices.pin[key as keyof typeof shippedNotices.pin] === value) && shippedNotices.sourceText === expectedNotices.sourceText);
  return artifact;
}

function serviceReceipt(sourceRun: string, matrix: S16EvidenceMatrix, source: Awaited<ReturnType<typeof observeS16EvidenceSource>>) {
  const profile = matrix.profiles.find(row => row.id === 'operations'), suite = 'tests/s16-ops-service-release.test.ts';
  require(profile && profile.suites.filter(row => row === suite).length === 1);
  const index = profile!.suites.indexOf(suite), directory = join(sourceRun, profile!.id, `${index}-service-package`);
  const receiptPath = join(sourceRun, profile!.id, `${index}-service-release.json`), record = json(receiptPath);
  require(record.contract === 's16-service-release-artifact-evidence/v1' && record.sourceCommit === source.commit && record.sourceState === 'clean' && record.artifactsAfter === 'verified_unchanged');
  require(record.platform === process.platform && record.arch === process.arch && record.bunVersion === Bun.version && record.engineContract === RELEASE_CONTRACT && record.engineRevision === 'unverified');
  require(record.driverSha256 === fileHash(join(root, suite)) && record.hostSha256 === fileHash(join(root, 'tests/fixtures/s16-service-release-host.ts')) && record.compositionSha256 === fileHash(join(root, 'tests/fixtures/s15-composition.ts')));
  require(Array.isArray(record.observations) && record.observations.length === 4 && equal(record.observations.map((row: any) => row.outcome).sort(), ['fallback_healthy', 'first_selected_healthy', 'installed_reinstalled', 'selected_healthy']));
  for (const row of record.observations) require(Number.isSafeInteger(row.ownerGeneration) && row.ownerGeneration > 0 && Number.isSafeInteger(row.policyRevision) && row.policyRevision > 0 && row.originalPaymentCalls === row.currentPaymentCalls);
  require(Array.isArray(record.packages) && record.packages.length === 2 && record.packages[0].sourceCommit === '23cfb85d1051ab52b42fefd421c85cd86388f6c3' && record.packages[1].sourceCommit === source.commit);
  inspectS16DeliveryTree(root, directory);
  const checked = validateArtifact(directory, { runtime: true }), dependency = readDependencyRecord(directory), current = record.packages[1];
  require(checked.ok && checked.manifest && dependency && checked.manifest.contentHash === current.hash && checked.manifest.lockHash === source.lockSha256 && dependency.dependencyHash === current.dependencyHash && dependency.dependencyFiles === current.dependencyFiles);
  return { directory, record, receiptSha256: fileHash(receiptPath), manifest: checked.manifest!, dependency: dependency! };
}

async function publicWeb(service: string, output: string, commit: string, serviceSha256: string) {
  // The caller has verified current source bytes and runtime dependencies before this import.
  const packaged = await import(pathToFileURL(join(service, 'src/s16/web/handler.ts')).href) as typeof import('../../src/s16/web/handler');
  const current = await import('../../src/s16/web/handler');
  const worker = await import('../../src/s16/web/worker');
  const deny = async (): Promise<Response> => { throw Error('s16_delivery_private_route_refused'); };
  const [actual, expected] = await Promise.all([packaged.createS16WebHandler(deny), current.createS16WebHandler(deny)]);
  const read = async (path: string, limit: number) => {
    const responses = await Promise.all([actual(new Request('http://localhost:3041' + path)), expected(new Request('http://localhost:3041' + path))]);
    require(responses.every(row => row.status === 200));
    const [a, b] = await Promise.all(responses.map(row => row.arrayBuffer()));
    require(a && b && a.byteLength > 0 && a.byteLength <= limit && Buffer.from(a).equals(Buffer.from(b))); return new Uint8Array(a!);
  };
  const releaseBytes = await read('/s16/desktop-release.json', 65536), release = JSON.parse(new TextDecoder().decode(releaseBytes));
  require(release.contract === 's16-desktop-release/v1' && Array.isArray(release.assets) && release.assets.length === current.s16PublicAssetCount);
  const { id, ...unsigned } = release; require(hash(JSON.stringify(unsigned)) === id);
  mkdirSync(output, { mode: 0o700 }); let bytes = 0; const seen = new Set<string>();
  for (const asset of release.assets) {
    require(typeof asset.path === 'string' && /^\/s16\/assets\/[a-f0-9]{64}\/[A-Za-z0-9.-]+$/.test(asset.path) && !seen.has(asset.path) && Number.isSafeInteger(asset.bytes) && asset.bytes > 0 && asset.bytes <= 4194304 && (bytes += asset.bytes) <= 8388608);
    seen.add(asset.path); const body = await read(asset.path, 4194304); require(body.length === asset.bytes && hash(body) === asset.sha256);
    const path = join(output, asset.path.slice(1)); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, body, { mode: 0o600, flag: 'wx' });
  }
  const workerBytes = await read(worker.s16WorkerPath, 65536);
  const manifest = { contract: 's16-observed-public-web/v1', source: commit, servicePackageSha256: serviceSha256, release, worker: { path: worker.s16WorkerPath, sha256: hash(workerBytes), bytes: workerBytes.length } };
  writeFileSync(join(output, 'worker.js'), workerBytes, { mode: 0o600, flag: 'wx' }); writeFileSync(join(output, 'web-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { sha256: hash(JSON.stringify(manifest)), releaseSha256: id as string, workerSha256: hash(workerBytes), assets: seen.size, bytes, basis: 'qualified_lifecycle_package_public_bytes_equal_to_source_browser_bundle' };
}

/** Runs the complete reviewed matrix with qualified same-head delivery inputs. No historical receipt is an input. */
export async function runS16DeliveryEvidence(output: string, iosDirectory: string, androidDirectory: string) {
  const source = await observeS16EvidenceSource();
  require(source.state === 'clean' && source.fixtureParserTools.state === 'recorded' && source.fixtureBrowser.state === 'recorded');
  inspectS16DeliveryTree(root, iosDirectory); inspectS16DeliveryTree(root, androidDirectory);
  require(iosDirectory !== androidDirectory && !iosDirectory.startsWith(androidDirectory + '/') && !androidDirectory.startsWith(iosDirectory + '/'));
  const out = createS16EvidenceOutput(output), scratch = join(out, 'source-qualification'); mkdirSync(scratch, { mode: 0o700 });
  const snapshot = prepareMobileBuildSource(root, scratch, source.commit), archive = { archiveSha256: snapshot.archiveSha256, files: snapshot.files, bytes: snapshot.bytes };
  const ios = qualifyS16MobileSource(root, iosDirectory, 'ios-simulator', source.commit, archive), android = qualifyS16MobileSource(root, androidDirectory, 'android', source.commit, archive);
  rmSync(scratch, { recursive: true, force: false });
  const desktopDirectory = join(out, 'desktop'), desktop = await buildNativeDesktop({ source: root, output: desktopDirectory });
  const matrix = readS16EvidenceMatrix(root), sourceRun = join(out, 'matrix');
  const executed = await runS16CrossClientEvidence(matrix.profiles.map(row => row.id), sourceRun, { desktopArtifact: desktopDirectory });
  verifyS16DeliveryLogs(matrix, executed, sourceRun);
  require(equal(source, executed.source) && equal(source, await observeS16EvidenceSource()) && executed.delivery?.desktopSha256 === desktop.id && executed.delivery.after === 'verified_unchanged');
  const service = serviceReceipt(sourceRun, matrix, source), expectedDirectory = join(out, 'service-qualification');
  buildPackage({ srcDir: root, outDir: expectedDirectory, engineContract: RELEASE_CONTRACT, engineRevision: null });
  require(artifactContentHash(expectedDirectory, manifestMetadata(service.manifest)) === service.manifest.contentHash);
  rmSync(expectedDirectory, { recursive: true, force: false });
  const web = await publicWeb(service.directory, join(out, 'web'), source.commit, service.manifest.contentHash);
  // Repeat full seals after executing bundled code and all fixtures, not only before them.
  require(verifyNativeDesktop(desktopDirectory).id === desktop.id && qualifyS16MobileSource(root, iosDirectory, 'ios-simulator', source.commit, archive).id === ios.id && qualifyS16MobileSource(root, androidDirectory, 'android', source.commit, archive).id === android.id);
  const retained = serviceReceipt(sourceRun, matrix, source); require(retained.manifest.contentHash === service.manifest.contentHash && retained.dependency.dependencyHash === service.dependency.dependencyHash);
  const assessment = verifyS16DeliveryLogs(matrix, executed, sourceRun); require(equal(source, await observeS16EvidenceSource()) && equal(json(join(sourceRun, 'receipt.json')), executed));
  const receipt = { contract: 's16-delivery-evidence/v1', source, sourceAfter: 'verified_unchanged', sourceReceiptSha256: fileHash(join(sourceRun, 'receipt.json')),
    artifacts: {
      service: { sha256: service.manifest.contentHash, dependenciesSha256: service.dependency.dependencyHash, basis: 'actual_current_package_exercised_by_selected_lifecycle_and_verified_against_source', journeys: service.record.observations.map((row: any) => row.outcome), lifecycleReceiptSha256: service.receiptSha256 },
      web, desktop: { sha256: desktop.id, basis: 'exact_source_sealed_package_used_by_installed_browser_fixtures' },
      mobile: { ios: ios.id, android: android.id, archive, basis: 'same_commit_native_release_builds', acceptance: 'build-only', nativeUi: 'not_observed' },
      parsers: { sha256: hash(JSON.stringify(source.fixtureParserTools)), basis: source.fixtureParserTools.basis },
    }, execution: executed.execution, scenarios: assessment.scenarios, deterministicInputs: 'passed', deterministicAcceptance: 'passed', productAcceptance: 'blocked', externalEvidence: matrix.externalEvidence };
  writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); return receipt;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 7 || args[0] !== 'accept' || args[1] !== '--out' || args[3] !== '--ios' || args[5] !== '--android') throw Error('s16_delivery_arguments_invalid');
    const result = await runS16DeliveryEvidence(args[2]!, args[4]!, args[6]!);
    console.log(JSON.stringify({ contract: result.contract, source: result.source.commit, sourceAfter: result.sourceAfter, deterministicAcceptance: result.deterministicAcceptance, productAcceptance: result.productAcceptance }));
  } catch { console.error('s16_delivery_evidence_refused'); process.exitCode = 1; }
}
