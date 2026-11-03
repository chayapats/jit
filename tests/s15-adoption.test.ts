import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, symlinkSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { S14Store } from '../src/s14/store';
import { acquireS14RuntimeLock } from '../src/s14/runtime-lock';
import { reportAdoption, openAdoptionService, type AdoptionCommand, type AdoptionCheckpoint } from '../src/s15/adoption';
import { hashValue } from '../src/s15/adoption/validation';
import { installerAdoptionReport } from '../ops/package/installer/adoption';
import { selectRuntime } from '../src/runtime-selection';
import { adoptionFixture, activate, prepare, install, preservedBytes, workRequest, type AdoptionFixture } from './fixtures/s15-adoption';
import { retryId, workCommand } from './fixtures/s14-domain';
import type { Effect } from '../src/s14/authority-types';

const fixtures: AdoptionFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
async function fixture(seed?: Parameters<typeof adoptionFixture>[0]) { const f = await adoptionFixture(seed); fixtures.push(f); return f; }
const fence = (f: AdoptionFixture) => join(f.database + '.ops', 'fence.json');

test('dry run preserves every original byte; real source schema, private history, usage, requests and empty policy survive staging', async () => {
  const f = await fixture(), before = preservedBytes(f), report = reportAdoption(f.options);
  expect(report).toMatchObject({ sourceRuntime: 's14', importedExecution: 'disabled', policy: 'empty_requires_owner_install', teamConversions: 0, refusals: [] });
  expect(report.privateItems).toBeGreaterThan(0); expect(report.pendingRequests).toBeGreaterThan(0);
  expect(existsSync(f.options.directory)).toBe(false); expect(preservedBytes(f)).toEqual(before);
  const service = f.open(), p = prepare(service, f.options), policy = service.policy(), owner = policy.owner.authenticate('owner_session');
  expect(policy.owner.current(owner)).toBeNull(); expect(policy.owner.proposePolicy(owner, null).installable).toBe(false);
  expect(policy.control.usage().charged).toMatchObject({ calls: 14, reads: 10, attempts: 3, outputBytes: 300 });
  expect(() => policy.owner.admit(owner, workRequest())).toThrow('transition_workers_fenced');
  expect(p.status).toMatchObject({ state: 'validated', workers: 'fenced', selectedRuntime: 's14', privateScopePreserved: true });
  expect(service.command(p.actor, p.command)).toEqual(p.status);
  expect(() => service.command(p.actor, { ...p.command, hash: 'a'.repeat(64) })).toThrow('transition_request_id_conflict');
  const db = new Database(join(f.options.directory, 'adoption.sqlite'), { readonly: true });
  try {
    expect(db.query("SELECT count(*) n FROM facts WHERE source_table='lifecycle.withdrawals'").get()).toEqual({ n: 1 });
    expect(db.query("SELECT cells_json FROM facts WHERE source_table='continuity.grant_usage' AND cells_json LIKE '%orphan_grant%'").get()).toMatchObject({ cells_json: expect.stringContaining('"integer":"7"') });
    expect(db.query("SELECT count(*) n FROM history WHERE source_table='memory_claims'").get()).toEqual({ n: 1 });
    expect(JSON.stringify(db.query("SELECT * FROM history WHERE source_table='owner'").all())).not.toContain('password_hash\\\",\\\"text');
  } finally { db.close(); }
  expect(preservedBytes(f)).toEqual(before);
});

test('old request IDs stay reserved and changed payloads conflict without replay or disclosure', async () => {
  const f = await fixture(), source = new Database(f.database, { readonly: true });
  const original = source.query<{ request_id: string; payload_hash: string }, []>('SELECT request_id,payload_hash FROM command_receipts LIMIT 1').get()!; source.close();
  const service = f.open(), p = prepare(service, f.options);
  expect(service.historicalRequest(p.actor, original.request_id, original.payload_hash)).toBe('historical_request_no_replay');
  expect(() => service.historicalRequest(p.actor, original.request_id, '0'.repeat(64))).toThrow('transition_request_id_conflict');
  expect(() => service.command(p.actor, { kind: 'validate', requestId: original.request_id, expectedRevision: p.status.revision, hash: p.status.report.planHash })).toThrow('transition_historical_request_no_replay');
  const policy = service.policy(), owner = policy.owner.authenticate('owner_session');
  expect(() => policy.owner.admit(owner, { ...workRequest(), requestId: original.request_id })).toThrow('transition_historical_request_no_replay');
});

