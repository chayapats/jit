import { expect, test } from 'bun:test';
import { firecrackerDaemonConfig, startFirecrackerDaemon } from '../src/s15/vm/firecracker/daemon';
import { runFirecrackerHost } from '../src/firecracker-cli';
import { firecrackerHostFixture } from './fixtures/s15-firecracker-host';

function config() { const { process: _process, ...selection } = firecrackerHostFixture().selected; return { contract: 's16-firecracker-host/v1', installationId: 'install-fixture', stateDirectory: '/var/lib/jit-firecracker', credentialFile: '/etc/jit/firecracker.token', managementPort: 34567, sshPort: 34568, guestPort: 22, selection }; }

test('closed installed helper configuration excludes control/credential state from jail and recovery trees', () => {
  expect(firecrackerDaemonConfig(config()).managementPort).toBe(34567);
  for (const patch of [{ stateDirectory: '/srv/jit/private-controller' }, { credentialFile: '/srv/jit/token' }, { stateDirectory: '/srv' }, { managementPort: 0 }, { managementPort: 34568 }, { argv: ['ignored'] }, { stateDirectory: '/var/lib/../other' }, { credentialFile: '/etc/jit/../other' }]) expect(() => firecrackerDaemonConfig({ ...config(), ...patch })).toThrow();
});

test('helper entry accepts only exact installed configuration commands, never a shell/host operation', async () => {
  for (const args of [[], ['shell', '--config', '/ignored'], ['serve', '--config'], ['serve', '--config', '/ignored', '--shell']]) await expect(runFirecrackerHost(args)).rejects.toBeInstanceOf(Error);
});

test.skipIf(process.platform === 'linux' && process.getuid?.() === 0)('this host refuses native helper startup before reading or creating any protected host file', async () => {
  await expect(startFirecrackerDaemon('/must-not-be-opened', { initialize: true })).rejects.toMatchObject({ code: 'vm_firecracker_host_configuration_unavailable' });
  await expect(runFirecrackerHost(['serve', '--config', '/must-not-be-opened'])).rejects.toMatchObject({ code: 'vm_firecracker_host_configuration_unavailable' });
});
