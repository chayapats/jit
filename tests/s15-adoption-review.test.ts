import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reportAdoption, type AdoptionCommand } from '../src/s15/adoption';
import { hashBytes, hashValue } from '../src/s15/adoption/validation';
import { browserContinuity } from '../src/s15/browser/state';
import { S14Store } from '../src/s14/store';
import { adoptionFixture, activate, prepare, preservedBytes, workRequest, type AdoptionFixture } from './fixtures/s15-adoption';
import { retryId, workCommand } from './fixtures/s14-domain';
import { FakeComputerRuntime } from './fixtures/s14-computer';
import { disclosureFixture } from './fixtures/s15-disclosure';
import { ref } from './fixtures/s15-policy';

const fixtures: AdoptionFixture[] = [], closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0).reverse()) close(); for (const f of fixtures.splice(0)) f.cleanup(); });
async function fixture(...args: Parameters<typeof adoptionFixture>) { const f = await adoptionFixture(...args); fixtures.push(f); return f; }

test.each(['preparing', 'validated'] as const)('discard from %s resumes its recorded rolling_back intent after restart', async initial => {
  const f = await fixture(), before = preservedBytes(f); let service = f.open(), actor = service.authenticate('owner_session');
  if (initial === 'preparing') {
    f.fault = 'preparing';
    expect(() => service.command(actor, { kind: 'prepare', requestId: retryId(), expectedRevision: 0, hash: reportAdoption(f.options).planHash })).toThrow('fixture_crash');
    f.fault = null;
  } else prepare(service, f.options);
  const staged = service.status(actor)!;
  const command: AdoptionCommand = { kind: 'discard', requestId: retryId(), expectedRevision: staged.revision, hash: staged.rollbackHash };
  f.fault = 'rollback_intent'; expect(() => service.command(actor, command)).toThrow('fixture_crash'); f.close(); f.fault = null;
  service = f.open(); actor = service.authenticate('owner_session');
  expect(service.status(actor)?.state).toBe('rolling_back');
  expect(() => service.guardActivity()).toThrow('transition_workers_fenced');
  expect(() => service.command(actor, { ...command, requestId: retryId() })).toThrow('transition_request_in_progress');
  const discarded = service.command(actor, command);
  expect(discarded).toMatchObject({ state: 'discarded', selectedRuntime: 's14', workers: 'fenced' });
  expect(service.command(actor, command)).toEqual(discarded);
  expect(() => service.command(actor, { ...command, hash: 'f'.repeat(64) })).toThrow('transition_request_id_conflict');
  expect(existsSync(join(f.database + '.ops', 'fence.json'))).toBe(false); expect(preservedBytes(f)).toEqual(before);
  const prior = new S14Store(f.database); prior.close();
});

test('SIGKILL during discard resumes the exact original intent and releases only its source fence', async () => {
  const f = await fixture(), before = preservedBytes(f); let service = f.open(); const p = prepare(service, f.options);
  const command: AdoptionCommand = { kind: 'discard', requestId: retryId(), expectedRevision: p.status.revision, hash: p.status.rollbackHash }; f.close();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/s15-adoption-worker.ts')], { stdin: new Blob([JSON.stringify({ root: f.root, installationId: f.installationId, point: 'rollback_intent', command })]), stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).finally(() => clearTimeout(timer));
  expect(code).not.toBe(0); expect(out).toBe(''); expect(err).toBe('');
  service = f.open(); const actor = service.authenticate('owner_session');
  expect(service.command(actor, command).state).toBe('discarded'); expect(service.command(actor, command).state).toBe('discarded');
  expect(preservedBytes(f)).toEqual(before); expect(existsSync(join(f.database + '.ops', 'fence.json'))).toBe(false);
});

