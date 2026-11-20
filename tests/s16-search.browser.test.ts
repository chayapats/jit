import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import { composedFixture } from './fixtures/s15-composition';
import { en } from '../src/i18n/en';
import { th } from '../src/i18n/th';

const browserTest = process.env.JIT_S16_BROWSER_TESTS === '1' ? test : test.skip;
let browser: Browser;
beforeAll(async () => { if (process.env.JIT_S16_BROWSER_TESTS === '1') browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--disable-background-networking', '--no-first-run'] }); });
afterAll(async () => { await browser?.close(); });

browserTest.each([1440, 390])('actual search bundle: filters, labels, response loss/restart, keyboard, old source, withdrawal and empty state at %i', async width => {
  const f = await composedFixture(); f.script = [{ type: 'text', text: 'Recorded observation.' }];
  f.interpretation = { intent: 'answer', purposeId: 'purpose', resourceIds: ['computer'], access: 'read', subject: null };
  for (let index = 0; index < 35; index++) { f.advance(1); await f.chat(`What about telescope observation ${index}?`, `history_${index}`); }
  await f.chat('I prefer concise replies.', 'memory_search');
  const preference = f.service.memory.view(f.owner).claims.find(claim => claim.text === 'I prefer concise replies.')!;
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: width === 1440 ? 'en-US' : 'th-TH' });
  const copy = width === 1440 ? en : th, errors: string[] = [], external: string[] = [];
  let loseLabels = false, labelPosts = 0, offlineBlock = false, serving = f, replacement: typeof f | null = null; const labelIds: string[] = [], reads: string[] = [], replies: { path: string; status: number }[] = [], failed: { path: string; code: string | null }[] = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()); reads.push(url.pathname);
    if (url.origin !== 'http://localhost:3099') { external.push(request.url()); await route.abort(); return; }
    if (offlineBlock) { await route.abort('internetdisconnected'); return; }
    const response = await serving.request(url.pathname + url.search, request.method(), request.method() === 'POST' ? request.postDataJSON() : undefined, { ...request.headers(), host: 'localhost:3099' });
    replies.push({ path: url.pathname, status: response.status });
    if (request.method() === 'POST' && url.pathname.endsWith('/search/labels')) { labelPosts++; labelIds.push(request.postDataJSON().requestId); if (loseLabels) { loseLabels = false; await route.abort('failed'); return; } }
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.on('requestfailed', request => failed.push({ path: new URL(request.url()).pathname, code: request.failure()?.errorText ?? null }));
  const countText = (count: number) => copy['s16.search.count'].replace('{count}', String(count));
  try {
    await page.goto('http://localhost:3099/s16/search');
    const query = page.getByRole('searchbox', { name: copy['s16.search.query'] }); await query.waitFor();
    await page.getByText(countText(37), { exact: true }).waitFor();
    expect(await query.evaluate(element => element === document.activeElement)).toBe(true);
    await query.fill('telescope'); await page.getByLabel(copy['s16.search.type'], { exact: true }).selectOption('history'); await query.press('Enter');
    await page.getByText(countText(35), { exact: true }).waitFor();
    expect(await page.locator('.search-result').count()).toBe(25);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.local/resolve-issues/428-search-${width}.png` });
    const first = page.locator('.search-result').first();
    await first.getByRole('button', { name: copy['s16.search.editFor'].replace('{title}', 'What about telescope observation 34?'), exact: true }).click();
    await first.getByRole('textbox', { name: copy['s16.search.edit'], exact: true }).fill('Ready');
    loseLabels = true; await first.getByRole('button', { name: copy['s16.search.save'], exact: true }).click();
    await page.getByText(copy['s16.search.unknown'], { exact: true }).waitFor();
    expect(labelPosts).toBe(1);
    offlineBlock = true; await context.setOffline(true);
    await page.locator('.search-page').waitFor({ state: 'detached' });
    expect(await page.locator('.search-result').count()).toBe(0);
    // Restart the service while all browser reads are held offline; reconnect only after composition ends.
    await f.reopen();
    offlineBlock = false; await context.setOffline(false);
    await page.getByText(countText(37), { exact: true }).waitFor();
    await page.getByText(copy['s16.search.unknown'], { exact: true }).waitFor();
    await page.getByRole('button', { name: copy['s16.search.check'], exact: true }).click();
    await page.locator('.search-label').getByText('Ready', { exact: true }).waitFor(); expect(labelPosts).toBe(1);
    expect(f.service.conversation.store.db.query<{ n: number }, []>('SELECT count(*) AS n FROM search_label_commands').get()!.n).toBe(1);
    const labelled = page.locator('.search-result').filter({ has: page.getByRole('button', { name: 'What about telescope observation 34?', exact: true }) });
    const editLabel = copy['s16.search.editFor'].replace('{title}', 'What about telescope observation 34?');
    await labelled.getByRole('button', { name: editLabel, exact: true }).click();
    await labelled.getByRole('textbox', { name: copy['s16.search.edit'], exact: true }).fill('Sales, APAC\nReady');
    await labelled.getByRole('button', { name: copy['s16.search.save'], exact: true }).click();
    await labelled.locator('.search-label').getByText('Sales, APAC', { exact: true }).waitFor();
    await labelled.getByRole('button', { name: editLabel, exact: true }).click();
    expect((await labelled.getByRole('textbox', { name: copy['s16.search.edit'], exact: true }).inputValue()).split('\n')).toContain('Sales, APAC');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.local/resolve-issues/428-search-labels-${width}.png` });
    await labelled.getByRole('button', { name: copy['s16.search.save'], exact: true }).click();
    await labelled.locator('.search-label-editor').waitFor({ state: 'detached' });
    await labelled.locator('.search-label').getByText('Sales, APAC', { exact: true }).waitFor(); expect(await labelled.locator('.search-label').allTextContents()).toEqual(['Sales, APAC', 'Ready']); expect(labelPosts).toBe(3);
    await page.getByRole('button', { name: copy['s16.search.next'], exact: true }).click();
    const old = page.locator('.search-results').getByRole('button', { name: 'What about telescope observation 0?', exact: true }); await old.waitFor(); await old.focus(); await page.keyboard.press('Enter');
    await page.locator('#request-history_0').waitFor({ timeout: 6000 }); expect(page.url()).toContain('/s16/chat/conversation');
    await page.keyboard.press('Control+k'); await query.waitFor();
    await query.fill('concise'); await page.getByLabel(copy['s16.search.type'], { exact: true }).selectOption('memory'); await query.press('Enter');
    await page.getByText(countText(1), { exact: true }).waitFor();
    f.service.memory.command(f.owner, { contract: 's15-memory-command/v1', requestId: 'browser_forget_search', kind: 'memory.forget', claim: { id: preference.id, revision: preference.revision } });
    await page.locator('.search-heading').getByRole('button', { name: copy['s16.common.refresh'], exact: true }).click();
    await page.getByText(copy['s16.search.empty'], { exact: true }).waitFor(); await page.getByText(countText(0), { exact: true }).waitFor();
    expect(await page.locator('.search-results').innerText()).not.toContain('concise');
    // A new authenticated binding never receives the prior binding's unresolved command or its label text.
    await query.fill('telescope'); await page.getByLabel(copy['s16.search.type'], { exact: true }).selectOption('history'); await query.press('Enter'); await page.getByText(countText(35), { exact: true }).waitFor();
    await page.locator('.search-result').first().getByRole('button', { name: editLabel, exact: true }).click();
    await page.locator('.search-label-editor').getByRole('textbox').fill('Private pending label'); loseLabels = true;
    await page.getByRole('button', { name: copy['s16.search.save'], exact: true }).click(); await page.getByText(copy['s16.search.unknown'], { exact: true }).waitFor(); const foreignCommand = labelIds.at(-1)!;
    offlineBlock = true; await context.setOffline(true); await page.locator('.search-page').waitFor({ state: 'detached' });
    replacement = await composedFixture(); serving = replacement;
    offlineBlock = false; await context.setOffline(false); await page.getByText(countText(0), { exact: true }).waitFor();
    expect(await page.getByRole('button', { name: copy['s16.search.check'], exact: true }).count()).toBe(0); expect(reads).not.toContain('/api/s16/client/search/commands/' + foreignCommand); expect(labelPosts).toBe(4);
    expect(await page.locator('body').innerText()).not.toContain('Private pending label');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => /search/i.test(key)))).toEqual([]);
    expect(errors).toEqual([]); expect(external).toEqual([]);
  } catch (error) {
    writeFileSync(`.local/resolve-issues/428-search-failure-${width}.json`, JSON.stringify({ url: page.url(), reads, replies, failed, errors, body: await page.locator('body').innerText(), ids: await page.locator('[id^="request-"]').evaluateAll(elements => elements.map(element => element.id)) }, null, 2));
    await page.screenshot({ path: `.local/resolve-issues/428-search-failure-${width}.png` }); throw error;
  } finally { await context.close(); await f.close(); await replacement?.close(); }
}, 60000);
