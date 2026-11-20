import { startFirecrackerDaemon } from './s15/vm/firecracker/daemon';

/** Administrator-only standalone helper entry; never part of the working execution/model tool surface. */
export async function runFirecrackerHost(argv: readonly string[]): Promise<Awaited<ReturnType<typeof startFirecrackerDaemon>>> {
  if (argv.length !== 3 || !['serve', 'initialize'].includes(argv[0]!) || argv[1] !== '--config') throw Error('vm_firecracker_host_configuration_unavailable');
  return startFirecrackerDaemon(argv[2]!, { initialize: argv[0] === 'initialize' });
}

if (import.meta.main) {
  try {
    const host = await runFirecrackerHost(process.argv.slice(2)); let stopping = false;
    const stop = () => { if (stopping) return; stopping = true; void host.close().then(() => process.exit(0), () => process.exit(1)); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    // Only safe immutable identity is printed; paths, credentials and native diagnostics never are.
    process.stdout.write(JSON.stringify({ contract: 's16-firecracker-host-ready/v1', computerId: host.computerId, selectionSha256: host.selectionSha256 }) + '\n');
  } catch { process.stderr.write('vm_firecracker_host_configuration_unavailable\n'); process.exitCode = 1; }
}
