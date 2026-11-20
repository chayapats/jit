import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { readS15RuntimeConfig } from '../src/s15/runtime-config';
import { openS16InstallationLease } from '../src/s16/operations/installation-lease';
import { openS16ControlMaintenance, type S16ControlMaintenance } from '../src/s16/operations/control-maintenance';
import { captureS16LedgerSet } from '../src/s16/operations/ledger-set';
import { s16LedgerSetManifestHash, verifyS16LedgerSet } from '../src/s16/operations/verify-ledger-set';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-control-maintenance-'))); cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
  const directory = join(parent, 'state'), configPath = join(parent, 'config.json');
  writeFileSync(configPath, JSON.stringify(s15StageConfig(directory, 'http://localhost:3041')), { mode: 0o600 });
  const child = Bun.spawn([process.execPath, 'src/main.ts', 'init', '--s15', '--config', configPath], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
  expect({ exit, error }).toEqual({ exit: 0, error: '' });
  return { parent, directory, config: readS15RuntimeConfig(configPath), ownerPath: join(directory, 'owner/owner.sqlite') };
}
function maintenance(f: Awaited<ReturnType<typeof fixture>>): S16ControlMaintenance { const context = openS16ControlMaintenance(f.config); cleanup.push(() => context.close()); return context; }
function mutate(path: string, sql: string) { const db = new Database(path, { readwrite: true, create: false }); try { db.exec(sql); } finally { db.close(true); } }

test('actual selected CLI state exposes current outer/runtime control without application boot, and captures separate owner/lifecycle identities', async () => {
  const f = await fixture(), ownerBefore = readFileSync(f.ownerPath), context = maintenance(f);
  expect(context.ownerIdentity).not.toBe(f.config.installationId);
  expect(context.outer.map(source => source.name)).toContain('owner-lifecycle.sqlite'); expect(context.outer.map(source => source.name)).toContain('recipients.sqlite');
  const native = context.nativeNamespace(); expect(native.roots).toEqual([]); expect(native.pending).toEqual([]); expect(native.untracked).toEqual([]); native.assertCurrent();
  context.assertCurrent();
  expect(() => openS16InstallationLease({ directory: f.directory, mode: 'shared' })).toThrow();
  const directory = join(f.parent, 'current-cohort'); mkdirSync(directory, { mode: 0o700 });
  const sources = [...context.outer, ...context.runtime.sources], options = { directory, id: 'a'.repeat(32), installationId: f.config.installationId, sources, guard: context.assertCurrent };
  const manifest = captureS16LedgerSet(options);
  expect(verifyS16LedgerSet({ ...options, readers: sources.map(({ name, reader }) => ({ name, reader })), manifestSha256: s16LedgerSetManifestHash(manifest) })).toEqual(manifest);
  expect(readFileSync(f.ownerPath)).toEqual(ownerBefore); context.assertCurrent(); context.close();
  expect(() => context.assertCurrent()).toThrow(); const lease = openS16InstallationLease({ directory: f.directory, mode: 'shared' }); lease.close();
  const retry = maintenance(f); expect(retry.ownerIdentity).toBe(context.ownerIdentity);
});

test.each(['owner-missing', 'lifecycle-missing', 'lifecycle-identity', 'recipient-identity', 'reader', 'json', 'mode', 'unknown', 'fence', 'epoch'] as const)('invalid outer %s refuses without initialization or a leaked participating lease', async kind => {
  const f = await fixture(), recipientPath = join(f.directory, 'recipients.sqlite');
  if (kind === 'owner-missing') unlinkSync(f.ownerPath);
  if (kind === 'lifecycle-missing') unlinkSync(f.ownerPath + '.lifecycle.sqlite');
  if (kind === 'lifecycle-identity') mutate(f.ownerPath + '.lifecycle.sqlite', "UPDATE identity SET id='foreign'");
  if (kind === 'recipient-identity') mutate(recipientPath, "UPDATE identity SET installation='foreign'");
  if (kind === 'reader') mutate(f.ownerPath, 'PRAGMA user_version=99');
  if (kind === 'json') mutate(f.ownerPath, "UPDATE installation SET profile_json='{'");
  if (kind === 'mode') chmodSync(recipientPath, 0o644);
  if (kind === 'epoch') mutate(recipientPath, "UPDATE records SET json='{\"kind\":\"meta\",\"epoch\":1234567890123456}' WHERE id='meta'");
  if (kind === 'unknown') writeFileSync(join(f.directory, 'foreign.sqlite'), 'not an owning ledger', { mode: 0o600 });
  if (kind === 'fence') { const directory = f.ownerPath + '.ops'; mkdirSync(directory, { mode: 0o700 }); writeFileSync(join(directory, 'fence.json'), '{"contract":"foreign"}', { mode: 0o600 }); }
  expect(() => openS16ControlMaintenance(f.config)).toThrow();
  if (kind === 'owner-missing') expect(existsSync(f.ownerPath)).toBe(false);
  if (kind === 'lifecycle-missing') expect(existsSync(f.ownerPath + '.lifecycle.sqlite')).toBe(false);
  const lease = openS16InstallationLease({ directory: f.directory, mode: 'shared' }); lease.close();
});

test('recognized website continuity remains current when a later config no longer selects the provisioned browser', async () => {
  const f = await fixture(); expect(existsSync(join(f.directory, 'browser-sites.sqlite'))).toBe(true);
  delete f.config.disclosure;
  const context = maintenance(f); expect(context.outer.map(source => source.name)).toContain('browser-sites.sqlite'); context.assertCurrent();
});

test('an unknown owned close retains installation and runtime exclusion until the original context can actually release', async () => {
  const f = await fixture(), context = maintenance(f), database = context.outer[0]!.database, originalClose = database.close.bind(database);
  database.close = () => { throw Error('fixture-close-not-confirmed'); };
  try {
    expect(() => context.close()).toThrow(expect.objectContaining({ code: 's16_ops_source_release_unknown' }));
    expect(() => context.assertCurrent()).toThrow(); expect(() => openS16InstallationLease({ directory: f.directory, mode: 'shared' })).toThrow();
  } finally { database.close = originalClose; }
  context.close(); const lease = openS16InstallationLease({ directory: f.directory, mode: 'shared' }); lease.close();
});

test.each(['config', 'inventory', 'source', 'fence'] as const)('changed current %s fences an already-open control context', async kind => {
  const f = await fixture(), context = maintenance(f);
  if (kind === 'config') f.config.installationId = 'changed';
  if (kind === 'inventory') writeFileSync(join(f.directory, 'extra.sqlite'), 'untracked', { mode: 0o600 });
  if (kind === 'source') chmodSync(f.ownerPath, 0o400);
  if (kind === 'fence') { const directory = f.ownerPath + '.ops'; mkdirSync(directory, { mode: 0o700 }); writeFileSync(join(directory, 'capture.json'), '{}', { mode: 0o600 }); }
  expect(() => context.assertCurrent()).toThrow();
});
