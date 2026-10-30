import type { ExecutionBackend } from "schway/host";
import type { BoxExecRequest, BoxExecResult } from "../exec/box-runtime";
import type { Envelope } from "./types";

/** Finite ceilings for each component; disk is a dedicated persistent filesystem, never a directory quota claim. */
export interface ComputerLimits {
  startupMs: number;
  cpuMillis: number;
  memoryBytes: number;
  pids: number;
  diskBytes: number;
  idleMs: number;
}
/** Logical persistent computer identity; generation fences every process, lease and queued operation. */
export interface BotComputer {
  id: string;
  botId: string;
  revision: number;
  generation: number;
  botGeneration: number;
  ownerGeneration: number;
  workId: string;
  state: "starting" | "running" | "stopping" | "stopped" | "resetting" | "deleting" | "deleted" | "unavailable";
  reason: string | null;
  limits: ComputerLimits;
  workspaceId: string;
  profileId: string;
  lastUsedAt: number;
}
/** Exclusive generation-bound input ownership; reads never create a lease. */
export interface InputLease {
  computerId: string;
  generation: number;
  revision: number;
  actor: "owner" | "agent" | null;
  attemptId: string | null;
  expiresAt: number;
}
/** Exact computer and lease query; no profile contents, runtime endpoints or host paths are exposed. */
export interface ComputerView { computer: BotComputer | null; lease: InputLease | null }
/** Existing work authority selects one Bot's computer; no new grant is inferred from opening it. */
export type OpenComputerCommand = Envelope<"computer.open", { botId: string; workId: string }>;
/** Exact lifecycle scope protects against stale reset/delete commands and cross-Bot substitution. */
export type ComputerLifecycleCommand = Envelope<"computer.stop" | "computer.reset" | "computer.delete", { botId: string; computerId: string; generation: number }>;
/** Takeover binds the current lease revision as well as the computer generation. */
export type LeaseCommand = Envelope<"takeover.start" | "takeover.end", { botId: string; computerId: string; generation: number; leaseRevision: number }>;
/** Authenticated durable computer commands share the foundation receipt boundary. */
export type ComputerCommand = OpenComputerCommand | ComputerLifecycleCommand | LeaseCommand;
/** Durable computer receipt is the committed intent; queries project eventual runtime settlement. */
export interface ComputerReceipt extends ComputerView { kind: ComputerCommand["kind"]; requestId: string }
/** Owner input remains transient inside the protected browser channel and never enters the runner or database. */
export type OwnerInput = { kind: "click"; x: number; y: number } | { kind: "text"; text: string } | { kind: "key"; key: string };
/** Phase A agent input permits only bounded scrolling of the offline read surface, never submit or arbitrary keys. */
export interface AgentInput { kind: "scroll"; deltaY: number }
/** Transient Web input envelope; its request ID is consumed before dispatch and is never automatically replayed. */
export type OwnerInputCommand = Envelope<"takeover.input", { botId: string; computerId: string; generation: number; leaseRevision: number; input: OwnerInput }>;
/** Safe retained input outcome for no-script redirects; the original input and its HMAC are never returned. */
export interface ComputerInputReceipt { requestId: string; computerId: string; state: "succeeded" | "unknown" }
/** Opaque service-only runtime handle; implementations reject copied or cross-computer handles. */
export interface ComputerHandle { readonly computerId: string; readonly generation: number }
/** Trusted isolated runtime port; final guards run immediately before each dispatch and after every wait. */
export interface ComputerRuntime {
  start(computer: BotComputer, allowed: () => void): Promise<ComputerHandle>;
  stop(computer: BotComputer): Promise<void>;
  destroy(computer: BotComputer, allowed: () => void): Promise<void>;
  exec(handle: ComputerHandle, request: BoxExecRequest, allowed: () => void): Promise<BoxExecResult>;
  input(handle: ComputerHandle, input: OwnerInput | AgentInput, allowed: () => void): Promise<void>;
  screenshot(handle: ComputerHandle, allowed: () => void): Promise<Uint8Array>;
}
/** Trusted runtime configuration; neither HTTP nor model content can replace this port or its finite ceilings. */
export interface ComputerOptions { runtime?: ComputerRuntime; limits?: ComputerLimits }
/** Attempt-bound supported Schway backend with no host execution fallback. */
export interface ComputerSession { backend: ExecutionBackend; lease: InputLease; release(): void }
