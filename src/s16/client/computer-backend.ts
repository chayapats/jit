import type { VmBackendDescriptor } from '../../s15/vm/types';

/** Finite public-client validation. A descriptor grants neither authority nor native acceptance. */
export function isVmBackendDescriptor(value: unknown, computerId: string): value is VmBackendDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const d = value as VmBackendDescriptor, text = (s: unknown) => typeof s === 'string' && /^[A-Za-z0-9._/-]{1,96}$/.test(s);
  if (d.contract !== 's16-computer-backend/v1' || d.computerId !== computerId || !Number.isSafeInteger(d.generation) || d.generation < 1 || !['qemu', 'firecracker'].includes(d.provider) || !text(d.implementation) || !text(d.apiVersion) || d.hypervisorVersion !== null && !text(d.hypervisorVersion) || !['configured', 'protocol_fixture', 'host_verified'].includes(d.basis)) return false;
  if (d.platform !== null && (!d.platform || !text(d.platform.os) || !text(d.platform.architecture))) return false;
  const keys = ['shell', 'filesystem', 'sudo', 'externalNetwork', 'browser', 'desktop', 'coldRecovery', 'strongStop'] as const;
  if (!d.features || Object.keys(d.features).length !== keys.length || !keys.every(k => (k === 'externalNetwork' ? ['available', 'restricted', 'unavailable', 'unproven'] : ['available', 'unavailable', 'unproven']).includes(d.features[k]))) return false;
  const bounds = { cpuCount: 1024, memoryBytes: 2 ** 50, diskBytes: 2 ** 52, sessions: 16, commandMs: 86400000, fileBytes: 8388608 };
  return !!d.limits && Object.keys(d.limits).length === 6 && Object.entries(bounds).every(([k, max]) => { const n = d.limits[k as keyof typeof bounds]; return Number.isSafeInteger(n) && n > 0 && n <= max; });
}
