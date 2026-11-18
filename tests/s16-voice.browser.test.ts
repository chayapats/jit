import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { composedFixture } from './fixtures/s15-composition';
import type { LocalVoiceConfig, LocalVoiceEngine } from '../src/s16/voice/local';
import { encodeCaptureWav } from '../src/s16/voice/wav';
import { en } from '../src/i18n/en';
import { th } from '../src/i18n/th';

// Real Chrome capture, AudioWorklet, React and composed HTTP ports; speech/model/VM are controlled fixtures.
// Fake media flags never open the owner's microphone or play sound. This is not physical-device acceptance.
const browserTest = process.env.JIT_S16_BROWSER_TESTS === '1' ? test : test.skip;
let browser: Browser;
beforeAll(async () => { if (process.env.JIT_S16_BROWSER_TESTS === '1') browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] }); });
afterAll(async () => { await browser?.close(); }, 30000);
const artifact = { path: '/fixture/local-voice', sha256: 'f'.repeat(64) };
const local: LocalVoiceConfig = { transcription: { executable: artifact, model: artifact, language: 'auto' }, synthesis: { kind: 'espeak', executable: artifact, voice: 'en' }, timeoutMs: 5000 };
async function fixture() {
  let transcriptions = 0, syntheses = 0, available = true, duration = 0;
  const engine: LocalVoiceEngine = { async available() { return available; }, async transcribe(bytes, context) { context.guard(); context.started(); transcriptions++; duration = (bytes.length - 44) / 32; return 'Approve this draft only.'; }, async synthesize(_text, context) { context.guard(); context.started(); syntheses++; return { wav: encodeCaptureWav(new Float32Array(16000 * 8)), durationMs: 8000 }; }, async close() {} };
  const f = await composedFixture('default', false, undefined, o => ({ ...o, voice: { local, quota: { dailyMs: 120000, captureMs: 30000 }, engine: async () => engine } }));
  return { f, get transcriptions() { return transcriptions; }, get syntheses() { return syntheses; }, get duration() { return duration; }, set available(value: boolean) { available = value; } };
}
async function wire(page: Page, f: Awaited<ReturnType<typeof composedFixture>>, language: string) {
  const external: string[] = [], errors: string[] = []; let revoked = false;
  const holds: { path: string; stage: 'before' | 'after'; entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> }[] = [], releases: (() => void)[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.error('Chrome:', message.text()); });
  // Chrome's AudioWorklet fetch is not intercepted by Playwright routing. Serve the real module over HTTP.
  const server = Bun.serve({ hostname: '127.0.0.1', port: 3099, async fetch(request) {
    const url = new URL(request.url), headers = { ...Object.fromEntries(request.headers), 'accept-language': language, ...(revoked ? { cookie: 'jit_s14=revoked_fixture' } : {}) };
    const index = holds.findIndex(hold => hold.path === url.pathname), hold = index < 0 ? undefined : holds.splice(index, 1)[0];
    if (hold?.stage === 'before') { hold.entered.resolve(); await hold.release.promise; }
    const response = request.headers.get('content-type') === 'application/octet-stream'
      ? await f.raw(url.pathname, await request.arrayBuffer(), headers)
      : await f.request(url.pathname + url.search, request.method, request.method === 'POST' ? await request.json() : undefined, headers);
    if (request.method === 'POST' && /\/messages$/.test(url.pathname)) await f.service.conversation.drain();
    if (hold?.stage === 'after') { hold.entered.resolve(); await hold.release.promise; }
    return response;
  } });
  await page.context().route('**/*', async route => {
    if (new URL(route.request().url()).origin !== 'http://localhost:3099') { external.push(route.request().url()); await route.abort(); return; }
    await route.continue();
  });
  // Keep actual native streams observable; denial/delay below are explicit controlled lifecycle cases.
  await page.addInitScript(() => {
    const state = { calls: 0, mode: 'native', tracks: [] as MediaStreamTrack[], release: null as (() => void) | null };
    Object.assign(window, { voiceTest: state });
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      state.calls++;
      if (state.mode === 'deny') throw new DOMException('Controlled denial', 'NotAllowedError');
      const stream = await original(constraints); state.tracks.push(...stream.getTracks());
      if (state.mode === 'delay') await new Promise<void>(resolve => { state.release = resolve; });
      return stream;
    };
  });
  return { observed: { errors, external }, close: () => { for (const release of releases) release(); return server.stop(true); }, revoke() { revoked = true; },
    hold(path: string, stage: 'before' | 'after') { const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); holds.push({ path, stage, entered, release }); releases.push(() => release.resolve()); return { entered: entered.promise, release: () => release.resolve() }; } };
}
const stopped = (page: Page) => page.waitForFunction(() => (window as unknown as { voiceTest: { tracks: MediaStreamTrack[] } }).voiceTest.tracks.every(track => track.readyState === 'ended'));
const requests = (f: Awaited<ReturnType<typeof composedFixture>>) => f.service.conversation.store.db.query<{ n: number }, []>('SELECT count(*) AS n FROM requests').get()!.n;

