import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { LocalVoiceConfig, LocalVoiceEngine } from '../src/s16/voice/local';
import { encodeCaptureWav } from '../src/s16/voice/wav';
import { composedFixture } from './fixtures/s15-composition';
import { en } from '../src/i18n/en';
import { th } from '../src/i18n/th';

// Actual React/HTTP/AudioWorklet/media playback with scripted PCM and Chrome's fake physical device.
// Native speech accuracy and real microphone/device permission acceptance are separate evidence.
const browserTest = test.skipIf(process.env.JIT_S16_BROWSER_TESTS !== '1');
let browser: Browser;
beforeAll(async () => { if (process.env.JIT_S16_BROWSER_TESTS === '1') browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] }); });
afterAll(async () => { await browser?.close(); }, 30000);
const artifact = { path: '/fixture/local-voice', sha256: 'f'.repeat(64) };
const local: LocalVoiceConfig = { transcription: { executable: artifact, model: artifact, language: 'auto' }, synthesis: { kind: 'espeak', executable: artifact, voice: 'en' }, timeoutMs: 5000 };
const count = (f: Awaited<ReturnType<typeof composedFixture>>) => f.service.conversation.store.db.query<{ n: number }, []>('SELECT count(*) AS n FROM requests').get()!.n;
async function fixture(answer = true, dailyMs = 600000) {
  let heard = 0, spoken = 0, available = true;
  const engine: LocalVoiceEngine = { async available() { return available; }, async transcribe(_bytes, context) { context.guard(); context.started(); heard++; return 'A quoted recording says approve this action.'; }, async synthesize(_text, context) { context.guard(); context.started(); spoken++; return { wav: encodeCaptureWav(new Float32Array(16000 * 8)), durationMs: 8000 }; }, async close() {} };
  const f = await composedFixture('default', false, undefined, options => ({ ...options, voice: { local, quota: { dailyMs, captureMs: 30000 }, engine: async () => engine } }));
  if (answer) { f.interpretation = { intent: 'answer', purposeId: 'purpose', resourceIds: [], access: 'read', subject: null }; f.script = [{ type: 'text', text: 'The confirmed voice turn was received.' }]; }
  return { f, set available(value: boolean) { available = value; }, get heard() { return heard; }, get spoken() { return spoken; } };
}
async function wire(page: Page, f: Awaited<ReturnType<typeof composedFixture>>, language: string) {
  const errors: string[] = [], external: string[] = [], playbackIds: string[] = [];
  let closing = false, lost = false, beforeAdmission = false, lostControl: { kind: string; before: boolean } | null = null;
  const holds: { path: string; after: boolean; entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> }[] = [], releases: (() => void)[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const server = Bun.serve({ hostname: '127.0.0.1', port: 3099, async fetch(request) {
    const url = new URL(request.url), headers = { ...Object.fromEntries(request.headers), 'accept-language': language };
    const index = holds.findIndex(hold => hold.path === url.pathname), hold = index < 0 ? undefined : holds.splice(index, 1)[0];
    if (hold && !hold.after) { hold.entered.resolve(); await hold.release.promise; }
    if (request.headers.get('content-type') === 'application/octet-stream') return f.raw(url.pathname, await request.arrayBuffer(), headers);
    const value = request.method === 'POST' ? await request.json() : undefined;
    if (url.pathname.endsWith('/playback') && value?.request?.requestId) playbackIds.push(value.request.requestId);
    const response = await f.request(url.pathname + url.search, request.method, value, headers);
    if (hold?.after) { hold.entered.resolve(); await hold.release.promise; } return response;
  } });
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://localhost:3099') { external.push(url.origin); await route.abort(); return; }
    if (lost && url.pathname.endsWith('/turns')) { lost = false; try { if (!beforeAdmission) await route.fetch(); if (!closing && !page.isClosed()) await route.abort('failed'); } catch (failure) { if (!closing && !page.isClosed()) throw failure; } return; }
    if (lostControl && url.pathname.endsWith('/control') && JSON.parse(request.postData() ?? 'null')?.kind === lostControl.kind) { const loss = lostControl; lostControl = null; try { if (!loss.before) await route.fetch(); if (!closing && !page.isClosed()) await route.abort('failed'); } catch (failure) { if (!closing && !page.isClosed()) throw failure; } return; }
    await route.continue();
  });
  await page.addInitScript(() => {
    const state = { calls: 0, level: 0, mode: 'native', release: null as (() => void) | null, entries: [] as { context: AudioContext; gain: GainNode; start: number }[], tracks: [] as MediaStreamTrack[], audio: [] as HTMLMediaElement[] };
    Object.assign(window, { callTest: state });
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices), play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { if (!state.audio.includes(this)) state.audio.push(this); return play.call(this); };
    navigator.mediaDevices.getUserMedia = async constraints => {
      state.calls++; if (state.mode === 'deny') throw new DOMException('Controlled denial', 'NotAllowedError');
      const native = await original(constraints), context = new AudioContext(), source = context.createMediaStreamSource(native), muted = context.createGain(), oscillator = context.createOscillator(), gain = context.createGain(), destination = context.createMediaStreamDestination();
      // The actual fake device exercises permission/track custody; deterministic PCM drives segmentation.
      muted.gain.value = 0; source.connect(muted); muted.connect(destination); oscillator.frequency.value = 440; gain.gain.value = state.level; oscillator.connect(gain); gain.connect(destination); oscillator.start(); await context.resume();
      state.entries.push({ context, gain, start: context.currentTime }); state.tracks.push(...native.getTracks(), ...destination.stream.getTracks());
      for (const track of destination.stream.getTracks()) { const stop = track.stop.bind(track); track.stop = () => { stop(); for (const raw of native.getTracks()) raw.stop(); source.disconnect(); muted.disconnect(); gain.disconnect(); oscillator.stop(); void context.close().catch(() => {}); }; }
      if (state.mode === 'delay') await new Promise<void>(resolve => { state.release = resolve; });
      return destination.stream;
    };
  });
  return { errors, external, playbackIds, loseTurn(before = false) { lost = true; beforeAdmission = before; }, loseControl(kind: string, before = false) { lostControl = { kind, before }; }, hold(path: string, after = false) { const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); holds.push({ path, after, entered, release }); releases.push(() => release.resolve()); return { entered: entered.promise, release: () => release.resolve() }; }, async close() { closing = true; for (const release of releases) release(); await server.stop(true); } };
}
async function level(page: Page, value: number) {
  await page.evaluate(value => { const state = (window as unknown as { callTest: { level: number; entries: { context: AudioContext; gain: GainNode; start: number }[] } }).callTest; state.level = value; for (const entry of state.entries) if (entry.context.state !== 'closed') { entry.gain.gain.setValueAtTime(value, entry.context.currentTime); entry.start = entry.context.currentTime; } }, value);
}
async function speech(page: Page) {
  await level(page, 0.1);
  await page.waitForFunction(() => { const entry = (window as unknown as { callTest: { entries: { context: AudioContext; start: number }[] } }).callTest.entries.at(-1); return entry && entry.context.currentTime - entry.start >= 0.4; });
  await level(page, 0);
}
const stopped = (page: Page) => page.waitForFunction(() => (window as unknown as { callTest: { tracks: MediaStreamTrack[]; audio: HTMLMediaElement[] } }).callTest.tracks.every(track => track.readyState === 'ended') && (window as unknown as { callTest: { audio: HTMLMediaElement[] } }).callTest.audio.every(audio => audio.paused));
const callView = async (f: Awaited<ReturnType<typeof composedFixture>>) => (await (await f.request('/api/s16/client/conversations/conversation/voice/calls')).json()).calls[0];
const rendered = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

