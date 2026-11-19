import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import type { Model, ModelRequest } from 'schway/host';
import { launchProtectedEngine } from '../src/s15/browser/engine';
import type { BrowserInputSnapshot, BrowserRequest } from '../src/s15/browser';
import { JitClient } from '../src/s16/client';
import { en } from '../src/i18n/en';
import { th } from '../src/i18n/th';
import { browserSite } from './fixtures/s15-browser';
import { composedFixture, ref } from './fixtures/s15-composition';

const native = test.skipIf(process.env.JIT_S16_BROWSER_TESTS !== '1');
let browser: Browser;
beforeAll(async () => { if (process.env.JIT_S16_BROWSER_TESTS === '1') browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--disable-background-networking', '--no-first-run'] }); });
afterAll(async () => { await browser?.close(); });
const uid = () => crypto.randomUUID().replaceAll('-', '');

for (const width of [1440, 390]) native(`actual composed protected login, async approval and team session reuse at ${width}`, async () => {
  const website = browserSite({ asyncIntent: 'fetch' }), copy = width === 1440 ? en : th;
  let plan: { kind: 'navigate' | 'read' | 'send' | 'edit'; url?: string; value?: string } = { kind: 'read' }, stage = 0;
  const prompts: string[] = [];
  const model: Model = { provider: 'codex-subscription', id: 'fixture-model', async *stream(request: ModelRequest) {
    prompts.push(JSON.stringify(request)); const last = request.items.at(-1), result = last?.type === 'tool_result' ? JSON.parse(last.content) : null;
    let arguments_: Record<string, unknown> | null = null;
    if (stage === 0) arguments_ = { kind: 'state' };
    else if (stage === 1) arguments_ = plan.kind === 'navigate' ? { kind: 'navigate', url: plan.url!, generation: result.generation } : { kind: 'read', generation: result.generation };
    else if (stage === 2 && (plan.kind === 'send' || plan.kind === 'edit')) {
      const target = result.observation?.elements.find((element: { name: string }) => element.name === (plan.kind === 'edit' ? 'message' : 'xhr'));
      if (!target) throw Error('missing_async_target'); arguments_ = { kind: plan.kind === 'edit' ? 'type' : 'click', target: target.id, generation: result.observation.generation, ...(plan.kind === 'edit' ? { value: plan.value! } : {}) };
    }
    stage++;
    yield { type: 'message_complete', message: { type: 'assistant', id: uid(), content: arguments_ ? [{ type: 'tool_call', id: uid(), name: 'protected_browser', arguments: arguments_ }] : [{ type: 'text', text: 'Completed using current protected browser observations.' }] } };
  } };
  const site = { ...website.site, intent(input: Readonly<BrowserInputSnapshot>): BrowserRequest | null {
    if (input.kind !== 'click' || input.url !== website.origin + '/dynamic' || input.target.name !== 'xhr') return null;
    const fields = new Map(input.fields.map(field => [field.name, field.values]));
    if (fields.size !== 2 || fields.size !== input.fields.length || fields.get('recipient')?.length !== 1 || fields.get('message')?.length !== 1) return null;
    return { method: 'POST', url: website.origin + '/dynamic-send', contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyBase64: Buffer.from(new URLSearchParams({ recipient: fields.get('recipient')![0]!, message: fields.get('message')![0]! }).toString()).toString('base64'), navigation: false };
  } };
  const f = await composedFixture('default', false, undefined, options => ({ ...options,
    browser: { ...options.browser!, site, factory: launchProtectedEngine, executablePath: process.env.JIT_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    model: { ...options.model, limits: { ...options.model.limits, turns: 8 }, scripted: () => model },
    disclosure: { ...options.disclosure!, routes: options.disclosure!.routes.map(route => route.id === 'browser' ? { ...route, resolve: (_work, value) => {
      const meaning = site.classify(value as unknown as BrowserRequest, 'general'); return meaning ? [ref('browser_service'), ...(meaning.kind === 'effect' ? meaning.recipients : [])] : null;
    } } : route) },
  }));
  const client = new JitClient({ origin: 'http://localhost:3099', async fetch(request) { const url = new URL(request.url); return f.request(url.pathname + url.search, request.method, request.method === 'POST' ? await request.json() : undefined, Object.fromEntries(request.headers)); } });
  await client.bootstrap(); f.interpretation = { intent: 'execute', purposeId: 'purpose', resourceIds: ['account'], access: 'effect', subject: null };
  const run = async (next: typeof plan) => { plan = next; stage = 0; const command = client.prepareMessage('conversation', 'Complete the selected protected website step'); await client.send(command); await f.service.conversation.drain(); return client.request(command.requestId); };
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: width === 1440 ? 'en-US' : 'th-TH' }), errors: string[] = [], external: string[] = [];
  let disconnect = false, delayFrame = false;
  const slowFrame = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()); if (url.origin !== 'http://localhost:3099') { external.push(url.origin); await route.abort(); return; }
    if (disconnect && url.pathname.includes('/protected-browser')) { await route.abort(); return; }
    if (delayFrame && url.pathname.endsWith('/protected-browser/frame')) { delayFrame = false; slowFrame.entered.resolve(); await slowFrame.release.promise; }
    const response = await f.request(url.pathname + url.search, request.method(), request.method() === 'POST' ? request.postDataJSON() : undefined, { ...request.headers(), host: 'localhost:3099' });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  try {
    const navigation = await run({ kind: 'navigate', url: website.origin + '/login' }); expect(navigation.row.evidence.at(-1)?.content).toContain('"state":"ok"');
    await page.goto('http://localhost:3099/s16/chat/conversation');
    const open = page.getByRole('button', { name: copy['s16.protected.title'], exact: true }); await open.waitFor();
    if (process.env.JIT_S16_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.JIT_S16_SCREENSHOT_DIR}/protected-entry-${width}.png` });
    await open.click();
    const dialog = page.getByRole('dialog', { name: copy['s16.protected.title'] }); await dialog.getByRole('button', { name: copy['s16.protected.takeover'], exact: true }).click();
    await dialog.getByRole('img').waitFor();
    await dialog.getByRole('button', { name: copy['s16.protected.close'], exact: true }).click();
    // Reopening an existing owner view must retain a slow full refresh across a background poll tick.
    await page.clock.install(); delayFrame = true; await open.click(); await slowFrame.entered.promise;
    await page.clock.fastForward(3100); slowFrame.release.resolve(); await page.clock.resume();
    await dialog.getByRole('img').waitFor();
    // Another tab's control discovery must not invalidate this view's already displayed handles.
    await client.protectedBrowserControls((await client.protectedBrowser()).generation);
    for (const field of ['password', 'otp'] as const) {
      const input = dialog.getByLabel(field, { exact: true }); await input.waitFor(); await input.fill(field === 'password' ? website.password() : website.code());
      await input.press('Enter');
      await dialog.getByRole('button', { name: field === 'password' ? 'Sign in' : 'Verify', exact: true }).waitFor();
      await dialog.getByRole('button', { name: field === 'password' ? 'Sign in' : 'Verify', exact: true }).click();
    }
    await dialog.getByRole('img').waitFor();
    await dialog.getByRole('button', { name: copy['s16.protected.return'], exact: true }).waitFor();
    expect(await dialog.locator('input').count()).toBe(0);
    if (process.env.JIT_S16_SCREENSHOT_DIR) await dialog.screenshot({ path: `${process.env.JIT_S16_SCREENSHOT_DIR}/protected-owner-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Disconnect covers the owner view and keeps custody; reconnect never repeats login or hands back.
    disconnect = true; await dialog.getByRole('button', { name: copy['s16.protected.refresh'], exact: true }).click();
    await dialog.getByRole('alert').waitFor(); expect(await dialog.locator('img').count()).toBe(0); expect((await client.protectedBrowser()).login).toBe('owner_control');
    disconnect = false; await dialog.getByRole('button', { name: copy['s16.protected.refresh'], exact: true }).click();
    await dialog.getByRole('img').waitFor();
    await dialog.getByRole('button', { name: copy['s16.protected.return'], exact: true }).click();
    await dialog.getByText(copy['s16.protected.signed_in'], { exact: true }).waitFor();
    await dialog.getByRole('button', { name: copy['s16.protected.close'], exact: true }).click();
    expect(website.attempts()).toEqual({ login: 1, verification: 1 });
    await run({ kind: 'navigate', url: website.origin + '/dynamic' });
    const message = '\u0e17\u0e14\u0e2a\u0e2d\u0e1a + Friday';
    const edited = await run({ kind: 'edit', value: message }); expect(edited.row.evidence.at(-1)?.content).toContain('"state":"ok"');
    const sent = await run({ kind: 'send' }); expect(sent.row.slips[0]?.state).toBe('pending'); expect(website.received.filter(request => request.path === '/dynamic-send')).toHaveLength(0);
    await page.reload();
    const card = page.getByRole('region', { name: copy['s16.card.title.website'] }); await card.waitFor();
    expect(await card.getByText(message, { exact: true }).count()).toBe(1);
    expect(await card.getByText(new URLSearchParams({ recipient: 'team', message }).toString(), { exact: true }).count()).toBe(1);
    if (process.env.JIT_S16_SCREENSHOT_DIR) await card.screenshot({ path: `${process.env.JIT_S16_SCREENSHOT_DIR}/protected-card-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const approve = card.getByRole('button', { name: copy['s16.card.approve'], exact: true }); await approve.focus(); await page.keyboard.press('Enter');
    await f.service.conversation.drain(); await card.waitFor({ state: 'detached' });
    expect(website.received.filter(request => request.path === '/dynamic-send')).toHaveLength(1);
    const other = f.service.policy.owner.admit(f.owner, { requestId: uid(), intent: 'execute', access: 'effect', purpose: ref('purpose'), bot: ref('specialist'), resources: [ref('account')], recipients: [ref('browser_service'), ref('payee'), ref('provider')], selection: f.choice, selectionPin: null, expiresAt: 800000, readLimit: 100 });
    expect(other.work).not.toBeNull(); if (!other.work) throw Error('team_work_not_admitted');
    const work = f.service.browser!.open(f.service.policy.control.bindWork(other.work.id));
    try { expect(work.state().login).toBe('signed_in'); expect((await work.execute({ kind: 'read', generation: work.state().generation })).state).toBe('observed'); } finally { work.release(); }
    const secret = website.password(); expect(prompts.some(prompt => prompt.includes(secret))).toBe(false);
    for (const entry of readdirSync(f.directory, { recursive: true, withFileTypes: true })) if (entry.isFile() && !entry.parentPath.includes('/profiles')) expect(readFileSync(join(entry.parentPath, entry.name)).includes(Buffer.from(secret))).toBe(false);
    expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally { slowFrame.release.resolve(); await context.close(); await f.close(); website.close(); }
}, 120000);
