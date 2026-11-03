import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovedWebsites, BrowserError, approvedWebsiteHistoryLimit, approvedWebsiteLimit, approvedWebsiteOrigin, approvedWebsitePolicy, withApprovedWebsites, type BrowserOperation, type BrowserRequest } from '../src/s15/browser';
import type { BrowserEngine, EngineOptions } from '../src/s15/browser/engine';
import { runtimeDisclosure } from '../src/s15/disclosure/runtime';
import type { WorkAuthority } from '../src/s15/policy';
import { browserFixture, browserSite } from './fixtures/s15-browser';

// BROW15-02 owner-approved websites: validation, the protected journal, request semantics and disclosure wiring.
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const directory = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-websites-'))); cleanup.push(() => rmSync(root, { recursive: true, force: true })); return root; };
const open = (root: string, now = () => 1_800_000_000_000) => { const sites = new ApprovedWebsites(join(root, 'browser-sites.sqlite'), 'fixture', { now }); cleanup.push(() => sites.close()); return sites; };
const code = (fn: () => unknown) => { try { fn(); } catch (error) { return error instanceof BrowserError ? error.code : String(error); } return null; };

test('owner entries normalize to one exact public HTTPS origin or refuse with a specific code', () => {
  for (const [input, origin] of [['example.com', 'https://example.com'], ['  https://Docs.Example.com/guide/intro?x=1#top  ', 'https://docs.example.com'], ['https://example.com:8443/a', 'https://example.com:8443'], ['https://bücher.de/', 'https://xn--bcher-kva.de'], ['example.co.th/path', 'https://example.co.th']] as const) expect(approvedWebsiteOrigin(input)).toBe(origin);
  for (const [input, refusal] of [
    ['http://example.com', 'website_https_required'], ['', 'website_invalid'], ['https://exa mple.com', 'website_invalid'], ['ftp://example.com', 'website_invalid'], ['javascript:alert(1)', 'website_invalid'],
    ['https://user:pass@example.com', 'website_invalid'], ['https://-bad.example.com', 'website_invalid'], ['https://example.com.', 'website_invalid'], [42, 'website_invalid'],
    ['https://127.0.0.1', 'website_not_public'], ['https://0x7f.1', 'website_not_public'], ['https://[::1]', 'website_not_public'], ['https://10.0.0.8:8006', 'website_not_public'],
    ['localhost', 'website_not_public'], ['https://intranet', 'website_not_public'], ['https://printer.local', 'website_not_public'], ['https://nas.home.arpa', 'website_not_public'], ['https://api.internal', 'website_not_public'],
    ['https://app.localhost', 'website_not_public'], ['https://example.test', 'website_not_public'], ['https://host.lan', 'website_not_public'], ['https://example.123', 'website_invalid'], ['https://shop.xn--p1ai', null],
  ] as const) expect({ input, code: code(() => approvedWebsiteOrigin(input)) }).toEqual({ input, code: refusal });
});

test('the journal keeps approvals with revisions across reopen; removal binds the revision the owner saw', () => {
  const root = directory(); let clock = 1_800_000_000_000; const sites = open(root, () => clock);
  expect(sites.list()).toEqual([]); expect(sites.allows('https://example.com')).toBe(false);
  const added = sites.add('https://example.com/some/page'); expect(added).toEqual({ origin: 'https://example.com', revision: 1, addedAt: clock });
  clock += 5; expect(sites.add('example.com')).toEqual(added);
  sites.add('docs.example.org'); expect(sites.list().map(s => s.origin)).toEqual(['https://docs.example.org', 'https://example.com']);
  expect(sites.allows('https://example.com')).toBe(true); expect(sites.allows('http://example.com')).toBe(false); expect(sites.allows('https://example.com:444')).toBe(false);
  expect(code(() => sites.remove('https://example.com', 2))).toBe('website_changed');
  expect(code(() => sites.remove('example.com', 1))).toBe('website_invalid');
  sites.remove('https://example.com', 1); expect(sites.allows('https://example.com')).toBe(false);
  expect(code(() => sites.remove('https://example.com', 1))).toBe('website_changed');
  clock += 10; expect(sites.add('https://example.com')).toEqual({ origin: 'https://example.com', revision: 2, addedAt: clock });
  // The process lease refuses a second writer; a reopen sees the same list.
  expect(() => new ApprovedWebsites(join(root, 'browser-sites.sqlite'), 'fixture')).toThrow();
  sites.close(); const reopened = open(root);
  expect(reopened.list()).toEqual([{ origin: 'https://docs.example.org', revision: 1, addedAt: 1_800_000_000_005 }, { origin: 'https://example.com', revision: 2, addedAt: clock }]);
});