test('the prepare command cannot reuse an original owner request ID', async () => {
  const f = await fixture(), source = new Database(f.database, { readonly: true });
  const original = source.query<{ request_id: string }, []>('SELECT request_id FROM command_receipts LIMIT 1').get()!; source.close();
  const service = f.open(), actor = service.authenticate('owner_session');
  expect(() => service.command(actor, { kind: 'prepare', requestId: original.request_id, expectedRevision: 0, hash: reportAdoption(f.options).planHash })).toThrow('transition_historical_request_no_replay');
  expect(existsSync(fence(f))).toBe(false);
});

test('large original Bot volumes are checksummed in place without being copied into the S15 store', async () => {
  const f = await fixture(), computers = join(f.root, 'computers'); mkdirSync(computers, { mode: 0o700 });
  const volume = join(computers, 'workspace.ext4'); writeFileSync(volume, '', { mode: 0o600 }); truncateSync(volume, 65 * 1024 * 1024);
  const report = reportAdoption(f.options); expect(report.bytes).toBeGreaterThan(65 * 1024 * 1024);
  const service = f.open(), p = prepare(service, f.options);
  expect(p.status.state).toBe('validated'); expect(existsSync(join(f.options.directory, 'workspace.ext4'))).toBe(false);
  const status = service.command(p.actor, { kind: 'discard', requestId: retryId(), expectedRevision: p.status.revision, hash: p.status.rollbackHash });
  expect(status.state).toBe('discarded'); expect(readFileSync(volume).length).toBe(65 * 1024 * 1024);
});

test.each(['preparing', 'source_fenced', 'candidate_committed', 'activation_intent', 'active_fenced', 'workers_released', 'rollback_intent', 'prior_selected', 'source_released'] as AdoptionCheckpoint[])('SIGKILL at %s retains single-writer fencing and exact-request recovery', async point => {
  const f = await fixture(), before = preservedBytes(f); let service = f.open(), actor = service.authenticate('owner_session');
  let command: AdoptionCommand = { kind: 'prepare', requestId: retryId(), expectedRevision: 0, hash: reportAdoption(f.options).planHash };
  if (!['preparing', 'source_fenced', 'candidate_committed'].includes(point)) {
    const p = service.command(actor, command);
    if (point === 'workers_released') install(service);
    const v = service.command(actor, { kind: 'validate', requestId: retryId(), expectedRevision: p.revision, hash: p.report.planHash });
    command = { kind: 'activate', requestId: retryId(), expectedRevision: v.revision, hash: v.actionHash! };
    if (['workers_released', 'rollback_intent', 'prior_selected', 'source_released'].includes(point)) {
      const a = service.command(actor, command);
      command = point === 'workers_released' ? { kind: 'release', requestId: retryId(), expectedRevision: a.revision, hash: a.releaseHash! } : { kind: 'rollback', requestId: retryId(), expectedRevision: a.revision, hash: a.rollbackHash };
    }
  }
  f.close();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/s15-adoption-worker.ts')], {
    stdin: new Blob([JSON.stringify({ root: f.root, installationId: f.installationId, point, command })]), stdout: 'pipe', stderr: 'pipe',
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).finally(() => clearTimeout(timeout));
  expect(code).not.toBe(0); expect(out).toBe(''); expect(err).toBe('');
  service = f.open(); actor = service.authenticate('owner_session');
  const recovered = service.command(actor, command);
  expect(recovered.state).toBe(command.kind === 'prepare' ? 'validated' : command.kind === 'activate' ? 'active_fenced' : command.kind === 'release' ? 'complete' : 'rolled_back');
  expect(service.command(actor, command)).toEqual(recovered); expect(preservedBytes(f)).toEqual(before);
});

test('report CLI exposes only safe metadata and never activates or writes a candidate', async () => {
  const f = await fixture(), before = preservedBytes(f), config = join(f.root, 'adoption-plan.json');
  writeFileSync(config, JSON.stringify({ directory: f.options.directory, source: f.options.source, target: f.options.target }), { mode: 0o600 });
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/main.ts'), 'adoption', '--s15', '--report', '--config', config], { stdout: 'pipe', stderr: 'pipe' });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(2); expect(err).toBe('');
  expect(JSON.parse(out)).toMatchObject({ contract: 's15-state-transition/v1', sourceRuntime: 's14', refusals: ['transition_protected_settlement_required'] });
  expect(out).not.toContain(f.database); expect(out).not.toContain('Private S14 owner knowledge');
  expect(existsSync(f.options.directory)).toBe(false); expect(preservedBytes(f)).toEqual(before);
});

