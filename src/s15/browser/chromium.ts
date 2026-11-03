import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statfsSync, writeFileSync, writeSync } from 'node:fs';
import { join, sep } from 'node:path';
import { localVmFileHash } from '../vm/local';
import { launchProtectedEngine, type BrowserEngine, type EngineOptions } from './engine';
import { BrowserError } from './validation';

const MiB = 1_048_576;

/**
 * One pinned Chrome for Testing build. The version is the `chromium` entry of `playwright-core`'s
 * `browsers.json` for the version locked in bun.lock (1.64.1, browser revision 1248). Playwright's own
 * download location (`cdn.playwright.dev/builds/cft/<version>/…`) redirects to the exact
 * `chrome-for-testing-public` object pinned here; the SHA-256 below is the trust root.
 */
export interface ProtectedChromiumBuild { id: string; architecture: 'x86_64' | 'aarch64'; version: string; url: string; sha256: string; bytes: number; executable: string }
/**
 * Hashes were computed from the official downloads on 2026-11-03 and cross-checked against the MD5 that
 * Google Cloud Storage publishes for each object (`x-goog-hash`). No downloaded file was executed.
 */
export const protectedChromiumBuilds: Readonly<Record<'x86_64' | 'aarch64', ProtectedChromiumBuild>> = Object.freeze({
  x86_64: Object.freeze({ id: 'cft-156.0.8078.4-linux64', architecture: 'x86_64', version: '156.0.8078.4', bytes: 200345244, executable: 'chrome-linux64/chrome',
    url: 'https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.4/linux64/chrome-linux64.zip',
    sha256: '43fd31766c7533a02dda2ded5ad50c2f861cd5400be7509c0abad71129f79d79' }),
  aarch64: Object.freeze({ id: 'cft-156.0.8078.4-linux-arm64', architecture: 'aarch64', version: '156.0.8078.4', bytes: 199750508, executable: 'chrome-linux-arm64/chrome',
    url: 'https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.4/linux-arm64/chrome-linux-arm64.zip',
    sha256: '910a12fff6170202195f72ef3d353801c7063d301ab80b1f51b77d791fda60ce' }),
}) as Readonly<Record<'x86_64' | 'aarch64', ProtectedChromiumBuild>>;

/** Provisioning steps in order. `verify` re-checks an existing installation at boot. */
export type ProtectedChromiumStep = 'verify' | 'download' | 'checksum' | 'extract' | 'libraries';
/** Stable failure codes. Each names one cause and has owner-facing reason and next-step copy. */
export type ProtectedChromiumCode = 'browser_host_unsupported' | 'browser_directory_unsafe' | 'browser_disk_insufficient' | 'browser_download_unavailable' | 'browser_checksum_mismatch' | 'browser_extract_failed' | 'browser_libraries_missing' | 'browser_engine_unavailable';
/** Owner-visible projection. `library` is a validated shared-object file name, never raw process output. */
export type ProtectedChromiumStatus =
  | { state: 'provisioning'; step: ProtectedChromiumStep; version: string }
  | { state: 'ready'; version: string }
  | { state: 'failed'; code: ProtectedChromiumCode; step: ProtectedChromiumStep | null; library: string | null; version: string | null };

/** Host seams for deterministic tests. The defaults read only controller-local facts. */
export interface ProtectedChromiumPorts {
  arch(): string; platform(): string;
  freeBytes(path: string): number;
  /** HTTPS only, no redirects or credentials, at most `maxBytes`; verification is separate and mandatory. */
  download(url: string, file: string, options: { maxBytes: number; signal: AbortSignal }): Promise<void>;
  hash(file: string): Promise<string>;
  /** Extracts the verified archive into the empty directory `into`; throws on any failure. */
  extract(archive: string, into: string): Promise<void>;
  /** Starts the verified executable once with `--version` to prove its system libraries load. */
  libraries(executable: string): Promise<{ ok: true } | { ok: false; library: string | null }>;
}

/** Room for the archive and its extracted tree (about 0.2 + 0.6 GB), with margin. */
export const protectedChromiumFreeBytes = 1024 * MiB;
const marker = '.jit-verified';
const libraryName = /^[A-Za-z0-9_+.-]{1,96}\.so(?:\.[0-9]+){0,4}$/;

/** Reads the shared-object name from a dynamic-loader refusal, or null. Raw output never leaves this function. */
export function missingLibrary(stderr: string): string | null {
  const match = /error while loading shared libraries: ([^\s:]+)/.exec(stderr);
  return match && libraryName.test(match[1]!) ? match[1]! : null;
}

async function run(command: string[], timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '/', LANG: 'C.UTF-8' } });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode: await child.exited, stdout: stdout.slice(0, 4096), stderr: stderr.slice(0, 16384) };
  } finally { clearTimeout(timer); }
}

