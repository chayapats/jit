import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BrowserError, ProtectedChromium, protectedChromiumBuilds, provisionedEngineFactory, type ProtectedChromiumPorts } from '../src/s15/browser';
import { missingLibrary } from '../src/s15/browser/chromium';
import type { BrowserEngine, EngineOptions } from '../src/s15/browser/engine';
import { localVmFileHash } from '../src/s15/vm/local';

// BROW15-02 pinned Chromium: verified download fixtures. Nothing here downloads, unpacks or executes a real browser.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const build = protectedChromiumBuilds.x86_64;

function host(options: { archiveHash?: () => string; library?: string | null; free?: number; arch?: string; platform?: string; downloadFails?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-chromium-'))); roots.push(root);
  const calls: string[] = [];
  const ports: ProtectedChromiumPorts = {
    arch: () => options.arch ?? 'x64', platform: () => options.platform ?? 'linux', freeBytes: () => options.free ?? 8 * 1024 ** 3,
    async download(url, file, o) { calls.push(`download:${url}:${o.maxBytes}`); if (options.downloadFails) throw new Error('network down'); writeFileSync(file, 'fixture archive bytes', { flag: 'wx', mode: 0o600 }); },
    // The fixture archive stands in for the pinned bytes only through this seam; the executable is hashed for real.
    hash: async file => file.includes('.partial-') ? (options.archiveHash?.() ?? build.sha256) : localVmFileHash(file),
    async extract(archive, into) { calls.push(`extract:${existsSync(archive)}`); const exe = join(into, build.executable); mkdirSync(dirname(exe), { recursive: true }); writeFileSync(exe, '#!/bin/false fixture chrome\n'); chmodSync(exe, 0o755); },
    async libraries(executable) { calls.push(`libraries:${executable}`); return options.library === undefined ? { ok: true } : { ok: false, library: options.library }; },
  };
  return { root, calls, ports, directory: join(root, 'browser-engine') };
}

test('pins match the playwright-core Chromium build per architecture, with exact sizes and HTTPS URLs', () => {
  const lock = readFileSync(join(import.meta.dir, '../bun.lock'), 'utf8');
  expect(lock).toContain('"playwright-core": ["playwright-core@1.64.1"');
  const browsers = JSON.parse(readFileSync(join(import.meta.dir, '../node_modules/playwright-core/browsers.json'), 'utf8')) as { browsers: { name: string; browserVersion: string }[] };
  const version = browsers.browsers.find(b => b.name === 'chromium')!.browserVersion;
  for (const pin of Object.values(protectedChromiumBuilds)) {
    expect(pin.version).toBe(version); expect(pin.url).toStartWith(`https://storage.googleapis.com/chrome-for-testing-public/${version}/`);
    expect(pin.sha256).toMatch(/^[a-f0-9]{64}$/); expect(pin.bytes).toBeGreaterThan(100_000_000); expect(pin.executable).toMatch(/^chrome-linux[a-z0-9-]*\/chrome$/);
  }
  expect(protectedChromiumBuilds.x86_64.sha256).not.toBe(protectedChromiumBuilds.aarch64.sha256);
});

test('a matching download is verified, unpacked, hashed and library-checked; the next boot re-verifies without downloading', async () => {
  const h = host(); const chromium = new ProtectedChromium(h.directory, { ...h.ports, libraries: async () => ({ ok: true }) });
  expect(chromium.status()).toEqual({ state: 'provisioning', step: 'verify', version: build.version });
  expect(() => chromium.executable()).toThrow(new BrowserError('browser_provisioning'));
  await chromium.start();
  expect(chromium.status()).toEqual({ state: 'ready', version: build.version });
  expect(chromium.executable()).toBe(join(h.directory, build.sha256.slice(0, 16), build.executable));
  expect(h.calls).toEqual([`download:${build.url}:${build.bytes}`, 'extract:true']);
  // Only the verified tree stays: no partial download, staging or archive.
  expect(readdirSync(h.directory)).toEqual([build.sha256.slice(0, 16)]);
  const record = JSON.parse(readFileSync(join(h.directory, build.sha256.slice(0, 16), '.jit-verified'), 'utf8'));
  expect(record).toEqual({ contract: 's15-protected-chromium/v1', build: build.id, archiveSha256: build.sha256, executableSha256: await localVmFileHash(chromium.executablePath) });
  const again = new ProtectedChromium(h.directory, { ...h.ports, libraries: async () => ({ ok: true }) }); await again.start();
  expect(again.status().state).toBe('ready'); expect(h.calls.filter(c => c.startsWith('download'))).toHaveLength(1);
  // A changed executable is not trusted: the next boot downloads and verifies again.
  writeFileSync(chromium.executablePath, 'tampered');
  const repaired = new ProtectedChromium(h.directory, { ...h.ports, libraries: async () => ({ ok: true }) }); await repaired.start();
  expect(repaired.status().state).toBe('ready'); expect(h.calls.filter(c => c.startsWith('download'))).toHaveLength(2);
});

test('a checksum mismatch is refused with a stable code, keeps nothing, and Try again downloads afresh', async () => {
  let hash = 'f'.repeat(64); const h = host({ archiveHash: () => hash }); const chromium = new ProtectedChromium(h.directory, { ...h.ports, libraries: async () => ({ ok: true }) });
  await chromium.start();
  expect(chromium.status()).toEqual({ state: 'failed', code: 'browser_checksum_mismatch', step: 'checksum', library: null, version: build.version });
  expect(() => chromium.executable()).toThrow(new BrowserError('browser_checksum_mismatch'));
  expect(readdirSync(h.directory)).toEqual([]); expect(h.calls.some(c => c.startsWith('extract'))).toBe(false);
  // A failure stays until the owner retries; a boot pass does not loop on it.
  await chromium.start(); expect(h.calls.filter(c => c.startsWith('download'))).toHaveLength(1);
  hash = build.sha256; await chromium.retry();
  expect(chromium.status().state).toBe('ready'); expect(h.calls.filter(c => c.startsWith('download'))).toHaveLength(2);
});

test('a missing system library is named; download, disk and host refusals are specific', async () => {
  const lib = host({ library: 'libnss3.so' }); const missing = new ProtectedChromium(lib.directory, lib.ports); await missing.start();
  expect(missing.status()).toEqual({ state: 'failed', code: 'browser_libraries_missing', step: 'libraries', library: 'libnss3.so', version: build.version });
  const unknown = host(); const engine = new ProtectedChromium(unknown.directory, { ...unknown.ports, libraries: async () => ({ ok: false, library: null }) }); await engine.start();
  expect(engine.status()).toMatchObject({ state: 'failed', code: 'browser_engine_unavailable', library: null });
  const offline = host({ downloadFails: true }); const down = new ProtectedChromium(offline.directory, offline.ports); await down.start();
  expect(down.status()).toMatchObject({ state: 'failed', code: 'browser_download_unavailable', step: 'download' }); expect(readdirSync(offline.directory)).toEqual([]);
  const full = host({ free: 100 * 1024 ** 2 }); const disk = new ProtectedChromium(full.directory, full.ports); await disk.start();
  expect(disk.status()).toMatchObject({ state: 'failed', code: 'browser_disk_insufficient' }); expect(full.calls).toEqual([]);
  for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'ia32']] as const) {
    const other = host({ platform, arch }); const unsupported = new ProtectedChromium(other.directory, other.ports); await unsupported.start();
    expect(unsupported.status()).toEqual({ state: 'failed', code: 'browser_host_unsupported', step: null, library: null, version: null });
    expect(() => unsupported.retry()).toThrow(new BrowserError('browser_host_unsupported')); expect(other.calls).toEqual([]);
  }
  const arm = host({ arch: 'arm64' }); expect(new ProtectedChromium(arm.directory, arm.ports).build).toBe(protectedChromiumBuilds.aarch64);
});

