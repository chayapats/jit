import { beginDeviceSignIn } from 'schway/host';

// Owner-only foreground terminal helper. Never run from an evidence log, working VM or scheduled job.
if (!process.stdin.isTTY || !process.stdout.isTTY || process.argv.slice(2).join() !== '--codex') throw Error('owner_foreground_terminal_required');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
const result = await beginDeviceSignIn({ route: 'codex', signal: controller.signal, credentialWriteGuard: () => { if (controller.signal.aborted || !process.stdin.isTTY || !process.stdout.isTTY) throw Error('owner_terminal_closed'); } });
if (result.kind !== 'pending') { console.log(JSON.stringify({ state: result.kind })); process.exitCode = 1; }
else {
  const timer = setTimeout(() => controller.abort(), Math.max(1, result.expiresAt - Date.now()));
  try { process.stdout.write(`Open ${result.verificationUri}\nDevice code: ${result.userCode}\n`); const outcome = await result.poll(controller.signal); console.log(JSON.stringify({ state: outcome.kind })); if (outcome.kind !== 'ready') process.exitCode = 1; }
  finally { clearTimeout(timer); result.cancel(); }
}
