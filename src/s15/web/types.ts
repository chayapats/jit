import type { Locale } from "../../i18n";
import type { FileSourcePin } from "../file-lineage";
import type { LoginState, OwnerBrowserInput } from "../browser";
import type { ConversationCommand, ConversationDecisionCommand, ConversationEvent, ConversationNeedsYou, ConversationListEntry, ConversationOwnerView, ConversationReceipt } from "../conversation";
import type { ModelBudgetView } from "../model";
import type { ActionClass, ActionRef, ActionSlip, Observation, PolicyProposal, Ref, Rule, StandingPolicy } from "../policy";
import type { RecurringFrequency, RecurringRuleProposal } from "../policy/recurring";
import type { ResponsibilityProjection } from "../work";
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
  /** MODEL15-01 `ModelService.project` (`s15-model-budget/v1`); composition adapts the owner actor. Absent until composed. */
  models?: S15WebModels<Actor>;
  /** UX15-02 owner commands on an exact held action: read-only re-check and owner statement for unknown outcomes. */
  actions?: S15WebActions<Actor>;
  /** WORK15-01 responsibilities (`s15-responsibility/v1`). Absent until composed. */
  duties?: S15WebDuties<Actor>;
  /** WORK15-02 durable stall-reply resume bindings. Required to name a responsibility from the composer. */
  resumes?: S15WebResumes<Actor>;
  /** BROW15 protected browser registrations, one per website session. Absent until composed. */
  browsers?: S15WebBrowser<Actor>[];
  /** BROW15-02 provisioned browser status and the owner's approved-website list. Absent: not composed here. */
  websites?: S15WebWebsites<Actor>;
  /** AUTH16-01 installation-wide people the owner named and remembered private-data recipients. Absent until composed. */
  recipients?: S15WebRecipients<Actor>;
  /** F13 recurring-payment rules over POLICY (`createRecurringRules`). Absent until composed. */
  recurring?: S15WebRecurring<Actor>;
  /** GIT15-04 Web GitHub connection (token, repository selection, removal). Absent: configured or not composed. */
  githubConnection?: S15WebGithubConnection<Actor>;
  /** GIT15-02 personal GitHub profile capture/install/revoke. Feature-detected until that slice is composed. */
  github?: S15WebGithub<Actor>;
  /** BIZ15 owner-only DecisionCard projection for a major change. Feature-detected until composed. */
  decisions?: (actor: Actor, action: ActionRef) => S15DecisionCard | null;
  /** TEAM15 team resources view (`s15-team-resources-view/v1`). Feature-detected until composed. */
  team?: S15WebTeam<Actor>;
  /** MIG15 adoption status (`s15-adoption-status/v1`). Feature-detected until composed. */
  adoption?: (actor: Actor) => S15AdoptionStatus | null;
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
  /** Every outstanding owner item across all conversations, not limited to the navigation or thread windows. */
  needs(actor: Actor): { conversationId: string; entry: ConversationNeedsYou }[];
  /** Owner-checked lookup of one action across all conversations (`conversationAction`), independent of navigation windows. */
  action?(actor: Actor, actionId: string): { conversationId: string; requestId: string; slips: ActionSlip[] } | null;
  /** Typed exact slip decision (`ConversationApplication.decide`). Absent: slips show no decision buttons. */
  decide?(actor: Actor, command: ConversationDecisionCommand): ConversationReceipt;
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
  /** Retained protected snapshots, newest first (`WorkingVmService.snapshots`). Absent: no restore control. */
  snapshots?(actor: Actor, id: string): { id: string; generation: number }[];
  /** Owner-authorized stop and restore (`WorkingVmService.recover`). The UI posts only after the exact restore slip. */
  restore?(actor: Actor, input: { vmId: string; snapshotId: string }): Promise<void>;
  /** SETUP15-01 automatic working computer on this controller. Absent: this installation creates no local VM. */
  local?: S15WebLocalComputer<Actor>;
  /** POOL15-01 working-computer pool. Absent: the page shows the single `vmId` computer as before. */
  pool?: S15WebComputerPool<Actor>;
}
/** Controller-observed host capability for automatic setup; never inferred from configuration. */
export interface S15LocalHost {
  state: "ready" | "missing"; code: string | null;
  facts: { cpus: number; memoryGiB: number; diskFreeGiB: number } | null;
  /** Default sizing setup will use (applies at the next VM start; editable later). */
  resources: { cpus: number; memoryMiB: number; diskGiB: number } | null;
}
/** Owner-safe projection of the durable provisioning job (`LocalVmProvisioningView`). */
export interface S15ProvisioningJob {
  state: "running" | "failed" | "enrolled"; step: string; failedStep: string | null; error: string | null;
  attempts: number; startedAt: number; stepStartedAt: number; updatedAt: number; finishedAt: number | null; active: boolean;
}
export interface S15WebLocalComputer<Actor> {
  host(actor: Actor): S15LocalHost | null;
  job(actor: Actor): S15ProvisioningJob | null;
  /** Owner "Create now" / "Try again": starts or re-runs the one job for the default computer. */
  start(actor: Actor): void;
}
/** One pool member: enrollment status plus protected placement facts. */
export interface S15PoolMember { id: string; isDefault: boolean; local: boolean; drained: boolean; activeSessions: number; capacity: number; works: number; status: VmStatus }
export interface S15WebComputerPool<Actor> {
  members(actor: Actor): S15PoolMember[];
  /** Drain (no new placement; running work finishes) or return a member to service. */
  drain(actor: Actor, vmId: string, drained: boolean): void;
  /** Composition-chosen id for the next owner-supplied computer; the owner never types one. */
  nextId(actor: Actor): string;
  /** Write-only registration of the hypervisor adapter an added computer is bound to (`VmManagers.register`). */
  registerManager?(actor: Actor, input: S15ManagerInput): void;
}
/** Owner-typed management adapter for an added computer. The Proxmox token is write-only and never echoed. */
export type S15ManagerInput = { kind: "lima"; instance: string }
  | { kind: "proxmox"; baseUrl: string; node: string; vmid: number; token: string; proxy: { address: string; port: number } };

