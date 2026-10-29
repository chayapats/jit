import { writeAttachmentEvent } from "../attachments/records";
import type { OutboundMatch } from "../security/outbound-guard";
import { createHash } from "node:crypto";
import { AppError } from "../errors";
import { requireId } from "../sources";
import type { AppTransaction } from "../store";
import { assertExecutionAllowed } from "./access";

/**
 * app.approval_cards/v1, app.auto_approve/v1 and the owner-named effect targets (EXE07, ADR 0037 § Effect tools and
 * approval cards).
 *
 * A model reaches an external effect only by calling a Jit effect tool at the `full` level. The call never performs
 * the effect: it validates the input, pins the exact action (destination, refs and SHAs, endpoint, body) and inserts
 * an `approval_cards` row holding the canonical action JSON and its SHA-256 digest, then returns `pending_approval`.
 * Only the owner decides a card (`approval.decide`, bound to the card's digest and revision, single use, expiring), or
 * an owner-written Web-only auto-approve rule. Approval moves the card to `executing` in the same transaction as its
 * receipt; the effect executor then runs it exactly once outside every box. A crash during `executing` reconciles to
 * `unknown` and is never retried automatically. Model output, retrieved content and tool results never decide a card.
 */
export type EffectKind = "effect.git_push" | "effect.github_pr_create" | "effect.github_comment" | "effect.github_pr_merge" | "effect.deploy" | "mcp_tool" | "browser_confirm"
  | "computer_confirm" | "outbound_release";
export const effectKinds: readonly EffectKind[] = Object.freeze(["effect.git_push", "effect.github_pr_create", "effect.github_comment", "effect.github_pr_merge", "effect.deploy", "mcp_tool",
  "browser_confirm", "computer_confirm", "outbound_release"]);
/**
 * Kinds an owner auto-approve rule may decide. A browser or computer confirm action always waits for the owner
 * (ADR 0039): there is no rule for either.
 */
export const autoApproveKinds: readonly EffectKind[] = Object.freeze(["effect.git_push", "effect.github_pr_create", "effect.github_comment", "effect.github_pr_merge", "effect.deploy", "mcp_tool"]);
/**
 * Card kinds whose effect runs inside the project box or an MCP sidecar through a registered performer
 * ({@link EffectExecutorOptions.performers}), rather than from Jit with a released connection.
 */
export const inBoxKinds: readonly EffectKind[] = Object.freeze(["mcp_tool", "browser_confirm", "computer_confirm"]);
/**
 * The level a card of `kind` needs from its proposing role, when it is created, decided and run. The EXE07 effects
 * need `full`; an `mcp_tool` card needs `workspace`, the level MCP servers are installed and run at (ADR 0038), and a
 * `browser_confirm` card the level browser tools run at (ADR 0039). A `computer_confirm` card needs `full`, like
 * computer-use itself.
 */
export function cardLevel(kind: EffectKind, action?: EffectAction): "read" | "workspace" | "full" {
  if (kind === "outbound_release") return action?.kind === "outbound_release" ? action.level ?? "read" : "read";
  return kind === "mcp_tool" || kind === "browser_confirm" ? "workspace" : "full";
}
/** Kinds whose rule scope is a remote or deploy target (the Settings › Approvals form); `mcp_tool` rules are per tool. */
export const targetRuleKinds: readonly EffectKind[] = Object.freeze(["effect.git_push", "effect.github_pr_create", "effect.github_comment", "effect.github_pr_merge", "effect.deploy"]);
/** Most bytes of the canonical arguments of one `mcp_tool` card. */
export const maximumMcpArgumentBytes = 65_536;
/** Most server/tool pairs one `mcp_tool` auto-approve rule names. */
export const maximumRuleTools = 64;
export type CardState = "pending" | "approved" | "denied" | "expired" | "executing" | "succeeded" | "failed" | "unknown";
/** How long a card can be decided (ADR 0037: 30 minutes). */
export const cardLifetimeMs = 30 * 60_000;
/** Most ref updates one `effect.git_push` card may pin. */
export const maximumRefUpdates = 8;
/** Most commit summaries a git push card shows. */
export const maximumCommitSummaries = 20;

const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const GITHUB_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** A conservative branch name: no `..`, no leading `-` or `/`, no `@{`, no control or special characters. */
export function validBranch(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) && !value.includes("..") && !value.includes("//") &&
    !value.endsWith("/") && !value.endsWith(".lock") && !value.endsWith(".");
}
/** A relative repository path inside the workspace (`.` for the workspace itself). */
export function validRepository(value: unknown): value is string {
  return typeof value === "string" && (value === "." || (/^[A-Za-z0-9._-][A-Za-z0-9._/-]{0,199}$/.test(value) &&
    value.split("/").every(part => part !== "" && part !== "." && part !== "..")));
}
const text = (value: unknown, max: number, allowEmpty = false): value is string => typeof value === "string" && value.isWellFormed() &&
  (allowEmpty || value.trim().length > 0) && Buffer.byteLength(value) <= max && !/[\u0000]/.test(value);

