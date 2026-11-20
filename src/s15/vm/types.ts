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
/** Protected connection identity; a vsock selection is usable only through its verified host forwarder. */
export type VmPhysicalBinding = { kind: "nic"; mac: string } | {
  kind: "firecracker-vsock"; instanceId: string; guestCid: number; guestPort: number; selectionSha256: string;
};
/** Independently owned hypervisor observation. Guest output is never such an observation. */
export interface VmMachineState {
  state: "running" | "stopped";
  identity: string;
  boot: string;
  cpuCount: number;
  memoryBytes: number;
  diskBytes: number;
  network: "isolated" | "proxy-only" | "unproven";
  /** NIC identity read from protected hypervisor configuration, never from a guest report. */
  nicMac?: string;
  /**
   * Alternative to nicMac. Only the protected manager may supply this after verifying its exact host
   * process/jail/disk selection and guarded host-initiated vsock forwarder. API/guest metadata alone
   * must never populate it. The forwarder's exact loopback endpoint is required in sshEndpoint.
   */
  binding?: VmPhysicalBinding;
  /** Lima/local QEMU protected host-forward binds the loopback SSH endpoint as well as the NIC. */
  sshEndpoint?: { host: string; port: number };
}
/** Protected, VM-scoped management. Credentials remain in this implementation, outside the guest. */
export interface VmManagement {
  /** Protected implementation facts; absent facts stay unknown rather than inferred from a display label. */
  readonly backend?: VmBackendProfile;
  inspect(): Promise<VmMachineState>;
  /** Explicit protected start never replays an old work command. */
  start?(): Promise<void>;
  stop(): Promise<void>;
  snapshot(name: string): Promise<void>;
  restore(name: string): Promise<void>;
  /** Deletes only an exact protected recovery tag, after the service checks active fences. */
  retireSnapshot(name: string): Promise<void>;
  /**
   * Optional controller-boot re-attachment for Jit-managed local VMs: starts the VM again only if it was
   * running before a host restart, and returns whether a new boot began. Owner-stopped or restored VMs stay
   * stopped. The caller re-verifies identity and egress before admitting work.
   */
  resume?(signal?: AbortSignal): Promise<boolean>;
  /**
   * Optional hook after the caller re-verified a VM that survived a controller restart (DESK16-01: a desktop VM
   * gets a fresh desktop browser lease, since the restarted proxy holds none). Failure never fences the VM.
   */
  reattached?(signal?: AbortSignal): Promise<void>;
}
/** Immutable operation supplied to the policy consumer; the payload is credential-free exact runner input. */
export interface VmPolicyOperation {
  vmId: string; generation: number; sessionId: string; workId: string; attemptId: string;
  operationId: string; kind: "setup" | "read" | "write" | "shell" | "system_admin" | "acquire";
  payloadHash: string; payload: string; timeoutMs: number; outputBytes: number;
}
/** Claim belongs to one operation. The implementation rechecks current authority at actual I/O and publication. */
export interface VmPolicyClaim {
  /** Original live action fence after transport preparation waits; never a replay/new claim. */
  guard?(): void;
  dispatch<T>(start: () => Promise<T>): Promise<T>;
  publish<T>(consume: () => T): T;
  observe(evidence: VmEvidence): void;
  /** Drops ephemeral invocation data on every terminal path; never refunds or erases durable claims. */
  release?(): void;
}
/** Trusted consumer seam for POLICY15. Neither guest nor model can install this port or issue its actor. */
export interface VmPolicyPort {
  assertCurrent(actor: object, scope: { vmId: string; workId: string; attemptId: string; mode: "work" | "system" }): void;
  claim(actor: object, operation: Readonly<VmPolicyOperation>): Promise<VmPolicyClaim>;
  /** Protected host lifecycle cleanup, including expired/revoked sessions. Drops only unclaimed held
   * invocation data for this exact session scope; durable actions, approvals and claims remain intact. */
  releaseSession?(scope: Pick<VmPolicyOperation, "vmId" | "workId" | "attemptId" | "sessionId" | "generation">): void;
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
  /**
   * FILE16-01C host-only bounded byte transfer inside this session's work root, present only for execution
   * sessions. Each call is one separately claimed VM write/read under the session's current guards. `put`
   * writes under a service-chosen `inputs/<id>/<name>` path; `take` reads one regular file (no symlink in any
   * path component) within the work root. Neither is a model tool; the protected file workflow owns them.
   */
  readonly transfer?: VmTransfer;
}
/** Bounded protected byte transfer of one execution session; see `VmSession.transfer`. */
export interface VmTransfer {
  put(input: { id: string; name: string; bytes: Uint8Array }): Promise<string>;
  take(path: string): Promise<Uint8Array>;
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
  /** Versioned placement facts. Configuration is never a live isolation/settlement certificate. */
  backend?: VmBackendDescriptor | null;
}
/** Supported implementation profile; only the owning management adapter constructs it. */
export interface VmBackendProfile {
  provider: "qemu" | "firecracker"; implementation: string; apiVersion: string;
  hypervisorVersion: string | null; platform: { os: string; architecture: string } | null;
  basis: "configured" | "protocol_fixture" | "host_verified";
  features: Record<"shell" | "filesystem" | "sudo" | "externalNetwork" | "browser" | "desktop" | "coldRecovery" | "strongStop", "available" | "unavailable" | "unproven">;
}
/** Credential-free finite capability projection used before choosing a computer. */
export interface VmBackendDescriptor extends VmBackendProfile {
  contract: "s16-computer-backend/v1"; computerId: string; generation: number;
  limits: { cpuCount: number; memoryBytes: number; diskBytes: number; sessions: number; commandMs: number; fileBytes: number };
}