/** Owner-typed finite amount. Currency and period come only from `budgetOptions`. */
export interface S15BudgetEntry { currency: string; spendMinor: string; periodId: string }
/** POLICY15-01 first-run seam. Composition maps the typed amount onto its protected base policy; the UI only ever sends the proposal hash to install. */
export interface S15WebRules<Actor> {
  current(actor: Actor): StandingPolicy | null;
  propose(actor: Actor, budget: S15BudgetEntry | null): PolicyProposal;
  install(actor: Actor, requestId: string, proposalHash: string): StandingPolicy;
  /** Choices readable from the selected billing route catalog. Empty lists preselect and offer nothing. */
  budgetOptions(actor: Actor): { currencies: string[]; periods: { id: string; days: number }[] };
  /** POLICY15-02 default proposal review (new, update or renewal). Absent or null: the configured-policy card. */
  review?(actor: Actor, budget: S15BudgetEntry | null): S15PolicyReview | null;
}

/** One exact row of the reviewed proposal. Labels are trusted composition names, never model text. */
export interface S15PolicyRow { kind: "bot" | "purpose" | "computer" | "browser" | "repository" | "connection" | "model" | "recipient"; id: string; label: string; detail: "subscription" | "metered" | "provider" | "github" | "work" | "interpretation" | null }
/**
 * POLICY15-02 (ADR 0073) review of the default standing policy derived from what this installation actually has.
 * `change`: `new` (nothing installed), `update` (the catalog or resources changed), `renew` (same scope, expiring or
 * expired) or `current` (installed and not yet renewable). The owner installs only `proposal.proposalHash`.
 */
