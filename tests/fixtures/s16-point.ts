import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { s15StageConfig } from '../../ops/evidence/s15-stage';
import { opsDirectory, opsWrite } from '../../src/s14/ops-files';
import { canonical } from '../../src/s15/conversation/validation';
import { readS15RuntimeConfig } from '../../src/s15/runtime-config';
import { FileStore } from '../../src/s16/files/store';
import { adoptS16Operations } from '../../src/s16/operations/adoption';
import { openS16ControlMaintenance, type S16ControlMaintenance } from '../../src/s16/operations/control-maintenance';
import { captureS16LedgerSet } from '../../src/s16/operations/ledger-set';
import { readS16OperationsFence } from '../../src/s16/operations/operations-state';
import { captureS16PayloadSet } from '../../src/s16/operations/payload-set';
import { inspectS16PointFiles, s16PointDirectory, s16PointReconnection, s16RecoveryPointText, type S16PointExpectation, type S16PointRole, type S16RecoveryPoint } from '../../src/s16/operations/point-files';

/** Digest of disposable fixture bytes, never an independently supplied production receipt. */
export const pointFixtureHash = (value: string | Uint8Array) => new Bun.CryptoHasher('sha256').update(value).digest('hex');
/**
 * Actual owning SQL/FILE/native captures in a disposable file-format fixture. Package and external
 * references are explicitly synthetic; this does not certify an aggregate backup or restore flow.
 */
