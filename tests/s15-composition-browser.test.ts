import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openProvisionedBrowser, provisionedBrowserResource, type ProvisionedBrowser } from '../src/s15/browser';
import type { S15CompositionOptions } from '../src/s15/composition';
import { composedFixture } from './fixtures/s15-composition';

// BROW15-02: composition of the provisioned browser on an installation that had none, and its owner-only Web port.
const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const ports = { arch: () => 'x64', platform: () => 'linux', freeBytes: () => 0, async download() { throw new Error('not used'); }, async hash() { return ''; }, async extract() {}, async libraries() { return { ok: true as const }; } };

async function setup() {
  let provisioned: ProvisionedBrowser | null = null, explicit = false;
  const tune = (options: S15CompositionOptions): S15CompositionOptions => {
    const { browser, ...rest } = options;
    if (explicit) return options;
    if (!provisioned) return rest;
    const p = provisioned;
    return { ...rest, browser: p.options(), disclosure: p.disclosure(options.disclosure!), catalogs: { ...options.catalogs, current: (kind, id) => options.catalogs.current(kind, id) ?? p.catalog(kind, id) } };
  };
  const f = await composedFixture('default', false, undefined, tune); cleanup.push(() => f.close());
  const manifest = () => JSON.parse(readFileSync(join(f.directory, 'composition.json'), 'utf8')) as { stores: string[] };
  return { f, manifest, provision() { provisioned = openProvisionedBrowser({ directory: join(f.parent, 'state'), installationId: 'fixture', ports }); cleanup.push(() => provisioned?.close()); return provisioned; }, set explicit(value: boolean) { explicit = value; } };
}

test('an installation composed without a browser gains the provisioned browser store once, and serves the owner websites port', async () => {
  const s = await setup(), f = s.f;
  expect(s.manifest().stores).not.toContain('browser.sqlite'); expect(f.service.browser).toBeUndefined();
  // A crash-interrupted upgrade boot can leave an unlisted generation-1 store; it is replaced, never trusted.
  writeFileSync(join(f.directory, 'browser.sqlite'), 'leftover', { mode: 0o600 });
  const p = s.provision(); await f.reopen();
  expect(s.manifest().stores).toContain('browser.sqlite'); expect(existsSync(join(f.directory, 'browser.sqlite'))).toBe(true); expect(f.service.browser).toBeDefined();
  await f.reopen(); expect(s.manifest().stores).toContain('browser.sqlite');
  expect(p.catalog('resource', provisionedBrowserResource.id)).toEqual({ ref: { ...provisionedBrowserResource }, active: true });

  // Resources → Websites: status, add and remove through authenticated no-script posts; changes apply at once.
  const page = await (await f.request('/resources/websites', 'GET', undefined, { 'accept-language': 'en' })).text();
  expect(page).toContain('Preparing the browser'); expect(page).toContain('No websites yet.'); expect(page).toContain('action="/s15/forms/websites/add"');
  const added = await f.form('/s15/forms/websites/add', { website: 'https://example.com/docs/start' });
  expect(added.status).toBe(303); expect(added.headers.get('location')).toBe('/resources/websites?added=https%3A%2F%2Fexample.com#s15-web-list');
  expect(p.sites.allows('https://example.com')).toBe(true);
  const refused = await f.form('/s15/forms/websites/add', { website: 'http://192.168.1.1' }, { 'accept-language': 'en' });
  expect(refused.status).toBe(409); const refusedPage = await refused.text();
  expect(refusedPage).toContain('website_https_required'); expect(refusedPage).toContain('value="http://192.168.1.1"');
  const removed = await f.form('/s15/forms/websites/remove', { origin: 'https://example.com', revision: '1' });
  expect(removed.status).toBe(303); expect(p.sites.allows('https://example.com')).toBe(false);
  expect((await f.form('/s15/forms/websites/remove', { origin: 'https://example.com', revision: '1' })).status).toBe(409);

  // Owner-only: no session cookie, or a foreign Origin, changes nothing.
  const anonymous = await f.service.fetch(new Request('http://localhost:3099/s15/forms/websites/add', { method: 'POST', headers: { origin: 'http://localhost:3099', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ website: 'example.org', requestId: 'r1', csrf: 'x' }) }));
  expect(anonymous.status).toBe(401);
  expect((await f.form('/s15/forms/websites/add', { website: 'example.org' }, { origin: 'http://evil.example' })).status).toBe(403);
  expect((await f.form('/s15/forms/websites/add', { website: 'example.org', csrf: 'wrong' })).status).toBe(403);
  expect(p.sites.list()).toEqual([]);
});

test('other manifest differences and an explicit browser still refuse on reopen', async () => {
  const s = await setup(), f = s.f, original = readFileSync(join(f.directory, 'composition.json'), 'utf8');
  s.provision();
  const narrowed = JSON.parse(original) as { stores: string[] }; narrowed.stores = narrowed.stores.filter(name => name !== 'github.sqlite');
  writeFileSync(join(f.directory, 'composition.json'), JSON.stringify(narrowed));
  await f.service.close();
  const { composeS15 } = await import('../src/s15/composition');
  await expect(composeS15(f.options(false))).rejects.toMatchObject({ code: 'continuity_unavailable' });
  writeFileSync(join(f.directory, 'composition.json'), original);
  // A configured (non-provisioned) browser is never added to an existing installation.
  s.explicit = true;
  await expect(composeS15(f.options(false))).rejects.toMatchObject({ code: 'continuity_unavailable' });
  expect(existsSync(join(f.directory, 'browser.sqlite'))).toBe(false);
  s.explicit = false; await f.reopen(); expect(JSON.parse(readFileSync(join(f.directory, 'composition.json'), 'utf8')).stores).toContain('browser.sqlite');
});