test('activation is exact, explicit and fenced; rollback before activity runs the recorded prior S14 runtime', async () => {
  const f = await fixture(), before = preservedBytes(f), service = f.open(), a = activate(service, f.options);
  expect(a.status).toMatchObject({ state: 'active_fenced', selectedRuntime: 's15', workers: 'fenced', policyRevision: null });
  expect(() => new S14Store(f.database)).toThrow('s14_ops_reconciliation_required');
  const blockedPrior = Bun.spawn([process.execPath, f.options.source.build.path, f.database], { stdout: 'pipe', stderr: 'pipe' });
  const [priorCode, priorOut, priorError] = await Promise.all([blockedPrior.exited, new Response(blockedPrior.stdout).text(), new Response(blockedPrior.stderr).text()]);
  expect(priorCode).not.toBe(0); expect(priorOut).toBe(''); expect(priorError).toContain('s14_ops_reconciliation_required');
  expect(() => acquireS14RuntimeLock(f.database)).toThrow('s14_runtime_already_open');
  expect(() => service.guardActivity()).toThrow('transition_workers_fenced');
  expect(() => service.command(a.actor, { kind: 'release', requestId: retryId(), expectedRevision: a.status.revision, hash: a.status.releaseHash! })).toThrow('transition_policy_install_required');
  const rolled = service.command(a.actor, { kind: 'rollback', requestId: retryId(), expectedRevision: a.status.revision, hash: a.status.rollbackHash });
  expect(rolled).toMatchObject({ state: 'rolled_back', selectedRuntime: 's14', workers: 'fenced' });
  expect(preservedBytes(f)).toEqual(before); expect(existsSync(fence(f))).toBe(false);
  const recoveredPrior = Bun.spawn([process.execPath, f.options.source.build.path, f.database], { stdout: 'pipe', stderr: 'pipe' });
  const [recoveredCode, recoveredOut, recoveredError] = await Promise.all([recoveredPrior.exited, new Response(recoveredPrior.stdout).text(), new Response(recoveredPrior.stderr).text()]);
  expect(recoveredCode).toBe(0); expect(JSON.parse(recoveredOut)).toEqual({ claims: 1 }); expect(recoveredError).toBe('');
  const prior = new S14Store(f.database);
  expect(prior.read(tx => tx.get("SELECT id FROM memory_claims WHERE id=?", f.claim.id))).toBeTruthy(); prior.close();
});

test('discard after a pre-fence crash preserves source and removes only its recorded transition intent', async () => {
  const f = await fixture(), before = preservedBytes(f), service = f.open(), actor = service.authenticate('owner_session');
  const c: AdoptionCommand = { kind: 'prepare', requestId: retryId(), expectedRevision: 0, hash: reportAdoption(f.options).planHash };
  f.fault = 'preparing'; expect(() => service.command(actor, c)).toThrow('fixture_crash'); f.fault = null;
  const current = service.status(actor)!;
  const discarded = service.command(actor, { kind: 'discard', requestId: retryId(), expectedRevision: current.revision, hash: current.rollbackHash });
  expect(discarded.state).toBe('discarded'); expect(preservedBytes(f)).toEqual(before); expect(existsSync(fence(f))).toBe(false);
  f.close(); const reopened = f.open(); expect(reopened.status(reopened.authenticate('owner_session'))?.state).toBe('discarded');
});

test('discard before activation keeps newer source facts written after a pre-fence crash', async () => {
  const f = await fixture(); let service = f.open(), actor = service.authenticate('owner_session');
  f.fault = 'preparing'; expect(() => service.command(actor, { kind: 'prepare', requestId: retryId(), expectedRevision: 0, hash: reportAdoption(f.options).planHash })).toThrow('fixture_crash');
  f.close(); f.fault = null;
  const prior = new S14Store(f.database); prior.transaction(tx => tx.run("INSERT INTO lifecycle.withdrawals VALUES ('source','newer_source','forgotten')")); prior.close();
  const newer = preservedBytes(f); service = f.open(); actor = service.authenticate('owner_session'); const current = service.status(actor)!;
  expect(service.command(actor, { kind: 'discard', requestId: retryId(), expectedRevision: current.revision, hash: current.rollbackHash }).state).toBe('discarded');
  expect(preservedBytes(f)).toEqual(newer);
});