export async function pointFormatFixture(payloadCount = 1) {
  if (!Number.isInteger(payloadCount) || payloadCount < 1 || payloadCount > 512) throw Error('point_fixture_bound');
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-point-format-'))), directory = join(parent, 'state'), configPath = join(parent, 'config.json');
  let ctx: S16ControlMaintenance | undefined;
  const dispose = () => { ctx?.close(); rmSync(parent, { recursive: true, force: true }); };
  try {
    writeFileSync(configPath, JSON.stringify({ ...s15StageConfig(directory, 'http://localhost:3041'), files: true }), { mode: 0o600 });
    const child = Bun.spawn([process.execPath, 'src/main.ts', 'init', '--s15', '--config', configPath], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    if (exit !== 0 || error) throw Error('point_fixture_init_failed: ' + error);
    const config = readS15RuntimeConfig(configPath); ctx = openS16ControlMaintenance(config); const ownerId = ctx.ownerIdentity; ctx.close();
    const data = Buffer.from('Current private point-format fixture input.\n');
    const store = new FileStore({ path: join(directory, 'runtime/files.sqlite'), directory: join(directory, 'runtime/file-bytes'), installationId: config.installationId, create: false, resource: { id: 'computer', revision: 1, generation: 1 }, requireOwner: () => ({ id: ownerId, generation: 1 }) });
    let uploadId = '';
    try { for (let at = 0; at < payloadCount; at++) { const upload = store.create({} as never, { requestId: 'file_original_' + at, conversationId: 'conversation', name: 'notes.txt', bytes: data.length, sha256: pointFixtureHash(data) }); if (at === 0) uploadId = upload.id; await store.write({} as never, upload.id, new Blob([data]).stream()); } } finally { await store.close(); }
    adoptS16Operations(config, 'adoption_original', { now: () => 10, id: () => 'a'.repeat(32) });
    const open = () => { ctx?.close(); ctx = openS16ControlMaintenance(config, existsSync(join(directory, 'owner/owner.sqlite.ops/fence.json')) ? { operationFence: readS16OperationsFence(directory) } : {}); return ctx; };
    const context = open(), journal = context.operations({ now: () => 20, id: () => 'b'.repeat(32) }), requestId = 'point_original';
    journal.begin({ requestId, kind: 'backup', hash: 'c'.repeat(64) }, journal.read().revision); journal.advance(requestId, journal.read().revision, 'capturing');
    const operation = journal.read().requests[0]!, pointId = operation.pointId!, root = s16PointDirectory(directory, pointId), cohortSha256 = 'd'.repeat(64);
    const session = context.nativeSet(requestId, { attempt: 'original', maxBytes: 4294967296 });
    const native = await (async () => { try { return await session.capture(); } finally { await session.close(); } })();
    const nativeManifest = JSON.parse(readFileSync(join(native.directory, 'manifest.json'), 'utf8'));
    const files = context.fileCustody(), github = context.githubArtifacts(), helpers = await context.helperCustody();
    const guard = context.assertCurrent;
    const cutsCurrent = async () => { guard(); files.assertCurrent(); github.assertCurrent(); await helpers.assertCurrent(); guard(); };
    await cutsCurrent();
    opsDirectory(join(root, 'ledgers')); opsDirectory(join(root, 'payloads'));
    captureS16LedgerSet({ directory: join(root, 'ledgers'), installationId: config.installationId, id: pointId, sources: context.sources, guard, now: () => 20 });
    const nativeSources = [
      { name: 'native_plan.json', path: join(native.directory, 'plan.json') },
      { name: 'native_manifest.json', path: join(native.directory, 'manifest.json') },
      ...nativeManifest.roots.map((row: { id: string; name: string }) => ({ name: 'native_' + row.id + '.json', path: join(native.directory, row.name) })),
    ].map(row => { const bytes = readFileSync(row.path); return { ...row, bytes: bytes.length, sha256: pointFixtureHash(bytes) }; });
    captureS16PayloadSet({ directory: join(root, 'payloads'), installationId: config.installationId, id: pointId, sources: [...files.sources, ...github.sources, ...nativeSources], guard, now: () => 20 });
    const references = { contract: 's16-current-references/v1', installationId: config.installationId, helpers: helpers.value,
      external: { contract: 's16-external-custody/v1', installationId: config.installationId, basis: 'point_format_fixture_only' } };
    const capture = { contract: 's16-point-capture/v1', installationId: config.installationId, operationId: operation.id, requestId, cohortSha256,
      native: { actionId: native.actionId, manifestSha256: native.manifestSha256, planSha256: nativeManifest.planSha256, roots: native.roots, pending: native.pending },
      files: { sha256: files.sha256, files: files.sources.length, pending: files.value.pending.length, parserJobs: files.value.parser.jobs.length },
      github: { sha256: github.sha256, bundles: github.value.bundles.length, correlations: github.value.bundles.reduce((n, row) => n + row.references.length, 0) } };
    opsWrite(join(root, 'references.json'), canonical(references)); opsWrite(join(root, 'capture.json'), canonical(capture));
    const specs: readonly [S16PointRole, string, string, string][] = [
      ['ledgers', 's16-ledger-set/v1', 'protected_copy', join(root, 'ledgers', pointId, 'manifest.json')],
      ['payloads', 's16-payload-set/v1', 'inert_copy', join(root, 'payloads', pointId, 'manifest.json')],
      ['references', 's16-current-references/v1', 'independent_current_required', join(root, 'references.json')],
      ['capture', 's16-point-capture/v1', 'capture_evidence', join(root, 'capture.json')],
    ];
    const manifest: S16RecoveryPoint = { contract: 's16-recovery-point/v1', id: pointId, installationId: config.installationId, capturedAt: operation.createdAt, scope: 'selected_control_plane',
      package: { contentHash: '1'.repeat(64), dependencyHash: '2'.repeat(64), lockHash: '3'.repeat(64), engineContract: 'schway.host.release/v2', engineRevision: 'point_format_fixture_only', readersSha256: '4'.repeat(64), noticesSha256: '5'.repeat(64) },
      configuration: { sha256: operation.configurationSha256!, ownerIdentity: ownerId, sources: context.sources.map(row => row.name), runtime: { selected: context.runtime.selected, retained: context.runtime.retained } },
      components: specs.map(([role, contract, custody, path]) => { const bytes = readFileSync(path); return { role, contract, custody, bytes: bytes.length, sha256: pointFixtureHash(bytes) }; }), reconnection: s16PointReconnection };
    const manifestText = s16RecoveryPointText(manifest); opsWrite(join(root, 'manifest.json'), manifestText);
    const expected: S16PointExpectation = { id: pointId, installationId: config.installationId, ownerIdentity: ownerId, operationId: operation.id, requestId, configurationSha256: operation.configurationSha256!, cohortSha256, manifestSha256: pointFixtureHash(manifestText), capturedAt: operation.createdAt };
    const inventory = inspectS16PointFiles(root, expected, guard); expected.bytes = inventory.bytes; await cutsCurrent();
    journal.advance(requestId, journal.read().revision, 'verifying', { cohortSha256, targetSha256: expected.manifestSha256 });
    journal.retainPoint(requestId, journal.read().revision, { sha256: expected.manifestSha256, bytes: inventory.bytes }); journal.advance(requestId, journal.read().revision, 'complete');
    return { parent, directory, configPath, config, pointId, root, expected, manifest, inventory, uploadId, data, open, dispose,
      get context() { return ctx!; } };
  } catch (error) { try { dispose(); } catch { /* Preserve the original fixture failure for diagnosis. */ } throw error; }
}
