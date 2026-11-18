import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { VmSession } from '../../src/s15/vm';
import { vmQuote } from '../../src/s15/vm/host';

/** Opt-in reference-host evidence over an actual root VM session and live protected Chromium.
 * Combines pipe-only process facts, protected-file/control-network positive canaries and actual guest attempts;
 * it does not attest against a hypervisor/browser-engine exploit or certify another installation. */
export async function proveProtectedBrowserBoundary(session: VmSession, profilePath: string) {
  if (process.env.JIT_S15_ARM64_EVIDENCE !== '1' || process.platform !== 'linux') throw Error('explicit_linux_boundary_evidence_required');
  // Read exact NUL-separated kernel argv, rather than a terminal-width-dependent `ps` rendering.
  const browser: string[][] = [];
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    let args: string[]; try { args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch { continue; }
    if (args.includes(`--user-data-dir=${profilePath}`) && args.includes('--remote-debugging-pipe')) browser.push(args);
  }
  if (browser.length !== 1 || browser[0]!.some(arg => arg.startsWith('--remote-debugging-port')) || existsSync(join(profilePath, 'DevToolsActivePort'))) throw Error(`browser_pipe_unproven:${browser.length}:${existsSync(join(profilePath, 'DevToolsActivePort'))}`);
  const cookiePaths = [join(profilePath, 'Default', 'Cookies'), join(profilePath, 'Default', 'Network', 'Cookies')].filter(existsSync);
  if (!cookiePaths.length) throw Error('browser_cookie_file_unproven');
  const marker = join(profilePath, 'jit-boundary-canary'); writeFileSync(marker, randomBytes(32), { mode: 0o600 });
  const addresses = [...new Set(Object.values(networkInterfaces()).flatMap(values => values?.filter(value => value.family === 'IPv4' && !value.internal).map(value => value.address) ?? []))];
  if (!addresses.length) throw Error('controller_interface_unproven');
  let requests = 0;
  const canary = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch() { requests++; return new Response(null, { status: 204 }); } });
  try {
    const positive = await fetch(`http://127.0.0.1:${canary.port}/boundary-canary`, { signal: AbortSignal.timeout(5000) }); await positive.arrayBuffer();
    if (positive.status !== 204 || requests !== 1) throw Error('controller_canary_unproven');
    const targets = [...new Set([...addresses, '192.168.5.2'])].flatMap(host => [canary.port!, 9222].map(port => [host, port]));
    const source = `import os,json,socket,subprocess,tempfile,concurrent.futures
paths=${JSON.stringify([marker, ...cookiePaths])}
targets=${JSON.stringify(targets)}
profile=${JSON.stringify(profilePath)}.encode()
def readable(path):
 try:
  fd=os.open(path,os.O_RDONLY);os.close(fd);return True
 except OSError:return False
def dial(target):
 s=socket.socket(socket.AF_INET,socket.SOCK_STREAM);s.settimeout(1)
 try:
  s.connect(tuple(target));s.sendall(b'GET /json/version HTTP/1.1\\r\\nHost: fixture\\r\\nConnection: close\\r\\n\\r\\n');return True
 except OSError:return False
 finally:s.close()
visible=False
for name in os.listdir('/proc'):
 if not name.isdigit():continue
 try:
  args=open('/proc/'+name+'/cmdline','rb').read().split(b'\\0')
  if b'--remote-debugging-pipe' in args and b'--user-data-dir='+profile in args:visible=True
 except OSError:pass
mounted=subprocess.run(['findmnt','-rn','-t','9p,virtiofs'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=3)
point=tempfile.mkdtemp(prefix='jit-browser-mount-')
try:
 attempted=subprocess.run(['mount','-t','9p','-o','trans=virtio','jit-protected',point],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=3)
 accepted=attempted.returncode==0
 if accepted:subprocess.run(['umount',point],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=3)
finally:os.rmdir(point)
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
 result={'root':os.geteuid()==0,'readable':list(map(readable,paths)),'controllerBrowserVisible':visible,'mountedShares':bool(mounted.stdout.strip()),'mountAccepted':accepted,'reachable':list(pool.map(dial,targets))}
print(json.dumps(result,separators=(',',':')))
`;
    const response = await session.backend.spawn({ command: 'sudo -n python3 -I -c ' + vmQuote(source), cwd: session.backend.workspaceRoot, timeoutMs: 15000 });
    if (response.exitCode !== 0 || response.timedOut) throw Error('guest_boundary_probe_failed');
    const result = JSON.parse(response.stdout) as { root: boolean; readable: boolean[]; controllerBrowserVisible: boolean; mountedShares: boolean; mountAccepted: boolean; reachable: boolean[] };
    if (!result.root || result.readable.length !== 1 + cookiePaths.length || result.readable.some(value => value !== false) || result.controllerBrowserVisible !== false || result.mountedShares !== false || result.mountAccepted !== false || result.reachable.length !== targets.length || result.reachable.some(value => value !== false) || requests !== 1) throw Error('protected_browser_boundary_bypassed');
    return { passed: true, browserControl: 'observed_pipe_only', persistedCookieFiles: cookiePaths.length, protectedCanary: 'controller_positive_guest_denied', controlNetworkCanary: 'controller_positive_zero_guest_requests', guest: result, basis: 'actual_root_attempts_plus_external_manager_inventory', scope: 'paired_reference_host_not_hypervisor_escape_attestation' };
  } finally { canary.stop(true); rmSync(marker, { force: true }); }
}
