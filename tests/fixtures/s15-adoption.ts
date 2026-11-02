import { mkdirSync, readFileSync, readdirSync, lstatSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { domainFixture, retryId, workCommand } from './s14-domain';
import { hashBytes, hashValue } from '../../src/s15/adoption/validation';
import { openAdoptionService, reportAdoption, type AdoptionCheckpoint, type AdoptionCommand, type AdoptionOptions, type AdoptionService } from '../../src/s15/adoption';
import { ref, selection } from './s15-policy';
import type { PolicyInput } from '../../src/s15/policy';

export const policyInput = (): PolicyInput => ({ purposes: [ref('purpose')], bots: [ref('bot')], resources: [], recipients: [], selections: [selection], rules: [],
  budget: { currency: 'USD', startsAt: 0, expiresAt: 100000, ceiling: { attempts: 4, steps: 4, calls: 40, reads: 40, outputBytes: 10000, activeMs: 10000, spendMinor: '10' }, concurrency: 1 }, expiresAt: 100000 });
export const workRequest = () => ({ requestId: retryId(), intent: 'execute' as const, purpose: ref('purpose'), bot: ref('bot'), resources: [], recipients: [], selection, selectionPin: null, expiresAt: 90000 });

/** Real S14 domain state plus explicit no-network protected host/authentication seams and a fake clock. */
export async function adoptionFixture(seed?: (f: Awaited<ReturnType<typeof domainFixture>>) => void | Promise<void>) {
  const f = await domainFixture();
  const claim = f.app.execute(f.auth.actor, { kind: 'memory.remember', requestId: retryId(), expectedRevision: f.app.conversation(f.auth.actor, f.conversationId).conversation.revision, payload: { conversationId: f.conversationId, text: 'Private S14 owner knowledge' } }).claim!;
  const work = f.app.execute(f.auth.actor, workCommand(f));
  f.store.transaction(tx => {
    tx.run("INSERT INTO lifecycle.withdrawals VALUES ('source','forgotten_source','forgotten')");
    tx.run("INSERT INTO lifecycle.grant_usage VALUES ('orphan_grant',2,1,7,200,5)");
    tx.run("INSERT INTO lifecycle.routine_usage VALUES ('orphan_routine',6,1000)");
    tx.run('INSERT INTO grant_usage VALUES (?,1,1,3,100,2) ON CONFLICT(grant_id) DO UPDATE SET attempts=1,steps=1,calls=3,output_bytes=100,reads=2', work.grant!.id);
    tx.run('INSERT INTO lifecycle.grant_usage VALUES (?,1,1,7,100,5)', work.grant!.id);
  });
  await seed?.(f);
  const root = f.root, state = join(root, 'state'); mkdirSync(state, { mode: 0o700 });
  const installationId = f.store.read(tx => tx.get<{ id: string }>('SELECT id FROM memory_identity')!.id);
  f.store.close();
  const database = join(state, 'application.sqlite');
  renameSync(f.path, database); renameSync(f.path + '.lifecycle.sqlite', database + '.lifecycle.sqlite');
  const prior = join(root, 'prior-build'), target = join(root, 'target-build'), configPath = join(root, 'service.json');
  const priorCode = `import { S14Store } from ${JSON.stringify(join(import.meta.dir, '../../src/s14/store.ts'))};\nconst store=new S14Store(process.argv[2]);\nconsole.log(JSON.stringify({claims:store.read(tx=>tx.get('SELECT count(*) n FROM memory_claims').n)}));\nstore.close();\n`;
  writeFileSync(prior, priorCode, { mode: 0o600 }); writeFileSync(target, 'target immutable executable', { mode: 0o600 });
  const config = { runtime: 's14', serviceUser: 'jit', executablePath: join(root, 'release/current'), workingDirectory: join(root, 'work'), stateDirectory: state,
    ledgerPath: join(root, 'ledger/checkpoint'), backupDirectory: join(root, 'backups'), routes: [], secretRefs: [], network: { bindHost: '127.0.0.1', port: 3001, vpnInterface: null },
    resources: { memoryMaxBytes: 268435456, maxRestarts: 5, restartWindowSeconds: 300, logBytes: 16777216, retentionDays: 14 }, runPort: 'schway',
    s14: { vaultDirectory: join(root, 'vault'), computerRoot: join(root, 'computers'), gitScratch: join(root, 'scratch') } };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const options = adoptionOptions(root, installationId);
  let fault: AdoptionCheckpoint | null = null, live = true, generation = 1, clock = 1000, settled = true;
  options.now = () => clock; options.policy.now = () => clock;
  options.policy.ownerGeneration = () => generation;
  options.policy.verifyOwner = proof => live && proof === 'owner_session' ? { id: 'owner', generation, expiresAt: 1000000 } : null;
  const originalBoundary = options.boundary.observe;
  options.boundary.observe = () => ({ ...originalBoundary(), settled });
  options.fault = point => { if (point === fault) throw new Error('fixture_crash'); };
  let service: AdoptionService | null = null;
  return { f, root, database, installationId, configPath, options, claim, work,
    get fault() { return fault; }, set fault(p: AdoptionCheckpoint | null) { fault = p; },
    set live(v: boolean) { live = v; }, set generation(v: number) { generation = v; }, set clock(v: number) { clock = v; }, set settled(v: boolean) { settled = v; },
    open() { service = openAdoptionService(options); return service; },
    close() { service?.close(); service = null; },
    cleanup() { service?.close(); f.dispose(); },
  };
}
/** Reconstructible child-process configuration; test-only trust seams cannot select an installation by discovery. */
export function adoptionOptions(root: string, installationId: string): AdoptionOptions {
  const prior = join(root, 'prior-build'), target = join(root, 'target-build');
  const sourceSha = hashBytes(readFileSync(prior)), targetSha = hashBytes(readFileSync(target));
  return { runtime: 's15', directory: join(root, 's15'), source: { runtime: 's14', database: join(root, 'state/application.sqlite'), installationId,
    build: { commit: 'a'.repeat(40), path: prior, sha256: sourceSha }, configPath: join(root, 'service.json'), argv: ['serve', '--s14', '--no-refusal-page'], preservedPaths: [] },
    target: { commit: 'b'.repeat(40), path: target, sha256: targetSha },
    boundary: { observe: () => ({ protected: true, settled: true, priorBuildFenceVerified: true, hostId: 'fixture_protected_host', evidenceHash: hashValue('fixture_external_boundary'), sourceArtifact: sourceSha, targetArtifact: targetSha }) },
    now: () => 1000, policy: { now: () => 1000, ownerGeneration: () => 1, verifyOwner: proof => proof === 'owner_session' ? { id: 'owner', generation: 1, expiresAt: 1000000 } : null,
      catalogs: { current: (_kind, id) => ({ ref: ref(id), active: true }), allows: () => true }, adapters: [] } };
}
/** Full selected source file bytes, including SQLite sidecar presence; only transition-owned fence/lock are excluded. */
export function preservedBytes(f: { database: string; root: string }): unknown {
  const visit = (path: string): unknown => {
    if (!lstatSync(path).isDirectory()) return hashBytes(readFileSync(path));
    const entries = readdirSync(path).filter(x => x !== 'fence.json' && !x.includes('.runtime-lock.sqlite')).sort().map(x => [x, visit(join(path, x))] as const);
    return Object.fromEntries(entries.filter(([, value]) => typeof value === 'string' || Object.keys(value as object).length));
  };
  return { state: visit(dirname(f.database)), config: visit(join(f.root, 'service.json')), build: visit(join(f.root, 'prior-build')) };
}
export function prepare(service: AdoptionService, options: AdoptionOptions) {
  const actor = service.authenticate('owner_session');
  const command: AdoptionCommand = { kind: 'prepare', requestId: retryId(), expectedRevision: 0, hash: reportAdoption(options).planHash };
  return { actor, command, status: service.command(actor, command) };
}
export function install(service: AdoptionService) {
  const policy = service.policy(), owner = policy.owner.authenticate('owner_session');
  const proposal = policy.owner.proposePolicy(owner, policyInput());
  policy.owner.installProposal(owner, retryId(), proposal.proposalHash);
  return { policy, owner };
}
export function activate(service: AdoptionService, options: AdoptionOptions, withPolicy = false) {
  const p = prepare(service, options);
  if (withPolicy) install(service);
  const validated = service.command(p.actor, { kind: 'validate', requestId: retryId(), expectedRevision: p.status.revision, hash: p.status.report.planHash });
  const command: AdoptionCommand = { kind: 'activate', requestId: retryId(), expectedRevision: validated.revision, hash: validated.actionHash! };
  return { ...p, command, status: service.command(p.actor, command) };
}
export type AdoptionFixture = Awaited<ReturnType<typeof adoptionFixture>>;
