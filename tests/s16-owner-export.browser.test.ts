import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { composedFixture } from './fixtures/s15-composition';
import { en } from '../src/i18n/en';
import { th } from '../src/i18n/th';

const browserTest = process.env.JIT_S16_BROWSER_TESTS === '1' ? test : test.skip;
let browser: Browser;
beforeAll(async () => { if (process.env.JIT_S16_BROWSER_TESTS === '1') browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--disable-background-networking', '--no-first-run'] }); });
afterAll(async () => { await browser?.close(); });

browserTest.each([1440, 390])('actual export bundle downloads guarded JSON, validates scope, shows empty/errors and clears auth at width %i', async width => {
  const f = await composedFixture(); f.interpretation = { intent: 'answer', purposeId: 'purpose', resourceIds: ['computer'], access: 'read', subject: null }; f.script = [{ type: 'text', text: 'Recorded current fixture reply.' }]; await f.chat('What about current export observations?', 'browser_export_original');
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: width === 1440 ? 'en-US' : 'th-TH' }), copy = width === 1440 ? en : th, errors: string[] = [], external: string[] = [];
  let mode: 'normal' | 'capacity' | 'changed' | 'auth' = 'normal', posts = 0, downloads = 0;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://localhost:3099') { external.push(request.url()); await route.abort(); return; }
    let response: Response;
    if (url.pathname === '/api/s16/client/export') {
      posts++;
      if (mode === 'auth') response = Response.json({ error: 'authentication_required' }, { status: 401 });
      else if (mode !== 'normal') response = Response.json({ error: mode === 'capacity' ? 'owner_export_capacity' : 'owner_export_source_changed' }, { status: mode === 'capacity' ? 413 : 409 });
      else response = await f.request(url.pathname, request.method(), request.postDataJSON(), { ...request.headers(), host: 'localhost:3099' });
    } else response = await f.request(url.pathname + url.search, request.method(), request.method() === 'POST' ? request.postDataJSON() : undefined, { ...request.headers(), host: 'localhost:3099' });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const page = await context.newPage(); page.setDefaultTimeout(7000); let stage = 'page'; page.on('pageerror', error => errors.push(error.message)); page.on('download', () => { downloads++; });
  const open = async () => { if (width === 390) { stage = 'menu'; await page.locator('.menu-toggle').click(); } stage = 'export_button'; await page.getByRole('button', { name: copy['s16.export.title'], exact: true }).click(); stage = 'dialog'; await page.getByRole('dialog', { name: copy['s16.export.title'] }).waitFor(); };
  try {
    await page.goto('http://localhost:3099/s16/chat/conversation');
    await page.locator('.export-entry').waitFor({ state: 'attached' }); await open();
    const dialog = page.getByRole('dialog', { name: copy['s16.export.title'] }); stage = 'heading_focus'; await page.waitForFunction(() => document.activeElement?.id === 'export-title');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.getByRole('checkbox', { name: copy['s16.export.memory'], exact: true }).uncheck(); await dialog.getByRole('checkbox', { name: copy['s16.export.work'], exact: true }).uncheck();
    await page.screenshot({ path: '.local/resolve-issues/429-owner-export-' + width + '.png' });
    const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: copy['s16.export.download'], exact: true }).click()]);
    expect(download.suggestedFilename()).toBe('jit-export.json'); const data = JSON.parse(readFileSync((await download.path())!, 'utf8'));
    expect(data.contract).toBe('s16-owner-export/v1'); expect(data.scope.sections).toEqual(['history']); expect(data.counts).toEqual({ history: 1 }); expect(data.records[0].text).toContain('What about current export observations?'); expect(data.records[0].text).toContain('Recorded current fixture reply.'); expect(data.records[0]).not.toHaveProperty('authority');
    await dialog.getByText(copy['s16.export.ready'], { exact: true }).waitFor(); expect(posts).toBe(1);
    await dialog.getByLabel(copy['s16.export.from'], { exact: true }).fill('2030-01-01'); await dialog.getByRole('button', { name: copy['s16.export.download'], exact: true }).click(); await dialog.getByText(copy['s16.export.empty'], { exact: true }).waitFor(); expect(downloads).toBe(1);
    await dialog.getByLabel(copy['s16.export.from'], { exact: true }).fill(''); await dialog.getByRole('checkbox', { name: copy['s16.export.history'], exact: true }).uncheck(); const beforeInvalid = posts; await dialog.getByRole('button', { name: copy['s16.export.download'], exact: true }).click(); await dialog.getByRole('alert').getByText(copy['s16.export.selection'], { exact: true }).waitFor(); expect(posts).toBe(beforeInvalid);
    await dialog.getByRole('checkbox', { name: copy['s16.export.history'], exact: true }).check(); mode = 'capacity'; await dialog.getByRole('button', { name: copy['s16.export.download'], exact: true }).click(); await dialog.getByRole('alert').getByText(copy['s16.export.capacity'], { exact: true }).waitFor();
    mode = 'changed'; await dialog.getByRole('button', { name: copy['s16.export.download'], exact: true }).click(); await dialog.getByRole('alert').getByText(copy['s16.export.changed'], { exact: true }).waitFor(); expect(downloads).toBe(1);
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' }); await page.waitForFunction(() => document.activeElement?.classList.contains('export-entry') || document.activeElement?.classList.contains('menu-toggle'));
    await open(); mode = 'auth'; await page.getByRole('dialog').getByRole('button', { name: copy['s16.export.download'], exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' });
    expect(await page.getByRole('button', { name: copy['s16.export.title'], exact: true }).count()).toBe(0); expect(await page.locator('.message').count()).toBe(0); expect(downloads).toBe(1); expect(errors).toEqual([]); expect(external).toEqual([]);
  } catch (error) {
    await page.screenshot({ path: '.local/resolve-issues/429-owner-export-failure-' + width + '.png' }).catch(() => {});
    const state = await page.evaluate(() => ({ active: document.activeElement?.tagName, id: document.activeElement?.id, classes: document.activeElement?.className, app: document.querySelector('.s16-app')?.className, dialog: document.querySelector('dialog')?.open })).catch(() => null);
    writeFileSync('.local/resolve-issues/429-owner-export-failure-' + width + '.json', JSON.stringify({ stage, state, errors, external, error: error instanceof Error ? error.message : 'unknown' }));
    throw error;
  } finally { await context.close(); await f.close(); }
}, 30000);
