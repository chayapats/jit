import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser } from 'playwright-core';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { AppError } from '../src/errors';
import { ConnectionVault } from '../src/exec/connections';
import { VmStore } from '../src/s15/vm/store';
import { VmManagers } from '../src/s15/vm/managers';
import { createFirecrackerManagementRelay } from '../src/s15/vm/firecracker/rpc';
import type { S15WebComputer } from '../src/s15/web';
import { en } from '../src/i18n/en';
import { th } from '../src/i18n/th';
import { webFixture, origin, type WebActor, type WebFixture } from './fixtures/s15-web';
import { firecrackerRuntimeFixture } from './fixtures/s15-firecracker-runtime';

// Real browser -> owning Web handler -> registry/vault/client RPC -> real fixture API/vsock/raw files.
// Host process/systemd observations remain protocol_fixture, never Linux/KVM acceptance.
const browserTest = process.env.JIT_S16_BROWSER_TESTS === '1' ? test : test.skip;
let browser: Browser;
beforeAll(async () => { if (process.env.JIT_S16_BROWSER_TESTS === '1') browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true }); });
afterAll(async () => { await browser?.close(); });

browserTest.each([1440, 390])('prepared offline computer setup through owning handler and actual RPC at width %i', async width => {
  const f = await firecrackerRuntimeFixture(), installationId = 'installation-fc-browser', credential = 'browser_fixture_' + 'b'.repeat(32);
  const relay = createFirecrackerManagementRelay(f.runtime(), { credential, installationId, port: 0 }), root = realpathSync(dirname(f.path)), store = new VmStore(join(root, 'controller.sqlite'));
  let web: WebFixture;
  const managers = new VmManagers({ store, vault: new ConnectionVault(join(root, 'vault'), { forbidden: [f.root, f.recovery] }), requireOwner(actor) { if (actor !== web.actor) throw new AppError('authentication_required', 401); }, firecracker: { directory: join(root, 'clients'), installationId, fixture: { basis: 'protocol_fixture' } } });
  const status = { id: 'working', generation: 1, state: 'ready' as const, networkIsolated: true, recoveryAvailable: true, activeSessions: 0, maxSessions: 2, reason: null, capabilities: [], facts: null };
  const computer: S15WebComputer<WebActor> = { vmId: 'working', get managerId() { return managers.unbound(() => true); }, hypervisor: null,
    status: () => status, snapshots: () => [], restore: async () => {}, begin: async () => ({ setupId: 'setup', publicKey: 'fixture-public-key', command: 'fixture enrollment' }), checkMachine: async () => { throw Error('unused'); }, useMachine: async () => { throw Error('unused'); },
    pool: { members: () => [{ id: 'working', isDefault: true, local: true, drained: false, activeSessions: 0, capacity: 2, works: 0, status }], drain() {}, nextId: () => 'second-computer', registerManager: (actor, input) => { managers.register(actor, input); },
      preparedManager: () => { const id = managers.unbound(() => true); return id ? { id, pending: managers.pendingFirecracker(id) } : null; }, startPrepared: (actor, id) => managers.startPrepared(actor, id) } };
  web = webFixture(() => ({ computer }));
  // Real loopback HTTP preserves ordinary form/303 navigation. Only the test fixture's fixed
  // Host/Origin and synthetic owner session are mapped by this controlled reverse proxy.
  let webOrigin = '';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url), headers = new Headers(request.headers); headers.set('host', 'jit.test'); headers.set('cookie', 'jit_s15=owner-token');
    if (headers.get('origin') === webOrigin) headers.set('origin', origin);
    return web.handler(new Request(origin + url.pathname + url.search, { method: request.method, headers, ...(request.method === 'POST' ? { body: await request.arrayBuffer() } : {}) }));
  } }); webOrigin = server.url.origin;
  const copy = width === 1440 ? en : th, context = await browser.newContext({ viewport: { width, height: 1000 }, locale: width === 1440 ? 'en-US' : 'th-TH', timezoneId: 'Asia/Bangkok' }), external: string[] = [], errors: string[] = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()); if (url.origin !== webOrigin) { external.push(request.url()); await route.abort(); return; } await route.continue();
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(webOrigin + '/resources/computer');
    const details = page.locator('details').filter({ has: page.getByText(copy['s15.pool.manager_firecracker'], { exact: true }) });
    await details.locator('summary').focus(); await page.keyboard.press('Enter');
    await details.getByText(copy['s15.pool.manager_firecracker_limits'], { exact: true }).waitFor();
    await details.getByLabel(copy['s15.pool.manager_firecracker_origin'], { exact: true }).fill(relay.origin);
    await details.getByLabel(copy['s15.pool.manager_firecracker_id'], { exact: true }).fill(f.runtime().computerId);
    await details.getByLabel(copy['s15.pool.manager_firecracker_fingerprint'], { exact: true }).fill(f.runtime().selectionSha256);
    const token = details.locator('input[name=token]'); expect(await token.getAttribute('type')).toBe('password'); await token.fill(credential); await token.press('Tab');
    expect(await details.getByRole('button', { name: copy['s15.pool.manager_save'] }).evaluate(element => document.activeElement === element)).toBe(true);
    await page.keyboard.press('Enter'); await page.waitForURL(/saved=manager/);
    expect(managers.size).toBe(1); expect(f.starts()).toBe(0); expect(await page.content()).not.toContain(credential);
    await page.getByRole('button', { name: copy['s15.pool.manager_firecracker_start'], exact: true }).focus(); await page.keyboard.press('Enter'); await page.waitForURL(url => !url.search);
    expect(f.starts()).toBe(1); expect((await managers.values().next().value!.inspect()).state).toBe('running');
    await page.getByRole('heading', { name: copy['s15.vm.restore_title'], exact: true }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); expect(errors).toEqual([]); expect(external).toEqual([]);
    await page.screenshot({ path: `.local/resolve-issues/427-firecracker-setup-${width}.png`, fullPage: true });
  } finally { await context.close(); server.stop(true); web.cleanup(); managers.close(); store.close(); relay.close(); await f.close(); }
}, 60000);
