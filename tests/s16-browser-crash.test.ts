import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserSite } from './fixtures/s15-browser';

const native = test.skipIf(process.env.JIT_BROWSER_LIVE !== '1');
for (const asyncIntent of [false, true]) native(`SIGKILL after real ${asyncIntent ? 'async intent' : 'native form'} dispatch preserves unknown continuity, then exact read-back clears it without replay`, async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'jit-browser-crash-'))), site = browserSite(asyncIntent ? { asyncIntent: 'fetch' } : {});
  const received = Promise.withResolvers<void>(), response = Promise.withResolvers<void>(); let readbacks = 0;
  site.beforeResponse = async path => { if (path === '/message') { received.resolve(); await response.promise; } };
  const readback = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url); if (request.method !== 'GET' || url.pathname !== '/receipt') return new Response(null, { status: 404 });
    readbacks++; const sha256 = url.searchParams.get('sha256');
    const count = site.received.filter(row => row.path === '/message' && row.method === 'POST' && createHash('sha256').update(row.body).digest('hex') === sha256).length;
    return Response.json({ sha256, count });
  } });
  const launch = (phase: 'dispatch' | 'recover') => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/s16-browser-crash.ts')], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: process.env });
    child.stdin.write(JSON.stringify({ phase, directory, origin: site.origin, readback: readback.url.origin, asyncIntent })); child.stdin.end(); return child;
  };
  // Kill only this test's exact pipe-controlled browser, never another profile or a system browser.
  const stopProfile = () => {
    const processes = Bun.spawnSync(['ps', '-eo', 'pid=,args=']);
    for (const row of processes.stdout.toString().split('\n')) {
      if (row.includes(`--user-data-dir=${join(directory, 'profile')}`) && row.includes('--remote-debugging-pipe')) {
        const pid = Number(/^\s*(\d+)\s/.exec(row)?.[1]); if (Number.isSafeInteger(pid) && pid > 1) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
      }
    }
  };
  let child = launch('dispatch'), timer: ReturnType<typeof setTimeout> | undefined, temporaryDirectory: string | undefined;
  try {
    await Promise.race([received.promise, child.exited.then(async code => { throw Error(`dispatch_child_exited_${code}:` + (await new Response(child.stderr).text()).slice(0, 2000)); }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('dispatch_barrier_timeout')), 30000); })]);
    clearTimeout(timer); expect(site.received.filter(row => row.path === '/message')).toHaveLength(1); expect(readbacks).toBe(0);
    const metadata = JSON.parse(readFileSync(join(directory, 'action.json'), 'utf8')) as { temporaryDirectory: string };
    temporaryDirectory = metadata.temporaryDirectory;
    child.kill('SIGKILL'); await child.exited; stopProfile(); response.resolve();
    child = launch('recover'); const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(stdout)).toEqual({ recovered: true, generationAdvanced: true, resumeBefore: 'unsupported', navigateBefore: 'unknown', missing: 'unknown', statementUncleared: true, verified: 'succeeded', cleared: true, resumeAfter: 'unsupported', freshNavigation: 'ok' });
    expect(site.received.filter(row => row.path === '/message')).toHaveLength(1); expect(readbacks).toBe(1);
  } finally {
    clearTimeout(timer); response.resolve(); child.kill(); await child.exited; stopProfile(); site.close(); readback.stop(true);
    if (temporaryDirectory?.startsWith(join(tmpdir(), 'jit-s15-policy-'))) rmSync(temporaryDirectory, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
}, 60000);
