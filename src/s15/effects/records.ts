import { Database } from 'bun:sqlite';
import { containsCredential } from '../../security/credentials';
import type { BrowserRequest, BrowserSitePolicy, RequestMeaning } from '../browser';
import type { ActionClass, ActionRef, JsonValue, OwnerActor, Ref, S15PolicyService } from '../policy';
import { canonical, digest, equal, exact, fail, id, nat, ref, string, unknownUsage } from '../policy/validation';
import { communicationClasses, type EffectDecisionCard } from './types';

/** Controlled service schema, not a claim of support for Google Docs, Tasks or a production CRM. */
export type FixtureRecordFields = { title: string; body: string } | { title: string; completed: boolean } | { note: string; classification: string; priceMinor: string; discountBps: number; terms: string; policy: string; commitment: string };
/** Every service-side consequence is protected metadata at the same observed record version. */
export interface FixtureRecord { id: string; kind: 'document' | 'task' | 'business'; version: number; fields: FixtureRecordFields; deleted: boolean; triggers: { notify: string[]; fulfillment: boolean; payment: boolean } }
/** A source version supports only one exact factual value for one record/field; inference is never fact authority. */
export interface FixtureRecordEvidence { id: string; revision: number; recordId: string; field: string; value: string; status: 'fact' | 'inference'; active: boolean }
/** Actual native-form request; no model effect/impact label is accepted. */
export interface FixtureRecordEdit { version: number; rule: Ref; changes: Record<string, string | boolean | number>; evidence: { id: string; revision: number }[]; notify: string[]; share: string[]; delete: boolean }
interface Edit { recordId: string; operationId: string; body: FixtureRecordEdit }
interface Analysis { before: FixtureRecord; after: FixtureRecord; classes: ActionClass[]; impacts: string[]; evidence: EffectDecisionCard['evidence']; recipients: Ref[] }
const htmlEscape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const htmlUnescape = (s: string) => s.replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
const responseHtml = (value: unknown, status = 200) => new Response(`<!doctype html><html><body><pre id="result">${htmlEscape(canonical(value))}</pre></body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const parseResponse = (body: Uint8Array): unknown => { const s = new TextDecoder('utf-8', { fatal: true }).decode(body), match = /^<!doctype html><html><body><pre id="result">([\s\S]*)<\/pre><\/body><\/html>$/.exec(s); if (!match) fail('record_result_unverified'); return JSON.parse(htmlUnescape(match[1]!)); };
function validateFields(kind: FixtureRecord['kind'], value: unknown): asserts value is FixtureRecordFields {
  if (kind === 'document') { exact(value, ['title', 'body']); string(value.title, 512); string(value.body, 16384); }
  else if (kind === 'task') { exact(value, ['title', 'completed']); string(value.title, 512); if (typeof value.completed !== 'boolean') fail('invalid_record'); }
  else if (kind === 'business') { exact(value, ['note', 'classification', 'priceMinor', 'discountBps', 'terms', 'policy', 'commitment']); for (const k of ['note', 'classification', 'terms', 'policy', 'commitment']) string(value[k], 16384); if (typeof value.priceMinor !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value.priceMinor)) fail('invalid_record'); nat(value.discountBps); if (value.discountBps > 10000) fail('invalid_record'); }
  else fail('record_kind_unsupported');
  canonical(value);
  if (Object.values(value).some(v => typeof v === 'string' && containsCredential(v))) fail('credential_content_refused');
}
function validateEdit(value: unknown): asserts value is FixtureRecordEdit {
  canonical(value); exact(value, ['version', 'rule', 'changes', 'evidence', 'notify', 'share', 'delete']); nat(value.version, true); ref(value.rule);
  if (!value.changes || typeof value.changes !== 'object' || Array.isArray(value.changes) || Object.keys(value.changes).length > 16 || Object.values(value.changes).some(v => !['string', 'number', 'boolean'].includes(typeof v))) fail('record_change_unsupported');
  if (typeof value.delete !== 'boolean') fail('invalid_record');
  for (const key of ['notify', 'share'] as const) { if (!Array.isArray(value[key]) || value[key].length > 16 || new Set(value[key]).size !== value[key].length) fail('invalid_recipient'); value[key].forEach(id); }
  if (!Array.isArray(value.evidence) || value.evidence.length > 16) fail('invalid_evidence');
  for (const e of value.evidence) { exact(e, ['id', 'revision']); id(e.id); nat(e.revision, true); }
}

/**
 * A durable controlled document/task/business HTTP service and its exact protected browser semantics.
 * The service performs CAS and journals one operation per observed record version. Fixture setup,
 * evidence/rule administration and DecisionCard projection stay in host composition, never tools.
 */
export function openFixtureRecordService(options: { runtime: 's15'; path: string; create: boolean; resource: Ref; rule: () => Ref | null; recipients: () => readonly { id: string; ref: Ref }[] }) {
  if (options.runtime !== 's15') fail('runtime_opt_in_required'); ref(options.resource);
  const db = new Database(options.path, { create: options.create }); db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
  if (options.create) db.exec(`CREATE TABLE records (id TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE versions (id TEXT, version INTEGER, json TEXT NOT NULL, PRIMARY KEY(id,version)); CREATE TABLE evidence (id TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE operations (id TEXT PRIMARY KEY, input TEXT NOT NULL, result TEXT NOT NULL); PRAGMA user_version=1; PRAGMA application_id=1246900533;`);
  if ((db.query('PRAGMA application_id').get() as { application_id: number }).application_id !== 1246900533 || (db.query('PRAGMA user_version').get() as { user_version: number }).user_version !== 1) { db.close(); fail('continuity_unavailable'); }
  const getRecord = (recordId: string, version?: number): FixtureRecord => {
    id(recordId); const row = version === undefined ? db.query('SELECT json FROM records WHERE id=?').get(recordId) : db.query('SELECT json FROM versions WHERE id=? AND version=?').get(recordId, version);
    if (!row) fail('record_not_found'); return JSON.parse((row as { json: string }).json) as FixtureRecord;
  };
  const getEvidence = (key: string): FixtureRecordEvidence | null => { const row = db.query('SELECT json FROM evidence WHERE id=?').get(key) as { json: string } | null; return row ? JSON.parse(row.json) as FixtureRecordEvidence : null; };
  const operationId = (r: FixtureRecord) => 'record_' + digest('s15.fixture.record.intent.v1', { id: r.id, version: r.version });
  let beforeCommit: (() => void) | null = null, loseResponse = false;
  function analyze(edit: Edit, historical = false): Analysis {
    validateEdit(edit.body); const p = edit.body, before = getRecord(edit.recordId, historical ? p.version : undefined);
    if (before.deleted || before.version !== p.version || edit.operationId !== operationId(before)) fail('stale_record');
    if (!historical && !equal(options.rule(), p.rule)) fail('stale_record_rule');
    if (!historical) for (const requested of p.evidence) {
      const current = getEvidence(requested.id);
      if (!current || current.revision !== requested.revision || !current.active) fail('stale_evidence');
    }
    const fields = { ...before.fields, ...p.changes }; validateFields(before.kind, fields);
    if (!p.delete && !Object.keys(p.changes).length && !p.notify.length && !p.share.length) fail('empty_record_change');
    const after: FixtureRecord = { ...structuredClone(before), version: before.version + 1, fields, deleted: p.delete };
    const classes: ActionClass[] = ['ordinary_edit'], impacts: string[] = [], proof: EffectDecisionCard['evidence'] = [];
    if (p.delete) impacts.push('destructive_data_change');
    if (before.kind === 'business') for (const [field, value] of Object.entries(p.changes)) {
      if (equal((before.fields as unknown as Record<string, unknown>)[field], value)) continue;
      if (['priceMinor', 'discountBps', 'terms', 'policy', 'commitment'].includes(field)) { impacts.push(({ priceMinor: 'new_price', discountBps: 'new_discount', terms: 'new_terms', policy: 'business_policy_change', commitment: 'new_business_obligation' } as Record<string, string>)[field]!); continue; }
      const entries = p.evidence.map(e => { const actual = getEvidence(e.id); return { request: e, actual }; }).filter(e => e.actual?.recordId === before.id && e.actual.field === field);
      const facts = entries.filter(e => e.actual!.revision === e.request.revision && e.actual!.active && e.actual!.status === 'fact' && e.actual!.value === value);
      if (facts.length !== 1) impacts.push('unverified_fact');
      if (!entries.length) proof.push({ id: field, revision: 0, value: String(value), status: 'missing' });
      else for (const e of entries) proof.push({ id: e.request.id, revision: e.request.revision, value: e.actual!.value, status: e.actual!.revision !== e.request.revision || !e.actual!.active ? 'missing' : e.actual!.status });
    }
    if (before.triggers.payment) fail('payment_trigger_unsupported');
    if (before.triggers.fulfillment) impacts.push('new_business_obligation');
    if (impacts.length) classes.push('major_change');
    const notificationIds = [...new Set([...p.notify, ...before.triggers.notify])];
    if (notificationIds.length) classes.push(...communicationClasses());
    if (p.share.length) classes.push('disclosure');
    const recipients = [...new Set([...notificationIds, ...p.share])].map(key => { const matches = options.recipients().filter(r => r.id === key); if (matches.length !== 1) fail('recipient_binding_required'); return structuredClone(matches[0]!.ref); });
    return { before, after, classes: [...new Set(classes)], impacts: [...new Set(impacts)], evidence: proof, recipients };
  }
  function parseRequest(r: BrowserRequest): Edit | null {
    const url = new URL(r.url), match = /^\/records\/([A-Za-z0-9_-]{1,128})\/save$/.exec(url.pathname);
    if (url.origin !== origin || url.search || !match || r.method !== 'POST' || r.contentType.split(';')[0] !== 'application/x-www-form-urlencoded') return null;
    const body = Buffer.from(r.bodyBase64, 'base64'); if (body.toString('base64') !== r.bodyBase64) return null;
    const fields = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if ([...fields.keys()].sort().join() !== 'edit,operationId') return null;
    const edit: Edit = { recordId: match[1]!, operationId: fields.get('operationId')!, body: JSON.parse(fields.get('edit')!) as FixtureRecordEdit }; id(edit.operationId); validateEdit(edit.body); return edit;
  }
  function verified(edit: Edit, status: number, body: Uint8Array): 'succeeded' | 'failed' | 'unknown' {
    if (status === 409 || status === 422) return 'failed'; if (status !== 200) return 'unknown';
    try {
      const observed = parseResponse(body); exact(observed, ['operationId', 'before', 'after', 'notified', 'shared', 'fulfilled']);
      const expected = analyze(edit, true);
      return observed.operationId === edit.operationId && equal(observed.before, expected.before) && equal(observed.after, expected.after) && equal(observed.notified, [...new Set([...edit.body.notify, ...expected.before.triggers.notify])]) && equal(observed.shared, edit.body.share) && observed.fulfilled === expected.before.triggers.fulfillment ? 'succeeded' : 'unknown';
    } catch { return 'unknown'; }
  }
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url), read = /^\/records\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname), saved = /^\/operations\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
    try {
      if (request.method === 'GET' && read && !url.search) {
        const r = getRecord(read[1]!), rule = options.rule() ?? fail('stale_record_rule');
        const edit: FixtureRecordEdit = { version: r.version, rule, changes: {}, evidence: [], notify: [], share: [], delete: false };
        return new Response(`<!doctype html><html><body><pre>${htmlEscape(canonical(r))}</pre><form method="post" action="/records/${r.id}/save"><input type="hidden" name="operationId" value="${operationId(r)}"><textarea name="edit">${htmlEscape(canonical(edit))}</textarea><button type="submit">Save</button></form></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (request.method === 'GET' && saved && !url.search) { const row = db.query('SELECT result FROM operations WHERE id=?').get(saved[1]!) as { result: string } | null; return row ? responseHtml(JSON.parse(row.result)) : responseHtml({ code: 'record_outcome_unknown' }, 404); }
      if (request.method !== 'POST') return responseHtml({ code: 'record_operation_unsupported' }, 404);
      const body = await request.text(); if (Buffer.byteLength(body) > 65536) return responseHtml({ code: 'input_too_large' }, 422);
      const r: BrowserRequest = { method: request.method, url: request.url, contentType: request.headers.get('content-type') ?? '', bodyBase64: Buffer.from(body).toString('base64'), navigation: true }, edit = parseRequest(r); if (!edit) return responseHtml({ code: 'record_operation_unsupported' }, 422);
      beforeCommit?.();
      const observed = db.transaction(() => {
        if (db.query('SELECT id FROM operations WHERE id=?').get(edit.operationId)) fail('already_claimed');
        const a = analyze(edit);
        // This fixture server is reachable only through its protected test broker. Classification/approval
        // happens there; the independent CAS and journal here stop stale or duplicate remote commits.
        db.query('UPDATE records SET json=? WHERE id=?').run(canonical(a.after), a.after.id);
        db.query('INSERT INTO versions VALUES (?,?,?)').run(a.after.id, a.after.version, canonical(a.after));
        const result = { operationId: edit.operationId, before: a.before, after: a.after, notified: [...new Set([...edit.body.notify, ...a.before.triggers.notify])], shared: edit.body.share, fulfilled: a.before.triggers.fulfillment };
        db.query('INSERT INTO operations VALUES (?,?,?)').run(edit.operationId, canonical(edit), canonical(result)); return result;
      })();
      if (loseResponse) { loseResponse = false; return new Response('<html><body>Save response lost</body></html>', { headers: { 'content-type': 'text/html' } }); }
      return responseHtml(observed);
    } catch { return responseHtml({ code: 'record_conflict_refresh_required' }, 409); }
  } });
  const origin = server.url.origin;
  const site: BrowserSitePolicy = {
    loginDocuments: [], session: null,
    observable(url) { const u = new URL(url); return u.origin === origin && !u.search && /^\/records\/[A-Za-z0-9_-]+(?:\/save)?$/.test(u.pathname); },
    classify(request): RequestMeaning | null {
      try {
        const url = new URL(request.url); if (url.origin !== origin || url.search) return null;
        if (request.method === 'GET' && !request.bodyBase64 && /^\/records\/[A-Za-z0-9_-]+$/.test(url.pathname)) { getRecord(url.pathname.split('/')[2]!); return { kind: 'read', private: true }; }
        const edit = parseRequest(request); if (!edit) return null;
        const a = analyze(edit);
        return { kind: 'effect', classes: a.classes, recipients: a.recipients, transaction: null, impact: a.impacts.length ? 'major' : 'reversible', verifyResponse: response => verified(edit, response.status, response.body) };
      } catch (e) { return { kind: 'unsupported', code: e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : 'record_operation_unsupported' }; }
    },
    async reconcileEffect(request, context) {
      const edit = parseRequest(request); if (!edit) fail('record_operation_unsupported');
      context.beforeRead();
      const response = await fetch(origin + '/operations/' + edit.operationId, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      const body = new Uint8Array(await response.arrayBuffer());
      return { outcome: verified(edit, response.status, body), actual: unknownUsage(), transportSettled: true };
    },
  };
  return { origin, site,
    /** Trusted fixture administration, unavailable through HTTP/browser/model input. */
    seed(record: FixtureRecord) { id(record.id); nat(record.version, true); validateFields(record.kind, record.fields); canonical(record); if (db.query('SELECT id FROM records WHERE id=?').get(record.id)) fail('record_exists'); db.transaction(() => { db.query('INSERT INTO records VALUES (?,?)').run(record.id, canonical(record)); db.query('INSERT INTO versions VALUES (?,?,?)').run(record.id, record.version, canonical(record)); })(); },
    /** Changes remote state for deterministic concurrent-edit/hidden-effect fixtures. */
    change(recordId: string, changes: Partial<Pick<FixtureRecord, 'fields' | 'triggers'>>) { const before = getRecord(recordId), after = { ...before, ...structuredClone(changes), version: before.version + 1 }; validateFields(after.kind, after.fields); db.transaction(() => { db.query('UPDATE records SET json=? WHERE id=?').run(canonical(after), recordId); db.query('INSERT INTO versions VALUES (?,?,?)').run(recordId, after.version, canonical(after)); })(); },
    putEvidence(e: FixtureRecordEvidence) { canonical(e); id(e.id); nat(e.revision, true); id(e.recordId); string(e.field); string(e.value, 16384); if (containsCredential(e.value)) fail('credential_content_refused'); if (!['fact', 'inference'].includes(e.status) || typeof e.active !== 'boolean') fail('invalid_evidence'); const old = getEvidence(e.id); if (old && e.revision <= old.revision) fail('stale_evidence'); db.query('INSERT INTO evidence VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(e.id, canonical(e)); },
    record: getRecord,
    /** Native-form serialization helper for protocol fixtures; the browser still owns and intercepts actual bytes. */
    request(recordId: string, body: FixtureRecordEdit): BrowserRequest { const r = getRecord(recordId, body.version); validateEdit(body); return { method: 'POST', url: `${origin}/records/${recordId}/save`, contentType: 'application/x-www-form-urlencoded', bodyBase64: Buffer.from(new URLSearchParams({ operationId: operationId(r), edit: canonical(body) }).toString()).toString('base64'), navigation: true }; },
    /** Authenticated owner JSON projection of the exact held impact and existing decision; never an approval port. */
    decisionCard(owner: OwnerActor, policy: S15PolicyService, action: ActionRef): EffectDecisionCard | null {
      const slip = policy.owner.actionSlip(owner, action); if (!slip.action.classes.includes('major_change')) return null;
      const value = slip.action.payload as Record<string, JsonValue>; if (value.contract !== 's15-browser-request/v1') fail('record_operation_unsupported');
      const { contract: _, ...request } = value, edit = parseRequest(request as unknown as BrowserRequest); if (!edit) fail('record_operation_unsupported');
      const a = analyze(edit, true);
      return { contract: 's15-effect-decision/v1', action: { id: action.id, revision: action.revision, actionHash: action.actionHash }, target: edit.recordId, version: edit.body.version, impacts: a.impacts, evidence: a.evidence, options: [{ id: 'apply_exact', consequence: 'Apply only the exact prepared change and its shown consequences.', reversible: !a.before.triggers.fulfillment }, { id: 'investigate', consequence: 'Keep the record unchanged and investigate within existing authority.', reversible: true }, { id: 'keep', consequence: 'Keep the existing record and make no new commitment.', reversible: true }], recommendation: { option: a.impacts.includes('unverified_fact') ? 'investigate' : 'keep', text: 'Confirm evidence and the business direction before applying this exact change.', authority: 'none' } };
    },
    get mutationCount() { return (db.query('SELECT count(*) AS count FROM operations').get() as { count: number }).count; },
    set beforeCommit(fn: (() => void) | null) { beforeCommit = fn; }, set loseNextResponse(value: boolean) { loseResponse = value; },
    close() { server.stop(true); db.close(); },
  };
}
