import { AppError } from "../errors";
import { requireId } from "../sources";
import type { AppTransaction } from "../store";
import { assertExecutionAllowed } from "./access";
import { canonicalJson } from "./approval-cards";
import { boxEnvironmentNames, boxProxyNames, pinnedImagePattern } from "./box-runtime";

/**
 * app.mcp_servers/v1 (EXE12, ADR 0038, S11-D06) — MCP install proposals and installed servers.
 *
 * - **Proposal.** A Jit reply may carry `{"kind":"mcp_install", name, source, package, version, command, args, env}`.
 *   It is untrusted model output: it is validated here and becomes Jit's revision 1 of a proposal. A version that is
 *   not exactly pinned (a range, a tag, `latest`) or any other invalid field leaves the proposal `dropped` with a
 *   visible reason (`unpinned_version`, …) that can never be accepted. Unknown keys are dropped and named.
 * - **Owner commands.** `mcp.install.accept` is Web only (`mcp_install_requires_web`), revision-bound, needs the
 *   project at `workspace` or above (installing needs the registry), and binds every env name to an owner `mcp_env`
 *   connection. `mcp.install.revise` (Web only) appends an owner revision; `mcp.install.reject` and
 *   `mcp.server.remove` only take power away and are also accepted from Telegram.
 * - **Server.** Acceptance records an `mcp_servers` row in state `installing`; the installer then moves it to
 *   `installed` (with the first tool listing) or `failed` with a finite reason. A server with bound env runs in its own
 *   sidecar; all others in the project box. No value is ever stored here: env is names → connection ids.
 */
export type McpSource = "npm" | "pypi" | "oci";
export const mcpSources: readonly McpSource[] = Object.freeze(["npm", "pypi", "oci"]);

/** The validated install spec the owner's card shows verbatim. `env` holds variable names only. */
export interface McpInstallSpec { name: string; source: McpSource; package: string; version: string; command: string; args: string[]; env: string[] }

export type McpProposalState = "proposed" | "accepted" | "rejected" | "superseded" | "dropped";
/** Why a proposal was dropped (finite codes). */
export type McpDropReason = "invalid_name" | "invalid_source" | "invalid_package" | "unpinned_version" | "invalid_command" | "invalid_args" | "invalid_env";

/** Read model of one proposal: its current revision and history. `spec` is null only for a proposal too broken to show. */
export interface McpProposalView {
  id: string; projectId: string; topicId: string; replyId: string;
  revision: number; author: "jit" | "owner"; state: McpProposalState; reason: string | null;
  spec: McpInstallSpec | null;
  /** For a dropped proposal: the well-formed display fields Jit offered (never accepted). */
  offered: Partial<Pick<McpInstallSpec, "name" | "source" | "package" | "version">> | null;
  dropped: string[]; serverId: string | null;
  history: { revision: number; author: "jit" | "owner"; state: McpProposalState }[];
  createdAt: number; decidedAt: number | null;
}

export type McpServerState = "installing" | "installed" | "failed" | "removed";
/** One tool as the server last listed it. `exposed` is the model-facing name; `refused` explains a tool not exposed. */
export interface McpToolListing {
  name: string; exposed: string | null; description: string; readOnly: boolean; inputSchema: Record<string, unknown> | null; refused: string | null;
}
/** Read model of one installed server. `env` binds names to connection ids (never values). */
export interface McpServerView {
  id: string; projectId: string; name: string; revision: number; spec: McpInstallSpec; env: Record<string, string>;
  state: McpServerState; reason: string | null; tools: McpToolListing[];
  /** True when the server runs in its own sidecar (it binds a connection, or comes from an OCI image). */
  sidecar: boolean;
  proposalId: string; createdAt: number; updatedAt: number;
}

/** Most MCP install proposals one reply may carry. */
export const mcpProposalLimit = 2;
const namePattern = /^[a-z][a-z0-9-]{1,31}$/;
const npmPackage = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const pypiPackage = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const ociPackage = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?(\/[a-z0-9]+([._-][a-z0-9]+)*)+$|^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*$/;
/** Exact versions only: semver for npm, a PEP 440 release for PyPI, an image digest for OCI. */
const pinned: Record<McpSource, RegExp> = {
  npm: /^\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
  pypi: /^\d{1,9}(\.\d{1,9}){0,5}((a|b|rc)\d{1,9})?(\.post\d{1,9})?(\.dev\d{1,9})?$/,
  oci: /^sha256:[a-f0-9]{64}$/,
};
const commandPattern = /^[A-Za-z0-9._+/][A-Za-z0-9._+/-]{0,127}$/;
const envPattern = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Variables an install spec may never bind: the box environment, proxies, loader and interpreter hooks, Podman's client. */
const reservedEnv = new Set([...boxEnvironmentNames, ...boxProxyNames.map(name => name.toUpperCase()), "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONHOME",
  "PYTHONSTARTUP", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "DBUS_SESSION_BUS_ADDRESS", "SHELL", "USER", "PWD", "DISPLAY", "BASH_ENV", "ENV"]);