/** Default host ports: Bun fetch for the download, Info-ZIP `unzip` (installed by `install.sh`) to extract. */
export const protectedChromiumPorts: ProtectedChromiumPorts = {
  arch: () => process.arch, platform: () => process.platform,
  freeBytes: path => { const fs = statfsSync(path); return Number(fs.bavail) * Number(fs.bsize); },
  async download(url, file, options) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new BrowserError('browser_checksum_mismatch');
    let response: Response;
    try { response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([options.signal, AbortSignal.timeout(1_800_000)]), headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'Jit-protected-browser/1' } }); }
    catch { throw new BrowserError('browser_download_unavailable'); }
    if (!response.ok || !response.body) throw new BrowserError('browser_download_unavailable');
    const fd = openSync(file, 'wx', 0o600); let total = 0;
    try {
      try {
        for await (const chunk of response.body) {
          total += chunk.length; if (total > options.maxBytes) throw new BrowserError('browser_checksum_mismatch');
          for (let offset = 0; offset < chunk.length;) offset += writeSync(fd, chunk, offset);
        }
      } catch (error) { if (error instanceof BrowserError) throw error; throw new BrowserError('browser_download_unavailable'); }
      fsyncSync(fd);
    } finally { closeSync(fd); }
  },
  hash: localVmFileHash,
  async extract(archive, into) {
    const result = await run(['/usr/bin/unzip', '-q', '-n', archive, '-d', into], 600_000);
    if (result.exitCode !== 0) throw new BrowserError('browser_extract_failed');
  },
  async libraries(executable) {
    const result = await run([executable, '--version'], 30_000);
    if (result.exitCode === 0 && /^(?:Google Chrome for Testing|Chromium) [0-9.]+/.test(result.stdout.trim())) return { ok: true };
    return { ok: false, library: missingLibrary(result.stderr) };
  },
};

/**
 * Protected Chromium for the S15 browser (BROW15-02). It downloads the pinned build once for this host's
 * architecture into a private directory of the S15 state, refuses any archive whose SHA-256 differs from
 * the pin (`browser_checksum_mismatch`, nothing kept), extracts it, records the executable's own hash, and
 * proves its system libraries load. Each boot re-verifies the recorded hash. There is no fallback build,
 * no PATH lookup and no browser profile here; profiles stay in the protected browser runtime.
 */
