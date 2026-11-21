import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readS15RuntimeConfig } from '../../src/s15/runtime-config';
import { openS16ControlMaintenance } from '../../src/s16/operations/control-maintenance';
import { captureS16PayloadSet, s16PayloadSetManifestHash, verifyS16PayloadSet } from '../../src/s16/operations/payload-set';

/** Sidecar process-death driver; production imports and the child's imports resolve only to the copied artifact. */
export async function probePackagedFileCustody(configPath: string): Promise<object> {
  const config = readS15RuntimeConfig(configPath), initial = openS16ControlMaintenance(config), ownerId = initial.ownerIdentity; initial.close();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../../tests/fixtures/s16-file-custody-process.ts'), config.directory, config.installationId, ownerId, 'validating'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const reader = child.stdout.getReader(), timer = setTimeout(() => child.kill('SIGKILL'), 5000); let id: string;
  try { const next = await reader.read(), value = JSON.parse(Buffer.from(next.value!).toString()); if (next.done || value.state !== 'validating' || typeof value.id !== 'string') throw Error('packaged_file_interruption_missing'); id = value.id; }
  finally { clearTimeout(timer); child.kill('SIGKILL'); await child.exited; await reader.cancel(); reader.releaseLock(); if (await new Response(child.stderr).text()) throw Error('packaged_file_fixture_failed'); }
  const context = openS16ControlMaintenance(config);
  try {
    const source = context.runtime.sources.find(row => row.name === 'files.sqlite')!, db = source.database;
    const before = readFileSync(join(config.directory, 'runtime/file-bytes', id! + '.part')), changes = db.query<{ n: number }, []>('SELECT total_changes() n').get()!.n;
    const cut = context.fileCustody(); cut.assertCurrent();
    if (cut.value.pending.length !== 1 || cut.value.pending[0]!.id !== id! || cut.value.pending[0]!.state !== 'validating' || cut.value.parser.jobs.length !== 1 || cut.sources.length !== 4 || cut.value.files.some(row => row.trust !== 'untrusted') || cut.value.parser.container.originalJobId !== null || cut.value.parser.container.generation !== null || cut.value.parser.container.settlement !== 'unobserved' || JSON.stringify(cut.value).includes(config.directory)) throw Error('packaged_file_custody_invalid');
    const directory = join(dirname(configPath), 'file-cohort-capture'); mkdirSync(directory, { mode: 0o700 });
    const options = { directory, id: '7'.repeat(32), installationId: config.installationId, sources: cut.sources, guard: context.assertCurrent }, manifest = captureS16PayloadSet(options);
    verifyS16PayloadSet({ ...options, files: manifest.files, manifestSha256: s16PayloadSetManifestHash(manifest) }); cut.assertCurrent();
    if (db.query<{ n: number }, []>('SELECT total_changes() n').get()!.n !== changes || JSON.parse(db.query<{ json: string }, [string]>('SELECT json FROM records WHERE id=?').get(id!)!.json).state !== 'validating' || !before.equals(readFileSync(join(config.directory, 'runtime/file-bytes', id! + '.part')))) throw Error('packaged_file_recovered_during_capture');
    const output = cut.value.files.find(row => row.role === 'parser_output')!, path = cut.sources.find(row => row.name === output.name)!.path; writeFileSync(path, 'changed retained output', { mode: 0o600 });
    let refused = false; try { cut.assertCurrent(); } catch { refused = true; } if (!refused) throw Error('packaged_file_changed_cut_accepted');
    return { basis: 'protocol_fixture', contract: cut.value.contract, interruption: 'actual_sigkill', files: manifest.files.length, bytes: manifest.bytes, parserJobs: cut.value.parser.jobs.length, currentState: 'validating_preserved', trust: 'untrusted_retained', parserJobCorrelation: 'unobserved', sourceBytes: 'preserved', applicationWrites: 0, payloadVerification: 'passed', changedCut: 'refused', privatePaths: 'not_exported', aggregateBackup: 'not_exercised' };
  } finally { context.close(); }
}

if (import.meta.main) console.log(JSON.stringify(await probePackagedFileCustody(Bun.argv[2]!)));
