import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectionVault } from '../../src/exec/connections';
import { readS15RuntimeConfig } from '../../src/s15/runtime-config';
import { FirecrackerVmManagement } from '../../src/s15/vm/firecracker/client';
import { createFirecrackerManagementRelay } from '../../src/s15/vm/firecracker/rpc';
import { openS16ControlMaintenance } from '../../src/s16/operations/control-maintenance';
import { firecrackerRuntimeFixture } from '../../tests/fixtures/s15-firecracker-runtime';

/** Sidecar fixture driver: all production imports resolve to the verified copied package. */
export async function probePackagedHelperCustody(configPath: string): Promise<object> {
  const config = readS15RuntimeConfig(configPath), host = await firecrackerRuntimeFixture();
  const credential = 'fixture_package_custody_' + 'q'.repeat(40), operations: string[] = [];
  const relay = createFirecrackerManagementRelay(host.runtime(), { credential, installationId: config.installationId, port: 0 });
  let context: ReturnType<typeof openS16ControlMaintenance> | undefined;
  try {
    const managerId = '22222222-2222-4222-8222-222222222222', root = join(config.directory, 'runtime/vm-firecracker'), path = join(root, managerId + '.sqlite');
    mkdirSync(root, { mode: 0o700 });
    const binding = { kind: 'firecracker', origin: relay.origin, computerId: host.runtime().computerId, selectionSha256: host.runtime().selectionSha256 };
    const vm = new Database(join(config.directory, 'runtime/vm.sqlite'), { readwrite: true, create: false });
    try { vm.query('INSERT INTO vm_managers VALUES (?,?)').run(managerId, JSON.stringify(binding)); } finally { vm.close(true); }
    new ConnectionVault(join(config.directory, 'vault'), { forbidden: [join(config.directory, 'runtime')] }).write(managerId, credential);
    const transport = (async (input, init) => { operations.push(JSON.parse(String(init?.body)).operation); return fetch(input, init); }) as typeof fetch;
    let lost = false;
    const client = new FirecrackerVmManagement({ path, create: true, installationId: config.installationId, ...binding, fixture: { basis: 'protocol_fixture' }, credential: () => credential,
      fetch: (async (input, init) => { const response = await transport(input, init); if (!lost && JSON.parse(String(init?.body)).operation === 'submit') { lost = true; throw Error('fixture_lost_reply'); } return response; }) as typeof fetch });
    let unknown = false;
    try { await client.start(); } catch (error) { unknown = (error as { code?: string }).code === 'vm_reconciliation_required'; } finally { client.close(); }
    if (!unknown || host.starts() !== 1) throw Error('packaged_original_unknown_missing');
    operations.splice(0); const before = readFileSync(path), changes = host.journal().db.query<{ n: number }, []>('SELECT total_changes() n').get()!.n;
    const commands = host.commands.length, requests = host.requests.length;
    context = openS16ControlMaintenance(config);
    const options = { fixture: { basis: 'protocol_fixture' as const, fetch: transport } }, observation = await context.helperCustody(options);
    await observation.assertCurrent();
    const view = observation.value.helpers[0]?.view;
    if (observation.value.helpers.length !== 1 || context.firecracker.controllers[0]?.pending?.state !== 'unknown' || view?.requested?.receipt?.state !== 'committed' || operations.join(',') !== 'custody,custody' || host.commands.length !== commands || host.requests.length !== requests || host.journal().db.query<{ n: number }, []>('SELECT total_changes() n').get()!.n !== changes || !before.equals(readFileSync(path))) throw Error('packaged_helper_read_changed_state');
    const encoded = JSON.stringify(observation.value);
    if (encoded.includes(credential) || encoded.includes(host.root) || encoded.includes('invocationId') || !Object.isFrozen(view)) throw Error('packaged_helper_private_disclosure');
    await host.runtime().submit(host.mutation(50, 'stop'));
    let changed = false; try { await observation.assertCurrent(); } catch (error) { changed = (error as { code?: string }).code === 's16_ops_helper_changed'; }
    const fresh = await context.helperCustody(options);
    if (!changed || fresh.sha256 === observation.sha256 || !before.equals(readFileSync(path)) || context.firecracker.controllers[0]?.pending?.state !== 'unknown') throw Error('packaged_helper_changed_cut_accepted');
    return { basis: 'protocol_fixture', helpers: 1, helperContract: view.contract, journalFormat: view.reader.format, journalRows: view.journal.rows, cohortSha256: observation.sha256, originalController: 'unknown_preserved', originalHelper: 'committed_retained', reads: 'authenticated_custody_only', sourceBytes: 'preserved', helperChangesDuringReads: 0, hostCallsDuringReads: 0, changedCut: 'refused', privateContext: 'not_exported', aggregateBackup: 'not_exercised' };
  } finally { context?.close(); await relay.close(); await host.close(); }
}

if (import.meta.main) console.log(JSON.stringify(await probePackagedHelperCustody(Bun.argv[2]!)));
