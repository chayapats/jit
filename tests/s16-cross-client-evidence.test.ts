import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assessS16MatrixEvidence, observeS16BunTests, type S16ProfileEvidence } from '../ops/evidence/s16-cross-client';
import { readS16EvidenceMatrix, s16EvidencePath, validateS16EvidenceMatrix } from '../ops/evidence/s16-matrix';

const root = resolve(import.meta.dir, '..'), roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const matrix = () => structuredClone(readS16EvidenceMatrix(root));

test('the reviewed plan retains all ACs and narrower FR/NFR traces, including unavailable owning deliveries', () => {
  const plan = matrix();
  expect(plan.scenarios).toHaveLength(24); expect(plan.requirements).toHaveLength(56);
  for (const requirement of plan.requirements) expect(plan.scenarios.some(row => row.id !== 'ac22' && row.requirements.includes(requirement.id))).toBe(true);
  expect(plan.profiles.some(row => row.id === 'mobile')).toBe(true); expect(plan.profiles.some(row => row.id === 'operations')).toBe(true);
  expect(plan.externalEvidence.map(row => row.status)).toEqual(Array(5).fill('pending'));
});

test.each(['missing-ac', 'missing-fr', 'aggregate-only-fr', 'empty-assertions', 'optional-ac', 'unknown-profile', 'duplicate-profile', 'implicit-live', 'shell', 'traversal'] as const)('invalid matrix %s refuses instead of shrinking acceptance', mode => {
  const plan = matrix();
  if (mode === 'missing-ac') plan.scenarios.splice(0, 1);
  if (mode === 'missing-fr') plan.requirements.splice(0, 1);
  if (mode === 'aggregate-only-fr') for (const scenario of plan.scenarios) if (scenario.id !== 'ac22') scenario.requirements = scenario.requirements.filter(name => name !== 'FR-08');
  if (mode === 'empty-assertions') plan.scenarios[0]!.expectedOutcomes = [];
  if (mode === 'optional-ac') Object.assign(plan.scenarios[0]!, { required: false });
  if (mode === 'unknown-profile') plan.scenarios[0]!.profiles.push('absent_owner');
  if (mode === 'duplicate-profile') plan.profiles.push(structuredClone(plan.profiles[0]!));
  if (mode === 'implicit-live') Object.assign(plan.profiles[0]!, { environment: { JIT_LIVE_TESTS: '1' } });
  if (mode === 'shell') Object.assign(plan.profiles[0]!, { command: 'sh -c arbitrary' });
  if (mode === 'traversal') plan.profiles[0]!.suites = ['tests/../private.test.ts'];
  expect(() => validateS16EvidenceMatrix(plan, root)).toThrow();
});

test('fixed test paths reject symlink files/directories and preserve explicit absence', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'jit-matrix-path-'))); roots.push(directory);
  mkdirSync(join(directory, 'tests')); writeFileSync(join(directory, 'owned.test.ts'), 'keep original');
  symlinkSync('../owned.test.ts', join(directory, 'tests/link.test.ts')); symlinkSync('tests', join(directory, 'alias'));
  expect(() => s16EvidencePath(directory, 'tests/link.test.ts')).toThrow('s16_matrix_path_invalid');
  expect(() => s16EvidencePath(directory, 'alias/missing.test.ts')).toThrow('s16_matrix_path_invalid');
  expect(s16EvidencePath(directory, 'tests/missing.test.ts')).toBeNull();
  expect(() => s16EvidencePath(directory, 'tests/../../elsewhere.test.ts')).toThrow('s16_matrix_path_invalid');
});

async function actualBun(source: string) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'jit-matrix-bun-'))); roots.push(directory);
  const path = join(directory, 'observed.test.ts'); writeFileSync(path, "import {expect,test} from 'bun:test';\n" + source);
  const child = Bun.spawn([process.execPath, 'test', path], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', NO_COLOR: '1' } });
  const [exitCode, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, log: out + error };
}

