/** S15 opt-in working-VM server/API and supported conversation consumer ports. S14 remains the runtime default. */
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

export { VmPolicyIntegration } from "./policy";
export type { VmPolicyIntegrationOptions } from "./policy";
