// Private finite process supervisor. Only its parent supplies a job over a fresh anonymous pipe.
// Keeping stdin open is the parent's liveness lease: EOF/SIGTERM/deadline stops and joins the CLI.
import { lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (import.meta.main) {
  if (process.argv[2] !== '--local-voice-worker') process.exit(2);
  let child: ReturnType<typeof Bun.spawn> | undefined, reason: string | null = null, finished = false, directory: string | undefined = process.cwd();
  const stop = (code: string) => { reason ??= code; if (child && !finished) { try { child.kill('SIGKILL'); } catch { /* Exit may have won the race. */ } } };
  process.on('SIGTERM', () => stop('cancelled')); process.on('SIGINT', () => stop('cancelled'));
  const respond = (state: string) => {
    finished = true;
    // A restarted service may remove this private scratch only after the actual CLI was joined.
    if (directory) writeFileSync(join(directory, 'settled.json'), JSON.stringify({ state, worker: process.pid, child: child?.pid ?? null }), { mode: 0o600 });
    process.stdout.write(JSON.stringify({ state }) + '\n'); process.exit(0);
  };
  const run = async (raw: string) => {
    let deadline: ReturnType<typeof setTimeout> | undefined, size: ReturnType<typeof setInterval> | undefined;
    try {
      const job = JSON.parse(raw) as { argv: string[]; cwd: string; timeoutMs: number; output: string; bytes: number };
      if (!job || Object.keys(job).sort().join() !== 'argv,bytes,cwd,output,timeoutMs' || !Array.isArray(job.argv) || !job.argv.length || job.argv.length > 32
        || job.argv.some(value => typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) || !job.argv[0]!.startsWith('/')
        || typeof job.cwd !== 'string' || !job.cwd.startsWith('/') || typeof job.output !== 'string' || !job.output.startsWith(job.cwd + '/')
        || !Number.isSafeInteger(job.timeoutMs) || job.timeoutMs < 1 || job.timeoutMs > 120000 || !Number.isSafeInteger(job.bytes) || job.bytes < 1 || job.bytes > 4 * 1024 * 1024) return respond('failed');
      directory = job.cwd;
      if (reason) return respond(reason);
      child = Bun.spawn(job.argv, { cwd: job.cwd, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TMPDIR: job.cwd } });
      deadline = setTimeout(() => stop('timeout'), job.timeoutMs);
      size = setInterval(() => { try { if (lstatSync(job.output).size > job.bytes) stop('limit'); } catch { /* The CLI may not have created its output yet. */ } }, 20);
      const code = await child.exited;
      respond(reason ?? (code === 0 ? 'completed' : 'failed'));
    } catch { stop('failed'); if (child) await child.exited; respond(reason ?? 'failed'); }
    finally { clearTimeout(deadline); clearInterval(size); }
  };
  let input = '', started = false; const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for await (const chunk of Bun.stdin.stream()) {
      if (started) { if (chunk.byteLength) stop('failed'); continue; }
      input += decoder.decode(chunk, { stream: true });
      if (Buffer.byteLength(input) > 16384) { stop('failed'); respond('failed'); }
      const end = input.indexOf('\n');
      if (end >= 0) { started = true; if (input.slice(end + 1)) process.exit(2); void run(input.slice(0, end)); input = ''; }
    }
    stop('cancelled'); if (!started) respond('cancelled');
  } catch { stop('failed'); if (!started) respond('failed'); }
}
