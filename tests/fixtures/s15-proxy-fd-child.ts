// Child for the inherited-socket proxy test: simulates systemd passing fd 3 named jit-s15-vm-proxy to this process.
import { startVmRegistryProxy } from '../../src/s15/vm/proxy';
import { takeInheritedSocket, vmmProxySocketName } from '../../src/s15/vm/vmm';

const path = process.argv[2]!;
const env = { LISTEN_PID: String(process.pid), LISTEN_FDS: '1', LISTEN_FDNAMES: vmmProxySocketName };
const fd = takeInheritedSocket(vmmProxySocketName, env);
if (fd !== 3) { console.log('no-socket'); process.exit(1); }
await startVmRegistryProxy({ hostname: '127.0.0.1', port: 0, socketPath: path, socketFd: fd, guestHostname: '192.168.5.100', guestPort: 3128, log: () => {} });
console.log('ready');
setTimeout(() => process.exit(0), 20_000);