const reservedPrefix = /^(LD_|DYLD_|JIT_|PODMAN_|CONTAINERS_)/;
const maximumArgs = 32, maximumArgBytes = 512, maximumEnv = 16;
const keys = ["kind", "name", "source", "package", "version", "command", "args", "env"];

const exact = (value: unknown, names: string[]) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...names].sort().join(",");
const line = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max &&
  value.isWellFormed() && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(value);

/** The first problem of a candidate spec, or null when it is valid. Shared by Jit's proposal and the owner's revision. */
export function specProblem(value: Record<string, unknown>): McpDropReason | null {
  if (typeof value.name !== "string" || !namePattern.test(value.name)) return "invalid_name";
  if (!mcpSources.includes(value.source as McpSource)) return "invalid_source";
  const source = value.source as McpSource;
  const pkg = value.package;
  if (typeof pkg !== "string" || !(source === "npm" ? npmPackage.test(pkg) && pkg.length <= 214 : source === "pypi" ? pypiPackage.test(pkg) && pkg.length <= 100
    : ociPackage.test(pkg) && pkg.length <= 255)) return "invalid_package";
  if (typeof value.version !== "string" || !pinned[source].test(value.version) || (source === "oci" && !pinnedImagePattern.test(`${pkg}@${value.version}`))) return "unpinned_version";
  if (typeof value.command !== "string" || !commandPattern.test(value.command) || value.command.includes("..")) return "invalid_command";
  const args = value.args ?? [];
  if (!Array.isArray(args) || args.length > maximumArgs || args.some(arg => typeof arg !== "string" || (arg !== "" && !line(arg, maximumArgBytes)))) return "invalid_args";
  const env = value.env ?? [];
  if (!Array.isArray(env) || env.length > maximumEnv || new Set(env).size !== env.length ||
      env.some(name => typeof name !== "string" || !envPattern.test(name) || reservedEnv.has(name) || reservedPrefix.test(name))) return "invalid_env";
  return null;
}

/** The canonical spec of a valid candidate (call {@link specProblem} first). */
function specOf(value: Record<string, unknown>): McpInstallSpec {
  return { name: value.name as string, source: value.source as McpSource, package: value.package as string, version: value.version as string,
    command: value.command as string, args: [...(value.args as string[] | undefined ?? [])], env: [...(value.env as string[] | undefined ?? [])].sort() };
}

/** Jit's parsed proposal: a valid spec, or a dropped one with its reason and the well-formed fields to show. */
export interface ParsedMcpProposal { spec: McpInstallSpec | null; reason: McpDropReason | null; offered: McpProposalView["offered"]; dropped: string[] }

/**
 * Parses one untrusted `{"kind":"mcp_install"}` entry, or null when it is not even an object. Unknown keys are
 * dropped as `field:<key>`; a spec with any invalid field is kept as a dropped proposal with its reason, so the owner
 * sees what Jit asked for and why it cannot be installed.
 */
export function parseMcpProposal(item: unknown): ParsedMcpProposal | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const value = item as Record<string, unknown>;
  const dropped = Object.keys(value).filter(key => !keys.includes(key)).map(key => /^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/.test(key) ? `field:${key}` : "field:invalid").slice(0, 8);
  const reason = specProblem(value);
  if (!reason) return { spec: specOf(value), reason: null, offered: null, dropped };
  const offered: NonNullable<McpProposalView["offered"]> = {};
  for (const field of ["name", "source", "package", "version"] as const) if (line(value[field], 255)) (offered as Record<string, string>)[field] = value[field] as string;
  return { spec: null, reason, offered, dropped };
}

/** Trusted operator text describing the proposal shape; only offered when the project level allows installing. */
export const mcpProposalInstruction = `Optional "proposals" entry {"kind":"mcp_install","name":string,"source":"npm"|"pypi"|"oci","package":string,"version":string,"command":string,"args":[string],"env":[NAME]} (at most ${mcpProposalLimit}) that asks the owner to install an MCP server in this project's execution box. "version" must be an exact pinned version (an OCI image digest for "oci"); ranges, tags and "latest" are dropped. "env" lists variable names only; the owner binds each to a credential in Jit, and you never see or ask for its value. Nothing is installed until the owner accepts the card in Web.`;

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