browserTest('late permission and automatic recording stop leave time to submit the completed native clip', async () => {
  const h = await fixture(), { f } = h, context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(15000);
  const { observed, close } = await wire(page, f, 'en');
  try {
    await page.clock.install(); await page.goto('http://localhost:3099/s16/chat/conversation');
    await page.evaluate(() => { (window as unknown as { voiceTest: { mode: string } }).voiceTest.mode = 'delay'; });
    await page.getByRole('button', { name: en['s16.voice.dictate'], exact: true }).click();
    await page.waitForFunction(() => !!(window as unknown as { voiceTest: { release: unknown } }).voiceTest.release);
    // Fake wall clocks model permission taking longer than the original 15-second allowance.
    f.advance(20000); await page.clock.fastForward(20000);
    await page.evaluate(() => { (window as unknown as { voiceTest: { release: () => void } }).voiceTest.release(); });
    await page.getByRole('button', { name: en['s16.voice.stop'], exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.voice-recording output')?.textContent === '00:01');
    f.advance(26000); await page.clock.fastForward(26000);
    const draft = page.getByLabel(en['s16.voice.transcript'], { exact: true }); await draft.waitFor(); await stopped(page);
    expect(await draft.inputValue()).toBe('Approve this draft only.'); expect(h.transcriptions).toBe(1); expect(requests(f)).toBe(0);
    expect(h.duration).toBeGreaterThanOrEqual(1000); expect(h.duration).toBeLessThanOrEqual(30000); expect(observed).toEqual({ errors: [], external: [] });
  } finally { await context.close(); await close(); await f.close(); }
}, 90000);

browserTest('an expired recording receipt never opens a microphone permission prompt', async () => {
  const h = await fixture(), { f } = h, context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(15000);
  const { observed, close, hold } = await wire(page, f, 'en');
  try {
    await page.clock.install(); await page.goto('http://localhost:3099/s16/chat/conversation');
    const reservation = hold('/api/s16/client/conversations/conversation/voice/captures', 'after');
    await page.getByRole('button', { name: en['s16.voice.dictate'], exact: true }).click(); await reservation.entered;
    f.advance(46000); await page.clock.fastForward(46000); reservation.release();
    await page.getByText(en['s16.voice.failed'], { exact: true }).waitFor();
    expect(await page.evaluate(() => (window as unknown as { voiceTest: { calls: number } }).voiceTest.calls)).toBe(0);
    expect(h.transcriptions).toBe(0); expect(requests(f)).toBe(0); expect(observed).toEqual({ errors: [], external: [] });
  } finally { await context.close(); await close(); await f.close(); }
}, 90000);

browserTest('a pending recording health read cannot discard a completed editable transcript', async () => {
  const h = await fixture(), { f } = h, context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(15000);
  const { observed, close, hold } = await wire(page, f, 'en');
  try {
    await page.clock.install(); await page.goto('http://localhost:3099/s16/chat/conversation');
    await page.getByRole('button', { name: en['s16.voice.dictate'], exact: true }).click(); await page.getByRole('button', { name: en['s16.voice.stop'], exact: true }).waitFor();
    const health = hold('/api/s16/client/voice', 'before'); f.advance(2100); await page.clock.fastForward(2100); await health.entered;
    await page.waitForFunction(() => document.querySelector('.voice-recording output')?.textContent === '00:01');
    await page.getByRole('button', { name: en['s16.voice.stop'], exact: true }).click();
    const draft = page.getByLabel(en['s16.voice.transcript'], { exact: true }); await draft.waitFor(); h.available = false; health.release();
    await page.getByText(en['s16.voice.unavailable'], { exact: true }).waitFor();
    expect(await draft.inputValue()).toBe('Approve this draft only.');
    await page.getByRole('button', { name: en['s16.voice.useText'], exact: true }).click();
    expect(await page.getByLabel(en['s16.chat.prompt'], { exact: true }).inputValue()).toBe('Approve this draft only.');
    expect(requests(f)).toBe(0); expect(observed).toEqual({ errors: [], external: [] });
  } finally { await context.close(); await close(); await f.close(); }
}, 90000);

browserTest.each([1440, 390])('actual voice capture/edit/Send/playback at width %i', async width => {
  const h = await fixture(), { f } = h, copy = width === 1440 ? en : th;
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: width === 1440 ? 'en-US' : 'th-TH' }), page = await context.newPage(); page.setDefaultTimeout(15000);
  const { observed, close } = await wire(page, f, width === 1440 ? 'en' : 'th');
  try {
    await page.goto('http://localhost:3099/s16/chat/conversation');
    const controls = page.getByRole('region', { name: copy['s16.voice.title'], exact: true }), dictate = controls.getByRole('button', { name: copy['s16.voice.dictate'], exact: true });
    await dictate.waitFor(); expect(await page.evaluate(() => (window as unknown as { voiceTest: { calls: number } }).voiceTest.calls)).toBe(0);
    const message = page.getByLabel(copy['s16.chat.prompt'], { exact: true }); await message.fill('Existing text.');
    await dictate.click(); await controls.getByRole('button', { name: copy['s16.voice.stop'], exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.voice-recording output')?.textContent === '00:01');
    expect(requests(f)).toBe(0); expect(f.modelPrompts).toEqual([]);
    await controls.getByRole('button', { name: copy['s16.voice.stop'], exact: true }).click();
    const transcript = controls.getByLabel(copy['s16.voice.transcript'], { exact: true }); await transcript.waitFor(); await stopped(page);
    expect(await transcript.inputValue()).toBe('Approve this draft only.'); expect(requests(f)).toBe(0); expect(h.duration).toBeGreaterThanOrEqual(1000); expect(h.duration).toBeLessThanOrEqual(30000);
    await transcript.fill('Edited ordinary message.'); await controls.getByRole('button', { name: copy['s16.voice.useText'], exact: true }).click();
    expect(await message.inputValue()).toBe('Existing text.\nEdited ordinary message.'); expect(requests(f)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.JIT_S16_SCREENSHOTS) await page.screenshot({ path: `${process.env.JIT_S16_SCREENSHOTS}/voice-composer-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: copy['s16.chat.send'], exact: true }).click();
    const listen = page.getByRole('button', { name: copy['s16.voice.listen'], exact: true }); await listen.waitFor();
    expect(requests(f)).toBe(1); expect(h.transcriptions).toBe(1);
    await listen.focus(); await page.keyboard.press('Enter');
    await controls.getByText(copy['s16.voice.playing'], { exact: true }).waitFor(); expect(h.syntheses).toBe(1);
    await controls.getByRole('button', { name: copy['s16.voice.interrupt'], exact: true }).click();
    expect(await page.evaluate(() => document.querySelector('.voice-playing') === null)).toBe(true); expect(requests(f)).toBe(1);
    await listen.click(); await controls.getByText(copy['s16.voice.playing'], { exact: true }).waitFor(); h.available = false;
    await controls.getByText(copy['s16.voice.unavailable'], { exact: true }).waitFor();
    expect(await page.evaluate(() => document.querySelector('.voice-playing') === null)).toBe(true); expect(requests(f)).toBe(1);
    h.available = true; await page.getByRole('button', { name: copy['s16.common.refresh'], exact: true }).click();
    await dictate.click(); await controls.getByRole('button', { name: copy['s16.voice.stop'], exact: true }).waitFor();
    await controls.getByRole('button', { name: copy['s16.voice.cancel'], exact: true }).click(); await stopped(page);
    expect(requests(f)).toBe(1); expect(h.transcriptions).toBe(1); expect(await transcript.count()).toBe(0);
    expect(observed).toEqual({ errors: [], external: [] });
  } catch (error) { console.error('Voice UI failure:', await page.locator('.voice-controls').textContent(), await page.evaluate(() => (window as unknown as { voiceTest: unknown }).voiceTest), observed); throw error; }
  finally { await context.close(); await close(); await f.close(); }
}, 90000);

browserTest('denial, local route loss, delayed permission and navigation keep text usable without adopting late media', async () => {
  const h = await fixture(), { f } = h, context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(15000);
  const { observed, close } = await wire(page, f, 'en');
  try {
    await page.goto('http://localhost:3099/s16/chat/conversation');
    const message = page.getByLabel(en['s16.chat.prompt'], { exact: true }), dictate = page.getByRole('button', { name: en['s16.voice.dictate'], exact: true });
    await message.fill('Keep this typed draft.'); await page.evaluate(() => { (window as unknown as { voiceTest: { mode: string } }).voiceTest.mode = 'deny'; });
    await dictate.click(); await page.getByText(en['s16.voice.permissionDenied'], { exact: true }).waitFor();
    expect(await message.inputValue()).toBe('Keep this typed draft.'); expect(requests(f)).toBe(0);
    h.available = false; await dictate.click(); await page.getByText(en['s16.voice.unavailable'], { exact: true }).waitFor();
    expect(await message.isEnabled()).toBe(true); expect(await message.inputValue()).toBe('Keep this typed draft.');
    h.available = true; await page.reload(); await message.fill('Before navigation.');
    await page.evaluate(() => { (window as unknown as { voiceTest: { mode: string } }).voiceTest.mode = 'delay'; });
    await dictate.click(); await page.waitForFunction(() => !!(window as unknown as { voiceTest: { release: unknown } }).voiceTest.release);
    await page.locator('.rail > button').first().click();
    await page.evaluate(() => { (window as unknown as { voiceTest: { release: () => void } }).voiceTest.release(); }); await stopped(page);
    expect(await message.inputValue()).toBe(''); expect(await page.locator('.voice-recording,.voice-draft').count()).toBe(0); expect(h.transcriptions).toBe(0); expect(requests(f)).toBe(0);
    expect(observed).toEqual({ errors: [], external: [] });
  } finally { await context.close(); await close(); await f.close(); }
}, 90000);

browserTest('unusable native capture stops every track; session revocation clears the private voice draft', async () => {
  const h = await fixture(), { f } = h, context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(15000);
  const { observed, close, revoke } = await wire(page, f, 'en');
  try {
    await page.goto('http://localhost:3099/s16/chat/conversation');
    const message = page.getByLabel(en['s16.chat.prompt'], { exact: true }), dictate = page.getByRole('button', { name: en['s16.voice.dictate'], exact: true });
    await message.fill('Typed text survives device loss.'); await dictate.click(); await page.getByRole('button', { name: en['s16.voice.stop'], exact: true }).waitFor();
    // Controlled native-track event exercises revocation cleanup; physical permission UI is #431.
    await page.evaluate(() => { (window as unknown as { voiceTest: { tracks: MediaStreamTrack[] } }).voiceTest.tracks.at(-1)!.dispatchEvent(new Event('mute')); });
    await page.getByText(en['s16.voice.permissionDenied'], { exact: true }).waitFor(); await stopped(page);
    expect(await message.inputValue()).toBe('Typed text survives device loss.'); expect(h.transcriptions).toBe(0);
    await dictate.click(); await page.getByRole('button', { name: en['s16.voice.stop'], exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.voice-recording output')?.textContent === '00:01');
    await page.getByRole('button', { name: en['s16.voice.stop'], exact: true }).click(); await page.getByLabel(en['s16.voice.transcript'], { exact: true }).waitFor();
    revoke();
    await page.getByRole('button', { name: en['s16.common.refresh'], exact: true }).click();
    await page.getByText(en['s16.common.authenticationRequired'], { exact: true }).waitFor();
    expect(await page.locator('.voice-draft,.voice-recording,.voice-playing').count()).toBe(0); expect(requests(f)).toBe(0); await stopped(page);
    expect(observed.errors).toEqual([]); expect(observed.external).toEqual([]);
  } finally { await context.close(); await close(); await f.close(); }
}, 90000);