test.each(['directory', 'file'] as const)('external browser continuity in an explicit protected %s is refused byte-for-byte', async selection => {
  const f = await fixture(), root = join(f.root, 'external-protected-browser'); mkdirSync(root, { mode: 0o700 });
  const path = join(root, 'continuity.sqlite'), browser = browserContinuity(path, true, 'account');
  browser.arm({ id: 'unresolved_send', revision: 1, actionHash: 'a'.repeat(64) }); browser.close();
  f.options.source.preservedPaths.push(selection === 'directory' ? root : path);
  const before = hashBytes(readFileSync(path)), source = preservedBytes(f);
  expect(() => reportAdoption(f.options)).toThrow('transition_unclassified_store_unsupported');
  expect(() => f.open()).toThrow('transition_unclassified_store_unsupported');
  expect(hashBytes(readFileSync(path))).toBe(before); expect(preservedBytes(f)).toEqual(source); expect(existsSync(f.options.directory)).toBe(false);
});

test.each(['native', 'computers', 'scratch'] as const)('named S14 %s custody stays opaque when explicitly preserved', async kind => {
  const f = await fixture(), root = kind === 'native' ? join(f.root, 'state', 'native') : join(f.root, kind); mkdirSync(root, { mode: 0o700 });
  const path = join(root, 'opaque.sqlite'), db = new Database(path);
  db.exec('CREATE TABLE opaque (id TEXT PRIMARY KEY)'); db.query('INSERT INTO opaque VALUES (?)').run('private_original'); db.close();
  f.options.source.preservedPaths.push(root); const before = hashBytes(readFileSync(path));
  expect(reportAdoption(f.options).refusals).toEqual([]); expect(hashBytes(readFileSync(path))).toBe(before); expect(existsSync(f.options.directory)).toBe(false);
});

test.each(['succeeded', 'unknown', 'audit_only'] as const)('consumed takeover.input %s IDs cannot become new S15 work after restart', async caseName => {
  const outcome = caseName === 'unknown' ? 'unknown' : 'succeeded';
  const runtime = new FakeComputerRuntime(), inputId = retryId(), privateInput = 'Private transient owner keystrokes';
  if (outcome === 'unknown') { const input = runtime.input.bind(runtime); runtime.input = async (...args) => { await input(...args); throw Error('fixture_lost_input_response'); }; }
  let inputDigest = '';
  const f = await fixture(async domain => {
    const work = domain.app.execute(domain.auth.actor, workCommand(domain, { tools: ['computer'] })).work!;
    domain.app.execute(domain.auth.actor, { kind: 'computer.open', requestId: retryId(), expectedRevision: 0, payload: { botId: 'jit', workId: work.id } }); await domain.app.computers.drain();
    let view = domain.app.computers.view(domain.auth.actor, 'jit'), c = view.computer!;
    domain.app.execute(domain.auth.actor, { kind: 'takeover.start', requestId: retryId(), expectedRevision: c.revision, payload: { botId: 'jit', computerId: c.id, generation: c.generation, leaseRevision: view.lease!.revision } });
    view = domain.app.computers.view(domain.auth.actor, 'jit'); c = view.computer!;
    expect(await domain.app.computers.ownerInput(domain.auth.actor, { kind: 'takeover.input', requestId: inputId, expectedRevision: c.revision, payload: { botId: 'jit', computerId: c.id, generation: c.generation, leaseRevision: view.lease!.revision, input: { kind: 'text', text: privateInput } } })).toEqual({ requestId: inputId, state: outcome });
    inputDigest = domain.store.read(tx => tx.get<{ payload_hash: string }>('SELECT payload_hash FROM computer_inputs WHERE request_id=?', inputId)!.payload_hash);
    c = domain.app.computers.view(domain.auth.actor, 'jit').computer!;
    domain.app.execute(domain.auth.actor, { kind: 'computer.stop', requestId: retryId(), expectedRevision: c.revision, payload: { botId: 'jit', computerId: c.id, generation: c.generation } }); await domain.app.computers.drain();
    // Managed S14 images omit computer_inputs but retain the safe audit identity.
    if (caseName === 'audit_only') domain.store.transaction(tx => tx.run('DELETE FROM computer_inputs WHERE request_id=?', inputId));
  }, { computers: { runtime } });
  const before = preservedBytes(f); let service = f.open(); const a = activate(service, f.options, true);
  service.command(a.actor, { kind: 'release', requestId: retryId(), expectedRevision: a.status.revision, hash: a.status.releaseHash! });
  const request = { ...workRequest(), requestId: inputId };
  expect(() => service.policy().owner.admit(service.policy().owner.authenticate('owner_session'), request)).toThrow('transition_historical_request_no_replay');
  const db = new Database(join(f.options.directory, 'adoption.sqlite'), { readonly: true });
  try {
    expect(db.query('SELECT * FROM source_requests WHERE id=?').get(inputId)).toEqual({ id: inputId, payload_hash: null, outcome_hash: null });
    const history = JSON.stringify(db.query('SELECT * FROM history').all()); expect(history).not.toContain(privateInput); expect(history).not.toContain(inputDigest);
  } finally { db.close(); }
  f.close(); service = f.open(); const actor = service.authenticate('owner_session');
  expect(service.historicalRequest(actor, inputId, hashValue(request))).toBe('historical_request_no_replay');
  expect(() => service.policy().owner.admit(service.policy().owner.authenticate('owner_session'), request)).toThrow('transition_historical_request_no_replay');
  expect(preservedBytes(f)).toEqual(before);
});