/** A pinned destination remote: the owner-configured name, URL and revision of the remote when the card was made. */
export interface PinnedRemote { name: string; url: string; revision: number }
/** One pinned ref update: `refs/heads/<branch>: <oldSha> → <newSha>`; `oldSha: null` creates the branch. */
export interface RefUpdate { ref: string; oldSha: string | null; newSha: string }
export type EffectAction = (
  | { kind: "effect.git_push"; remote: PinnedRemote; repository: string; updates: RefUpdate[]; commits: { sha: string; summary: string }[] }
  | { kind: "effect.github_pr_create"; remote: PinnedRemote; github: GitHubTarget; base: string; head: string; title: string; body: string; draft: boolean }
  | { kind: "effect.github_comment"; remote: PinnedRemote; github: GitHubTarget; issueNumber: number; body: string }
  | { kind: "effect.github_pr_merge"; remote: PinnedRemote; github: GitHubTarget; pullNumber: number; headSha: string; method: "merge" | "squash" | "rebase" }
  | { kind: "effect.deploy"; target: { name: string; url: string; revision: number }; ref: string | null }
  | McpToolAction
  | BrowserConfirmAction
  | ComputerConfirmAction
  | OutboundReleaseAction) & { outbound?: OutboundMatch };
/** One exact held outbound service call; provider revision and context generation prevent later configuration or deletion from changing it. */
export interface OutboundReleaseAction {
  kind: "outbound_release"; tool: "web_search" | "web_fetch" | "browser_open" | "browser_type" | "computer_type" | "mcp_tool"; subject: string; matchedSpan: string;
  level?: "read" | "workspace" | "full";
  release?: McpToolAction | BrowserConfirmAction | ComputerConfirmAction | BrowserOpenAction;
  outbound?: OutboundMatch;
  providerRevision: number; contextId: string; contextGeneration: number; ownerGeneration: number;
}
/** Exact held navigation, bound to the existing browser session and its current page. */
export interface BrowserOpenAction { kind: "browser_open"; url: string; pageUrl: string }
/** The intent a model declares for a computer action. Untrusted: it can only add a card, never remove one (ADR 0039). */
export type ComputerIntent = "input" | "navigate" | "submit" | "confirm";
export const computerIntents: readonly ComputerIntent[] = Object.freeze(["input", "navigate", "submit", "confirm"]);
/** Why Jit put a computer action behind a card. */
export type ComputerReason = "declared_submit" | "declared_confirm" | "enter_key" | "line_break" | "confirm_every_action" | "outbound_text";
export const computerReasonCodes: readonly ComputerReason[] = Object.freeze(["declared_submit", "declared_confirm", "enter_key", "line_break", "confirm_every_action", "outbound_text"]);
/** exec.computer/v1 (EXE16): one paused desktop action with its exact input, the declared intent and Jit's reasons. */
export interface ComputerConfirmAction {
  kind: "computer_confirm"; operation: "click" | "type" | "key";
  x: number | null; y: number | null; text: string | null; keys: string[] | null;
  intent: ComputerIntent; reasons: ComputerReason[];
}
/** app.mcp_servers/v1 (EXE12): one call of a gated MCP tool with its exact arguments, pinned to the server revision. */
export interface McpToolAction { kind: "mcp_tool"; server: { id: string; name: string; revision: number }; tool: string; arguments: Record<string, unknown> }
/** Why Jit classified a browser action as a confirm action (ADR 0039). */
export type ConfirmReason = "submit_control" | "confirm_word" | "line_break" | "outbound_text";
export const confirmReasons: readonly ConfirmReason[] = Object.freeze(["submit_control", "confirm_word", "line_break", "outbound_text"]);
/**
 * exec.browser/v1 (EXE14): one paused browser confirm action, pinned to the page URL and the element. For text typed
 * into a password field the card holds only `textDigest` (SHA-256), never the value.
 */
export interface BrowserConfirmAction {
  kind: "browser_confirm"; operation: "click" | "type"; url: string;
  element: { ref: string; tag: string; name: string };
  /** Names of the enclosing form's fields (never their values). */
  formFields: string[];
  text: string | null; textDigest: string | null; reasons: ConfirmReason[];
}
/** An MCP tool name as the server listed it: printable, no whitespace, at most 128 characters. */
export const validMcpToolName = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.\/-]{1,128}$/.test(value);
const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** The GitHub repository and API base of a remote; only these endpoints are ever called for its cards. */
export interface GitHubTarget { owner: string; repo: string; apiBase: string }

/** Deterministic JSON with sorted object keys; the digest input. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
/** SHA-256 hex of the canonical action JSON; `approval.decide` must name it. */
export function actionDigest(action: EffectAction): string {
  return createHash("sha256").update(canonicalJson(action)).digest("hex");
}

/**
 * Validates a complete pinned action (`invalid_effect_action`). The service builds actions; this guards storage and
 * replay so a card can never hold an action the executor would interpret differently.
 */