export interface S15PolicyReview {
  change: "new" | "update" | "renew" | "current";
  proposal: PolicyProposal | null;
  rows: S15PolicyRow[];
  held: ActionClass[];
  /** Personal GitHub exceptions are never proposed; `kept` means one the owner installed separately carries over. */
  personalGithub: "off" | "kept";
  expiresAt: number | null;
  /** True when a selected route is metered, so the owner must type a finite budget. */
  needsBudget: boolean;
  /** Stable code explaining why installing is not possible right now, or null. */
  reason: string | null;
  /** For `current`: when renewal opens. */
  renewFrom: number | null;
  /** The same click registers these TEAM resources; the hash binds the exact list shown. */
  team: { hash: string; count: number } | null;
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
  provenance: { origin: { kind: "owner_message" | "work" | "historical"; id: string; conversationId: string | null; at: number }; scope: { kind: "team" } | { kind: "bot"; botId: string; origin: "s15" | "s14" }; filePins?: FileSourcePin[] };
  createdAt: number; lifecycle: "active" | "superseded" | "forgotten"; confirmation: "owner_stated" | "observed" | "unconfirmed";
  supersedes: string | null; correction: string | null; sourceState: "current" | "withdrawn";
}
/** Counts from `memory.impact`; previously seen model bytes cannot be recalled. */
export interface S15ForgetImpact { claims: number; sources: number; summaries: number; artifacts: number; contexts: number; nativeSessions: number; workItems: number }
/** MEM15-01 owner API: `view` and the revision-bound `s15-memory-command/v1` commands. */
export interface S15WebMemory<Actor> { view(actor: Actor): { contract: "s15-memory-view/v1"; claims: S15MemoryClaim[] }; command(actor: Actor, input: unknown): unknown }

/** MODEL15-01 read-only projection (`s15-model-budget/v1`), the real `ModelService.project` result. */
export type S15ModelBudgetView = ModelBudgetView;
export interface S15WebModels<Actor> { project(actor: Actor, workId?: string): S15ModelBudgetView }

/** POLICY owner reads/commands for one exact action revision. Neither resends nor certifies an effect. */
export interface S15WebActions<Actor> {
  /** Read-only reconciliation through the owning adapter; unknown stays unknown when the read cannot tell. */
  reconcile(actor: Actor, action: ActionRef, requestId: string): Promise<Observation>;
  /** Owner statement for an unknown outcome. It is recorded beside the action and never attests remote truth. */
  statement(actor: Actor, action: ActionRef, requestId: string, outcome: "occurred" | "did_not_occur"): void;
}
/** WORK15-01 owner seam: list/project and a scoped stop. Resume is an ordinary later owner message. */
export interface S15WebDuties<Actor> {
  list(actor: Actor): ResponsibilityProjection[];
  project(actor: Actor, id: string): ResponsibilityProjection;
  stop(actor: Actor, id: string, requestId: string): void;
  /** WORK `resume` from the owner's completed reply message; it cannot install authority or revive stopped work. */
  resume(actor: Actor, id: string, sourceRequestId: string): void;
}
/**
 * WORK15-02 port (`openResumeBindings`). The Web handler holds no resume state: the binding commits with the
 * owner's reply, settlement runs in the protected drain, and refusals are read back from the durable table.
 */
export interface S15WebResumes<Actor> {
  submit(actor: Actor, command: ConversationCommand, dutyId: string): ConversationReceipt;
  settle(): unknown;
  refusal(actor: Actor, dutyId: string): string | null;
}
/** Pinned Chromium state for Resources → Websites; `library` is a validated shared-object name. */
export type S15WebsiteEngine = import("../browser/chromium").ProtectedChromiumStatus;
/** One owner-approved website; `revision` binds a removal to the approval the owner saw. */
/** `tier` (S16-D09): `trusted` sites are used in the working VM browser; everything else stays in the protected browser. */
export interface S15ApprovedWebsite { origin: string; revision: number; addedAt: number; tier: 'trusted' | 'sensitive' }
/**
 * BROW15-02 owner seam over the protected approved-website journal. Composition verifies the owner on every
 * call. Changes apply to the next browser request without a restart; nothing here grants sending, sign-in
 * or private disclosure, which keep their own gates.
 */
