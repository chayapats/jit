import type { Locale } from "../../i18n";
import type { ConversationCommand, ConversationEvent, ConversationListEntry, ConversationOwnerView, ConversationReceipt } from "../conversation";
import type { PolicyProposal, StandingPolicy } from "../policy";
import type { VmStatus } from "../vm";
import type { VmMachineFacts } from "../vm/types";

/**
 * Consumer seams of the opt-in S15 Web UI (UX15-01). Every port is supplied by protected S15 composition;
 * the UI never builds authority, policy bodies, VM endpoints or model routes itself. An absent optional
 * port renders an honest "not available yet" state instead of inferring data.
 */
export interface S15WebPorts<Actor extends object> {
  /** Existing owner login session. The token comes from the configured cookie; CSRF is checked on every post. */
  authentication: { authenticate(token: string): { actor: Actor; csrf: string }; verifyCsrf(expected: string, supplied: unknown): void };
  conversation: S15WebConversation<Actor>;
  computer?: S15WebComputer<Actor>;
  rules?: S15WebRules<Actor>;
  accounts?: S15WebAccounts<Actor>;
  /** GIT15-01 readiness projection for a completed report-only request. Absent until that slice lands. */
  readiness?: (actor: Actor, requestId: string) => S15ReadinessReport | null;
  /** MEM15-01 owner API (`s15-memory-view/v1`). Absent until that slice is composed. */
  memory?: S15WebMemory<Actor>;
  /** MODEL15-01 read-only projection (`s15-model-budget/v1`). Absent until that slice is composed. */
  models?: S15WebModels<Actor>;
  /** Owner language preference; Accept-Language decides when absent. */
  locale?: (actor: Actor) => Locale | null;
}

/** CHAT15-01 owner surface; `s15ConversationPort` adapts the real ConversationApplication. */
export interface S15WebConversation<Actor> {
  view(actor: Actor, conversationId: string): ConversationOwnerView;
  list(actor: Actor): ConversationListEntry[];
  submit(actor: Actor, command: ConversationCommand): ConversationReceipt;
  stop(actor: Actor, requestId: string): void;
  events(actor: Actor, conversationId: string, after: number): { events: ConversationEvent[]; cursor: number };
  /** Wakes the durable queue after a committed receipt. It never resubmits anything. */
  drain(): Promise<void>;
}

/** Result of a host-initiated "check the machine": typed address, observed fingerprint and guest-reported facts. */
export interface S15MachineCheck { checkId: string; address: string; fingerprint: string; transportProfile: "ssh-sudo-systemd/v1"; facts: VmMachineFacts }
/** VM15-01 enrollment seam (the real `VmEnrollment`). One team working computer, named by composition. */
export interface S15WebComputer<Actor> {
  /** Composition-chosen id for the team's working computer; the owner never types it. */
  vmId: string;
  /** Protected hypervisor adapter configured by composition, or null for SSH-only management. */
  managerId: string | null;
  /** Owner-facing hypervisor name for the no-snapshot instruction, for example `Proxmox` or `Lima`. */
  hypervisor: string | null;
  begin(actor: Actor): Promise<{ setupId: string; publicKey: string; command: string }>;
  checkMachine(actor: Actor, input: { setupId: string; host: string; port?: number; user?: string; managerId?: string }): Promise<S15MachineCheck>;
  useMachine(actor: Actor, input: { id: string; checkId: string; fingerprint: string; transportProfile: "ssh-sudo-systemd/v1" }): Promise<VmStatus>;
  /** Throws `vm_not_enrolled` before the owner registers the machine. */
  status(actor: Actor, id: string): VmStatus;
}

