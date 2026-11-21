import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { RELEASE_CONTRACT } from 'schway/host';
import { spawnRunner } from '../../src/ops/supervisor';
import { readS16EvidenceMatrix, s16EvidencePath, type S16EvidenceMatrix, type S16EvidenceProfile } from './s16-matrix';
import { s16FixtureParserTools, s16FixturePath } from './s16-fixture-tools';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const root = realpathSync(resolve(import.meta.dir, '../..'));
const matrixName = 'docs/evidence/s16-cross-client-matrix.json';
const outputLimit = 65536;
/** Observed Bun cases, never inferred from process exit or suite source presence. Names stay hashed in receipts. */
export interface S16SuiteObservations { pass: number; fail: number; skip: number; assertions: number; testNameSha256: string[] }
/** One bounded source-suite execution or an explicit missing input. Private logs are stored separately. */
export interface S16SuiteEvidence {
  suite: string; state: 'passed' | 'failed' | 'skipped' | 'unavailable' | 'unobserved' | 'timed_out' | 'output_bound';
  exitCode: number | null; observations: S16SuiteObservations | null; logSha256: string | null; logBytes: number;
}
/** A profile is passing only when every declared suite and required observation passed without skips. */
export interface S16ProfileEvidence { id: string; basis: string; reused: boolean; state: 'passed' | 'blocked' | 'not_run'; suites: S16SuiteEvidence[] }

/** Rejects truncated, zero-assertion, missing and inconsistent test summaries. */
export function observeS16BunTests(log: string): S16SuiteObservations | null {
  if (Buffer.byteLength(log) >= outputLimit) return null;
  const plain = log.replace(/\x1b\[[0-9;]*m/g, '');
  const summary = /\n\s*(\d+) pass\n(?:\s*(\d+) skip\n)?\s*(\d+) fail\n\s*(\d+) expect\(\) calls\nRan (\d+) tests? across 1 file\./g;
  const matches = [...plain.matchAll(summary)]; if (matches.length !== 1) return null;
  const match = matches[0]!, pass = Number(match[1]), skip = Number(match[2] ?? 0), fail = Number(match[3]), assertions = Number(match[4]), total = Number(match[5]);
  const cases = [...plain.matchAll(/^\((pass|fail|skip)\) (.+)$/gm)];
  if (![pass, skip, fail, assertions, total].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 10000000) || pass < 1 || assertions < 1 || pass + skip + fail !== total || cases.length !== total) return null;
  for (const [kind, count] of [['pass', pass], ['skip', skip], ['fail', fail]] as const) if (cases.filter(row => row[1] === kind).length !== count) return null;
  return { pass, fail, skip, assertions, testNameSha256: cases.map(row => hash(row[2]!.replace(/ \[[^\n]*\]$/, ''))) };
}

/** Missing profiles, unsupported drivers and unrecorded artifacts remain blockers, including in partial runs. */
export function assessS16MatrixEvidence(matrix: S16EvidenceMatrix, results: readonly S16ProfileEvidence[]) {
  if (new Set(results.map(row => row.id)).size !== results.length || results.some(row => !matrix.profiles.some(profile => profile.id === row.id))) throw Error('s16_matrix_result_invalid');
  const profileState = new Map(matrix.profiles.map(profile => {
    const result = results.find(row => row.id === profile.id);
    const passed = result?.state === 'passed' && result.basis === profile.basis && result.reused === profile.reused && result.suites.length === profile.suites.length && profile.suites.every(suite => {
      const matches = result.suites.filter(row => row.suite === suite), observed = matches[0]?.observations;
      return matches.length === 1 && matches[0]!.state === 'passed' && matches[0]!.exitCode === 0 && /^[a-f0-9]{64}$/.test(matches[0]!.logSha256 ?? '') && matches[0]!.logBytes > 0 && matches[0]!.logBytes < outputLimit && observed !== null && observed !== undefined && Number.isSafeInteger(observed.pass) && observed.pass > 0 && observed.fail === 0 && observed.skip === 0 && Number.isSafeInteger(observed.assertions) && observed.assertions > 0 && observed.testNameSha256.length === observed.pass && observed.testNameSha256.every(name => /^[a-f0-9]{64}$/.test(name));
    }) && result.suites.reduce((sum, suite) => sum + (suite.observations?.pass ?? 0), 0) >= profile.requiredObservations;
    return [profile.id, passed ? 'passed' : result ? 'blocked' : 'not_run'] as const;
  }));
  const scenarios = matrix.scenarios.map(scenario => ({ id: scenario.id, acceptance: scenario.acceptance, requirements: scenario.requirements, owners: scenario.owners,
    state: scenario.requiredDriverGaps.length ? 'driver_gap' : scenario.profiles.every(name => profileState.get(name) === 'passed') ? 'source_inputs_passed' : 'source_inputs_pending',
    profiles: scenario.profiles.map(id => ({ id, state: profileState.get(id) })), driverGaps: scenario.requiredDriverGaps }));
  return { deterministicInputs: [...profileState.values()].every(state => state === 'passed') ? 'passed' : 'blocked',
    // This source executor does not promote package/native artifacts from test output or accept external receipts.
    deterministicAcceptance: 'blocked', productAcceptance: 'blocked',
    additionalBlockers: ['profile_specific_artifact_digests_unrecorded', ...matrix.externalEvidence.map(row => row.id)], scenarios };
}

