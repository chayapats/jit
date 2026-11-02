import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserRequest, BrokerResponse } from '../../src/s15/browser';
import type { BrowserEngine, EngineOptions } from '../../src/s15/browser/engine';
import type { BrowserClock } from '../../src/s15/browser/gateway';
import { openFixtureRecordService, type FixtureRecord, type FixtureRecordEdit } from '../../src/s15/effects';
import { browserFixture } from './s15-browser';
import { ref } from './s15-policy';

/** Protocol fixture: only the real gateway/broker can reach the real controlled HTTP service. */
export function recordEngine() {
  let options!: EngineOptions, url = '', next: BrowserRequest | null = null, content = '';
  const responses: BrokerResponse[] = [];
  async function request(r: BrowserRequest, attributable = true) { await options.request({ request: r, cookies: '', main: true, document: true, attributable, async send(response) { url = r.url; content = Buffer.from(response.body).toString(); responses.push(response); }, async deny() {} }); }
  const engine: BrowserEngine = {
    async navigate(target) { await request({ method: 'GET', url: target, contentType: '', bodyBase64: '', navigation: true }); },
    async read(generation) { return { id: 'record_observation', generation, url, text: content.replace(/<[^>]*>/g, ''), truncated: false, elements: [{ id: 'e1_1', tag: 'button', name: 'Save', type: 'submit' }] }; },
    async image() { return new Uint8Array([1]); },
    async interact(_kind, _target, _value, _generation, input) { input.guard(); if (next) { const r = next; next = null; await request(r); } },
    async ownerInput() {}, async cookie() { return null; }, async close() {},
  };
  return { responses, request, set next(value: BrowserRequest) { next = value; }, factory: async (o: EngineOptions) => { options = o; return engine; } };
}
export const documentRecord = (): FixtureRecord => ({ id: 'document', kind: 'document', version: 1, fields: { title: 'Plan', body: 'Before' }, deleted: false, triggers: { notify: [], fulfillment: false, payment: false } });
export const taskRecord = (): FixtureRecord => ({ ...documentRecord(), id: 'task', kind: 'task', fields: { title: 'Task', completed: false } });
export const businessRecord = (): FixtureRecord => ({ ...documentRecord(), id: 'business', kind: 'business', fields: { note: 'Existing fact', classification: 'lead', priceMinor: '5000', discountBps: 0, terms: 'Existing terms', policy: 'Existing policy', commitment: '' } });
export async function recordFixture(mode: 'static' | 'general' = 'static', record = documentRecord(), clock?: BrowserClock) {
  const dir = mkdtempSync(join(tmpdir(), 'jit-record-service-')); let rule = ref('business_rule');
  const server = openFixtureRecordService({ runtime: 's15', path: join(dir, 'records.sqlite'), create: true, resource: ref('account'), rule: () => rule, recipients: () => [{ id: 'team', ref: ref('payee') }, { id: 'new_recipient', ref: ref('other') }] });
  server.seed(record); const engine = recordEngine(), f = await browserFixture(mode, server.site, engine.factory, clock);
  const edit = (changes: FixtureRecordEdit['changes'], extra: Partial<FixtureRecordEdit> = {}): FixtureRecordEdit => ({ version: record.version, rule: structuredClone(rule), changes, evidence: [], notify: [], share: [], delete: false, ...extra });
  const execute = (request: BrowserRequest) => { engine.next = request; return f.work.execute({ kind: 'submit', target: 'e1_1', generation: f.work.state().generation }); };
  const navigate = () => f.work.execute({ kind: 'navigate', url: `${server.origin}/records/${record.id}`, generation: f.work.state().generation });
  await navigate();
  return { ...f, engine, server, record, edit, execute, navigate, set rule(r: typeof rule) { rule = r; }, get rule() { return rule; }, async cleanup() { await f.cleanup(); server.close(); rmSync(dir, { recursive: true, force: true }); } };
}
