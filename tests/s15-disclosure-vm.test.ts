import { afterEach, expect, test } from 'bun:test';
import { connect } from 'node:net';
import { startVmRegistryProxy } from '../src/s15/vm/proxy';
import { fetchVmArtifact } from '../src/s15/vm/acquisition';
import { disclosureFixture } from './fixtures/s15-disclosure';
import { ref } from './fixtures/s15-policy';

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function setup() { const f = disclosureFixture(); cleanups.push(f.cleanup); f.disclosure.read(f.actor, ref('private')); return f; }
async function exchange(port: number, authorization: string, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1'), chunks: Buffer[] = [];
    socket.setTimeout(2000, () => socket.destroy(new Error('test_timeout')));
    socket.on('connect', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: new.test\r\nProxy-Authorization: ${authorization}\r\n\r\n`));
    socket.on('data', b => chunks.push(Buffer.from(b))); socket.on('close', () => resolve(Buffer.concat(chunks).toString())); socket.on('error', reject);
  });
}
const auth = (url: string) => { const u = new URL(url); return 'Basic ' + Buffer.from(u.username + ':' + u.password).toString('base64'); };

test('real VM registry proxy denies an unapproved private recipient before DNS or upstream connection', async () => {
  const x = setup(); let dns = 0, connections = 0;
  const proxy = await startVmRegistryProxy({ hostname: '127.0.0.1', port: 0, guestHostname: '127.0.0.1', hosts: ['new.test'], log() {},
    resolve: async () => { dns++; return [{ address: '93.184.216.34', family: 4 }]; }, connect: () => { connections++; throw Error('inert_connect'); } }); cleanups.push(() => proxy.close());
  const lease = proxy.lease('work', Date.now() + 10000, host => x.disclosure.registryLease(x.actor, host));
  expect(await exchange(proxy.port, auth(lease.environment.HTTP_PROXY!), 'new.test:443')).toContain('403'); expect(dns).toBe(0); expect(connections).toBe(0);
  x.grant('new_service'); await exchange(proxy.port, auth(lease.environment.HTTP_PROXY!), 'new.test:443'); expect(dns).toBe(1); expect(connections).toBe(1);
});

test('registry consent revocation during DNS prevents the actual outbound connect', async () => {
  const x = setup(); x.grant('new_service'); let connections = 0;
  const entered = Promise.withResolvers<void>(), answer = Promise.withResolvers<readonly { address: string; family: number }[]>();
  const proxy = await startVmRegistryProxy({ hostname: '127.0.0.1', port: 0, guestHostname: '127.0.0.1', hosts: ['new.test'], log() {},
    resolve: async () => { entered.resolve(); return answer.promise; }, connect: () => { connections++; throw Error('must_not_connect'); } }); cleanups.push(() => proxy.close());
  const lease = proxy.lease('work', Date.now() + 10000, host => x.disclosure.registryLease(x.actor, host));
  const result = exchange(proxy.port, auth(lease.environment.HTTP_PROXY!), 'new.test:443'); await entered.promise;
  x.approvals.splice(0); answer.resolve([{ address: '93.184.216.34', family: 4 }]);
  expect(await result).toContain('403'); expect(connections).toBe(0);
});

test.each(['new.test.evil.test:443', '169.254.169.254:443', '[::1]:443', 'dns-proxy.test:443'])('guest-supplied alternate route %s cannot select a new DNS/proxy destination', async target => {
  const x = setup(); x.grant('new_service'); let dns = 0;
  const proxy = await startVmRegistryProxy({ hostname: '127.0.0.1', port: 0, guestHostname: '127.0.0.1', hosts: ['new.test'], log() {}, resolve: async () => { dns++; throw Error('must_not_resolve'); } }); cleanups.push(() => proxy.close());
  const lease = proxy.lease('work', Date.now() + 10000, host => x.disclosure.registryLease(x.actor, host));
  expect(await exchange(proxy.port, auth(lease.environment.HTTP_PROXY!), target)).toContain('403'); expect(dns).toBe(0);
});

test('shared guest ancestry blocks a clean sibling proxy from disclosing private work files', () => {
  const x = setup(); x.disclosure.vmInput(x.actor, 'working_vm');
  const sibling = x.f.admit({ access: 'effect' }).actor!;
  expect(() => x.disclosure.registryLease(sibling, 'new.test', 'working_vm')).toThrow('opaque_egress_unavailable');
  x.grant('new_service'); expect(() => x.disclosure.registryLease(sibling, 'new.test', 'working_vm')).not.toThrow();
  x.sources.get('private')!.active = false;
  expect(() => x.disclosure.registryLease(sibling, 'new.test', 'working_vm')).toThrow('lineage_withdrawn');
});

test('artifact acquisition rechecks protected consent after DNS before HTTPS request creation', async () => {
  const x = setup(); x.grant('payee'); let requests = 0;
  await expect(fetchVmArtifact({ url: 'https://existing.test/artifact?private=derived', sha256: 'a'.repeat(64), maxBytes: 1000 }, undefined, {
    beforeRequest: () => x.disclosure.registryDestination(x.actor, ref('payee'), 'existing.test'),
    resolve: async () => { x.approvals.splice(0); return [{ address: '93.184.216.34', family: 4 }]; },
    request: (() => { requests++; throw Error('must_not_request'); }) as never,
  })).rejects.toThrow('opaque_egress_unavailable'); expect(requests).toBe(0);
});

test('credential-shaped DNS labels are refused without leaking them into proxy logs', async () => {
  const x = setup(), logs: unknown[] = [];
  const proxy = await startVmRegistryProxy({ hostname: '127.0.0.1', port: 0, guestHostname: '127.0.0.1', hosts: ['new.test'], log: e => logs.push(e) }); cleanups.push(() => proxy.close());
  const lease = proxy.lease('work', Date.now() + 10000, host => x.disclosure.registryLease(x.actor, host));
  // Host grammar excludes underscores; use an API-key shape which is a legal DNS label.
  const label = 'sk-' + 'a'.repeat(24);
  expect(await exchange(proxy.port, auth(lease.environment.HTTP_PROXY!), label + '.evil.test:443')).toContain('403');
  expect(JSON.stringify(logs)).not.toContain(label);
});
