import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';
import { workingStateFixture } from './fixtures/s16-working-state';
import { en } from '../src/i18n/en';
import { th } from '../src/i18n/th';

// Real React/client/API/POLICY/TEAM/DATA15 with scripted guest/VMM protocols, not native Linux/KVM proof.
const browserTest = process.env.JIT_S16_BROWSER_TESTS === '1' ? test : test.skip;
let browser: Browser;
beforeAll(async () => { if (process.env.JIT_S16_BROWSER_TESTS === '1') browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true }); });
afterAll(async () => { await browser?.close(); }, 30000);

browserTest.each([1440, 390])('actual reviewed recovery, original response-loss check and reconnect history at width %i', async width => {
  const { f, client, source } = await workingStateFixture(), workId = await source(), copy = width === 1440 ? en : th;
  const context = await browser.newContext({ viewport: { width, height: 1100 }, locale: width === 1440 ? 'en-US' : 'th-TH', timezoneId: 'Asia/Bangkok' });
  const external: string[] = [], errors: string[] = []; let loseImportReply = width === 390;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()); if (url.origin !== 'http://localhost:3099') { external.push(url.origin); await route.abort(); return; }
    const response = await f.request(url.pathname + url.search, request.method(), request.method() === 'POST' ? request.postDataJSON() : undefined, { ...request.headers(), host: 'localhost:3099' });
    if (loseImportReply && request.method() === 'POST' && url.pathname.endsWith('/working-state/imports')) { loseImportReply = false; await route.abort('failed'); return; }
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto('http://localhost:3099/s16/computers');
    await page.getByRole('heading', { name: copy['s16.workingState.title'], exact: true }).waitFor();
    await page.getByLabel(copy['s16.workingState.source'], { exact: true }).selectOption(workId);
    await page.getByLabel(copy['s16.workingState.paths'], { exact: true }).fill('result.txt\nsrc/note.md');
    await page.getByRole('button', { name: copy['s16.workingState.capture'], exact: true }).focus(); await page.keyboard.press('Enter');
    const review = page.getByRole('heading', { name: copy['s16.workingState.review'], exact: true }); await review.waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'working-state-review');
    expect(await review.evaluate(element => element === document.activeElement)).toBe(true);
    await page.getByText('result.txt', { exact: true }).waitFor(); await page.getByText('src/note.md', { exact: true }).waitFor();
    const before = await client.workingState(); expect(before.packages).toHaveLength(1); expect(before.imports).toHaveLength(0);
    await page.getByLabel(copy['s16.workingState.destination'], { exact: true }).selectOption('vm2');
    await page.getByRole('button', { name: copy['s16.workingState.recover'], exact: true }).click();
    if (width === 390) { const check = page.getByRole('button', { name: copy['s16.workingState.checkImport'], exact: true }); await check.waitFor(); const commits = f.vmCalls.filter(op => op === 'portable_commit').length; await check.click(); await page.getByRole('status').filter({ hasText: copy['s16.workingState.complete'] }).waitFor(); expect(f.vmCalls.filter(op => op === 'portable_commit').length).toBe(commits); }
    else await page.getByRole('status').filter({ hasText: copy['s16.workingState.complete'] }).waitFor();
    const result = (await client.workingState()).imports[0]!; expect(result.state).toBe('committed'); expect(f.files.get(result.path + '/result.txt')).toEqual(Buffer.from('portable result\n')); expect(f.files.get(result.path + '/src/note.md')).toEqual(Buffer.from('reviewed note\n')); expect(f.service.vmPool.holder(workId)).toBe('vm');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // Reconnect reads the stored original receipt; it creates neither another workspace nor another transfer.
    const writes = f.vmCalls.length; await page.reload(); await page.getByText(copy['s16.workingState.history'], { exact: true }).click();
    const history = page.getByLabel(copy['s16.workingState.history'], { exact: true }); await history.getByText(copy['s16.workingState.complete'], { exact: true }).waitFor(); await history.getByText(result.path!, { exact: true }).waitFor(); expect(f.vmCalls.length).toBe(writes);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); expect(errors).toEqual([]); expect(external).toEqual([]);
    mkdirSync('.local/resolve-issues', { recursive: true }); await page.screenshot({ path: `.local/resolve-issues/427-working-state-${width}.png`, fullPage: true });
  } finally { await context.close(); await f.close(); }
}, 60000);