export class ProtectedChromium {
  readonly build: ProtectedChromiumBuild | null;
  /** Deterministic verified-executable path for this build; usable only once `status()` is `ready`. */
  readonly executablePath: string;
  #status: ProtectedChromiumStatus;
  #running: Promise<void> | null = null;
  #abort = new AbortController();
  #closed = false;
  constructor(readonly directory: string, readonly ports: ProtectedChromiumPorts = protectedChromiumPorts) {
    const arch = ports.arch(), architecture = ports.platform() !== 'linux' ? null : arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : null;
    this.build = architecture ? protectedChromiumBuilds[architecture] : null;
    this.executablePath = this.build ? join(directory, this.build.sha256.slice(0, 16), this.build.executable) : join(directory, 'unsupported');
    this.#status = this.build ? { state: 'provisioning', step: 'verify', version: this.build.version } : { state: 'failed', code: 'browser_host_unsupported', step: null, library: null, version: null };
  }
  status(): ProtectedChromiumStatus { return structuredClone(this.#status); }
  /** Starts (or resumes at boot) provisioning once; a failure stays until {@link retry}. */
  start(): Promise<void> {
    if (!this.build || this.#closed) return Promise.resolve();
    if (!this.#running && this.#status.state !== 'provisioning') return Promise.resolve();
    return this.#running ??= this.#provision().finally(() => { this.#running = null; });
  }
  /** Owner-requested retry after a failure. Verified files are re-checked, not downloaded again. */
  retry(): Promise<void> {
    if (!this.build) throw new BrowserError('browser_host_unsupported');
    if (this.#status.state !== 'failed') return this.#running ?? Promise.resolve();
    this.#status = { state: 'provisioning', step: 'verify', version: this.build.version };
    return this.start();
  }
  /** The verified executable, or a stable refusal naming why the protected browser cannot start yet. */
  executable(): string {
    const status = this.#status;
    if (status.state === 'ready') return this.executablePath;
    throw new BrowserError(status.state === 'failed' ? status.code : 'browser_provisioning');
  }
  /** Stops an in-flight download. The next boot resumes from the verified files that exist. */
  async close(): Promise<void> { this.#closed = true; this.#abort.abort(); await this.#running?.catch(() => {}); }

  #step(step: ProtectedChromiumStep): void {
    if (this.#closed) throw new BrowserError('browser_engine_unavailable');
    this.#status = { state: 'provisioning', step, version: this.build!.version };
  }
  async #provision(): Promise<void> {
    const build = this.build!;
    let step: ProtectedChromiumStep = 'verify';
    const fail = (code: ProtectedChromiumCode, library: string | null = null) => { this.#status = { state: 'failed', code, step: code === 'browser_host_unsupported' ? null : step, library, version: build.version }; };
    try {
      this.#step(step);
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const own = lstatSync(this.directory);
      if (!own.isDirectory() || own.isSymbolicLink() || own.mode & 0o077 || (process.getuid && own.uid !== process.getuid())) { fail('browser_directory_unsafe'); return; }
      const final = join(this.directory, build.sha256.slice(0, 16));
      if (await this.#verified(final)) { step = 'libraries'; await this.#libraries(fail); return; }
      rmSync(final, { recursive: true, force: true });
      // Leftovers of an interrupted run never held verified bytes; only these exact names are removed.
      for (const name of readdirSync(this.directory)) if (/^\.(?:partial|extract)-[a-f0-9]{16}$/.test(name)) rmSync(join(this.directory, name), { recursive: true, force: true });
      if (this.ports.freeBytes(this.directory) < protectedChromiumFreeBytes) { fail('browser_disk_insufficient'); return; }
      const suffix = randomBytes(8).toString('hex'), partial = join(this.directory, `.partial-${suffix}`), staging = join(this.directory, `.extract-${suffix}`);
      try {
        step = 'download'; this.#step(step);
        await this.ports.download(build.url, partial, { maxBytes: build.bytes, signal: this.#abort.signal });
        step = 'checksum'; this.#step(step);
        if (await this.ports.hash(partial) !== build.sha256) { fail('browser_checksum_mismatch'); return; }
        step = 'extract'; this.#step(step);
        mkdirSync(staging, { mode: 0o700 });
        await this.ports.extract(partial, staging);
        const executable = join(staging, build.executable), stat = lstatSync(executable, { throwIfNoEntry: false });
        if (!stat?.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o100) || !realpathSync(executable).startsWith(realpathSync(staging) + sep)) { fail('browser_extract_failed'); return; }
        writeFileSync(join(staging, marker), JSON.stringify({ contract: 's15-protected-chromium/v1', build: build.id, archiveSha256: build.sha256, executableSha256: await this.ports.hash(executable) }), { mode: 0o600, flag: 'wx' });
        this.#step(step); renameSync(staging, final);
      } finally { rmSync(partial, { force: true }); rmSync(staging, { recursive: true, force: true }); }
      step = 'libraries'; await this.#libraries(fail);
    } catch (error) {
      if (this.#closed) return;
      const code = error instanceof BrowserError && (['browser_download_unavailable', 'browser_checksum_mismatch', 'browser_extract_failed'] as string[]).includes(error.code) ? error.code as ProtectedChromiumCode : step === 'download' ? 'browser_download_unavailable' : step === 'extract' ? 'browser_extract_failed' : 'browser_engine_unavailable';
      fail(code);
    }
  }
  async #verified(final: string): Promise<boolean> {
    const build = this.build!;
    try {
      const stat = lstatSync(final, { throwIfNoEntry: false }); if (!stat) return false;
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      const record = JSON.parse(readFileSync(join(final, marker), 'utf8')) as Record<string, unknown>;
      if (Object.keys(record).sort().join() !== 'archiveSha256,build,contract,executableSha256' || record.contract !== 's15-protected-chromium/v1' || record.build !== build.id || record.archiveSha256 !== build.sha256 || typeof record.executableSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.executableSha256)) return false;
      const executable = lstatSync(this.executablePath, { throwIfNoEntry: false });
      if (!executable?.isFile() || executable.isSymbolicLink()) return false;
      return await this.ports.hash(this.executablePath) === record.executableSha256;
    } catch { return false; }
  }
  async #libraries(fail: (code: ProtectedChromiumCode, library?: string | null) => void): Promise<void> {
    this.#step('libraries');
    const result = await this.ports.libraries(this.executablePath);
    if (this.#closed) return;
    if (result.ok) this.#status = { state: 'ready', version: this.build!.version };
    else fail(result.library ? 'browser_libraries_missing' : 'browser_engine_unavailable', result.library);
  }
}

/**
 * Engine factory for the provisioned browser. Registration stays immediate; the real engine launches on the
 * first owner or work operation once Chromium is verified, and an unready browser refuses with its stable
 * provisioning code instead of waiting for a download. A failed launch is retried on the next operation.
 */
export function provisionedEngineFactory(chromium: Pick<ProtectedChromium, 'executable'>, launch: (options: EngineOptions) => Promise<BrowserEngine> = launchProtectedEngine): (options: EngineOptions) => Promise<BrowserEngine> {
  return async options => {
    let current: Promise<BrowserEngine> | null = null, closed = false;
    const live = (): Promise<BrowserEngine> => {
      if (closed) return Promise.reject(new BrowserError('engine_unavailable'));
      if (current) return current;
      let executablePath: string;
      try { executablePath = chromium.executable(); } catch (error) { return Promise.reject(error); }
      const launched = launch({ ...options, executablePath }).catch((error: unknown) => { if (current === launched) current = null; throw error instanceof BrowserError ? error : new BrowserError('engine_unavailable'); });
      return current = launched;
    };
    return {
      navigate: async (url, input) => (await live()).navigate(url, input),
      read: async generation => (await live()).read(generation),
      image: async () => (await live()).image(),
      interact: async (kind, target, value, generation, input) => (await live()).interact(kind, target, value, generation, input),
      ownerInput: async (input, context) => (await live()).ownerInput(input, context),
      cookie: async (name, url) => (await live()).cookie(name, url),
      async close() { closed = true; const engine = current; current = null; if (engine) await (await engine.catch(() => null))?.close(); },
    };
  };
}