export function validateAction(action: EffectAction): void {
  const invalid = () => new AppError("invalid_effect_action");
  const remote = (value: PinnedRemote) => {
    if (!value || !NAME.test(value.name) || !validRemoteUrl(value.url) || !Number.isSafeInteger(value.revision) || value.revision < 1) throw invalid();
  };
  const github = (value: GitHubTarget) => {
    if (!value || !GITHUB_PART.test(value.owner) || !GITHUB_PART.test(value.repo) || !validApiBase(value.apiBase)) throw invalid();
  };
  if (!action || typeof action !== "object") throw invalid();
  if (action.outbound && (!Number.isSafeInteger(action.outbound.chars) || action.outbound.chars < 24 || !text(action.outbound.span, 256))) throw invalid();
  if (action.outbound?.attachmentId) requireId(action.outbound.attachmentId);
  switch (action.kind) {
    case "outbound_release":
      if (!["web_search", "web_fetch", "browser_open", "browser_type", "computer_type", "mcp_tool"].includes(action.tool) || !text(action.subject, maximumMcpArgumentBytes) || !text(action.matchedSpan, 256) ||
          !Number.isSafeInteger(action.providerRevision) || action.providerRevision < 0 || !Number.isSafeInteger(action.contextGeneration) || action.contextGeneration < 1 ||
          !Number.isSafeInteger(action.ownerGeneration) || action.ownerGeneration < 1) throw invalid();
      requireId(action.contextId);
      if (action.tool === "web_search" || action.tool === "web_fetch") {
        if (action.level !== undefined && action.level !== "read" || action.release !== undefined) throw invalid();
      } else {
        const level = action.tool === "computer_type" ? "full" : "workspace";
        if (action.level !== level || !action.release) throw invalid();
        const kind = action.tool === "browser_type" ? "browser_confirm" : action.tool === "computer_type" ? "computer_confirm" : action.tool;
        if (action.release.kind !== kind) throw invalid();
        if (action.release.kind === "browser_open") {
          for (const url of [action.release.url, action.release.pageUrl]) { try { if (!["http:", "https:", "about:"].includes(new URL(url).protocol)) throw invalid(); } catch { throw invalid(); } }
          if (action.release.url.length > 2048 || action.release.pageUrl.length > 2048) throw invalid();
        } else validateAction(action.release);
      }
      return;
    case "effect.git_push": {
      remote(action.remote);
      if (!validRepository(action.repository) || !Array.isArray(action.updates) || action.updates.length < 1 || action.updates.length > maximumRefUpdates) throw invalid();
      const refs = new Set<string>();
      for (const update of action.updates) {
        if (!update || typeof update.ref !== "string" || !update.ref.startsWith("refs/heads/") || !validBranch(update.ref.slice(11)) ||
            refs.has(update.ref) || !SHA.test(update.newSha) || !(update.oldSha === null || SHA.test(update.oldSha)) || update.oldSha === update.newSha) throw invalid();
        refs.add(update.ref);
      }
      if (!Array.isArray(action.commits) || action.commits.length > maximumCommitSummaries ||
          action.commits.some(commit => !commit || !SHA.test(commit.sha) || !text(commit.summary, 300, true))) throw invalid();
      return;
    }
    case "effect.github_pr_create":
      remote(action.remote); github(action.github);
      if (!validBranch(action.base) || !validBranch(action.head) || !text(action.title, 256) || !text(action.body, 65_536, true) || typeof action.draft !== "boolean") throw invalid();
      return;
    case "effect.github_comment":
      remote(action.remote); github(action.github);
      if (!Number.isSafeInteger(action.issueNumber) || action.issueNumber < 1 || !text(action.body, 65_536)) throw invalid();
      return;
    case "effect.github_pr_merge":
      remote(action.remote); github(action.github);
      if (!Number.isSafeInteger(action.pullNumber) || action.pullNumber < 1 || !SHA.test(action.headSha) || !["merge", "squash", "rebase"].includes(action.method)) throw invalid();
      return;
    case "effect.deploy":
      if (!action.target || !NAME.test(action.target.name) || !validHttpsUrl(action.target.url) || !Number.isSafeInteger(action.target.revision) ||
          action.target.revision < 1 || !(action.ref === null || validBranch(action.ref) || SHA.test(action.ref))) throw invalid();
      return;
    case "browser_confirm": {
      const singleLine = (value: unknown, max: number) => typeof value === "string" && value.isWellFormed() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
      const typed = action.operation === "type";
      if ((action.operation !== "click" && !typed) || !singleLine(action.url, 2048) || !action.element || !/^e\d{1,12}$/.test(action.element.ref) ||
          !/^[a-z][a-z0-9-]{0,31}$/.test(action.element.tag) || !singleLine(action.element.name, 200) || !Array.isArray(action.formFields) ||
          action.formFields.length > 32 || action.formFields.some(name => !singleLine(name, 64)) || !Array.isArray(action.reasons) || action.reasons.length < 1 ||
          action.reasons.some(reason => !confirmReasons.includes(reason)) || new Set(action.reasons).size !== action.reasons.length) throw invalid();
      if (typed ? !((typeof action.text === "string" && action.text.isWellFormed() && Buffer.byteLength(action.text) <= 4096 && action.textDigest === null) ||
          (action.text === null && typeof action.textDigest === "string" && /^[0-9a-f]{64}$/.test(action.textDigest)))
        : action.text !== null || action.textDigest !== null) throw invalid();
      return;
    }
    case "computer_confirm": {
      const int = (value: unknown, max: number) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < max;
      const shape = action.operation === "click" ? int(action.x, 1280) && int(action.y, 800) && action.text === null && action.keys === null
        : action.operation === "type" ? action.x === null && action.y === null && typeof action.text === "string" && action.text.length >= 1 && [...action.text].length <= 2000 &&
          action.text.isWellFormed() && !action.text.includes("\u0000") && action.keys === null
        : action.operation === "key" ? action.x === null && action.y === null && action.text === null && Array.isArray(action.keys) && action.keys.length >= 1 && action.keys.length <= 16 &&
          action.keys.every(key => typeof key === "string" && /^[A-Za-z0-9_]{1,32}(\+[A-Za-z0-9_]{1,32}){0,3}$/.test(key) && !/(^|\+)0x/i.test(key))
        : false;
      if (!shape || !computerIntents.includes(action.intent) || !Array.isArray(action.reasons) || action.reasons.length < 1 ||
          action.reasons.some(reason => !computerReasonCodes.includes(reason)) || new Set(action.reasons).size !== action.reasons.length) throw invalid();
      return;
    }
    case "mcp_tool":
      if (!action.server || typeof action.server.id !== "string" || !/^[a-f0-9-]{36}$/.test(action.server.id) || !NAME.test(action.server.name) ||
          !Number.isSafeInteger(action.server.revision) || action.server.revision < 1 || !validMcpToolName(action.tool) || !plainObject(action.arguments) ||
          Buffer.byteLength(canonicalJson(action.arguments)) > maximumMcpArgumentBytes) throw invalid();
      return;
    default: throw invalid();
  }
}

