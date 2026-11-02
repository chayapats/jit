import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableJournal } from '../src/s15/durable-journal';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const applicationId = 0x4a445135;
function fixture(capacity?: { records: number; bytes: number }) {
  const root = mkdtempSync(join(tmpdir(), 'jit-journal-capacity-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'journal.sqlite'); let journal = new DurableJournal(path, 'fixture', true, applicationId, capacity);
  cleanup.push(() => journal.close());
  return { get journal() { return journal; }, reopen() { journal.close(); journal = new DurableJournal(path, 'fixture', false, applicationId, capacity); } };
}

test('a historical journal at 10,000 records can update settlement and recovery but refuses another record', () => {
  const f = fixture();
  // Reproduce a valid journal filled under the prior actual-byte admission rule.
  f.journal.tx(() => {
    const insert = f.journal.db.query('INSERT INTO records VALUES (?,?)');
    for (let i = 0; i < 10000; i++) insert.run('record_' + i, JSON.stringify({ state: 'unknown', transportSettled: false }));
  });
  f.journal.tx(() => f.journal.put('record_0', { state: 'settled', transportSettled: true }));
  expect(f.journal.get('record_0')).toEqual({ state: 'settled', transportSettled: true });
  expect(() => f.journal.tx(() => f.journal.put('new_record', { state: 'admitted' }))).toThrow('continuity_capacity');
  f.reopen();
  f.journal.tx(() => f.journal.put('record_1', { state: 'reconcile_only', transportSettled: false }));
  expect(f.journal.get('record_1')).toEqual({ state: 'reconcile_only', transportSettled: false });
});

test('admission reserves future record slots so settlement, net replacement and reopen retain headroom', () => {
  const f = fixture({ records: 10000, bytes: 1024 * 1024 });
  f.journal.tx(() => { for (let i = 0; i < 8; i++) f.journal.put('record_' + i, { state: 'unknown' }); });
  expect(() => f.journal.tx(() => f.journal.put('new_record', { state: 'admitted' }))).toThrow('continuity_capacity');
  let newAdmissionRan = false;
  expect(() => f.journal.tx(() => f.journal.once('new_command', 'hash', () => { newAdmissionRan = true; return {}; }))).toThrow('continuity_capacity');
  expect(newAdmissionRan).toBe(false);
  f.journal.tx(() => { for (let i = 0; i < 8; i++) f.journal.put('record_' + i, { state: 'settled', evidence: 'x'.repeat(125000) }); });
  const size = () => f.journal.db.query<{ n: number }, []>('SELECT sum(length(CAST(json AS BLOB))) AS n FROM records').get()!.n;
  const before = size(); expect(before).toBeGreaterThan(900000);
  f.journal.tx(() => f.journal.put('record_0', { state: 'settled', evidence: 'y'.repeat(125000) }));
  expect(size()).toBe(before);
  f.reopen();
  f.journal.tx(() => f.journal.put('record_0', { state: 'reconciled', evidence: 'z'.repeat(125000) }));
  expect(f.journal.get<{ state: string }>('record_0').state).toBe('reconciled');
});

test('immutable receipt bytes count against new admissions without blocking an existing record update', () => {
  const f = fixture({ records: 10000, bytes: 4 * 131072 });
  f.journal.tx(() => { f.journal.put('record', { state: 'unknown' }); f.journal.once('receipt', 'hash', () => ({ evidence: 'x'.repeat(125000) })); });
  f.journal.tx(() => f.journal.put('second', { state: 'unknown' }));
  f.journal.tx(() => f.journal.put('third', { state: 'unknown' }));
  expect(() => f.journal.tx(() => f.journal.put('fourth', { state: 'new' }))).toThrow('continuity_capacity');
  f.journal.tx(() => f.journal.put('record', { state: 'settled', evidence: 'z'.repeat(125000) }));
  expect(f.journal.get<{ state: string }>('record').state).toBe('settled');
});
