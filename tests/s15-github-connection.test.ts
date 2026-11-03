import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionVault } from '../src/exec/connections';
import { s15CredentialKey } from '../src/s15/credentials';
import { GithubConnections, s15GithubConnectionAlias } from '../src/s15/github/connection';
import { GithubStore } from '../src/s15/github/store';

const dirs: string[] = [], stores: GithubStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const token = (letter: string) => 'github_pat_' + letter.repeat(60);

/** GIT15-04 custody: the vault value and the committed fingerprint only ever change together. */
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jit-ghc-'))); dirs.push(dir);
  const store = new GithubStore(join(dir, 'github.sqlite'), 'connection_fixture', true); stores.push(store);
  const vault = new ConnectionVault(join(dir, 'vault'), { forbidden: [join(dir, 'state')] });
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname, auth = new Headers(init?.headers).get('authorization') ?? '';
    calls.push(path);
    if (!/^Bearer github_pat_/.test(auth)) return Response.json({}, { status: 401 });
    if (path === '/user') return Response.json({ login: 'chayapats' });
    return Response.json([{ full_name: 'chayapats/jit-s15-sandbox', default_branch: 'main', private: true, permissions: { push: true } }]);
  }) as typeof globalThis.fetch;
  const connections = new GithubConnections({ store, vault, installationId: 'connection_fixture', fetch, now: () => 1000 });
  const stored = () => vault.read(s15CredentialKey('connection_fixture', s15GithubConnectionAlias));
  return { store, vault, connections, calls, stored, key: s15CredentialKey('connection_fixture', s15GithubConnectionAlias) };
}

test('GIT15-04: replaying an earlier connect returns its record and never restores the earlier token', async () => {
  const f = fixture();
  const first = await f.connections.connect('connect_a', token('A'));
  const second = await f.connections.connect('connect_b', token('B'));
  expect(second.revision).toBe(first.revision + 1); expect(f.connections.credential()).toBe(token('B'));
  const calls = f.calls.length;
  expect(await f.connections.connect('connect_a', token('A'))).toEqual(first);
  expect(f.calls.length).toBe(calls); expect(f.stored()).toBe(token('B')); expect(f.connections.credential()).toBe(token('B'));
  // A reused request id with another token conflicts before any verification or vault write.
  await expect(f.connections.connect('connect_b', token('C'))).rejects.toThrow('request_id_conflict');
  expect(f.calls.length).toBe(calls); expect(f.stored()).toBe(token('B'));
});

test('GIT15-04: a failed journal write restores the previous vault value', async () => {
  const f = fixture();
  await f.connections.connect('connect_a', token('A'));
  const tx = f.store.tx.bind(f.store);
  f.store.tx = (() => { throw new Error('disk full'); }) as typeof f.store.tx;
  await expect(f.connections.connect('connect_b', token('B'))).rejects.toThrow('disk full');
  f.store.tx = tx;
  expect(f.stored()).toBe(token('A')); expect(f.connections.credential()).toBe(token('A')); expect(f.connections.current()!.revision).toBe(1);
  // With no earlier token the new value is removed again.
  const g = fixture(); g.store.tx = (() => { throw new Error('disk full'); }) as typeof g.store.tx;
  await expect(g.connections.connect('connect_a', token('A'))).rejects.toThrow('disk full');
  expect(() => g.stored()).toThrow(); expect(g.connections.current()).toBeNull();
});

test('GIT15-04: credential() fails closed unless the vault holds the committed token; disconnect deletes it', async () => {
  const f = fixture();
  const record = await f.connections.connect('connect_a', token('A'));
  expect(record.tokenFingerprint).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(record)).not.toContain(token('A'));
  f.vault.write(f.key, token('Z'));
  expect(() => f.connections.credential()).toThrow('github_credential_unavailable');
  f.vault.write(f.key, token('A')); expect(f.connections.credential()).toBe(token('A'));
  f.connections.remove('remove', record.revision);
  expect(() => f.connections.credential()).toThrow('github_not_connected'); expect(() => f.stored()).toThrow();
});