interface ProposalRow {
  project_id: string; id: string; revision: number; author: "jit" | "owner"; state: McpProposalState; reason: string | null; spec_json: string | null;
  dropped_json: string; topic_id: string; reply_id: string; server_id: string | null; created_at: number; decided_at: number | null;
}

function proposalView(rows: ProposalRow[]): McpProposalView {
  const current = rows.at(-1)!;
  const stored = current.spec_json ? JSON.parse(current.spec_json) as Record<string, unknown> : null;
  const valid = current.state !== "dropped" && stored !== null;
  return {
    id: current.id, projectId: current.project_id, topicId: current.topic_id, replyId: current.reply_id,
    revision: current.revision, author: current.author, state: current.state, reason: current.reason,
    spec: valid ? stored as unknown as McpInstallSpec : null, offered: valid ? null : stored as McpProposalView["offered"],
    dropped: JSON.parse(current.dropped_json) as string[], serverId: current.server_id,
    history: rows.map(row => ({ revision: row.revision, author: row.author, state: row.state })),
    createdAt: rows[0]!.created_at, decidedAt: current.decided_at,
  };
}

/** Records Jit's revision 1 of a parsed proposal for a committed reply; returns its id. */
export function insertMcpProposal(tx: AppTransaction, origin: { projectId: string; topicId: string; replyId: string }, parsed: ParsedMcpProposal, now: number): string {
  const id = crypto.randomUUID();
  tx.run(`INSERT INTO mcp_proposals (project_id, id, revision, author, state, reason, spec_json, dropped_json, topic_id, reply_id, server_id, created_at, decided_at)
    VALUES (?, ?, 1, 'jit', ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`, origin.projectId, id, parsed.spec ? "proposed" : "dropped", parsed.reason,
    parsed.spec ? canonicalJson(parsed.spec) : parsed.offered ? canonicalJson(parsed.offered) : null, JSON.stringify(parsed.dropped), origin.topicId, origin.replyId, now);
  return id;
}

/** One proposal of a project (`mcp_proposal_not_found`, 404). */
export function readMcpProposal(tx: AppTransaction, projectId: string, proposalId: string): McpProposalView {
  requireId(proposalId);
  const rows = tx.all<ProposalRow>("SELECT * FROM mcp_proposals WHERE project_id = ? AND id = ? ORDER BY revision", projectId, proposalId);
  if (!rows.length) throw new AppError("mcp_proposal_not_found", 404);
  return proposalView(rows);
}