/** An https URL without credentials, query or fragment. */
export function validHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.hostname.length > 0;
}
/** A git remote URL: https only (no ssh, file or other transports, no embedded credentials). */
export const validRemoteUrl = validHttpsUrl;
/** A GitHub REST API base: https, no path beyond an optional prefix. */
export const validApiBase = validHttpsUrl;

// ---------------------------------------------------------------------------
// Owner-named targets: git remotes and deploy targets (Web only)
// ---------------------------------------------------------------------------

/** An owner-configured git remote of a project, with its optional GitHub repository and the bound connection. */
export interface GitRemote { projectId: string; name: string; revision: number; url: string; github: GitHubTarget | null; connectionId: string; removed: boolean; updatedAt: number }
/** An owner-named deploy target: the deploy hook URL and the connection that authorizes it. */
export interface DeployTarget { projectId: string; name: string; revision: number; url: string; connectionId: string; removed: boolean; updatedAt: number }

export interface SetEffectTargetCommand {
  kind: "effect.target.set"; requestId: string; projectId: string; expectedRevision: number;
  payload: { target: "git_remote"; name: string; url: string; github: GitHubTarget | null; connectionId: string }
    | { target: "deploy"; name: string; url: string; connectionId: string };
}
export interface RemoveEffectTargetCommand {
  kind: "effect.target.remove"; requestId: string; projectId: string; expectedRevision: number;
  payload: { target: "git_remote" | "deploy"; name: string };
}
/** app.auto_approve/v1: sets (or disables) the project's rule for one effect kind. Web only. */
export interface SetAutoApproveCommand {
  kind: "approval.rule.set"; requestId: string; projectId: string; expectedRevision: number;
  payload: { effectKind: EffectKind; scope: AutoApproveScope; enabled: boolean };
}
/** app.approval_cards/v1: the owner's decision on one card, bound to its digest; `expectedRevision` is the card revision. */
export interface DecideCardCommand {
  kind: "approval.decide"; requestId: string; projectId: string; expectedRevision: number;
  payload: { cardId: string; digest: string; decision: "approve" | "deny" };
}
export type ApprovalCommand = DecideCardCommand | SetAutoApproveCommand | SetEffectTargetCommand | RemoveEffectTargetCommand;
const approvalKinds = new Set(["approval.decide", "approval.rule.set", "effect.target.set", "effect.target.remove"]);
export function isApprovalCommand(command: unknown): command is ApprovalCommand {
  return !!command && typeof command === "object" && approvalKinds.has((command as { kind?: unknown }).kind as string);
}

/**
 * Which cards an auto-approve rule decides. Every field must match exactly: git pushes to `remote` whose every
 * branch is one of `branches`; GitHub effects on `remote`; deploys to `target`; `mcp_tool` calls whose installed
 * server name and tool name are one of the listed pairs (ADR 0038: per tool, never a whole server).
 */
export type AutoApproveScope = { remote: string; branches: string[] } | { remote: string } | { target: string } | { tools: { server: string; tool: string }[] };
export interface AutoApproveRule { projectId: string; effectKind: EffectKind; revision: number; scope: AutoApproveScope; enabled: boolean; channel: string; createdAt: number }

const exact = (value: unknown, keys: string[]) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const requestIdPattern = /^[a-zA-Z0-9_-]{8,128}$/;

function validScope(kind: EffectKind, scope: unknown): scope is AutoApproveScope {
  if (kind === "mcp_tool") {
    const tools = (scope as { tools?: unknown }).tools;
    return exact(scope, ["tools"]) && Array.isArray(tools) && tools.length >= 1 && tools.length <= maximumRuleTools &&
      tools.every(item => exact(item, ["server", "tool"]) && NAME.test((item as { server: string }).server) && validMcpToolName((item as { tool: unknown }).tool)) &&
      new Set(tools.map(item => `${(item as { server: string }).server}\u0000${(item as { tool: string }).tool}`)).size === tools.length;
  }
  if (kind === "effect.git_push") return exact(scope, ["remote", "branches"]) && NAME.test((scope as { remote: string }).remote) &&
    Array.isArray((scope as { branches: unknown[] }).branches) && (scope as { branches: unknown[] }).branches.length >= 1 &&
    (scope as { branches: unknown[] }).branches.length <= 16 && (scope as { branches: unknown[] }).branches.every(validBranch);
  if (kind === "effect.deploy") return exact(scope, ["target"]) && NAME.test((scope as { target: string }).target);
  return exact(scope, ["remote"]) && NAME.test((scope as { remote: string }).remote);
}