test('catalog identities: recipients follow approval, website sources stay public and active after removal', () => {
  const sites = open(directory()), other = open(directory());
  sites.add('https://example.com'); other.add('https://example.com');
  const recipient = sites.recipient('https://example.com/a/b')!, source = sites.source('https://example.com/x')!;
  expect(recipient).toMatchObject({ revision: 1, generation: 1 }); expect(recipient.id).toMatch(/^web_[a-f0-9]{16}_[a-f0-9]{24}$/);
  expect(source).toMatchObject({ revision: 1, generation: 1 }); expect(source.id).toMatch(/^websrc_[a-f0-9]{16}_[a-f0-9]{24}$/);
  // A recreated journal has a new epoch, so identities from another journal never match.
  expect(other.recipient('https://example.com')!.id).not.toBe(recipient.id);
  expect(sites.catalog('recipient', recipient.id)).toEqual({ ref: recipient, active: true }); expect(sites.catalog('lineage', source.id)).toEqual({ ref: source, active: true });
  expect(sites.catalog('resource', recipient.id)).toBeNull(); expect(sites.catalog('recipient', 'web_unknown')).toBeNull(); expect(sites.recipient('https://other.example')).toBeNull();
  expect(sites.disclosureSource(source, { id: 'browser', revision: 1, generation: 1 })).toEqual({ ref: source, resource: { id: 'browser', revision: 1, generation: 1 }, classification: 'public', active: true, ownerReleasable: true });
  sites.remove('https://example.com', 1);
  expect(sites.recipient('https://example.com')).toBeNull(); expect(sites.catalog('recipient', recipient.id)).toEqual({ ref: recipient, active: false });
  expect(sites.source('https://example.com')).toEqual(source); expect(sites.catalog('lineage', source.id)).toEqual({ ref: source, active: true });
  sites.add('https://example.com'); expect(sites.recipient('https://example.com')).toEqual({ ...recipient, revision: 2 });
  expect(sites.catalog('recipient', recipient.id)).toEqual({ ref: { ...recipient, revision: 2 }, active: true });
});

test('at most 200 websites are approved at once; removing one frees a place', () => {
  const sites = open(directory());
  for (let i = 0; i < approvedWebsiteLimit; i++) sites.add(`https://site${i}.example.org`);
  expect(code(() => sites.add('https://one-more.example.org'))).toBe('website_list_full');
  sites.remove('https://site0.example.org', 1); expect(sites.add('https://one-more.example.org').revision).toBe(1);
});

test('the lifetime limit has its own code: removing cannot free it, re-adding an earlier website still works', () => {
  const sites = open(directory());
  expect(approvedWebsiteHistoryLimit).toBeGreaterThan(approvedWebsiteLimit);
  for (let i = 0; i < approvedWebsiteHistoryLimit; i++) { sites.add(`https://site${i}.example.org`); if (i >= 100) sites.remove(`https://site${i}.example.org`, 1); }
  expect(sites.list()).toHaveLength(100);
  // Plenty of room in the active list, yet a new origin needs a new record: a specific refusal, not "remove one".
  expect(code(() => sites.add('https://new.example.org'))).toBe('website_history_full');
  sites.remove('https://site0.example.org', 1); expect(code(() => sites.add('https://new.example.org'))).toBe('website_history_full');
  expect(sites.add('https://site300.example.org')).toMatchObject({ revision: 2 }); expect(sites.add('https://site0.example.org')).toMatchObject({ revision: 2 });
});

test('request semantics: only GET navigations without query or body to a currently approved origin are reads', () => {
  const allowed = new Set(['https://example.com']), policy = approvedWebsitePolicy({ allows: origin => allowed.has(origin) });
  const request = (url: string, more: Partial<BrowserRequest> = {}): BrowserRequest => ({ method: 'GET', url, contentType: '', bodyBase64: '', navigation: true, ...more });
  expect(policy.classify(request('https://example.com/docs/page'), 'static')).toEqual({ kind: 'read', private: false });
  expect(policy.classify(request('https://example.com/search?q=private'), 'static')).toBeNull();
  expect(policy.classify(request('https://example.com/form', { method: 'POST', contentType: 'application/x-www-form-urlencoded', bodyBase64: Buffer.from('a=1').toString('base64') }), 'static')).toBeNull();
  expect(policy.classify(request('https://example.com/style.css', { navigation: false }), 'static')).toBeNull();
  expect(policy.classify(request('https://example.com/', { method: 'HEAD' }), 'static')).toBeNull();
  for (const url of ['https://other.example/', 'http://example.com/', 'https://example.com:444/']) expect(policy.classify(request(url), 'static')).toEqual({ kind: 'unsupported', code: 'website_not_approved' });
  expect(policy.observable('https://example.com/a', 'static')).toBe(true); expect(policy.observable('https://other.example/', 'static')).toBe(false); expect(policy.observable('about:blank', 'static')).toBe(false);
  expect(policy.loginDocuments).toEqual([]); expect(policy.session).toBeNull();
  allowed.delete('https://example.com');
  expect(policy.classify(request('https://example.com/docs/page'), 'static')).toEqual({ kind: 'unsupported', code: 'website_not_approved' });
});

