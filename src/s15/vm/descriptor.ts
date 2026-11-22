import type { VmBackendDescriptor, VmBackendProfile, VmLimits } from './types';
import type { VmRegistration } from './store';

/** One shared owner/tool projection of protected resource facts and the current execution ceilings. */
export function vmBackendDescriptor(row: Pick<VmRegistration, 'id' | 'generation' | 'backend' | 'maxSessions'>, limits: Readonly<VmLimits>): VmBackendDescriptor | null {
  const b = row.backend; if (!b) return null;
  return { ...structuredClone(b.profile), contract: 's16-computer-backend/v1', computerId: row.id, generation: row.generation,
    limits: { cpuCount: b.cpuCount, memoryBytes: b.memoryBytes, diskBytes: b.diskBytes, sessions: Math.min(row.maxSessions, limits.maxSessions), commandMs: limits.commandMs, fileBytes: limits.fileBytes } };
}

/** Existing QEMU implementations retain their own network/desktop profile. Unknown versions stay null. */
export function qemuBackend(input: { implementation: string; fixture: boolean; platform?: VmBackendProfile['platform']; desktop?: boolean }): VmBackendProfile {
  return { provider: 'qemu', implementation: input.implementation, apiVersion: 'jit-qemu-management/v1', hypervisorVersion: null,
    platform: input.platform ?? null, basis: input.fixture ? 'protocol_fixture' : 'host_verified',
    features: { shell: 'available', filesystem: 'available', sudo: 'available', externalNetwork: 'restricted', browser: input.desktop ? 'available' : 'unproven', desktop: input.desktop ? 'available' : 'unavailable', coldRecovery: 'available', strongStop: 'available' } };
}
// Public clients share only the pure DTO validator; native bundles do not import host descriptor producers.
export { isVmBackendDescriptor } from '../../s16/client/computer-backend';
