import type { ExecutionBackend, ToolDefinition } from "schway/host";

/** Finite transport/session ceilings; none grants a spending allowance. */
export interface VmLimits {
  /** Runtime ceiling for owner-editable per-VM capacity; new enrollments still default to two. */
  maxSessions: number;
  sessionMs: number;
  commandMs: number;
  outputBytes: number;
  fileBytes: number;
  calls: number;
  networkProbeMs: number;
}
/** Conservative editable execution ceilings, independently narrowed by standing policy. */
export const defaultVmLimits: Readonly<VmLimits> = Object.freeze({ maxSessions: 16, sessionMs: 900_000,
  commandMs: 120_000, outputBytes: 1_048_576, fileBytes: 1_048_576, calls: 512, networkProbeMs: 60_000 });
/** Protected setup data. Addresses and key paths never appear in model tools/evidence. */
export interface VmEndpoint { host: string; port: number; user: string; identityFile: string; knownHostsFile: string }
/** Host-only argv execution seam. It must never interpret argv through a host shell. */
export interface VmHostCommand {
  (argv: readonly string[], options: { input?: Uint8Array; timeoutMs: number; maxBytes: number; signal?: AbortSignal;
    env?: Readonly<Record<string, string>>; beforeStart?: () => void }): Promise<{ stdout: Uint8Array; exitCode: number }>;
}
/** Independently owned hypervisor observation. Guest output is never such an observation. */
export interface VmMachineState {
  state: "running" | "stopped";
  identity: string;
  boot: string;
  cpuCount: number;
  memoryBytes: number;
  diskBytes: number;
  network: "isolated" | "proxy-only" | "unproven";
}
/** Protected, VM-scoped management. Credentials remain in this implementation, outside the guest. */
export interface VmManagement {
  inspect(): Promise<VmMachineState>;
  /** Explicit protected start never replays an old work command. */
  start?(): Promise<void>;
  stop(): Promise<void>;
  snapshot(name: string): Promise<void>;
  restore(name: string): Promise<void>;
}
/** Immutable operation supplied to the policy consumer; the payload is credential-free exact runner input. */
export interface VmPolicyOperation {
  vmId: string; generation: number; sessionId: string; workId: string; attemptId: string;
  operationId: string; kind: "setup" | "read" | "write" | "shell" | "system_admin" | "acquire";
  payloadHash: string; payload: string; timeoutMs: number; outputBytes: number;
}
/** Claim belongs to one operation. The implementation rechecks current authority at actual I/O and publication. */
export interface VmPolicyClaim {
  dispatch<T>(start: () => Promise<T>): Promise<T>;
  publish<T>(consume: () => T): T;
  observe(evidence: VmEvidence): void;
}
/** Trusted consumer seam for POLICY15. Neither guest nor model can install this port or issue its actor. */
export interface VmPolicyPort {
  assertCurrent(actor: object, scope: { vmId: string; workId: string; attemptId: string; mode: "work" | "system" }): void;
  claim(actor: object, operation: Readonly<VmPolicyOperation>): Promise<VmPolicyClaim>;
}
/** Safe metadata only. All command results are guest-reported; scoped cgroup checks are cooperative, not root-proof. */
export interface VmEvidence {
  id: string; vmId: string; sessionId: string; operationId: string; payloadHash: string;
  outcome: "not_dispatched" | "guest_reported" | "unknown";
  responseHash: string | null; outputBytes: number | null;
  transport: "pending" | "closed";
  execution: "unsettled" | "guest_scope_empty" | "vm_stopped";
  published: boolean;
}
/** One work-scoped tool session; waiting work closes it and holds no VM slot after cleanup. */
export interface VmSession {
  readonly id: string;
  readonly backend: ExecutionBackend;
  readonly definitions: readonly ToolDefinition[];
  evidence(): readonly VmEvidence[];
  /** Fences publication immediately; cleanup does not regain revoked work authority. */
  cancel(): Promise<void>;
  /** Idempotent exact-unit cleanup; uncertainty fences the shared VM and retains its capacity. */
  close(): Promise<void>;
}
/** Conversation-facing port. A system session takes an exclusive VM lease and requires a protected snapshot. */
export interface WorkingVmPort {
  openAttempt(actor: object, input: { vmId: string; workId: string; attemptId: string; signal?: AbortSignal;
    mode?: "work" | "system"; access?: "inspect" | "execute" }): Promise<VmSession>;
}
/** Owner-visible capability evidence. Configured adapters alone are unproven, never a live certification. */
export interface VmCapability { id: "network-isolated" | "snapshot-recovery" | "hypervisor-stop"; state: "proven" | "unproven" | "unavailable"; reason: string | null }
/** Bounded machine inventory; guest OS/architecture/software facts remain adversarial observations. */
export interface VmMachineFacts { architecture: string; os: string; cpuCount: number; memoryBytes: number; diskBytes: number; sudo: boolean; docker: boolean; basis: "guest_reported" }
/** Enrollment/health projection, safe for the authenticated owner API and i18n. */
export interface VmStatus {
  id: string; generation: number; state: "ready" | "unproven" | "uncertain" | "stopped";
  networkIsolated: boolean; recoveryAvailable: boolean; activeSessions: number; maxSessions: number;
  reason: string | null;
  capabilities: readonly VmCapability[];
  facts: VmMachineFacts | null;
}