/** Validates the exact shape of an approval command (`invalid_approval_command`) and returns its receipt identity. */
export function approvalCommandIdentity(command: ApprovalCommand): string {
  const invalid = () => new AppError("invalid_approval_command");
  if (!isApprovalCommand(command) || !exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) ||
      typeof command.requestId !== "string" || !requestIdPattern.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) throw invalid();
  requireId(command.projectId);
  const p = command.payload as Record<string, unknown>;
  if (command.kind === "approval.decide") {
    if (!exact(p, ["cardId", "digest", "decision"]) || typeof p.digest !== "string" || !/^[0-9a-f]{64}$/.test(p.digest) ||
        (p.decision !== "approve" && p.decision !== "deny")) throw invalid();
    requireId(p.cardId);
  } else if (command.kind === "approval.rule.set") {
    if (!exact(p, ["effectKind", "scope", "enabled"]) || !autoApproveKinds.includes(p.effectKind as EffectKind) ||
        !validScope(p.effectKind as EffectKind, p.scope) || typeof p.enabled !== "boolean") throw invalid();
  } else if (command.kind === "effect.target.set") {
    if (p.target === "git_remote") {
      if (!exact(p, ["target", "name", "url", "github", "connectionId"]) || !NAME.test(p.name as string) || !validRemoteUrl(p.url)) throw invalid();
      const github = p.github as GitHubTarget | null;
      if (github !== null && (!exact(github, ["owner", "repo", "apiBase"]) || !GITHUB_PART.test(github.owner) || !GITHUB_PART.test(github.repo) || !validApiBase(github.apiBase))) throw invalid();
    } else if (p.target === "deploy") {
      if (!exact(p, ["target", "name", "url", "connectionId"]) || !NAME.test(p.name as string) || !validHttpsUrl(p.url)) throw invalid();
    } else throw invalid();
    requireId(p.connectionId);
  } else if (!exact(p, ["target", "name"]) || (p.target !== "git_remote" && p.target !== "deploy") || !NAME.test(p.name as string)) throw invalid();
  return canonicalJson([command.kind, command.projectId, command.expectedRevision, p]);
}

/**
 * Web-only power: auto-approve rules and effect targets widen what can happen without a per-card decision, so only
 * the owner in Web writes them (`approval_rule_requires_web`, 403); Telegram, the local API and models never do.
 */
export function requireApprovalConfigChannel(channel: string): void {
  if (channel !== "web") throw new AppError("approval_rule_requires_web", 403);
}

function remoteRow(tx: AppTransaction, projectId: string, name: string): GitRemote | null {
  const row = tx.get<{ revision: number; url: string; github_json: string | null; connection_id: string; removed: number; created_at: number }>(
    "SELECT revision, url, github_json, connection_id, removed, created_at FROM git_remotes WHERE project_id = ? AND name = ? ORDER BY revision DESC LIMIT 1", projectId, name);
  return row ? { projectId, name, revision: row.revision, url: row.url, github: row.github_json ? JSON.parse(row.github_json) : null,
    connectionId: row.connection_id, removed: row.removed === 1, updatedAt: row.created_at } : null;
}
function deployRow(tx: AppTransaction, projectId: string, name: string): DeployTarget | null {
  const row = tx.get<{ revision: number; url: string; connection_id: string; removed: number; created_at: number }>(
    "SELECT revision, url, connection_id, removed, created_at FROM deploy_targets WHERE project_id = ? AND name = ? ORDER BY revision DESC LIMIT 1", projectId, name);
  return row ? { projectId, name, revision: row.revision, url: row.url, connectionId: row.connection_id, removed: row.removed === 1, updatedAt: row.created_at } : null;
}
/** The current (not removed) git remote of a project, or null. */
export function readRemote(tx: AppTransaction, projectId: string, name: string): GitRemote | null {
  const remote = remoteRow(tx, projectId, name);
  return remote && !remote.removed ? remote : null;
}
/** The current (not removed) deploy target of a project, or null. */
export function readDeployTarget(tx: AppTransaction, projectId: string, name: string): DeployTarget | null {
  const target = deployRow(tx, projectId, name);
  return target && !target.removed ? target : null;
}
/** Every current git remote and deploy target of a project. Metadata only; no connection value. */
export function readEffectTargets(tx: AppTransaction, projectId: string): { remotes: GitRemote[]; deploys: DeployTarget[] } {
  const names = (table: string) => tx.all<{ name: string }>(`SELECT DISTINCT name FROM ${table} WHERE project_id = ? ORDER BY name`, projectId).map(row => row.name);
  return {
    remotes: names("git_remotes").map(name => readRemote(tx, projectId, name)).filter((item): item is GitRemote => !!item),
    deploys: names("deploy_targets").map(name => readDeployTarget(tx, projectId, name)).filter((item): item is DeployTarget => !!item),
  };
}