test('on the protected gateway an approved origin is read, an unlisted one is refused before any request, and changes apply without restart', async () => {
  const server = browserSite(); cleanup.push(() => server.close());
  const allowed = new Set([server.origin]);
  let options!: EngineOptions, url = 'about:blank';
  const engine: BrowserEngine = {
    async navigate(target) { await options.request({ request: { method: 'GET', url: target, contentType: '', bodyBase64: '', navigation: true }, cookies: '', main: true, document: true, attributable: true, async send() { url = target; }, async deny() {} }); },
    async read(generation) { return { id: 'observation', generation, url, text: 'Observed public content', truncated: false, elements: [] }; },
    async image() { return new Uint8Array([1]); }, async interact() {}, async ownerInput() {}, async cookie() { return null; }, async close() {},
  };
  const f = await browserFixture('static', approvedWebsitePolicy({ allows: origin => allowed.has(origin) }), async o => { options = o; return engine; }); cleanup.push(() => f.cleanup());
  const run = (input: { kind: 'navigate'; url: string } | { kind: 'read' }) => f.work.execute({ ...input, generation: f.work.state().generation } as BrowserOperation);
  expect(await run({ kind: 'navigate', url: `${server.origin}/` })).toMatchObject({ state: 'ok' });
  expect(await run({ kind: 'read' })).toMatchObject({ state: 'observed', observation: { text: 'Observed public content' } });
  const before = server.received.length;
  expect(await run({ kind: 'navigate', url: `${server.origin}/task?private=1` })).toEqual({ state: 'unsupported', code: 'effect_semantics_unknown' });
  allowed.delete(server.origin);
  expect(await run({ kind: 'navigate', url: `${server.origin}/clean-task` })).toEqual({ state: 'unsupported', code: 'website_not_approved' });
  expect(await run({ kind: 'read' })).toEqual({ state: 'denied', code: 'secret_boundary' });
  expect(server.received.length).toBe(before);
  allowed.add(server.origin);
  expect(await run({ kind: 'navigate', url: `${server.origin}/attacks` })).toMatchObject({ state: 'ok' });
  expect(server.received.at(-1)).toMatchObject({ path: '/attacks', method: 'GET' });
});

test('disclosure resolves an approved origin to its recipient and source; unlisted stays unknown; configured bindings keep priority', () => {
  const sites = open(directory()); sites.add('https://example.com');
  const configuredRecipient = { id: 'configured', revision: 1, generation: 1 }, configuredSource = { id: 'configured_source', revision: 1, generation: 1 }, resource = { id: 'browser', revision: 1, generation: 1 };
  const base = runtimeDisclosure({ sources: [], approvals: [], githubRecipient: null, googleRecipient: null, browser: [{ origin: 'https://configured.example', recipient: configuredRecipient, source: configuredSource }], acquisitions: [], registries: [] }, [], { current: () => null, allows: () => true }, []);
  const d = withApprovedWebsites(base, sites, resource), route = d.routes.find(r => r.id === d.browserRoute)!, work = {} as WorkAuthority;
  const payload = (url: string) => ({ contract: 's15-browser-request/v1', method: 'GET', url, contentType: '', bodyBase64: '', navigation: true });
  expect(route.resolve(work, payload('https://example.com/a'))).toEqual([sites.recipient('https://example.com')!]);
  expect(route.resolve(work, payload('https://configured.example/a'))).toEqual([configuredRecipient]);
  expect(route.resolve(work, payload('https://unlisted.example/a'))).toBeNull();
  expect(d.browserSource!(work, 'https://example.com/page', 'text')).toEqual(sites.source('https://example.com'));
  expect(d.browserSource!(work, 'https://configured.example/page', 'text')).toEqual(configuredSource);
  expect(d.browserSource!(work, 'https://unlisted.example/page', 'text')).toBeNull();
  expect(d.catalogs.source(sites.source('https://example.com')!)).toMatchObject({ classification: 'public', resource, active: true });
  expect(d.catalogs.recipient(sites.recipient('https://example.com')!)).toEqual({ ref: sites.recipient('https://example.com')!, active: true });
  // Other routes are untouched.
  expect(d.routes.filter(r => r.id !== d.browserRoute)).toEqual(base.routes.filter(r => r.id !== base.browserRoute));
});