function git(checkout: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', checkout, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env: { PATH: '/usr/bin:/bin' } });
  if (result.exitCode !== 0) throw Error('s16_matrix_source_unavailable'); return result.stdout.toString().trim();
}
/** Source dependency seal includes bounded internal file symlinks; it is not a packaged dependency seal. */
function dependencies(checkout: string) {
  const directory = realpathSync(join(checkout, 'node_modules')), digest = createHash('sha256'); let files = 0, bytes = 0;
  const walk = (at: string, name: string, depth: number) => {
    if (depth > 32) throw Error('s16_matrix_dependency_bounds');
    const stat = lstatSync(at); digest.update(`${name}\0${stat.mode.toString(8)}\0`);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(at);
      if (!target.startsWith(directory + '/') || !lstatSync(target).isFile()) throw Error('s16_matrix_dependency_link_invalid');
      digest.update(`l\0${readlinkSync(at)}\0`); files++;
    } else if (stat.isDirectory()) { digest.update('d\0'); for (const child of readdirSync(at).sort()) walk(join(at, child), name + '/' + child, depth + 1); }
    else if (stat.isFile()) {
      if (stat.size > 134217728 || (bytes += stat.size) > 1073741824) throw Error('s16_matrix_dependency_bounds');
      digest.update(`f\0${hash(readFileSync(at))}\0`); files++;
    } else throw Error('s16_matrix_dependency_invalid');
    if (files > 50000) throw Error('s16_matrix_dependency_bounds');
  };
  walk(directory, 'node_modules', 0); return { basis: 'source_dependency_tree_with_internal_file_links/v1', sha256: digest.digest('hex'), files };
}
async function fingerprint(matrix: S16EvidenceMatrix) {
  const commit = git(root, ['rev-parse', 'HEAD']); if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('s16_matrix_source_invalid');
  const status = git(root, ['status', '--porcelain', '--untracked-files=normal']);
  return { commit, state: status === '' ? 'clean' : 'changed', matrixSha256: hash(readFileSync(join(root, matrixName))),
    documents: [...matrix.governingDocuments, matrix.historicalOwnership].map(path => ({ path, sha256: hash(readFileSync(s16EvidencePath(root, path)!)) })),
    lockSha256: hash(readFileSync(join(root, 'bun.lock'))), dependencies: dependencies(root),
    engine: { contract: RELEASE_CONTRACT, revision: 'unverified', basis: 'executing_public_host_contract_and_vendored_archive' },
    vendor: readdirSync(join(root, 'vendor')).sort().map(name => ({ name, sha256: hash(readFileSync(s16EvidencePath(root, 'vendor/' + name)!)) })),
    platform: process.platform, arch: process.arch, bunVersion: Bun.version, bunSha256: hash(readFileSync(process.execPath)), fixtureParserTools: await s16FixtureParserTools() };
}
function freshOutput(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || !path.startsWith(join(root, '.local') + '/') || existsSync(path)) throw Error('s16_matrix_output_invalid');
  const parent = dirname(path); let at = root;
  for (const part of parent.slice(root.length + 1).split('/')) {
    at = join(at, part); const stat = lstatSync(at, { throwIfNoEntry: false });
    if (stat) { if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('s16_matrix_output_invalid'); }
    else mkdirSync(at, { mode: 0o700 });
  }
  mkdirSync(path, { mode: 0o700 }); return path;
}
async function executeProfile(profile: S16EvidenceProfile, out: string): Promise<S16ProfileEvidence> {
  const suites: S16SuiteEvidence[] = [], privateRoot = join(out, profile.id); mkdirSync(privateRoot, { mode: 0o700 });
  for (const directory of ['home', 'tmp', 'cache']) mkdirSync(join(privateRoot, directory), { mode: 0o700 });
  const env: Record<string, string> = { PATH: s16FixturePath(), HOME: join(privateRoot, 'home'), TMPDIR: join(privateRoot, 'tmp'), XDG_CACHE_HOME: join(privateRoot, 'cache'), NO_COLOR: '1', TZ: 'UTC' };
  const browserPath = process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium';
  if (profile.kind === 'browser') Object.assign(env, { JIT_S16_BROWSER_TESTS: '1', JIT_S16_DESKTOP_TESTS: '1', JIT_BROWSER_LIVE: '1', JIT_BROWSER_EXECUTABLE: browserPath });
  for (const [index, suite] of profile.suites.entries()) {
    if (!s16EvidencePath(root, suite) || profile.kind === 'browser' && !existsSync(browserPath)) {
      suites.push({ suite, state: 'unavailable', exitCode: null, observations: null, logSha256: null, logBytes: 0 }); continue;
    }
    // No shell. Both test streams enter the existing process-group/output/time bounded runner.
    const argv = ['test', '--timeout', '30000', './' + suite];
    const wrapper = `const p=Bun.spawn([process.execPath,...${JSON.stringify(argv)}],{stdin:'ignore',stdout:1,stderr:1});process.exit(await p.exited);`;
    let result;
    try { result = await spawnRunner([process.execPath, '--eval', wrapper], { cwd: root, env, timeoutMs: profile.timeoutMs }); }
    catch { suites.push({ suite, state: 'unavailable', exitCode: null, observations: null, logSha256: null, logBytes: 0 }); continue; }
    const observations = observeS16BunTests(result.stdout), logBytes = Buffer.byteLength(result.stdout);
    const state = result.timedOut ? 'timed_out' : logBytes >= outputLimit ? 'output_bound' : result.exitCode !== 0 ? 'failed' : !observations ? 'unobserved' : observations.skip ? 'skipped' : observations.fail ? 'failed' : 'passed';
    writeFileSync(join(privateRoot, `${index}.log`), result.stdout, { mode: 0o600, flag: 'wx' });
    suites.push({ suite, state, exitCode: result.exitCode, observations, logSha256: hash(result.stdout), logBytes });
  }
  return { id: profile.id, basis: profile.basis, reused: profile.reused, state: suites.every(suite => suite.state === 'passed') && suites.reduce((sum, suite) => sum + (suite.observations?.pass ?? 0), 0) >= profile.requiredObservations ? 'passed' : 'blocked', suites };
}

