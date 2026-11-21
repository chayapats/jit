import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConnectionVault } from '../../src/exec/connections';
import { readS15RuntimeConfig } from '../../src/s15/runtime-config';
import { GithubBundleStore } from '../../src/s15/github/artifacts';
import { githubConnectionRuntime } from '../../src/s15/github/runtime';
import { GithubStore } from '../../src/s15/github/store';
import type { Ref } from '../../src/s15/policy';
import { DurableJournal } from '../../src/s15/durable-journal';
import { digest as policyDigest } from '../../src/s15/policy/validation';
import { openS16ControlMaintenance } from '../../src/s16/operations/control-maintenance';
import { captureS16PayloadSet, s16PayloadSetManifestHash, verifyS16PayloadSet } from '../../src/s16/operations/payload-set';

/** Actual local Git objects and owning packaged byte/SQL writers around explicit protocol-fixture original states. */
export async function probePackagedGithubCustody(configPath: string): Promise<object> {
  const config = readS15RuntimeConfig(configPath), parent = dirname(configPath), working = join(parent, 'github-working'), root = join(config.directory, 'github-artifacts'); mkdirSync(working, { mode: 0o700 });
  const git = (...args: string[]) => { const result = Bun.spawnSync(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', ...args], { cwd: working, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 5000 }); if (result.exitCode !== 0) throw Error('packaged_git_fixture_failed'); };
  git('init', '-q'); const writer = new GithubBundleStore(root, 268435456), refs: Ref[] = [];
  for (let i = 0; i < 4; i++) { writeFileSync(join(working, 'notes.txt'), 'Fixture revision ' + i + '\n', { mode: 0o600 }); git('add', 'notes.txt'); git('commit', '-qm', 'Fixture revision ' + i); const path = join(working, 'bundle-' + i); git('bundle', 'create', path, 'HEAD'); const bytes = readFileSync(path); refs.push(writer.capture(bytes, new Bun.CryptoHasher('sha256').update(bytes).digest('hex'))); }
  const path = join(config.directory, 'runtime/github.sqlite'), store = new GithubStore(path, config.installationId, false);
  const current = { id: 'selected_current', workId: 'original_work', state: 'implementing', evidence: { bundle: refs[0] } }, prior = { ...current, id: 'selected_prior', state: 'reconcile_only', evidence: { bundle: refs[1] } };
  try { store.tx(() => { store.put('selection', current.id, current); store.put('babysit', 'original_babysit', { id: 'original_babysit', state: 'remediating' }); store.put('action', 'original_action', { id: 'original_action', selection: prior, evidence: prior.evidence, effect: { bundle: refs[1] } }); store.put('remote_result', 'original_action', { outcome: 'unknown', receipt: null }); store.commitReceipt('select_original', 'd'.repeat(64), prior); }); } finally { store.close(); }
  const lineagePath = join(config.directory, 'runtime/disclosure.sqlite'), lineage = new DurableJournal(lineagePath, config.installationId, false, 0x4a445135), derived = 'derived_' + policyDigest('s15.disclosure.derived.v1', refs[3]);
  try { lineage.tx(() => lineage.put(derived, { kind: 'derived', id: derived, ref: refs[3], workId: 'original_work', format: 'artifact', sources: [] })); } finally { lineage.close(); }
  let credentials = 0, network = 0, subprocesses = 0;
  const read = ConnectionVault.prototype.read, existing = ConnectionVault.prototype.readExisting, fetch = globalThis.fetch, spawn = Bun.spawn, spawnSync = Bun.spawnSync;
  const credential = () => { credentials++; throw Error('unexpected_packaged_credential'); };
  ConnectionVault.prototype.read = credential; ConnectionVault.prototype.readExisting = credential;
  globalThis.fetch = Object.assign(async (): Promise<Response> => { network++; throw Error('unexpected_packaged_network'); }, { preconnect() { network++; throw Error('unexpected_packaged_network'); } }) as typeof fetch;
  Bun.spawn = (() => { subprocesses++; throw Error('unexpected_packaged_process'); }) as typeof Bun.spawn;
  Bun.spawnSync = (() => { subprocesses++; throw Error('unexpected_packaged_process'); }) as typeof Bun.spawnSync;
  let context: ReturnType<typeof openS16ControlMaintenance> | undefined;
  try {
    const runtime = githubConnectionRuntime({ directory: config.directory, vmId: 'working', route: { provider: 'codex', model: 'fixture' }, modelCallUpperBound: { attempts: 0, steps: 0, calls: 0, reads: 0, outputBytes: 0, activeMs: 0, spendMinor: '0' }, repositories: () => [], credential, catalogPurpose: { id: 'fixture', revision: 1, generation: 1 } });
    if (refs.some(ref => !runtime.current(ref.id)?.active)) throw Error('packaged_owning_artifact_reader_failed');
    const before = readFileSync(path), lineageBefore = readFileSync(lineagePath); context = openS16ControlMaintenance(config); const db = context.runtime.sources.find(row => row.name === 'github.sqlite')!.database, changes = db.query<{ n: number }, []>('SELECT total_changes() n').get()!.n, lineageDb = context.runtime.sources.find(row => row.name === 'disclosure.sqlite')!.database, lineageChanges = lineageDb.query<{ n: number }, []>('SELECT total_changes() n').get()!.n;
    const cut = context.githubArtifacts(); cut.assertCurrent();
    if (cut.value.bundles.length !== 4 || cut.value.bundles.find(row => row.id === refs[1]!.id)?.references.length !== 4 || cut.value.bundles.find(row => row.id === refs[2]!.id)?.references.length !== 0 || cut.value.bundles.find(row => row.id === refs[3]!.id)?.references[0]?.table !== 'disclosure' || JSON.stringify(cut.value).includes(config.directory)) throw Error('packaged_github_custody_invalid');
    const directory = join(parent, 'github-payload-capture'); mkdirSync(directory, { mode: 0o700 }); const options = { directory, id: '8'.repeat(32), installationId: config.installationId, sources: cut.sources, guard: context.assertCurrent }, manifest = captureS16PayloadSet(options);
    verifyS16PayloadSet({ ...options, files: manifest.files, manifestSha256: s16PayloadSetManifestHash(manifest) }); cut.assertCurrent();
    const row = (kind: string, id: string) => JSON.parse(db.query<{ json: string }, [string, string]>('SELECT json FROM records WHERE kind=? AND id=?').get(kind, id)!.json);
    if (row('selection', 'selected_current').state !== 'implementing' || row('babysit', 'original_babysit').state !== 'remediating' || row('remote_result', 'original_action').outcome !== 'unknown' || db.query<{ n: number }, []>('SELECT total_changes() n').get()!.n !== changes || lineageDb.query<{ n: number }, []>('SELECT total_changes() n').get()!.n !== lineageChanges || !before.equals(readFileSync(path)) || !lineageBefore.equals(readFileSync(lineagePath)) || credentials || network || subprocesses) throw Error('packaged_github_recovered_during_capture');
    const original = join(root, refs[0]!.id); renameSync(original, original + '.old'); writeFileSync(original, readFileSync(original + '.old'), { mode: 0o600 }); unlinkSync(original + '.old');
    let refused = false; try { cut.assertCurrent(); } catch { refused = true; } if (!refused) throw Error('packaged_github_changed_cut_accepted');
    return { basis: 'protocol_fixture', contract: cut.value.contract, gitObjects: 'actual_local_bundles', writer: 'owning_packaged', bundles: manifest.files.length, bytes: manifest.bytes, oldReferences: 4, unpublishedRetained: 1, lineageReferences: 1, originalStates: 'preserved', sourceSqlBytes: 'preserved', applicationWrites: 0, credentialReads: credentials, networkCalls: network, subprocessesDuringCapture: subprocesses, payloadVerification: 'passed', changedInode: 'refused', privatePaths: 'not_exported', aggregateBackup: 'not_exercised' };
  } finally { context?.close(); ConnectionVault.prototype.read = read; ConnectionVault.prototype.readExisting = existing; globalThis.fetch = fetch; Bun.spawn = spawn; Bun.spawnSync = spawnSync; }
}

if (import.meta.main) console.log(JSON.stringify(await probePackagedGithubCustody(Bun.argv[2]!)));
