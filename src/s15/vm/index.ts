/**
 * S15 opt-in working-VM server/API and supported conversation consumer ports. S14 remains the runtime default.
 * The default S15 topology (2026-11-03) is a Jit-managed nested KVM guest (`QemuVmManagement`) on the
 * controller host; owner-supplied SSH VMs with Lima/Proxmox management remain an optional path.
 */
export { WorkingVmService } from "./service";
export type { WorkingVmOptions } from "./service";
export { VmEnrollment } from "./enrollment";
export type { VmEnrollmentInput } from "./enrollment";
export { VmStore } from "./store";
export { VmManagers } from "./managers";
export type { VmManagerInput } from "./managers";
export { createVmApi } from "./api";
export { LimaVmManagement, ProxmoxVmManagement, limaRestrictedQemu } from "./management";
export { startVmRegistryProxy, defaultVmRegistryHosts } from "./proxy";
export { defaultVmLimits } from "./types";
export type { WorkingVmPort, VmSession, VmPolicyPort, VmPolicyClaim, VmPolicyOperation, VmEvidence, VmStatus, VmCapability, VmLimits, VmManagement } from "./types";

export { QemuVmManagement, qemuArgv, qemuArgvFacts, qemuGuestNetwork, isVmLocalManagement } from "./qemu";
export type { QemuHostOptions, QemuVmIdentity, QemuMachineSpec, QemuArgvFacts, QemuProvisionOptions, QemuProc, VmLocalManagement } from "./qemu";
export { defaultLocalVmResources, validateLocalVmResources, detectLocalVmHost, localVmDiskReserve, localVmImages, localVmControllerReserve, localVmMinimum, localVmDefaultDiskGiB, ensureLocalVmImage } from "./local";
export type { LocalVmResources, LocalVmHostFacts, LocalVmImage, LocalVmHostProbe, LocalVmDownload } from "./local";
export { startLocalVmControl } from "./local-control";
export type { LocalVmControl, LocalVmControlOptions } from "./local-control";
export type { LocalVmResourceView } from "./managers";
export type { QmpExchange, QmpCommand } from "./qmp";

export { VmPolicyIntegration } from "./policy";
export type { VmPolicyIntegrationOptions } from "./policy";