test('missing target continuity cannot create an empty replacement or release the prior boot fence', async () => {
  const f = await fixture(), service = f.open(); activate(service, f.options); f.close();
  unlinkSync(join(f.options.directory, 'policy.sqlite'));
  expect(() => f.open()).toThrow('transition_continuity_unavailable'); expect(existsSync(fence(f))).toBe(true);
});

test('SIGKILL after the durable activity marker never permits a raw rollback', async () => {
  const f = await fixture(), before = preservedBytes(f); let service = f.open(), a = activate(service, f.options, true);
  service.command(a.actor, { kind: 'release', requestId: retryId(), expectedRevision: a.status.revision, hash: a.status.releaseHash! }); f.close();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/s15-adoption-worker.ts')], {
    stdin: new Blob([JSON.stringify({ root: f.root, installationId: f.installationId, point: 'activity_recorded', command: null })]), stdout: 'pipe', stderr: 'pipe',
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).not.toBe(0); expect(out).toBe(''); expect(err).toBe('');
  service = f.open(); const actor = service.authenticate('owner_session'), current = service.status(actor)!;
  expect(current.activityRecorded).toBe(true);
  expect(() => service.command(actor, { kind: 'rollback', requestId: retryId(), expectedRevision: current.revision, hash: current.rollbackHash })).toThrow('transition_rollback_unsupported');
  expect(preservedBytes(f)).toEqual(before);
});

test('owner-installed POLICY alone enables release; first S15 admission durably prevents unsupported rollback', async () => {
  const f = await fixture(), before = preservedBytes(f), service = f.open(), a = activate(service, f.options, true);
  expect(a.status.policyRevision).toBe(1);
  const released = service.command(a.actor, { kind: 'release', requestId: retryId(), expectedRevision: a.status.revision, hash: a.status.releaseHash! });
  expect(released).toMatchObject({ state: 'complete', workers: 'released', activityRecorded: false });
  f.settled = false; expect(() => service.guardActivity()).toThrow('transition_protected_settlement_required'); f.settled = true;
  const p = service.policy(), owner = p.owner.authenticate('owner_session');
  expect(p.owner.admit(owner, workRequest()).work).toBeTruthy();
  const current = service.status(a.actor)!; expect(current.activityRecorded).toBe(true);
  expect(() => service.command(a.actor, { kind: 'rollback', requestId: retryId(), expectedRevision: current.revision, hash: current.rollbackHash })).toThrow('transition_rollback_unsupported');
  expect(service.status(a.actor)).toMatchObject({ state: 'blocked', workers: 'fenced', reason: 'transition_new_s15_facts_require_reverse_projection' });
  expect(() => service.guardActivity()).toThrow('transition_workers_fenced');
  expect(() => new S14Store(f.database)).toThrow('s14_ops_reconciliation_required'); expect(preservedBytes(f)).toEqual(before);
});

test('policy changes, including revocation, cannot disappear through a pre-activity rollback', async () => {
  const f = await fixture(), service = f.open(), a = activate(service, f.options, true);
  const p = service.policy(), owner = p.owner.authenticate('owner_session');
  p.owner.revoke(owner, retryId(), { kind: 'policy' });
  expect(() => service.command(a.actor, { kind: 'rollback', requestId: retryId(), expectedRevision: a.status.revision, hash: a.status.rollbackHash })).toThrow('transition_rollback_unsupported');
});

test('forged/stale owner actors and host settlement cannot authorize a transition', async () => {
  const f = await fixture(), service = f.open();
  expect(() => service.authenticate({ id: 'owner', generation: 1 })).toThrow('transition_authentication_required');
  expect(() => service.status({} as never)).toThrow('transition_authentication_required');
  const actor = service.authenticate('owner_session'); f.live = false;
  expect(() => service.command(actor, { kind: 'prepare', requestId: retryId(), expectedRevision: 0, hash: 'a'.repeat(64) })).toThrow('transition_authentication_required');
  f.live = true; f.settled = false; expect(reportAdoption(f.options).refusals).toEqual(['transition_protected_settlement_required']);
  expect(() => prepare(service, f.options)).toThrow('transition_stale_validation'); expect(existsSync(fence(f))).toBe(false);
});

