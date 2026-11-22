import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnRunner } from '../../src/ops/supervisor';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
/** Fixed installed fixture tools only. Never inherit account-specific PATH or arbitrary environment flags. */
export function s16FixturePath(): string {
  return [dirname(process.execPath), ...(process.platform === 'darwin' ? [process.arch === 'arm64' ? '/opt/homebrew/bin' : '/usr/local/bin'] : []), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
}
/** Bounded installed parser library identity, including readable bytecode. Links refuse. */
export function s16FixtureLibraryHash(directory: string): { sha256: string; files: number } {
  const root = realpathSync(directory), digest = createHash('sha256'); let files = 0, bytes = 0;
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(root).isDirectory()) throw Error('s16_fixture_library_invalid');
  const walk = (path: string, name: string, depth: number) => {
    if (depth > 16) throw Error('s16_fixture_library_bounds');
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw Error('s16_fixture_library_invalid');
    if (info.isDirectory()) {
      digest.update(`d\0${name}\0`);
      for (const child of readdirSync(path).sort()) walk(join(path, child), name + '/' + child, depth + 1);
    } else if (info.isFile()) {
      if (++files > 4096 || info.size > 67108864 || (bytes += info.size) > 134217728) throw Error('s16_fixture_library_bounds');
      digest.update(`f\0${name}\0${hash(readFileSync(path))}\0`);
    } else throw Error('s16_fixture_library_invalid');
  };
  walk(root, '', 0); return { sha256: digest.digest('hex'), files };
}
/** Actual host-fixture parser pins. This is neither a shipped container digest nor Linux isolation proof. */
export async function s16FixtureParserTools() {
  const base = process.platform === 'darwin' ? process.arch === 'arm64' ? '/opt/homebrew/bin' : '/usr/local/bin' : '/usr/bin';
  try {
    const tools = ['python3', 'pdfinfo', 'pdftotext'].map(name => {
      const path = realpathSync(join(base, name)), info = lstatSync(path);
      if (!info.isFile() || info.size > 134217728) throw Error('s16_fixture_tool_invalid');
      return { name, path, sha256: hash(readFileSync(path)) };
    });
    const env = { PATH: s16FixturePath(), LANG: 'C.UTF-8' };
    const python = await spawnRunner([tools[0]!.path, '-I', '-B', '-c', 'import json,sys,pathlib,PIL;print(json.dumps({"pythonVersion":sys.version.split()[0],"pillowVersion":PIL.__version__,"pillowDirectory":str(pathlib.Path(PIL.__file__).parent)}))'], { cwd: '/', env, timeoutMs: 10000 });
    if (python.exitCode || python.timedOut || Buffer.byteLength(python.stdout) > 8192) throw Error('s16_fixture_python_unavailable');
    const value = JSON.parse(python.stdout);
    if (!value || Object.keys(value).sort().join(',') !== 'pillowDirectory,pillowVersion,pythonVersion' || ![value.pythonVersion, value.pillowVersion].every(v => typeof v === 'string' && /^[0-9][A-Za-z0-9.+_-]{0,63}$/.test(v)) || typeof value.pillowDirectory !== 'string') throw Error('s16_fixture_python_invalid');
    const library = realpathSync(value.pillowDirectory);
    if (!(process.platform === 'darwin' ? library.startsWith(base.slice(0, -4) + '/') : library.startsWith('/usr/lib/') || library.startsWith('/usr/local/lib/'))) throw Error('s16_fixture_python_invalid');
    // Poppler prints version facts on stderr. Use the same bounded no-shell
    // stream wrapper as the evidence executor, without changing the shared runner.
    const wrapper = `const p=Bun.spawn(${JSON.stringify([tools[1]!.path, '-v'])},{stdin:'ignore',stdout:1,stderr:1});process.exit(await p.exited);`;
    const poppler = await spawnRunner([process.execPath, '--eval', wrapper], { cwd: '/', env, timeoutMs: 10000 });
    if (poppler.exitCode || poppler.timedOut || !/pdfinfo version [0-9][^\r\n]{0,63}/.test(poppler.stdout)) throw Error('s16_fixture_poppler_unavailable');
    return { state: 'recorded' as const, basis: 'actual_host_fixture_parser_tools_without_isolation' as const,
      tools: tools.map(({ name, sha256 }) => ({ name, sha256 })), pythonVersion: value.pythonVersion as string, pillowVersion: value.pillowVersion as string,
      pillow: s16FixtureLibraryHash(library), popplerVersionSha256: hash(poppler.stdout), sanitizerSha256: hash(readFileSync(new URL('../box/sanitize', import.meta.url))) };
  } catch { return { state: 'unavailable' as const, basis: 'actual_host_fixture_parser_tools_without_isolation' as const }; }
}

/** Verified fixed browser input, with no profile/session or account data. The path stays private. */
export async function s16FixtureBrowser(root: string) {
  const candidate = join(root, '.local/s16-evidence-browser/Google Chrome.app/Contents/MacOS/Google Chrome');
  const privateCopy = process.platform === 'darwin' && existsSync(candidate);
  const path = process.platform === 'darwin' ? privateCopy ? candidate : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium';
  try {
    const entry = new URL('../../src/s16/desktop/executable.ts', import.meta.url).pathname;
    // Retain the actual installed launcher's complete vendor signature guard.
    const wrapper = `import{desktopBrowser}from${JSON.stringify(entry)};console.log(JSON.stringify({path:desktopBrowser(${JSON.stringify(path)})}));`;
    const checked = await spawnRunner([process.execPath, '--eval', wrapper], { cwd: '/', env: { PATH: s16FixturePath() }, timeoutMs: 30000 });
    if (checked.exitCode || checked.timedOut || checked.stdout.length > 8192) return null;
    const value = JSON.parse(checked.stdout);
    if (!value || Object.keys(value).join(',') !== 'path' || typeof value.path !== 'string' || !value.path.startsWith('/') || /[\u0000-\u001f]/.test(value.path)) return null;
    const boundedHash = (path: string, limit: number) => { const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw Error('s16_fixture_browser_invalid'); return hash(readFileSync(path)); };
    const executableSha256 = boundedHash(value.path, 134217728);
    const bundle = dirname(dirname(dirname(value.path)));
    return { path: value.path as string, evidence: { basis: 'verified_fixed_fixture_browser' as const, source: privateCopy ? 'task_private_vendor_copy' as const : 'installed_browser' as const, executableSha256,
      ...(process.platform === 'darwin' ? { signature: 'mac_chrome_vendor_verified' as const, infoSha256: boundedHash(join(bundle, 'Contents/Info.plist'), 1048576), resourcesSha256: boundedHash(join(bundle, 'Contents/_CodeSignature/CodeResources'), 4194304) } : { signature: 'not_applicable' as const }) } };
  } catch { return null; }
}