/** Appends the next revision of a git remote or deploy target (`stale_revision`); the connection must exist and serve the project. */
export function writeEffectTarget(tx: AppTransaction, command: SetEffectTargetCommand | RemoveEffectTargetCommand, now: number): GitRemote | DeployTarget | { removed: true; name: string } {
  const p = command.payload, isRemote = p.target === "git_remote";
  const current = isRemote ? remoteRow(tx, command.projectId, p.name) : deployRow(tx, command.projectId, p.name);
  if ((current?.revision ?? 0) !== command.expectedRevision) throw new AppError("stale_revision", 409);
  const next = (current?.revision ?? 0) + 1;
  if (command.kind === "effect.target.remove") {
    if (!current || current.removed) throw new AppError("effect_target_not_found", 404);
    if (isRemote) tx.run("INSERT INTO git_remotes (project_id, name, revision, url, github_json, connection_id, removed, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
      command.projectId, p.name, next, current.url, (current as GitRemote).github ? JSON.stringify((current as GitRemote).github) : null, current.connectionId, now);
    else tx.run("INSERT INTO deploy_targets (project_id, name, revision, url, connection_id, removed, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
      command.projectId, p.name, next, current.url, current.connectionId, now);
    return { removed: true, name: p.name };
  }
  const set = command.payload as SetEffectTargetCommand["payload"];
  const connection = tx.get<{ kind: string; scope: string | null; removed: number | null }>(
    "SELECT kind, project_scope_json AS scope, removed_at AS removed FROM connections WHERE id = ?", set.connectionId);
  if (!connection || connection.removed !== null) throw new AppError("connection_not_found", 404);
  const scope = connection.scope ? JSON.parse(connection.scope) as string[] : null;
  if (scope && !scope.includes(command.projectId)) throw new AppError("connection_out_of_scope", 403);
  if (connection.kind !== (isRemote ? "github_token" : "deploy_secret")) throw new AppError("effect_connection_kind_mismatch", 409);
  if (set.target === "git_remote") {
    tx.run("INSERT INTO git_remotes (project_id, name, revision, url, github_json, connection_id, removed, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
      command.projectId, set.name, next, set.url, set.github ? JSON.stringify(set.github) : null, set.connectionId, now);
    return readRemote(tx, command.projectId, set.name)!;
  }
  tx.run("INSERT INTO deploy_targets (project_id, name, revision, url, connection_id, removed, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    command.projectId, set.name, next, set.url, set.connectionId, now);
  return readDeployTarget(tx, command.projectId, set.name)!;
}

// ---------------------------------------------------------------------------
// app.auto_approve/v1
// ---------------------------------------------------------------------------

/** The latest rule of one effect kind in a project, or null. */
export function readAutoApproveRule(tx: AppTransaction, projectId: string, effectKind: EffectKind): AutoApproveRule | null {
  const row = tx.get<{ revision: number; scope_json: string; enabled: number; channel: string; created_at: number }>(
    "SELECT revision, scope_json, enabled, channel, created_at FROM auto_approve_rules WHERE project_id = ? AND effect_kind = ? ORDER BY revision DESC LIMIT 1", projectId, effectKind);
  return row ? { projectId, effectKind, revision: row.revision, scope: JSON.parse(row.scope_json), enabled: row.enabled === 1, channel: row.channel, createdAt: row.created_at } : null;
}
/** Every effect kind's latest rule in a project. */
export function readAutoApproveRules(tx: AppTransaction, projectId: string): AutoApproveRule[] {
  return autoApproveKinds.map(kind => readAutoApproveRule(tx, projectId, kind)).filter((rule): rule is AutoApproveRule => !!rule);
}
/** Appends the next rule revision for one effect kind (`stale_revision` when `expectedRevision` is not current). */
export function writeAutoApproveRule(tx: AppTransaction, command: SetAutoApproveCommand, channel: string, now: number): AutoApproveRule {
  requireApprovalConfigChannel(channel);
  const current = readAutoApproveRule(tx, command.projectId, command.payload.effectKind);
  if ((current?.revision ?? 0) !== command.expectedRevision) throw new AppError("stale_revision", 409);
  tx.run("INSERT INTO auto_approve_rules (project_id, effect_kind, scope_json, revision, enabled, channel, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    command.projectId, command.payload.effectKind, canonicalJson(command.payload.scope), (current?.revision ?? 0) + 1, command.payload.enabled ? 1 : 0, channel, now);
  return readAutoApproveRule(tx, command.projectId, command.payload.effectKind)!;
}

/**
 * The enabled rule that decides `action`, or null. A rule matches only on exact names: the git push remote and every
 * pushed branch, the GitHub remote, or the deploy target. Rules are evaluated by the service, never by a model.
 */
export function matchingRule(tx: AppTransaction, projectId: string, action: EffectAction): AutoApproveRule | null {
  if (action.outbound || !autoApproveKinds.includes(action.kind)) return null;
  const rule = readAutoApproveRule(tx, projectId, action.kind);
  if (!rule?.enabled) return null;
  const scope = rule.scope as Record<string, unknown>;
  if (action.kind === "effect.git_push") {
    const branches = scope.branches as string[];
    return scope.remote === action.remote.name && action.updates.every(update => branches.includes(update.ref.slice(11))) ? rule : null;
  }
  if (action.kind === "effect.deploy") return scope.target === action.target.name ? rule : null;
  if (action.kind === "mcp_tool") return (scope.tools as { server: string; tool: string }[]).some(item => item.server === action.server.name && item.tool === action.tool) ? rule : null;
  if (action.kind === "browser_confirm" || action.kind === "computer_confirm" || action.kind === "outbound_release") return null;
  return scope.remote === action.remote.name ? rule : null;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** How a card was decided. `auto-rule` names the rule revision. */
export interface CardDecision { decision: "approve" | "deny"; channel: string; ruleRevision: number | null; decidedAt: number }
/** The executor's outcome receipt: technical evidence only, never a credential. */
export interface CardReceipt { outcome: "succeeded" | "failed" | "unknown"; reason: string | null; detail: Record<string, unknown>; finishedAt: number }
/** app.approval_cards/v1 read model. `telegramEligible` is true only for a single action (EXE10 renders it). */
export interface ApprovalCard {
  id: string; projectId: string; topicId: string; runId: string; jobId: string; roleId: string;
  kind: EffectKind; action: EffectAction; digest: string; revision: number; state: CardState; reason: string | null;
  decision: CardDecision | null; receipt: CardReceipt | null; telegramEligible: boolean;
  createdAt: number; expiresAt: number; updatedAt: number; startedAt: number | null;
  /** Content-free count of all matched calls held by this card. */
  outboundBlocks?: number;
}

interface CardRow {
  id: string; project_id: string; topic_id: string; run_id: string; job_id: string; role_id: string; kind: EffectKind; action_json: string; digest: string;
  revision: number; state: CardState; reason: string | null; decision_json: string | null; receipt_json: string | null; telegram_eligible: number;
  created_at: number; expires_at: number; updated_at: number; started_at: number | null;
}
function project(row: CardRow, now: number | null): ApprovalCard {
  // A pending card past its expiry reads as expired even before a write records it.
  const expired = now !== null && row.state === "pending" && now >= row.expires_at;
  return {
    id: row.id, projectId: row.project_id, topicId: row.topic_id, runId: row.run_id, jobId: row.job_id, roleId: row.role_id, kind: row.kind,
    action: JSON.parse(row.action_json) as EffectAction, digest: row.digest, revision: row.revision, state: expired ? "expired" : row.state,
    reason: expired ? "expired" : row.reason, decision: row.decision_json ? JSON.parse(row.decision_json) : null,
    receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null, telegramEligible: row.telegram_eligible === 1,
    createdAt: row.created_at, expiresAt: row.expires_at, updatedAt: row.updated_at, startedAt: row.started_at,
  };
}

/** One card of a project (`approval_card_not_found`), with lazy expiry at `now`. */
export function readCard(tx: AppTransaction, projectId: string, cardId: string, now: number | null = null): ApprovalCard {
  requireId(cardId);
  const row = tx.get<CardRow>("SELECT * FROM approval_cards WHERE project_id = ? AND id = ?", projectId, cardId);
  if (!row) throw new AppError("approval_card_not_found", 404);
  return { ...project(row, now), outboundBlocks: tx.get<{ count: number }>("SELECT count(*) AS count FROM attachment_events WHERE run_id = ? AND kind = 'outbound_block' AND json_extract(detail_json, '$.cardId') = ?", row.run_id, row.id)!.count };
}
/**
 * The project's cards, newest first, at most `limit` (1–100). `state` filters by the state the reader sees: with
 * `now`, a pending card past its deadline is `expired` (and not `pending`), whether or not the expiry was written yet.
 * `topicId` narrows the query before the limit, so a topic page never loses its cards to newer cards in other topics.
 */
export function readCards(tx: AppTransaction, projectId: string, options: { now?: number; state?: CardState; limit?: number; topicId?: string } = {}): ApprovalCard[] {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AppError("invalid_cursor");
  const now = options.now ?? null;
  let filter = "", args: (string | number)[] = [projectId];
  if (options.topicId !== undefined) { requireId(options.topicId); filter += "AND topic_id = ? "; args.push(options.topicId); }
  if (options.state && now !== null && options.state === "pending") { filter += "AND state = 'pending' AND expires_at > ?"; args.push(now); }
  else if (options.state && now !== null && options.state === "expired") { filter += "AND (state = 'expired' OR (state = 'pending' AND expires_at <= ?))"; args.push(now); }
  else if (options.state) { filter += "AND state = ?"; args.push(options.state); }
  args = [...args, limit];
  return tx.all<CardRow>(`SELECT * FROM approval_cards WHERE project_id = ? ${filter} ORDER BY created_at DESC, id DESC LIMIT ?`, ...args).map(row => ({ ...project(row, now), outboundBlocks: tx.get<{ count: number }>("SELECT count(*) AS count FROM attachment_events WHERE run_id = ? AND kind = 'outbound_block' AND json_extract(detail_json, '$.cardId') = ?", row.run_id, row.id)!.count }));
}

function transition(tx: AppTransaction, card: ApprovalCard, state: CardState, now: number, extra: { reason?: string | null; decision?: CardDecision; receipt?: CardReceipt; startedAt?: number } = {}): ApprovalCard {
  tx.run(`UPDATE approval_cards SET state = ?, reason = ?, revision = revision + 1, updated_at = ?,
    decision_json = coalesce(?, decision_json), receipt_json = coalesce(?, receipt_json), started_at = coalesce(?, started_at) WHERE id = ? AND revision = ?`,
    state, extra.reason === undefined ? card.reason : extra.reason, now, extra.decision ? JSON.stringify(extra.decision) : null,
    extra.receipt ? JSON.stringify(extra.receipt) : null, extra.startedAt ?? null, card.id, card.revision);
  return readCard(tx, card.projectId, card.id);
}

/** Records the expiry of every pending card of the project that passed its deadline. */
export function expireCards(tx: AppTransaction, projectId: string, now: number): void {
  for (const row of tx.all<CardRow>("SELECT * FROM approval_cards WHERE project_id = ? AND state = 'pending' AND expires_at <= ?", projectId, now)) {
    transition(tx, project(row, null), "expired", now, { reason: "expired" });
  }
}

/** Whether a card may be decided from Telegram: exactly one action (one ref for a push). */
export function telegramEligible(action: EffectAction): boolean {
  return !action.outbound && action.kind !== "outbound_release" && (action.kind !== "effect.git_push" || action.updates.length === 1);
}

/** Who and what proposed a card: the run, its job, topic and role. */
export interface CardOrigin { projectId: string; topicId: string; runId: string; jobId: string; roleId: string }

/**
 * Inserts a `pending` card for `action` (validated, digested, expiring after {@link cardLifetimeMs}) in the caller's
 * transaction. The project must allow the card's {@link cardLevel} for the role and must not be halted. When an enabled Web-written
 * auto-approve rule matches, the card is decided `approve` by `auto-rule` with the rule revision and moves to
 * `executing` in the same transaction; the caller then hands it to the executor after commit.
 */
export function createCard(tx: AppTransaction, origin: CardOrigin, action: EffectAction, now: number, options: { autoApprove: boolean }): ApprovalCard {
  for (const id of [origin.projectId, origin.topicId, origin.runId, origin.jobId, origin.roleId]) requireId(id);
  validateAction(action);
  assertExecutionAllowed(tx, origin.projectId, origin.roleId, cardLevel(action.kind, action));
  const id = crypto.randomUUID();
  tx.run(`INSERT INTO approval_cards (id, project_id, topic_id, run_id, job_id, role_id, kind, action_json, digest, revision, state, reason, decision_json, receipt_json,
    telegram_eligible, created_at, expires_at, updated_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', NULL, NULL, NULL, ?, ?, ?, ?, NULL)`,
    id, origin.projectId, origin.topicId, origin.runId, origin.jobId, origin.roleId, action.kind, canonicalJson(action), actionDigest(action),
    telegramEligible(action) ? 1 : 0, now, now + cardLifetimeMs, now);
  const card = readCard(tx, origin.projectId, id);
  if (action.outbound) writeAttachmentEvent(tx, { projectId: origin.projectId, attachmentId: action.outbound.attachmentId ?? null, kind: "outbound_block", status: "refused", reason: "outbound_blocked",
    runId: origin.runId, jobId: origin.jobId, detail: { channel: action.kind, count: action.outbound.chars, cardId: id }, createdAt: now });
  const rule = options.autoApprove && !action.outbound ? matchingRule(tx, origin.projectId, action) : null;
  if (!rule) return card;
  return transition(tx, card, "executing", now, { reason: null, decision: { decision: "approve", channel: "auto-rule", ruleRevision: rule.revision, decidedAt: now } });
}

/**
 * `approval.decide`: the owner's decision on one pending card. Rules, in order: the card must belong to the project
 * (`approval_card_not_found`); Telegram may decide only a single-action card and the local API none
 * (`approval_requires_web`, 403); a used card is `approval_card_not_pending` and an expired one
 * `approval_card_expired` (recording the expiry); `expectedRevision` must be the card revision (`stale_revision`)
 * and `digest` the card's action digest (`approval_digest_mismatch`). Approval also needs the proposing role to still
 * have the card's {@link cardLevel} in an unhalted project. Approval moves the card to `executing` in this transaction; denial to `denied`.
 */
export function decideCard(tx: AppTransaction, command: DecideCardCommand, channel: string, now: number, options: { executor: boolean }): ApprovalCard {
  const card = readCard(tx, command.projectId, command.payload.cardId);
  if (channel !== "web" && !(channel === "telegram" && card.telegramEligible)) throw new AppError("approval_requires_web", 403);
  if (card.state === "expired") throw new AppError("approval_card_expired", 409);
  if (card.state !== "pending") throw new AppError("approval_card_not_pending", 409, { state: card.state });
  if (now >= card.expiresAt) { transition(tx, card, "expired", now, { reason: "expired" }); throw new AppError("approval_card_expired", 409); }
  if (card.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  if (card.digest !== command.payload.digest) throw new AppError("approval_digest_mismatch", 409);
  const decision: CardDecision = { decision: command.payload.decision, channel, ruleRevision: null, decidedAt: now };
  if (command.payload.decision === "deny") return transition(tx, card, "denied", now, { reason: "denied", decision });
  if (!options.executor) throw new AppError("effects_not_configured", 503);
  assertExecutionAllowed(tx, card.projectId, card.roleId, cardLevel(card.kind, card.action));
  return transition(tx, card, "executing", now, { reason: null, decision });
}

/**
 * The executor's claim, in its own transaction before any effect: an `executing` card that has not started yet is
 * marked started. Returns null when the card is not claimable (already started, decided otherwise or another
 * process got it), so an effect is attempted at most once.
 */
export function claimCard(tx: AppTransaction, projectId: string, cardId: string, now: number): ApprovalCard | null {
  const card = readCard(tx, projectId, cardId);
  if (card.state !== "executing" || card.startedAt !== null) return null;
  return transition(tx, card, "executing", now, { startedAt: now });
}

/** Records the executor's outcome on a started card. */
export function finishCard(tx: AppTransaction, card: ApprovalCard, receipt: CardReceipt, now: number): ApprovalCard {
  const current = readCard(tx, card.projectId, card.id);
  if (current.state !== "executing") return current;
  return transition(tx, current, receipt.outcome, now, { reason: receipt.reason, receipt });
}

/** Fails an `executing` card before it started (nothing was attempted): access changed, a target moved, no vault. */
export function failBeforeStart(tx: AppTransaction, card: ApprovalCard, reason: string, now: number): ApprovalCard {
  const current = readCard(tx, card.projectId, card.id);
  if (current.state !== "executing" || current.startedAt !== null) return current;
  return transition(tx, current, "failed", now, { reason, receipt: { outcome: "failed", reason, detail: {}, finishedAt: now } });
}

/**
 * Boot reconciliation (ADR 0012): an `executing` card whose effect had started when the process stopped is
 * `unknown` — the effect may or may not have happened — and needs the owner; it is never retried. One that had not
 * started fails as `interrupted` (nothing was attempted; the agent may propose again). Returns the card ids touched.
 */
export function reconcileCards(tx: AppTransaction, now: number): string[] {
  const touched: string[] = [];
  for (const row of tx.all<CardRow>("SELECT * FROM approval_cards WHERE state = 'executing' ORDER BY created_at")) {
    const card = project(row, null);
    if (card.startedAt !== null) transition(tx, card, "unknown", now, { reason: "interrupted", receipt: { outcome: "unknown", reason: "interrupted", detail: {}, finishedAt: now } });
    else transition(tx, card, "failed", now, { reason: "interrupted_before_start", receipt: { outcome: "failed", reason: "interrupted_before_start", detail: {}, finishedAt: now } });
    touched.push(card.id);
  }
  return touched;
}
