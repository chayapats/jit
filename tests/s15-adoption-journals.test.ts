import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reportAdoption } from '../src/s15/adoption';
import { hashBytes } from '../src/s15/adoption/validation';
import { GithubStore } from '../src/s15/github';
import { DurableJournal } from '../src/s15/durable-journal';
import { browserContinuity } from '../src/s15/browser/state';
import { openFixtureRecordService } from '../src/s15/effects';
import { adoptionFixture, prepare, type AdoptionFixture } from './fixtures/s15-adoption';
import { fixture as policyFixture, ref } from './fixtures/s15-policy';
import { retryId } from './fixtures/s14-domain';

const fixtures: AdoptionFixture[] = [], closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0).reverse()) close(); for (const f of fixtures.splice(0)) f.cleanup(); });
async function fixture() { const f = await adoptionFixture(); fixtures.push(f); return f; }
const bytes = (path: string) => hashBytes(readFileSync(path));

test.each(['github', 'model', 'work', 'policy'] as const)('existing %s continuity refuses without opening recovery or resetting its facts', async kind => {
  const f = await fixture(), path = join(f.root, 'state', kind + '.sqlite');
  if (kind === 'github') {
    const store = new GithubStore(path, f.installationId, true);
    store.put('selection', 'existing', { id: 'existing', state: 'implementing' }); store.close();
  } else if (kind === 'policy') {
    const p = policyFixture({ path }); p.install();
    const actor = p.admit().actor!; p.service.work.reserveModelCall(actor, { requestId: 'unsettled', selection: p.input.selections[0]!, upperBound: { attempts: 1, steps: 1, calls: 1, reads: 0, outputBytes: 0, activeMs: 1, spendMinor: '1' } });
    p.cleanup();
  } else {
    const store = new DurableJournal(path, f.installationId, true, kind === 'model' ? 0x4a4d5135 : 0x4a575135);
    store.put('existing', { id: 'existing', state: 'running', effect: 'unknown' }); store.close();
  }
  const before = bytes(path), source = bytes(f.database);
  expect(() => reportAdoption(f.options)).toThrow(`transition_existing_s15_${kind}_unsupported`);
  expect(() => f.open()).toThrow(`transition_existing_s15_${kind}_unsupported`);
  expect(bytes(path)).toBe(before); expect(bytes(f.database)).toBe(source); expect(existsSync(f.options.directory)).toBe(false);
});

test('controlled edit/business record versions and operation journal stay in their original custody', async () => {
  const f = await fixture(), path = join(f.root, 'state', 'records.sqlite');
  const service = openFixtureRecordService({ runtime: 's15', path, create: true, resource: ref('records'), rule: () => ref('rule'), recipients: () => [] });
  service.seed({ id: 'document', kind: 'document', version: 1, fields: { title: 'Private record', body: 'Original document' }, deleted: false, triggers: { notify: [], fulfillment: false, payment: false } });
  service.change('document', { fields: { title: 'Private record', body: 'Newer document' } }); service.close();
  const before = bytes(path);
  expect(() => reportAdoption(f.options)).toThrow('transition_existing_s15_effects_unsupported');
  expect(bytes(path)).toBe(before);
});

test('unversioned browser uncertainty is not treated as an empty legacy or S14 store', async () => {
  const f = await fixture(), path = join(f.root, 'state', 'browser.sqlite');
  const browser = browserContinuity(path, true, 'account');
  browser.arm({ id: 'uncertain_send', revision: 1, actionHash: 'a'.repeat(64) }); browser.close();
  const before = bytes(path);
  expect(() => reportAdoption(f.options)).toThrow('transition_unclassified_store_unsupported'); expect(bytes(path)).toBe(before);
});

test('active WAL continuity refuses rather than hashing only its stale main file', async () => {
  const f = await fixture(), path = join(f.root, 'state', 'browser.sqlite');
  const browser = browserContinuity(path, true, 'account'); closers.push(() => browser.close());
  const walBefore = bytes(path + '-wal');
  expect(() => reportAdoption(f.options)).toThrow(); expect(bytes(path + '-wal')).toBe(walBefore); expect(existsSync(f.options.directory)).toBe(false);
});

test('explicit external preserved roots cannot hide existing model journals', async () => {
  const f = await fixture(), root = join(f.root, 'other-protected-state'); mkdirSync(root, { mode: 0o700 });
  const path = join(root, 'model.sqlite'), journal = new DurableJournal(path, f.installationId, true, 0x4a4d5135); journal.close();
  f.options.source.preservedPaths.push(root);
  const before = bytes(path);
  expect(() => reportAdoption(f.options)).toThrow('transition_existing_s15_model_unsupported'); expect(bytes(path)).toBe(before);
});

test('retained S14 quarantine ledger copies are checksummed without becoming current continuity', async () => {
  const f = await fixture(), root = join(f.database + '.ops', 'stages', 'a'.repeat(32)); mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'candidate-lifecycle.sqlite'); copyFileSync(f.database + '.lifecycle.sqlite', path); const before = bytes(path);
  expect(reportAdoption(f.options).refusals).toEqual([]); expect(bytes(path)).toBe(before);
});

test('new target journals before activation stay intact and prevent selection under stale validation', async () => {
  const f = await fixture(), service = f.open(), p = prepare(service, f.options), root = join(f.options.directory, 'journals'); mkdirSync(root, { mode: 0o700 });
  const path = join(root, 'github.sqlite'), store = new GithubStore(path, f.installationId, true); store.close(); const before = bytes(path);
  expect(() => service.command(p.actor, { kind: 'validate', requestId: retryId(), expectedRevision: p.status.revision, hash: p.status.report.planHash })).toThrow('transition_existing_s15_state_unsupported');
  expect(bytes(path)).toBe(before); expect(service.policy().owner.current(service.policy().owner.authenticate('owner_session'))).toBeNull();
  expect(service.status(p.actor)?.workers).toBe('fenced');
});