/** The project's proposals, newest first, at most 50. */
export function readMcpProposals(tx: AppTransaction, projectId: string): McpProposalView[] {
  const ids = tx.all<{ id: string }>("SELECT id FROM mcp_proposals WHERE project_id = ? AND revision = 1 ORDER BY created_at DESC, id DESC LIMIT 50", projectId);
  return ids.map(row => readMcpProposal(tx, projectId, row.id));
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

interface ServerRow {
  project_id: string; id: string; revision: number; name: string; spec_json: string; env_json: string; state: McpServerState; reason: string | null;
  tools_json: string; proposal_id: string; created_at: number; updated_at: number;
}
function serverView(row: ServerRow): McpServerView {
  const spec = JSON.parse(row.spec_json) as McpInstallSpec;
  return { id: row.id, projectId: row.project_id, name: row.name, revision: row.revision, spec, env: JSON.parse(row.env_json) as Record<string, string>,
    state: row.state, reason: row.reason, tools: JSON.parse(row.tools_json) as McpToolListing[], sidecar: spec.env.length > 0 || spec.source === "oci",
    proposalId: row.proposal_id, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** One server's current revision (`mcp_server_not_found`, 404). */
export function readMcpServer(tx: AppTransaction, projectId: string, serverId: string): McpServerView {
  requireId(serverId);
  const row = tx.get<ServerRow>("SELECT * FROM mcp_servers WHERE project_id = ? AND id = ? ORDER BY revision DESC LIMIT 1", projectId, serverId);
  if (!row) throw new AppError("mcp_server_not_found", 404);
  return serverView(row);
}

/** Every server of the project at its current revision, by name; `removed` ones only when asked. */
export function readMcpServers(tx: AppTransaction, projectId: string, options: { removed?: boolean } = {}): McpServerView[] {
  return tx.all<ServerRow>(`SELECT s.* FROM mcp_servers s WHERE s.project_id = ? AND s.revision = (SELECT max(revision) FROM mcp_servers x WHERE x.id = s.id)
    ORDER BY s.name, s.created_at`, projectId).map(serverView).filter(server => options.removed || server.state !== "removed");
}

/** Every server in state `installing`, across projects (boot reconciliation). */
export function installingServers(tx: AppTransaction): McpServerView[] {
  return tx.all<ServerRow>(`SELECT s.* FROM mcp_servers s WHERE s.state = 'installing' AND s.revision = (SELECT max(revision) FROM mcp_servers x WHERE x.id = s.id)`).map(serverView);
}

/**
 * Appends the next revision of a server in `state` (the spec and bindings carry over). Returns the new revision, or
 * the current one unchanged when it is not at `expected` (another writer moved it; nothing is written).
 */
export function writeServerState(tx: AppTransaction, server: Pick<McpServerView, "projectId" | "id">, expected: number, state: McpServerState,
  reason: string | null, now: number, tools?: McpToolListing[]): McpServerView {
  const current = readMcpServer(tx, server.projectId, server.id);
  if (current.revision !== expected) return current;
  tx.run(`INSERT INTO mcp_servers (project_id, id, revision, name, spec_json, env_json, state, reason, tools_json, proposal_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, current.projectId, current.id, current.revision + 1, current.name, canonicalJson(current.spec),
    canonicalJson(current.env), state, reason, JSON.stringify(tools ?? current.tools), current.proposalId, current.createdAt, now);
  return readMcpServer(tx, server.projectId, server.id);
}

/** Records the latest tool listing of a server revision in place: a listing never changes the revision cards pin. */
export function writeServerTools(tx: AppTransaction, server: Pick<McpServerView, "projectId" | "id" | "revision">, tools: McpToolListing[], now: number): void {
  tx.run("UPDATE mcp_servers SET tools_json = ?, updated_at = ? WHERE project_id = ? AND id = ? AND revision = ?",
    JSON.stringify(tools), now, server.projectId, server.id, server.revision);
}

// ---------------------------------------------------------------------------
// Owner commands
// ---------------------------------------------------------------------------

export type McpCommand =
  | { kind: "mcp.install.accept"; requestId: string; projectId: string; expectedRevision: number; payload: { proposalId: string; env: Record<string, string> } }
  | { kind: "mcp.install.reject"; requestId: string; projectId: string; expectedRevision: number; payload: { proposalId: string } }
  | { kind: "mcp.install.revise"; requestId: string; projectId: string; expectedRevision: number; payload: { proposalId: string; spec: McpInstallSpec } }
  | { kind: "mcp.server.remove"; requestId: string; projectId: string; expectedRevision: number; payload: { serverId: string } };
/** The committed receipt of an app.mcp_servers/v1 command. */
export interface McpReceipt { proposal?: McpProposalView; server?: McpServerView }

const mcpKinds = new Set(["mcp.install.accept", "mcp.install.reject", "mcp.install.revise", "mcp.server.remove"]);
export function isMcpCommand(command: unknown): command is McpCommand {
  return !!command && typeof command === "object" && mcpKinds.has((command as { kind?: unknown }).kind as string);
}

/** Validates the exact command shape (`invalid_mcp_command`) and returns its receipt identity. */
export function mcpCommandIdentity(command: McpCommand): string {
  const invalid = () => new AppError("invalid_mcp_command");
  if (!isMcpCommand(command) || !exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1) throw invalid();
  requireId(command.projectId);
  const p = command.payload as Record<string, unknown>;
  if (command.kind === "mcp.install.accept") {
    if (!exact(p, ["proposalId", "env"]) || !p.env || typeof p.env !== "object" || Array.isArray(p.env)) throw invalid();
    for (const [name, id] of Object.entries(p.env as Record<string, unknown>)) { if (!envPattern.test(name) || typeof id !== "string") throw invalid(); requireId(id); }
  } else if (command.kind === "mcp.install.revise") {
    if (!exact(p, ["proposalId", "spec"]) || !p.spec || typeof p.spec !== "object" || Array.isArray(p.spec) ||
        Object.keys(p.spec).some(key => !keys.includes(key) || key === "kind")) throw invalid();
  } else if (command.kind === "mcp.server.remove") {
    if (!exact(p, ["serverId"])) throw invalid();
    requireId(p.serverId);
    return canonicalJson([command.kind, command.projectId, command.expectedRevision, p]);
  } else if (!exact(p, ["proposalId"])) throw invalid();
  requireId(p.proposalId);
  return canonicalJson([command.kind, command.projectId, command.expectedRevision, p]);
}

/**
 * Applies one command in the caller's transaction (receipt and audit are the caller's). Rules, in order:
 * accept and revise need the `web` channel (`mcp_install_requires_web`, 403); the proposal or server must belong to the
 * project; `expectedRevision` must be current (`stale_revision`); an accept or revise needs an open proposal
 * (`mcp_proposal_not_open`); accept needs the project at `workspace` or above, no other live server of the same name
 * (`mcp_server_exists`) and exactly the spec's env names bound to `mcp_env` connections serving the project
 * (`mcp_env_unbound`, `connection_not_found`, `mcp_connection_kind_mismatch`, `connection_out_of_scope`).
 */
export function applyMcpCommand(tx: AppTransaction, command: McpCommand, channel: string, now: number): McpReceipt {
  if ((command.kind === "mcp.install.accept" || command.kind === "mcp.install.revise") && channel !== "web") throw new AppError("mcp_install_requires_web", 403);
  if (command.kind === "mcp.server.remove") {
    const server = readMcpServer(tx, command.projectId, command.payload.serverId);
    if (server.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
    if (server.state === "removed") throw new AppError("mcp_server_not_found", 404);
    return { server: writeServerState(tx, server, server.revision, "removed", "removed_by_owner", now) };
  }
  const proposal = readMcpProposal(tx, command.projectId, command.payload.proposalId);
  if (proposal.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  if (proposal.state !== "proposed") throw new AppError("mcp_proposal_not_open", 409, { state: proposal.state });
  const append = (state: McpProposalState, spec: McpInstallSpec, author: "jit" | "owner", serverId: string | null, decided: boolean) =>
    tx.run(`INSERT INTO mcp_proposals (project_id, id, revision, author, state, reason, spec_json, dropped_json, topic_id, reply_id, server_id, created_at, decided_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`, proposal.projectId, proposal.id, proposal.revision + 1, author, state, canonicalJson(spec),
      author === "owner" && state === "proposed" ? "[]" : JSON.stringify(proposal.dropped), proposal.topicId, proposal.replyId, serverId, now, decided ? now : null);
  const spec = proposal.spec!;
  if (command.kind === "mcp.install.reject") {
    append("rejected", spec, proposal.author, null, true);
    return { proposal: readMcpProposal(tx, command.projectId, proposal.id) };
  }
  if (command.kind === "mcp.install.revise") {
    const candidate = command.payload.spec as unknown as Record<string, unknown>;
    const problem = specProblem(candidate);
    if (problem) throw new AppError("invalid_mcp_spec", 400, { reason: problem });
    // The earlier revision is superseded by the owner's edit, which becomes the open revision.
    tx.run("UPDATE mcp_proposals SET state = 'superseded', decided_at = ? WHERE id = ? AND revision = ?", now, proposal.id, proposal.revision);
    append("proposed", specOf(candidate), "owner", null, false);
    return { proposal: readMcpProposal(tx, command.projectId, proposal.id) };
  }
  assertExecutionAllowed(tx, command.projectId, null, "workspace");
  if (readMcpServers(tx, command.projectId).some(server => server.name === spec.name && server.state !== "failed")) throw new AppError("mcp_server_exists", 409);
  const bound = command.payload.env;
  if (Object.keys(bound).sort().join(",") !== [...spec.env].sort().join(",")) throw new AppError("mcp_env_unbound", 409);
  for (const connectionId of Object.values(bound)) {
    const connection = tx.get<{ kind: string; scope: string | null; removed: number | null; secret: string }>(
      "SELECT kind, project_scope_json AS scope, removed_at AS removed, secret_state AS secret FROM connections WHERE id = ?", connectionId);
    if (!connection || connection.removed !== null) throw new AppError("connection_not_found", 404);
    if (connection.kind !== "mcp_env") throw new AppError("mcp_connection_kind_mismatch", 409);
    const scope = connection.scope ? JSON.parse(connection.scope) as string[] : null;
    if (scope && !scope.includes(command.projectId)) throw new AppError("connection_out_of_scope", 403);
  }
  const serverId = crypto.randomUUID();
  tx.run(`INSERT INTO mcp_servers (project_id, id, revision, name, spec_json, env_json, state, reason, tools_json, proposal_id, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?, ?, 'installing', NULL, '[]', ?, ?, ?)`, command.projectId, serverId, spec.name, canonicalJson(spec), canonicalJson(bound), proposal.id, now, now);
  append("accepted", spec, proposal.author, serverId, true);
  return { proposal: readMcpProposal(tx, command.projectId, proposal.id), server: readMcpServer(tx, command.projectId, serverId) };
}