/** Runs selected reviewed source profiles; all omitted, missing and external requirements stay in its private receipt. */
export async function runS16CrossClientEvidence(profiles: readonly string[], output: string) {
  const matrix = readS16EvidenceMatrix(root);
  if (!profiles.length || new Set(profiles).size !== profiles.length || profiles.some(id => !matrix.profiles.some(profile => profile.id === id))) throw Error('s16_matrix_profile_invalid');
  const before = await fingerprint(matrix); if (before.state !== 'clean') throw Error('s16_matrix_clean_source_required');
  const out = freshOutput(output), results: S16ProfileEvidence[] = [];
  for (const name of profiles) results.push(await executeProfile(matrix.profiles.find(profile => profile.id === name)!, out));
  let after: Awaited<ReturnType<typeof fingerprint>> | null = null;
  try { after = await fingerprint(matrix); } catch { /* A removed/corrupt source or dependency cannot certify the earlier input. */ }
  const unchanged = JSON.stringify(before) === JSON.stringify(after), assessment = assessS16MatrixEvidence(matrix, results);
  const receipt = { contract: 's16-cross-client-evidence/v1', basis: 'executed_source_profiles_with_scripted_ports', source: before, sourceAfter: unchanged ? 'verified_unchanged' : 'changed',
    execution: { profiles: [...profiles], argv: 'bun test --timeout 30000 ./<reviewed-suite>', outputBoundBytes: outputLimit, timeoutScope: 'per_suite_process_group', profileResults: results },
    artifacts: ['service_package', 'web_bundle', 'desktop_client', 'mobile_client', 'parsers'].map(kind => ({ kind, state: 'unrecorded', sha256: null })),
    ...assessment, ...(unchanged ? {} : { deterministicInputs: 'blocked', sourceBlocker: 'source_or_dependencies_changed' }), externalEvidence: matrix.externalEvidence };
  writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); return receipt;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === 'validate') {
      const matrix = readS16EvidenceMatrix(root);
      console.log(JSON.stringify({ contract: matrix.contract, validation: 'passed', scenarios: matrix.scenarios.length, requirements: matrix.requirements.length, profiles: matrix.profiles.length,
        unavailableSuites: matrix.profiles.flatMap(profile => profile.suites.filter(path => !s16EvidencePath(root, path)).map(suite => ({ profile: profile.id, suite }))), execution: 'not_run' }));
    } else if (args.length === 5 && args[0] === 'run' && args[1] === '--profiles' && args[3] === '--out') {
      const receipt = await runS16CrossClientEvidence(args[2]!.split(','), args[4]!);
      console.log(JSON.stringify({ contract: receipt.contract, source: receipt.source.commit, sourceAfter: receipt.sourceAfter, deterministicInputs: receipt.deterministicInputs, deterministicAcceptance: receipt.deterministicAcceptance, productAcceptance: receipt.productAcceptance }));
      if (receipt.deterministicInputs !== 'passed' || receipt.deterministicAcceptance !== 'passed') process.exitCode = 2;
    } else throw Error('s16_matrix_arguments_invalid');
  } catch { console.error('s16_cross_client_evidence_refused'); process.exitCode = 1; }
}