test('unknown schema, sidecars, foreign installation, changed binary and overlapping/symlink targets refuse without source writes', async () => {
  const f = await fixture(), before = preservedBytes(f);
  for (const options of [
    { ...f.options, source: { ...f.options.source, installationId: 'different_installation' } },
    { ...f.options, source: { ...f.options.source, build: { ...f.options.source.build, sha256: '0'.repeat(64) } } },
    { ...f.options, directory: f.database + '.adoption' },
  ]) expect(() => reportAdoption(options)).toThrow();
  writeFileSync(f.database + '-wal', 'unsettled bytes');
  expect(() => reportAdoption(f.options)).toThrow('transition_sqlite_settlement_required'); unlinkSync(f.database + '-wal');
  const alias = join(f.root, 'alias'); symlinkSync(join(f.root, 'state'), alias);
  expect(() => reportAdoption({ ...f.options, directory: join(alias, 's15') })).toThrow(); unlinkSync(alias);
  expect(preservedBytes(f)).toEqual(before);
  const db = new Database(f.database); db.exec('CREATE TABLE unknown_empty (id TEXT)'); db.close();
  const changed = preservedBytes(f); expect(() => reportAdoption(f.options)).toThrow('transition_schema_unreviewed'); expect(preservedBytes(f)).toEqual(changed);
});

test.each([16, 18, 45])('source schema %i refuses before creating target or lock files', async version => {
  const f = await fixture(), bytes = Buffer.from(readFileSync(f.database)); bytes.writeUInt32BE(version, 60); writeFileSync(f.database, bytes);
  const before = preservedBytes(f);
  expect(() => openAdoptionService(f.options)).toThrow('transition_source_unsupported');
  expect(existsSync(f.options.directory)).toBe(false); expect(existsSync(f.database + '.runtime-lock.sqlite')).toBe(false);
  expect(preservedBytes(f)).toEqual(before);
});

test('source drift after validate refuses activation while the prior build stays fenced', async () => {
  const f = await fixture(), service = f.open(), p = prepare(service, f.options);
  const v = service.command(p.actor, { kind: 'validate', requestId: retryId(), expectedRevision: p.status.revision, hash: p.status.report.planHash });
  writeFileSync(join(f.root, 'prior-build'), 'substituted binary');
  expect(() => service.command(p.actor, { kind: 'activate', requestId: retryId(), expectedRevision: v.revision, hash: v.actionHash! })).toThrow('transition_stale_validation');
  expect(existsSync(fence(f))).toBe(true);
});

test('a pre-existing S14 store handle cannot write through the persisted boot fence', async () => {
  const f = await fixture(), old = new S14Store(f.database), oldMaintenance = new S14Store(f.database, {}), service = f.open(); prepare(service, f.options);
  expect(() => old.transaction(tx => tx.run("UPDATE installation SET revision=revision+1"))).toThrow('s14_ops_reconciliation_required'); old.close();
  expect(() => oldMaintenance.transaction(tx => tx.run("UPDATE installation SET revision=revision+1"))).toThrow('s14_foreign_maintenance_fence'); oldMaintenance.close();
  f.close(); expect(() => new S14Store(f.database)).toThrow('s14_ops_reconciliation_required');
  const before = preservedBytes(f);
  expect(() => new S14Store(f.database, {})).toThrow('s14_foreign_maintenance_fence');
  expect(preservedBytes(f)).toEqual(before);
});

test('omitted-runtime old service configuration remains legacy; explicit S15 report never selects another installation', async () => {
  const f = await fixture(), config = JSON.parse(readFileSync(f.configPath, 'utf8')); delete config.runtime; delete config.s14;
  const legacyPath = join(f.root, 'legacy.json'); writeFileSync(legacyPath, JSON.stringify(config), { mode: 0o600 });
  expect(selectRuntime(['serve', '--service-config', legacyPath], {}).runtime).toBe('legacy');
  expect(selectRuntime(['serve'], {}).runtime).toBe('s14');
  expect(selectRuntime(['adoption', '--s15', '--report', '--config', f.configPath], {}).runtime).toBe('adoption');
  expect(() => selectRuntime(['serve', '--s15'], {})).toThrow('explicit_s15_config_required');
  expect(() => selectRuntime(['adoption', '--report', '--config', f.configPath], {})).toThrow('explicit_s15_adoption_report_required');
  const source = { ...f.options.source, runtime: 'legacy' as const, database: join(f.root, 'state/app.sqlite'), configPath: legacyPath, argv: ['serve', '--service-config', legacyPath] };
  const before = preservedBytes(f);
  expect(() => installerAdoptionReport({ ...f.options, source })).toThrow('transition_legacy_continuity_unsupported');
  expect(preservedBytes(f)).toEqual(before);
  expect(installerAdoptionReport(f.options).refusals).toEqual(['transition_protected_settlement_required']);
});