/** AUTH16-01 (S16-D07 b, g) owner settings list; forgetting needs the exact registration revision. */
export interface S15WebRecipients<Actor> {
  list(actor: Actor): { people: { address: string; label: string | null; addedAt: number }[]; remembered: { grantId: string; label: string; purposeId: string; resourceId: string; dataClasses: string[]; rememberedAt: number; revision: number }[] };
  forget(actor: Actor, requestId: string, grantId: string, revision: number): void;
  forgetPerson(actor: Actor, requestId: string, address: string): void;
}
export interface S15WebWebsites<Actor> {
  status(actor: Actor): S15WebsiteEngine;
  list(actor: Actor): S15ApprovedWebsite[];
  /** Normalizes a pasted link or name to its HTTPS origin; refuses `website_*` codes. */
  add(actor: Actor, requestId: string, input: string): S15ApprovedWebsite;
  remove(actor: Actor, requestId: string, origin: string, revision: number): void;
  /** AUTH16-01: marks exactly the seen approval revision trusted or sensitive; refuses `website_sensitive_only`/`website_changed`. */
  setTier?(actor: Actor, requestId: string, origin: string, revision: number, tier: 'trusted' | 'sensitive'): S15ApprovedWebsite;
  /** Re-runs a failed Chromium provisioning; verified files are re-checked, not downloaded again. */
  retry(actor: Actor): void;
}
/** One trusted owner-input field of a website's sign-in documents, from protected registration. */
export interface S15BrowserField { name: string; kind: "type" | "click"; secret: boolean; label: string }
/** One protected website session. The UI never stores, echoes or logs what the owner types into it. */
export interface S15WebBrowser<Actor> {
  /** Stable registration id used in routes; never a URL. */
  id: string;
  /** Trusted site label from composition, for example `example.com`. */
  site: string;
  /** Whether this registration's sign-in documents ask for a second factor. */
  twoFactor: boolean;
  fields: S15BrowserField[];
  owner: {
    takeover(actor: Actor): Promise<{ generation: number }>;
    frame(actor: Actor, generation: number): Promise<Uint8Array>;
    input(actor: Actor, generation: number, input: OwnerBrowserInput): Promise<void>;
    handBack(actor: Actor, generation: number, cancel?: boolean): { generation: number; login: LoginState };
    checkSession(actor: Actor): Promise<LoginState>;
  };
}
/** F13 seam (`createRecurringRules`): exact proposal from a payment, exact install and revoke. */
export interface S15WebRecurring<Actor> {
  frequencies(): RecurringFrequency[];
  propose(actor: Actor, input: { action: ActionRef; amountCeilingMinor: string; frequencyId: string }): RecurringRuleProposal;
  install(actor: Actor, requestId: string, proposalHash: string): StandingPolicy;
  revoke(actor: Actor, requestId: string, ruleId: string): StandingPolicy;
}
/** Structural subset of GIT15-02 `GithubPersonalCapture`; installation is an explicit owner command. */
export interface S15GithubCapture {
  contract: "s15-github-personal-capture/v1"; captureId: string; expectedPolicyRevision: number;
  repositories: { repository: { resource: Ref; name: string; target: string }; protection: { known: boolean; requiredChecks: string[]; requiredApprovals: number; requireCodeOwners: boolean }; production: { consequence: "none" | "protected_gate" | "would_deploy" | "unknown" }; autoMergeAvailable: boolean; reason: string | null }[];
  publication: "off" | "personal"; merge: "off" | "personal"; ruleIds: string[]; revoke: { expectedPolicyRevision: number; ruleIds: string[] };
}
export interface S15WebGithub<Actor> {
  capture(actor: Actor): Promise<S15GithubCapture>;
  install(actor: Actor, input: { requestId: string; captureId: string; repositoryIds: string[]; publication: boolean; merge: boolean }): Promise<{ revision: number; ruleIds: string[] }>;
  revoke(actor: Actor, input: { requestId: string; expectedPolicyRevision: number; ruleIds: string[] }): void;
}
/** Structural subset of BIZ15 `EffectDecisionCard`. Option consequences are trusted adapter text; the recommendation is not. */
export interface S15DecisionCard {
  contract: "s15-effect-decision/v1"; action: ActionRef; target: string; version: number; impacts: string[];
  evidence: { id: string; revision: number; status: "fact" | "inference" | "missing"; value: string }[];
  options: { id: "apply_exact" | "investigate" | "keep"; consequence: string; reversible: boolean }[];
  recommendation: { option: "investigate" | "keep"; text: string; authority: "none" };
  /** A decision already recorded for the same impact and target; it is shown, never asked again. */
  retained?: { at: number; option: "apply_exact" | "investigate" | "keep" } | null;
}
/** Structural subset of TEAM15 `TeamResourcesView`. */
export interface S15TeamResource {
  id: string; revision: number; label: string; kind: "account" | "browser" | "workspace" | "data";
  scope: { kind: "team" } | { kind: "bot"; botId: string; origin: "s15" | "s14" };
  operations: ("read" | "write" | "input")[]; active: boolean; whoCanUse: "enabled_team" | string[]; restrictions: string[];
}
/** One not-yet-registered resource exactly as it would be registered for the team. */
export interface S15TeamCandidate {
  id: string; revision: number; label: string; kind: S15TeamResource["kind"]; scope: S15TeamResource["scope"];
  purposes: string[]; operations: S15TeamResource["operations"]; allowedBots: string[] | null;
}
export interface S15WebTeam<Actor> {
  view(actor: Actor): { contract: "s15-team-resources-view/v1"; resources: S15TeamResource[] };
  /** Resources the installed/proposed policy and composed connections reference that TEAM has not registered, with the digest of exactly these rows. Read-only. */
  pending?(actor: Actor): { items: S15TeamCandidate[]; hash: string };
  /** The owner's single confirmation of the reviewed list; refused (`team_resources_changed`) if the list differs. */
  register?(actor: Actor, requestId: string, hash: string): void;
}
/** Structural subset of MIG15 `AdoptionStatus`; the adoption command itself is out of this UI's scope. */
export interface S15AdoptionStatus {
  contract: "s15-adoption-status/v1"; state: "preparing" | "validated" | "activating" | "active_fenced" | "complete" | "rolling_back" | "rolled_back" | "discarded" | "blocked";
  selectedRuntime: "s14" | "legacy" | "s15"; reason: string | null;
  report: { sourceRuntime: "s14" | "legacy"; targetBuild: { commit: string; sha256: string }; historyRows: number; privateItems: number; pendingRequests: number; unknownEffects: number };
  historyPreserved: true; privateScopePreserved: true;
}
export type { Rule };

/** GIT15-04 owner view of the protected GitHub connection. It never contains the token or its hash. */
export interface S15GithubConnectionView {
  state: "not_connected" | "connected" | "removed"; revision: number; login: string | null;
  tokenExpiresAt: number | null; verifiedAt: number | null; truncated: boolean;
  accessible: { name: string; target: string; private: boolean; push: boolean }[];
  /** Selected repository full names. */
  selected: string[];
}
/** GIT15-04 owner commands. `connect` receives the pasted token once and keeps nothing in the Web layer. */
export interface S15WebGithubConnection<Actor> {
  view(actor: Actor): S15GithubConnectionView;
  connect(actor: Actor, requestId: string, token: string): Promise<void>;
  select(actor: Actor, requestId: string, expectedRevision: number, names: string[]): void;
  remove(actor: Actor, requestId: string, expectedRevision: number): void;
}