test('an unsafe engine directory is refused before any download', async () => {
  const h = host(); mkdirSync(h.directory, { mode: 0o755 }); chmodSync(h.directory, 0o755);
  const chromium = new ProtectedChromium(h.directory, h.ports); await chromium.start();
  expect(chromium.status()).toMatchObject({ state: 'failed', code: 'browser_directory_unsafe' }); expect(h.calls).toEqual([]);
});

test('only a validated shared-object name leaves the dynamic-loader refusal', () => {
  expect(missingLibrary('chrome: error while loading shared libraries: libnss3.so: cannot open shared object file: No such file or directory')).toBe('libnss3.so');
  expect(missingLibrary('error while loading shared libraries: libasound.so.2: cannot open')).toBe('libasound.so.2');
  expect(missingLibrary('error while loading shared libraries: /home/owner/secret: cannot open')).toBeNull();
  expect(missingLibrary('Segmentation fault')).toBeNull();
});

test('the provisioned engine launches lazily with the verified executable, refuses while unready and retries a failed launch', async () => {
  let state: 'provisioning' | 'ready' = 'provisioning', launches = 0, fail = true;
  const chromium = { executable: () => { if (state !== 'ready') throw new BrowserError('browser_provisioning'); return '/verified/chrome'; } };
  const seen: string[] = []; let closed = 0;
  const real: BrowserEngine = { async navigate(url) { seen.push(url); }, async read(generation) { return { id: 'o', generation, url: 'https://example.com/', text: '', truncated: false, elements: [] }; }, async image() { return new Uint8Array(); },
    async interact() {}, async ownerInput() {}, async cookie() { return null; }, async close() { closed++; } };
  const factory = provisionedEngineFactory(chromium, async (options: EngineOptions) => { launches++; expect(options.executablePath).toBe('/verified/chrome'); if (fail) { fail = false; throw new Error('raw launch failure text'); } return real; });
  const engine = await factory({ profilePath: '/protected/profiles', executablePath: '/planned/chrome', mode: 'static', request: async () => {} });
  const input = { signal: new AbortController().signal, guard() {} };
  expect(launches).toBe(0);
  await expect(engine.navigate('https://example.com/', input)).rejects.toEqual(new BrowserError('browser_provisioning'));
  state = 'ready';
  await expect(engine.navigate('https://example.com/', input)).rejects.toEqual(new BrowserError('engine_unavailable'));
  await engine.navigate('https://example.com/', input); await engine.read(2);
  expect(launches).toBe(2); expect(seen).toEqual(['https://example.com/']);
  await engine.close(); expect(closed).toBe(1);
  await expect(engine.navigate('https://example.com/', input)).rejects.toEqual(new BrowserError('engine_unavailable'));
});