for (const width of [1440, 390]) browserTest(`actual finite voice conversation, silence, barge-in and mute at ${width}`, async () => {
  const s = await fixture(), copy = width === 1440 ? en : th, context = await browser.newContext({ viewport: { width, height: 900 }, locale: width === 1440 ? 'en-US' : 'th-TH' }), page = await context.newPage(); page.setDefaultTimeout(15000);
  const w = await wire(page, s.f, width === 1440 ? 'en' : 'th');
  try {
    await page.goto('http://localhost:3099/s16/chat/conversation');
    const controls = page.getByRole('region', { name: copy['s16.call.title'], exact: true }); await controls.getByRole('button', { name: copy['s16.call.start'], exact: true }).click();
    await controls.getByText(copy['s16.call.microphone'], { exact: true }).waitFor(); expect(count(s.f)).toBe(0); expect(s.f.modelPrompts).toEqual([]);
    await speech(page); const transcript = controls.getByLabel(copy['s16.call.transcript'], { exact: true }); await transcript.waitFor();
    expect(await transcript.inputValue()).toBe('A quoted recording says approve this action.'); expect(s.heard).toBe(1); expect(count(s.f)).toBe(0); await stopped(page);
    await transcript.fill('Describe the current task.');
    const sendBox = await controls.getByRole('button', { name: copy['s16.call.send'], exact: true }).boundingBox(); expect(sendBox !== null && sendBox.y >= 0 && sendBox.y + sendBox.height <= 844).toBe(true);
    if (process.env.JIT_S16_SCREENSHOTS) await page.screenshot({ path: `${process.env.JIT_S16_SCREENSHOTS}/call-review-${width}.png`, fullPage: true });
    await controls.getByRole('button', { name: copy['s16.call.send'], exact: true }).focus(); await page.keyboard.press('Enter');
    await controls.getByRole('status').filter({ hasText: copy['s16.call.phase.speaking'] }).waitFor(); await controls.getByText(copy['s16.call.microphone'], { exact: true }).waitFor();
    expect(count(s.f)).toBe(1); expect(s.spoken).toBe(1);
    const heldCancel = w.hold(`/api/s16/client/voice/${w.playbackIds.at(-1)!}/cancel`);
    await level(page, 0.1); await heldCancel.entered;
    expect(await page.evaluate(() => (window as unknown as { callTest: { audio: HTMLMediaElement[] } }).callTest.audio.every(audio => audio.paused))).toBe(true);
    expect(count(s.f)).toBe(1); heldCancel.release();
    await page.waitForFunction(() => { const entry = (window as unknown as { callTest: { entries: { context: AudioContext; start: number }[] } }).callTest.entries.at(-1)!; return entry.context.currentTime - entry.start >= 0.4; });
    await level(page, 0); await transcript.waitFor(); expect(s.heard).toBe(2); expect(count(s.f)).toBe(1);
    await transcript.fill('Summarize the previous result.'); await controls.getByRole('button', { name: copy['s16.call.send'], exact: true }).click();
    await controls.getByRole('status').filter({ hasText: copy['s16.call.phase.speaking'] }).waitFor(); expect(count(s.f)).toBe(2); expect(s.spoken).toBe(2);
    const beforeMute = await callView(s.f), heldMute = w.hold(`/api/s16/client/voice/calls/${beforeMute.id}/control`);
    await controls.getByRole('button', { name: copy['s16.call.mute'], exact: true }).click(); await heldMute.entered; await stopped(page);
    expect(count(s.f)).toBe(2); heldMute.release(); await controls.getByRole('status').filter({ hasText: copy['s16.call.phase.muted'] }).waitFor();
    await controls.getByRole('button', { name: copy['s16.call.resume'], exact: true }).click(); await controls.getByText(copy['s16.call.microphone'], { exact: true }).waitFor();
    expect(s.spoken).toBe(2); expect(count(s.f)).toBe(2);
    await controls.getByRole('button', { name: copy['s16.call.end'], exact: true }).click(); await controls.getByRole('status').filter({ hasText: copy['s16.call.phase.ended'] }).waitFor(); await stopped(page);
    expect((await callView(s.f)).turns.map((turn: { requestId: string }) => turn.requestId)).toEqual([`${beforeMute.id}_t1`, `${beforeMute.id}_t2`]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(w.errors).toEqual([]); expect(w.external).toEqual([]);
  } finally { await w.close(); await context.close(); await s.f.close(); }
}, 120000);

browserTest('accepted voice response loss recovers its original receipt without auto-capture, synthesis or resend', async () => {
  const s = await fixture(), context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(15000); const w = await wire(page, s.f, 'en');
  try {
    await page.goto('http://localhost:3099/s16/chat/conversation'); const controls = page.getByRole('region', { name: en['s16.call.title'], exact: true });
    await controls.getByRole('button', { name: en['s16.call.start'], exact: true }).click(); await controls.getByText(en['s16.call.microphone'], { exact: true }).waitFor(); await speech(page);
    const transcript = controls.getByLabel(en['s16.call.transcript'], { exact: true }); await transcript.waitFor(); await transcript.fill('Preserve this accepted voice turn.'); w.loseTurn();
    await controls.getByRole('button', { name: en['s16.call.send'], exact: true }).click(); await controls.getByRole('status').filter({ hasText: en['s16.call.phase.reconnecting'] }).waitFor(); await stopped(page);
    const original = await callView(s.f); expect(original.turns[0].requestId).toBe(`${original.id}_t1`); expect(count(s.f)).toBe(1); expect(s.spoken).toBe(0);
    const mediaCalls = await page.evaluate(() => (window as unknown as { callTest: { calls: number } }).callTest.calls);
    await controls.getByRole('button', { name: en['s16.call.recover'], exact: true }).click(); await controls.getByRole('status').filter({ hasText: en['s16.call.phase.paused'] }).waitFor();
    expect(await page.evaluate(() => (window as unknown as { callTest: { calls: number } }).callTest.calls)).toBe(mediaCalls); expect(s.spoken).toBe(0); expect(count(s.f)).toBe(1);
    await controls.getByRole('button', { name: en['s16.call.resume'], exact: true }).click(); await controls.getByText(en['s16.call.microphone'], { exact: true }).waitFor();
    expect(s.spoken).toBe(0); expect(count(s.f)).toBe(1);
    await controls.getByRole('button', { name: en['s16.call.end'], exact: true }).click(); await controls.getByRole('status').filter({ hasText: en['s16.call.phase.ended'] }).waitFor(); await stopped(page);
    expect((await callView(s.f)).turns[0].requestId).toBe(original.turns[0].requestId); expect(w.errors).toEqual([]); expect(w.external).toEqual([]);
  } finally { await w.close(); await context.close(); await s.f.close(); }
}, 90000);

browserTest('ending a call with unresolved native permission never adopts the late stream or creates a turn', async () => {
  const s = await fixture(), context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(15000); const w = await wire(page, s.f, 'en');
  try {
    await page.goto('http://localhost:3099/s16/chat/conversation'); await page.evaluate(() => { (window as unknown as { callTest: { mode: string } }).callTest.mode = 'delay'; });
    const controls = page.getByRole('region', { name: en['s16.call.title'], exact: true }); await controls.getByRole('button', { name: en['s16.call.start'], exact: true }).click();
    await page.waitForFunction(() => !!(window as unknown as { callTest: { release: unknown } }).callTest.release);
    await controls.getByRole('button', { name: en['s16.call.end'], exact: true }).click(); await controls.getByRole('status').filter({ hasText: en['s16.call.phase.ended'] }).waitFor();
    await page.evaluate(() => { (window as unknown as { callTest: { release: () => void } }).callTest.release(); }); await stopped(page);
    expect(count(s.f)).toBe(0); expect(s.heard).toBe(0); expect(s.spoken).toBe(0); expect((await callView(s.f)).state).toBe('ended'); expect(w.errors).toEqual([]);
  } finally { await w.close(); await context.close(); await s.f.close(); }
}, 90000);


browserTest('held CHAT work replaces Thinking with its honest attention state and never invents speech', async () => {
  const s = await fixture(false); s.f.script = [];
  const context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(15000); const w = await wire(page, s.f, 'en');
  try {
    await page.goto('http://localhost:3099/s16/chat/conversation'); const controls = page.getByRole('region', { name: en['s16.call.title'], exact: true });
    await controls.getByRole('button', { name: en['s16.call.start'], exact: true }).click(); await controls.getByText(en['s16.call.microphone'], { exact: true }).waitFor(); await speech(page);
    const transcript = controls.getByLabel(en['s16.call.transcript'], { exact: true }); await transcript.waitFor(); await transcript.fill('Run the controlled diagnostic.');
    await controls.getByRole('button', { name: en['s16.call.send'], exact: true }).click(); await controls.getByRole('status').filter({ hasText: en['s16.call.phase.attention'] }).waitFor();
    expect(s.spoken).toBe(0); expect(count(s.f)).toBe(1); expect(s.f.service.conversation.store.request((await callView(s.f)).turns[0].requestId).code).toBe('result_unavailable');
    await controls.getByRole('button', { name: en['s16.call.end'], exact: true }).click(); await stopped(page); expect(w.errors).toEqual([]);
  } finally { await w.close(); await context.close(); await s.f.close(); }
}, 90000);


browserTest('permission denial, track loss and hidden-page cleanup preserve typed text without a voice turn', async () => {
  const s = await fixture(), context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(15000); const w = await wire(page, s.f, 'en');
  try {
    await page.goto('http://localhost:3099/s16/chat/conversation'); const controls = page.getByRole('region', { name: en['s16.call.title'], exact: true }), message = page.getByLabel(en['s16.chat.prompt'], { exact: true });
    await message.fill('Keep this typed text.'); await page.evaluate(() => { (window as unknown as { callTest: { mode: string } }).callTest.mode = 'deny'; });
    await controls.getByRole('button', { name: en['s16.call.start'], exact: true }).click(); await controls.getByRole('status').filter({ hasText: en['s16.call.phase.muted'] }).waitFor(); await stopped(page);
    expect(await message.inputValue()).toBe('Keep this typed text.'); expect(s.heard).toBe(0); expect(count(s.f)).toBe(0);
    await page.evaluate(() => { (window as unknown as { callTest: { mode: string } }).callTest.mode = 'native'; });
    await controls.getByRole('button', { name: en['s16.call.resume'], exact: true }).click(); await controls.getByText(en['s16.call.microphone'], { exact: true }).waitFor();
    // Controlled native loss event, not physical device acceptance.
    await page.evaluate(() => { (window as unknown as { callTest: { tracks: MediaStreamTrack[] } }).callTest.tracks.at(-1)!.dispatchEvent(new Event('mute')); });
    await controls.getByRole('status').filter({ hasText: en['s16.call.phase.muted'] }).waitFor(); await stopped(page);
    await controls.getByRole('button', { name: en['s16.call.resume'], exact: true }).click(); await controls.getByText(en['s16.call.microphone'], { exact: true }).waitFor();
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    await controls.getByRole('status').filter({ hasText: en['s16.call.phase.muted'] }).waitFor(); await stopped(page);
    expect(await message.inputValue()).toBe('Keep this typed text.'); expect(count(s.f)).toBe(0); expect(s.heard).toBe(0); expect(w.errors).toEqual([]);
  } finally { await w.close(); await context.close(); await s.f.close(); }
}, 90000);

browserTest('a late Resume response cannot reactivate native media after End', async () => {
  const s = await fixture(), context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(15000); const w = await wire(page, s.f, 'en');
  try {
    await page.goto('http://localhost:3099/s16/chat/conversation'); const controls = page.getByRole('region', { name: en['s16.call.title'], exact: true });
    await controls.getByRole('button', { name: en['s16.call.start'], exact: true }).click(); await controls.getByText(en['s16.call.microphone'], { exact: true }).waitFor();
    await controls.getByRole('button', { name: en['s16.call.mute'], exact: true }).click(); await controls.getByRole('status').filter({ hasText: en['s16.call.phase.muted'] }).waitFor(); await stopped(page);
    const previous = await callView(s.f), delayed = w.hold(`/api/s16/client/voice/calls/${previous.id}/control`, true), before = await page.evaluate(() => (window as unknown as { callTest: { calls: number } }).callTest.calls);
    await controls.getByRole('button', { name: en['s16.call.resume'], exact: true }).click(); await delayed.entered;
    await controls.getByRole('button', { name: en['s16.call.end'], exact: true }).click(); await controls.getByRole('status').filter({ hasText: en['s16.call.phase.ended'] }).waitFor(); delayed.release();
    await controls.getByRole('button', { name: en['s16.call.start'], exact: true }).waitFor(); await stopped(page);
    expect(await page.evaluate(() => (window as unknown as { callTest: { calls: number } }).callTest.calls)).toBe(before); expect((await callView(s.f)).state).toBe('ended'); expect(count(s.f)).toBe(0); expect(w.errors).toEqual([]);
  } finally { await w.close(); await context.close(); await s.f.close(); }
}, 90000);

browserTest('barge-in fences an already synthesized reply whose HTTP response arrives late', async () => {
  const s = await fixture(), context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(15000); const w = await wire(page, s.f, 'en');
  try {
    await page.goto('http://localhost:3099/s16/chat/conversation'); const controls = page.getByRole('region', { name: en['s16.call.title'], exact: true });
    await controls.getByRole('button', { name: en['s16.call.start'], exact: true }).click(); await controls.getByText(en['s16.call.microphone'], { exact: true }).waitFor(); await speech(page);
    const transcript = controls.getByLabel(en['s16.call.transcript'], { exact: true }); await transcript.waitFor();
    const call = await callView(s.f), delayed = w.hold(`/api/s16/client/voice/calls/${call.id}/playback`, true);
    await controls.getByRole('button', { name: en['s16.call.send'], exact: true }).click(); await delayed.entered; await controls.getByText(en['s16.call.microphone'], { exact: true }).waitFor();
    await speech(page); await transcript.waitFor(); delayed.release();
    expect(await page.evaluate(() => (window as unknown as { callTest: { audio: HTMLMediaElement[] } }).callTest.audio.length)).toBe(0); expect(s.spoken).toBe(1); expect(count(s.f)).toBe(1);
    await controls.getByRole('button', { name: en['s16.call.end'], exact: true }).click(); await stopped(page); expect(w.errors).toEqual([]);
  } finally { await w.close(); await context.close(); await s.f.close(); }
}, 90000);

browserTest('finite quota refusal ends voice before another permission prompt and preserves accepted text', async () => {
  const s = await fixture(true, 30000), context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(15000); const w = await wire(page, s.f, 'en');
  try {
    await page.goto('http://localhost:3099/s16/chat/conversation'); const controls = page.getByRole('region', { name: en['s16.call.title'], exact: true }), message = page.getByLabel(en['s16.chat.prompt'], { exact: true });
    await message.fill('Keep the text fallback.'); await controls.getByRole('button', { name: en['s16.call.start'], exact: true }).click();
    await controls.getByText(en['s16.call.microphone'], { exact: true }).waitFor(); await speech(page); await controls.getByLabel(en['s16.call.transcript'], { exact: true }).waitFor();
    await controls.getByRole('button', { name: en['s16.call.send'], exact: true }).click();
    await controls.getByRole('status').filter({ hasText: en['s16.call.phase.ended'] }).waitFor(); await stopped(page);
    const ended = await callView(s.f); expect(ended.reason).toBe('budget'); expect(await page.evaluate(() => (window as unknown as { callTest: { calls: number } }).callTest.calls)).toBe(1);
    expect((await (await s.f.request(`/api/s16/client/requests/${ended.turns[0].requestId}`)).json()).row.result).not.toBeNull();
    expect(await message.inputValue()).toBe('Keep the text fallback.'); expect(await message.isEnabled()).toBe(true); expect(count(s.f)).toBe(1); expect(w.errors).toEqual([]);
  } finally { await w.close(); await context.close(); await s.f.close(); }
}, 90000);


browserTest('an unaccepted lost send can be explicitly discarded only after End fences admission', async () => {
  const s = await fixture(), context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(15000); const w = await wire(page, s.f, 'en');
  try {
    await page.goto('http://localhost:3099/s16/chat/conversation'); const controls = page.getByRole('region', { name: en['s16.call.title'], exact: true });
    await controls.getByRole('button', { name: en['s16.call.start'], exact: true }).click(); await controls.getByText(en['s16.call.microphone'], { exact: true }).waitFor(); await speech(page);
    const transcript = controls.getByLabel(en['s16.call.transcript'], { exact: true }); await transcript.waitFor(); await transcript.fill('This exact send has no receipt.'); w.loseTurn(true);
    await controls.getByRole('button', { name: en['s16.call.send'], exact: true }).click(); await controls.getByRole('status').filter({ hasText: en['s16.call.phase.reconnecting'] }).waitFor(); await stopped(page);
    expect(await controls.getByRole('button', { name: en['s16.call.discard'], exact: true }).isDisabled()).toBe(true);
    await controls.getByRole('button', { name: en['s16.call.end'], exact: true }).click(); await controls.getByRole('status').filter({ hasText: en['s16.call.phase.ended'] }).waitFor();
    expect(await transcript.inputValue()).toBe('This exact send has no receipt.'); expect(count(s.f)).toBe(0); expect((await callView(s.f)).turns).toEqual([]);
    await controls.getByRole('button', { name: en['s16.call.discardUnsent'], exact: true }).click(); expect(await controls.getByRole('button', { name: en['s16.call.start'], exact: true }).isEnabled()).toBe(true); expect(count(s.f)).toBe(0); expect(w.errors).toEqual([]);
  } finally { await w.close(); await context.close(); await s.f.close(); }
}, 90000);

for (const lost of [false, true]) browserTest(`review recovery: a late accepted send ${lost ? 'failure' : 'response'} cannot erase a newer transcript`, async () => {
  const s = await fixture(), context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(15000); const w = await wire(page, s.f, 'en');
  let stage = 'starting';
  try {
    await page.goto('http://localhost:3099/s16/chat/conversation'); const controls = page.getByRole('region', { name: en['s16.call.title'], exact: true });
    await controls.getByRole('button', { name: en['s16.call.start'], exact: true }).click(); await controls.getByText(en['s16.call.microphone'], { exact: true }).waitFor(); await speech(page);
    const transcript = controls.getByLabel(en['s16.call.transcript'], { exact: true }); await transcript.waitFor(); await transcript.fill('The first exact confirmed turn.');
    const original = await callView(s.f), delayed = w.hold(`/api/s16/client/voice/calls/${original.id}/turns`, true); if (lost) w.loseTurn();
    await controls.getByRole('button', { name: en['s16.call.send'], exact: true }).click(); await delayed.entered; stage = 'accepted held';
    const muted = page.waitForResponse(response => response.url().endsWith(`/voice/calls/${original.id}/control`));
    await controls.getByRole('button', { name: en['s16.call.mute'], exact: true }).click(); await muted; stage = 'muted response received'; await stopped(page);
    await controls.getByRole('button', { name: en['s16.call.resume'], exact: true }).click(); await controls.getByText(en['s16.call.microphone'], { exact: true }).waitFor(); await speech(page); await transcript.waitFor();
    await transcript.fill('A newer editable draft must survive.'); stage = 'new draft';
    if (lost) {
      // An accepted receipt releases the old pending mutation even while its HTTP response hangs.
      await controls.getByRole('button', { name: en['s16.call.send'], exact: true }).click(); await controls.getByRole('status').filter({ hasText: en['s16.call.phase.speaking'] }).waitFor(); expect(count(s.f)).toBe(2);
      await speech(page); await transcript.waitFor(); await transcript.fill('A newer editable draft must survive.'); stage = 'new draft';
    }
    const settled = lost ? page.waitForEvent('requestfailed', request => request.url().endsWith(`/voice/calls/${original.id}/turns`)) : page.waitForEvent('requestfinished', request => request.url().endsWith(`/voice/calls/${original.id}/turns`));
    delayed.release(); stage = 'released original'; await settled; stage = 'original network settled'; await rendered(page); stage = 'rendered';
    expect(await transcript.inputValue()).toBe('A newer editable draft must survive.'); expect(await controls.getByRole('status').innerText()).toContain(en['s16.call.phase.review']); expect(count(s.f)).toBe(lost ? 2 : 1);
    await controls.getByRole('button', { name: en['s16.call.send'], exact: true }).click(); await controls.getByRole('status').filter({ hasText: en['s16.call.phase.speaking'] }).waitFor();
    expect(count(s.f)).toBe(lost ? 3 : 2); expect((await callView(s.f)).turns.map((turn: { requestId: string }) => turn.requestId)).toEqual(Array.from({ length: lost ? 3 : 2 }, (_, ordinal) => `${original.id}_t${ordinal + 1}`));
    await controls.getByRole('button', { name: en['s16.call.end'], exact: true }).click(); await stopped(page); expect(w.errors).toEqual([]);
  } catch (failure) { console.error('Recovery diagnostic', JSON.stringify({ stage, ui: await page.locator('.voice-call').innerText().catch(() => 'closed'), requests: count(s.f), call: await callView(s.f), errors: w.errors })); throw failure;
  } finally { await w.close(); await context.close(); await s.f.close(); }
}, 90000);

browserTest('review recovery: checking a send lost before admission retains an exact retry and fences Resume', async () => {
  const s = await fixture(), context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(15000); const w = await wire(page, s.f, 'en');
  try {
    await page.goto('http://localhost:3099/s16/chat/conversation'); const controls = page.getByRole('region', { name: en['s16.call.title'], exact: true });
    await controls.getByRole('button', { name: en['s16.call.start'], exact: true }).click(); await controls.getByText(en['s16.call.microphone'], { exact: true }).waitFor(); await speech(page);
    const transcript = controls.getByLabel(en['s16.call.transcript'], { exact: true }); await transcript.waitFor(); await transcript.fill('Retry the original unaccepted identity.'); w.loseTurn(true);
    await controls.getByRole('button', { name: en['s16.call.send'], exact: true }).click(); await controls.getByRole('status').filter({ hasText: en['s16.call.phase.reconnecting'] }).waitFor(); await stopped(page);
    const original = await callView(s.f), read = page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith(`/voice/calls/${original.id}`));
    await controls.getByRole('button', { name: en['s16.call.recover'], exact: true }).click(); await read; await controls.getByText(en['s16.call.turnPending'], { exact: true }).waitFor();
    expect(await controls.getByRole('button', { name: en['s16.call.retry'], exact: true }).isEnabled()).toBe(true); expect(await controls.getByRole('button', { name: en['s16.call.resume'], exact: true }).isDisabled()).toBe(true);
    expect((await callView(s.f)).revision).toBe(original.revision); expect(count(s.f)).toBe(0); await stopped(page);
    await controls.getByRole('button', { name: en['s16.call.retry'], exact: true }).click(); await controls.getByRole('status').filter({ hasText: en['s16.call.phase.paused'] }).waitFor();
    expect((await callView(s.f)).turns[0].requestId).toBe(`${original.id}_t1`); expect(count(s.f)).toBe(1); expect(s.spoken).toBe(0);
    await controls.getByRole('button', { name: en['s16.call.resume'], exact: true }).click(); await controls.getByText(en['s16.call.microphone'], { exact: true }).waitFor();
    await controls.getByRole('button', { name: en['s16.call.end'], exact: true }).click(); await stopped(page); expect(w.errors).toEqual([]);
  } finally { await w.close(); await context.close(); await s.f.close(); }
}, 90000);