test.each(['preparing', 'source_fenced', 'candidate_committed', 'activation_intent', 'active_fenced', 'workers_released', 'rollback_intent', 'prior_selected', 'source_released'] as AdoptionCheckpoint[])('crash/restart at %s resolves the same exact request without dispatch or rewriting old bytes', async point => {
  const f = await fixture(), before = preservedBytes(f); let service = f.open(), actor = service.authenticate('owner_session');
  let command: AdoptionCommand = { kind: 'prepare', requestId: retryId(), expectedRevision: 0, hash: reportAdoption(f.options).planHash };
  if (!['preparing', 'source_fenced', 'candidate_committed'].includes(point)) {
    const p = service.command(actor, command);
    if (point === 'workers_released') install(service);
    const v = service.command(actor, { kind: 'validate', requestId: retryId(), expectedRevision: p.revision, hash: p.report.planHash });
    command = { kind: 'activate', requestId: retryId(), expectedRevision: v.revision, hash: v.actionHash! };
    if (['workers_released', 'rollback_intent', 'prior_selected', 'source_released'].includes(point)) {
      const a = service.command(actor, command);
      command = point === 'workers_released' ? { kind: 'release', requestId: retryId(), expectedRevision: a.revision, hash: a.releaseHash! } : { kind: 'rollback', requestId: retryId(), expectedRevision: a.revision, hash: a.rollbackHash };
    }
  }
  f.fault = point; expect(() => service.command(actor, command)).toThrow('fixture_crash'); f.close(); f.fault = null;
  service = f.open(); actor = service.authenticate('owner_session');
  const recovered = service.command(actor, command);
  expect(recovered.state).toBe(command.kind === 'prepare' ? 'validated' : command.kind === 'activate' ? 'active_fenced' : command.kind === 'release' ? 'complete' : 'rolled_back');
  expect(service.command(actor, command)).toEqual(recovered); expect(preservedBytes(f)).toEqual(before);
  if (recovered.state !== 'rolled_back') expect(() => new S14Store(f.database)).toThrow('s14_ops_reconciliation_required');
});

const effects: [Effect['state'], boolean][] = ['pending', 'approved', 'executing', 'unknown', 'succeeded', 'failed', 'denied', 'expired', 'changed'].map(state => [state as Effect['state'], false]);
effects.push(['pending', true], ['approved', true]);
test.each(effects)('effect %s (claimed=%s) is historical or reconcile-only and never imported as dispatch authority', async (state, claimed) => {
  let effectId = '';
  const f = await fixture(domain => {
    const work = domain.app.execute(domain.auth.actor, workCommand(domain)).work!;
    const attempt = domain.app.authority.admit(work.id, retryId(), { botId: 'jit', tools: [], scopes: [], input: 'Exact fixture work', calls: 1, outputBytes: 1024 });
    effectId = retryId();
    const action = { kind: 'send' as const, destination: 'fixture-recipient', content: 'Exact held message' };
    const effect: Effect = { id: effectId, revision: 1, workId: work.id, attemptId: attempt.id, botId: 'jit', action, actionHash: hashValue(action), expiresAt: domain.clock.now + 30000, state, reason: null, supported: false };
    domain.store.transaction(tx => {
      tx.run('INSERT INTO effects VALUES (?,?,?,?,?,?)', effectId, work.id, attempt.id, retryId(), hashValue('effect request'), JSON.stringify(effect));
      if (claimed) tx.run("INSERT INTO lifecycle.withdrawals VALUES ('effect_claim',?,'revision_1')", effectId);
      if (state === 'unknown') tx.run('INSERT INTO lifecycle.effect_outcomes VALUES (?,?,?,?,?)', effectId, effect.actionHash, 1, 'did_not_occur', domain.clock.now);
    });
  });
  const service = f.open(), p = prepare(service, f.options), db = new Database(join(f.options.directory, 'adoption.sqlite'), { readonly: true });
  try {
    const row = db.query<{ cells_json: string }, []>("SELECT cells_json FROM facts WHERE source_table='continuity.effects'").get()!;
    const cells = JSON.parse(row.cells_json), projected = JSON.parse(cells[1][1].text);
    expect(projected).toMatchObject({ id: effectId, state: claimed ? 'unknown' : ['pending', 'approved'].includes(state) ? 'expired' : state === 'executing' ? 'unknown' : state, executable: false });
    expect(p.status.report.unknownEffects).toBe(claimed || ['executing', 'unknown'].includes(state) ? 1 : 0);
  } finally { db.close(); }
});