test.each(['revoked', 'expired'] as const)('a bound %s policy cannot report worker release, including after restart', async change => {
  const f = await fixture(), before = preservedBytes(f); let service = f.open(); const a = activate(service, f.options, true);
  const command: AdoptionCommand = { kind: 'release', requestId: retryId(), expectedRevision: a.status.revision, hash: a.status.releaseHash! };
  if (change === 'revoked') service.policy().owner.revoke(service.policy().owner.authenticate('owner_session'), retryId(), { kind: 'policy' });
  else f.clock = 100001;
  for (let attempt = 0; attempt < 2; attempt++) {
    const actor = service.authenticate('owner_session');
    expect(() => service.command(actor, command)).toThrow(change === 'revoked' ? 'transition_policy_revoked' : 'transition_policy_expired');
    expect(service.status(actor)).toMatchObject({ state: 'active_fenced', workers: 'fenced', activityRecorded: false });
    expect(() => service.guardActivity()).toThrow('transition_workers_fenced');
    if (!attempt) { f.close(); service = f.open(); }
  }
  expect(preservedBytes(f)).toEqual(before);
});

test('the owner usable-policy read is authenticated and does not invoke the activity guard', async () => {
  const f = await fixture(), service = f.open(), p = prepare(service, f.options), policy = service.policy(), owner = policy.owner.authenticate('owner_session');
  expect(() => policy.owner.current({} as never, { requireUsable: true })).toThrow('authentication_required');
  expect(() => policy.owner.current(owner, { requireUsable: true })).toThrow('policy_required');
  expect(service.status(p.actor)?.activityRecorded).toBe(false);
});

test.each(['state', 'external'] as const)('DATA disclosure lineage in %s custody is refused without rewriting restrictions', async location => {
  const f = await fixture(), data = disclosureFixture(); closers.push(data.cleanup);
  data.disclosure.read(data.actor, ref('private')); data.disclosure.derive(data.actor, ref('derived'), 'text'); data.disclosure.close();
  const path = location === 'state' ? join(f.root, 'state', 'disclosure.sqlite') : data.path;
  if (location === 'state') copyFileSync(data.path, path);
  else f.options.source.preservedPaths.push(data.dir);
  const before = hashBytes(readFileSync(path)), source = preservedBytes(f);
  expect(() => reportAdoption(f.options)).toThrow('transition_existing_s15_disclosure_unsupported');
  expect(() => f.open()).toThrow('transition_existing_s15_disclosure_unsupported');
  expect(hashBytes(readFileSync(path))).toBe(before); expect(preservedBytes(f)).toEqual(source); expect(existsSync(f.options.directory)).toBe(false);
});