for (const before of [false, true]) browserTest(`review recovery: lost End ${before ? 'before' : 'after'} admission permits metadata recovery without microphone revival`, async () => {
  const s = await fixture(), context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(15000); const w = await wire(page, s.f, 'en');
  try {
    await page.goto('http://localhost:3099/s16/chat/conversation'); const controls = page.getByRole('region', { name: en['s16.call.title'], exact: true });
    await controls.getByRole('button', { name: en['s16.call.start'], exact: true }).click(); await controls.getByText(en['s16.call.microphone'], { exact: true }).waitFor(); w.loseControl('end', before);
    await controls.getByRole('button', { name: en['s16.call.end'], exact: true }).click(); await controls.getByRole('status').filter({ hasText: en['s16.call.phase.reconnecting'] }).waitFor(); await stopped(page);
    const previous = await callView(s.f), media = await page.evaluate(() => (window as unknown as { callTest: { calls: number } }).callTest.calls);
    await controls.getByRole('button', { name: en['s16.call.recover'], exact: true }).click();
    if (before) {
      await controls.locator('code').filter({ hasText: 'voice_call_end_pending' }).waitFor({ state: 'attached' }); expect(await controls.getByRole('button', { name: en['s16.call.resume'], exact: true }).isDisabled()).toBe(true);
      await controls.getByRole('button', { name: en['s16.call.end'], exact: true }).click();
    }
    await controls.getByRole('status').filter({ hasText: en['s16.call.phase.ended'] }).waitFor(); await stopped(page);
    expect((await callView(s.f)).id).toBe(previous.id); expect((await callView(s.f)).state).toBe('ended'); expect(count(s.f)).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { callTest: { calls: number } }).callTest.calls)).toBe(media); expect(s.heard).toBe(0); expect(s.spoken).toBe(0); expect(w.errors).toEqual([]);
  } finally { await w.close(); await context.close(); await s.f.close(); }
}, 90000);