/** Owner-typed finite amount. Currency and period come only from `budgetOptions`. */
export interface S15BudgetEntry { currency: string; spendMinor: string; periodId: string }
/** POLICY15-01 first-run seam. Composition maps the typed amount onto its protected base policy; the UI only ever sends the proposal hash to install. */
export interface S15WebRules<Actor> {
  current(actor: Actor): StandingPolicy | null;
  propose(actor: Actor, budget: S15BudgetEntry | null): PolicyProposal;
  install(actor: Actor, requestId: string, proposalHash: string): StandingPolicy;
  /** Choices readable from the selected billing route catalog. Empty lists preselect and offer nothing. */
  budgetOptions(actor: Actor): { currencies: string[]; periods: { id: string; days: number }[] };
}

/** Tools an account lends to the team, as trusted dictionary labels. */
export type S15AccountUse = "email_read" | "email_draft" | "calendar" | "documents" | "github" | "websites" | "model";
/** One connected or connectable account. Readiness is configured state, not a tested capability. */
export interface S15AccountRow {
  id: string; kind: "model" | "service";
  /** Trusted provider or service display name from composition, never model text. */
  label: string;
  state: "not_connected" | "configured" | "checked" | "unavailable";
  uses: S15AccountUse[];
  /** Same-origin path of the existing one-click sign-in flow; null when none is supported. */
  signInHref: string | null;
}
export interface S15WebAccounts<Actor> { list(actor: Actor): S15AccountRow[] }

/** GIT15-01 per-issue readiness, sorted by the system. Titles and details are GitHub content: plain text only. */
export interface S15ReadinessReport {
  repository: string;
  rows: { issue: number; title: string; state: "ready" | "blocked" | "owned" | "open_pr";
    facts: { kind: "scope" | "acceptance" | "blockers" | "assignee" | "branch_pr"; ok: boolean; detail: string; href: string | null }[] }[];
}

/** Structural subset of MEM15-01 `MemoryClaimView`. */
export interface S15MemoryClaim {
  id: string; revision: number; kind: "fact" | "inference"; category: "fact" | "preference" | "working_knowledge"; text: string;
  provenance: { origin: { kind: "owner_message" | "work" | "historical"; id: string; conversationId: string | null; at: number }; scope: { kind: "team" } | { kind: "bot"; botId: string; origin: "s15" | "s14" } };
  createdAt: number; lifecycle: "active" | "superseded" | "forgotten"; confirmation: "owner_stated" | "observed" | "unconfirmed";
  supersedes: string | null; correction: string | null; sourceState: "current" | "withdrawn";
}
/** Counts from `memory.impact`; previously seen model bytes cannot be recalled. */
export interface S15ForgetImpact { claims: number; sources: number; summaries: number; artifacts: number; contexts: number; nativeSessions: number; workItems: number }
/** MEM15-01 owner API: `view` and the revision-bound `s15-memory-command/v1` commands. */
export interface S15WebMemory<Actor> { view(actor: Actor): { contract: "s15-memory-view/v1"; claims: S15MemoryClaim[] }; command(actor: Actor, input: unknown): unknown }

/** Structural subset of MODEL15-01 `ModelBudgetView`. */
export interface S15ModelBudgetView {
  contract: "s15-model-budget/v1"; currency: string | null;
  ceilings: { dimension: string; ceiling: number | string | null; charged: number | string | null; measured: number | string | null; unknown: boolean }[];
  routes: { provider: string; model: string; charge: "subscription" | "metered"; availability: "available" | "unavailable" | "quota"; holdCode: string | null; selection: { route: { id: string; revision: number }; model: { id: string; revision: number }; effort: string } }[];
  pins: { workId: string; pins: { route: { id: string } | null; model: { id: string } | null; effort: string | null } }[];
  selections: { id: string; workId: string; reason: "owner_pin" | "ordinary" | "difficult" | "approved_alternative"; state: string; route: { provider: string; modelId: string }; effort: { requested: string; evidence: "requested_only" | "adapter_mapped"; providerConfirmed: false } }[];
  unsettled: number;
}
export interface S15WebModels<Actor> { project(actor: Actor, workId?: string): S15ModelBudgetView }