test('actual Bun pass observations retain assertion counts and hash test names', async () => {
  const result = await actualBun("test('actual resulting bytes',()=>{expect('retained').toBe('retained');expect(2).toBe(2)});");
  expect(result.exitCode).toBe(0);
  const observed = observeS16BunTests(result.log)!;
  expect(observed).toMatchObject({ pass: 1, fail: 0, skip: 0, assertions: 2 });
  expect(observed.testNameSha256).toHaveLength(1); expect(observed.testNameSha256[0]).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(observed)).not.toContain('actual resulting bytes');
});

test('actual required skips remain visible even when Bun exits successfully', async () => {
  const result = await actualBun("test('observed',()=>expect(1).toBe(1));test.skip('required unavailable path',()=>expect(2).toBe(2));");
  expect(result.exitCode).toBe(0); expect(observeS16BunTests(result.log)).toMatchObject({ pass: 1, fail: 0, skip: 1, assertions: 1 });
});

test('zero assertions, duplicate summaries and truncated logs cannot become observations', async () => {
  const empty = await actualBun("test('no assertions',()=>{});");
  expect(empty.exitCode).toBe(0); expect(observeS16BunTests(empty.log)).toBeNull();
  const actual = await actualBun("test('observed',()=>expect(1).toBe(1));");
  expect(observeS16BunTests(actual.log + actual.log)).toBeNull();
  expect(observeS16BunTests(actual.log.slice(0, -35))).toBeNull();
  expect(observeS16BunTests('x'.repeat(65536) + actual.log)).toBeNull();
});

/** Explicit result fixtures test accounting only; they are never stored as product evidence. */
function passingInputs(): S16ProfileEvidence[] {
  return matrix().profiles.map(profile => ({ id: profile.id, state: 'passed', basis: profile.basis, reused: profile.reused,
    suites: profile.suites.map(suite => ({ suite, state: 'passed', exitCode: 0, observations: { pass: profile.requiredObservations, fail: 0, skip: 0, assertions: profile.requiredObservations, testNameSha256: Array(profile.requiredObservations).fill('a'.repeat(64)) }, logSha256: 'b'.repeat(64), logBytes: 250 })) }));
}

test('even every passing integrated input preserves unrecorded artifacts and independent live/device gaps', () => {
  const result = assessS16MatrixEvidence(matrix(), passingInputs());
  expect(result.deterministicInputs).toBe('passed'); expect(result.deterministicAcceptance).toBe('blocked'); expect(result.productAcceptance).toBe('blocked');
  expect(result.scenarios.find(row => row.id === 'ac21')!.state).toBe('source_inputs_passed');
  expect(result.scenarios.find(row => row.id === 'ac22')!.driverGaps).toEqual([]);
  expect(result.scenarios.find(row => row.id === 'ac22')!.profiles).toContainEqual({ id: 'voice_mobile', state: 'passed' });
  expect(result.additionalBlockers).toContain('native_ui'); expect(result.additionalBlockers).toContain('profile_specific_artifact_digests_unrecorded');
});

test.each(['omitted', 'empty', 'skip', 'failed', 'missing-observations', 'duplicate-suite', 'wrong-basis'] as const)('a %s required input cannot be promoted by a passing profile label', mode => {
  const inputs = passingInputs(), changed = inputs[0]!;
  if (mode === 'omitted') inputs.shift();
  if (mode === 'empty') changed.suites = [];
  if (mode === 'skip') changed.suites[0]!.observations!.skip = 1;
  if (mode === 'failed') changed.suites[0]!.exitCode = 1;
  if (mode === 'missing-observations') changed.suites[0]!.observations = null;
  if (mode === 'duplicate-suite') changed.suites.push(structuredClone(changed.suites[0]!));
  if (mode === 'wrong-basis') changed.basis = 'claimed_native_ui';
  const result = assessS16MatrixEvidence(matrix(), inputs);
  expect(result.deterministicInputs).toBe('blocked'); expect(result.scenarios.find(row => row.id === 'ac01')!.state).toBe('source_inputs_pending');
});
