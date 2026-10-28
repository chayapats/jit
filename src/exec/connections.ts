import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync, chmodSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { AppError } from "../errors";
import { containsCredential } from "../security/credentials";
import { registerSecretFingerprint } from "../security/secret-fingerprints";
import { requireId } from "../sources";
import type { AppTransaction } from "../store";

/**
 * app.connections/v1 (EXE08, ADR 0037 § Connections) — owner-entered credentials stored outside every box, prompt
 * and backup. SQLite holds metadata only (`connections`, `connection_audit`); each value lives in
 * `<execution.secretsDirectory>/<connectionId>` (directory 0700, file 0600, service uid). A value is written only by
 * an owner command from the Web channel, is never rendered back, logged, exported, backed up, placed in a prompt or
 * tool result or written under the execution directory, and is released only through {@link releaseConnection}.
 */
export type ConnectionKind = "github_token" | "deploy_secret" | "mcp_env";
export const connectionKinds: readonly ConnectionKind[] = Object.freeze(["github_token", "deploy_secret", "mcp_env"]);

/** What the owner sees of a connection: never the value, only whether one is stored. */
export interface ConnectionView {
  id: string; kind: ConnectionKind; label: string;
  /** Project ids the connection may serve, or null for every project. */
  projectScope: string[] | null;
  revision: number; secret: "empty" | "set";
  createdAt: number; rotatedAt: number | null; removedAt: number | null;
}

export interface CreateConnectionCommand {
  kind: "connection.create"; requestId: string; projectId: null; expectedRevision: 0;
  payload: { kind: ConnectionKind; label: string; projectScope: string[] | null };
}
export interface SetConnectionSecretCommand {
  kind: "connection.set_secret" | "connection.rotate"; requestId: string; projectId: null; expectedRevision: number;
  payload: { connectionId: string; secret: string };
}
export interface RemoveConnectionCommand {
  kind: "connection.remove" | "connection.test"; requestId: string; projectId: null; expectedRevision: number;
  payload: { connectionId: string };
}
/** app.connections/v1 owner commands; every one is Web only (`connection_requires_web`). */
export type ConnectionCommand = CreateConnectionCommand | SetConnectionSecretCommand | RemoveConnectionCommand;
/** The receipt: the connection's metadata after the command, plus the file check of `connection.test`. */
export interface ConnectionReceipt { connection: ConnectionView; test?: { state: SecretFileState } }

/** A stored value's file verdict, from metadata only. */
export type SecretFileState = "present" | "missing" | "unsafe";

const commandKinds = new Set(["connection.create", "connection.set_secret", "connection.rotate", "connection.remove", "connection.test"]);
export function isConnectionCommand(command: unknown): command is ConnectionCommand {
  return !!command && typeof command === "object" && commandKinds.has((command as { kind?: unknown }).kind as string);
}

/** Largest stored value; the Web form body limit bounds it further. */
export const maximumSecretBytes = 8192;
const exact = (value: unknown, keys: string[]) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

/**
 * Validates the exact command shape (`invalid_connection_command`) and returns its receipt identity. The identity of
 * a secret-bearing command deliberately omits the value, so no digest of a secret is ever stored in a receipt; a
 * replay of the same request id returns the first receipt.
 */
export function connectionCommandIdentity(command: ConnectionCommand): string {
  const invalid = () => new AppError("invalid_connection_command");
  if (!isConnectionCommand(command) || !exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) || command.projectId !== null ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) throw invalid();
  if (command.kind === "connection.create") {
    const p = command.payload;
    if (command.expectedRevision !== 0 || !exact(p, ["kind", "label", "projectScope"]) || !connectionKinds.includes(p.kind) ||
        typeof p.label !== "string" || !p.label.trim() || p.label.length > 80 || /[\u0000-\u001f\u007f]/.test(p.label) || !p.label.isWellFormed() || containsCredential(p.label) ||
        (p.projectScope !== null && (!Array.isArray(p.projectScope) || p.projectScope.length < 1 || p.projectScope.length > 32))) throw invalid();
    for (const id of p.projectScope ?? []) requireId(id);
    return JSON.stringify([command.kind, p.kind, p.label.trim(), p.projectScope ? [...new Set(p.projectScope)].sort() : null]);
  }
  if (command.kind === "connection.set_secret" || command.kind === "connection.rotate") {
    if (!exact(command.payload, ["connectionId", "secret"])) throw invalid();
    requireId(command.payload.connectionId);
    normalizeSecret(command.payload.secret);
    return JSON.stringify([command.kind, command.payload.connectionId, command.expectedRevision]);
  }
  if (!exact(command.payload, ["connectionId"])) throw invalid();
  requireId(command.payload.connectionId);
  return JSON.stringify([command.kind, command.payload.connectionId, command.expectedRevision]);
}

/** Trims surrounding whitespace; the value must be 8..8192 bytes of well-formed text without NUL (`invalid_connection_secret`). */
export function normalizeSecret(value: unknown): string {
  if (typeof value !== "string") throw new AppError("invalid_connection_secret");
  const secret = value.trim();
  if (secret.length < 8 || Buffer.byteLength(secret) > maximumSecretBytes || secret.includes("\u0000") || !secret.isWellFormed()) throw new AppError("invalid_connection_secret");
  return secret;
}

/**
 * Web only: every connection command — including create and test, which carry no value — is refused for any channel
 * but `web` with `connection_requires_web` (403). The local API counts as `local-api` and Telegram as `telegram`.
 */
export function requireConnectionChannel(channel: string): void {
  if (channel !== "web") throw new AppError("connection_requires_web", 403);
}

interface Row { id: string; kind: ConnectionKind; label: string; scope: string | null; revision: number; secret: "empty" | "set"; createdAt: number; rotatedAt: number | null; removedAt: number | null }
const select = "SELECT id, kind, label, project_scope_json AS scope, revision, secret_state AS secret, created_at AS createdAt, rotated_at AS rotatedAt, removed_at AS removedAt FROM connections";
const view = (row: Row): ConnectionView => ({ id: row.id, kind: row.kind, label: row.label, projectScope: row.scope ? JSON.parse(row.scope) as string[] : null,
  revision: row.revision, secret: row.secret, createdAt: row.createdAt, rotatedAt: row.rotatedAt, removedAt: row.removedAt });

/** Every connection the owner created, oldest first, including removed ones (with `removedAt`). */
export function readConnections(tx: AppTransaction): ConnectionView[] {
  return tx.all<Row>(`${select} ORDER BY created_at, id`).map(view);
}
/** One connection (`connection_not_found`, 404). */
export function readConnection(tx: AppTransaction, id: string): ConnectionView {
  requireId(id);
  const row = tx.get<Row>(`${select} WHERE id = ?`, id);
  if (!row) throw new AppError("connection_not_found", 404);
  return view(row);
}

function audit(tx: AppTransaction, connectionId: string, action: string, purpose: string | null, channel: string, now: number): void {
  tx.run("INSERT INTO connection_audit (connection_id, action, purpose, channel, created_at) VALUES (?, ?, ?, ?, ?)", connectionId, action, purpose, channel, now);
}

/**
 * Applies one owner command inside the caller's transaction (receipts and the `audit` row are the caller's). The
 * value of `set_secret`/`rotate` is fingerprinted before it is written, written atomically to the vault, and never
 * returned. `set_secret` needs an empty connection (`connection_secret_exists`), `rotate` a set one
 * (`connection_secret_missing`); a removed connection is `connection_removed`. `expectedRevision` is the connection's.
 */
export function applyConnectionCommand(tx: AppTransaction, vault: ConnectionVault, command: ConnectionCommand, channel: string, now: number): ConnectionReceipt {
  requireConnectionChannel(channel);
  if (command.kind === "connection.create") {
    const scope = command.payload.projectScope ? [...new Set(command.payload.projectScope)].sort() : null;
    for (const projectId of scope ?? []) if (!tx.get("SELECT id FROM projects WHERE id = ?", projectId)) throw new AppError("project_not_found", 404);
    const id = crypto.randomUUID();
    tx.run("INSERT INTO connections (id, kind, label, project_scope_json, revision, secret_state, created_at, rotated_at, removed_at) VALUES (?, ?, ?, ?, 1, 'empty', ?, NULL, NULL)",
      id, command.payload.kind, command.payload.label.trim(), scope ? JSON.stringify(scope) : null, now);
    audit(tx, id, "created", null, channel, now);
    return { connection: readConnection(tx, id) };
  }
  const current = readConnection(tx, command.payload.connectionId);
  if (current.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  if (current.removedAt !== null) throw new AppError("connection_removed", 409);
  if (command.kind === "connection.test") {
    audit(tx, current.id, "tested", null, channel, now);
    return { connection: current, test: { state: current.secret === "set" ? vault.inspect(current.id) : "missing" } };
  }
  if (command.kind === "connection.remove") {
    vault.remove(current.id);
    tx.run("UPDATE connections SET revision = revision + 1, secret_state = 'empty', removed_at = ? WHERE id = ?", now, current.id);
    audit(tx, current.id, "removed", null, channel, now);
    return { connection: readConnection(tx, current.id) };
  }
  if (command.kind === "connection.set_secret" && current.secret === "set") throw new AppError("connection_secret_exists", 409);
  if (command.kind === "connection.rotate" && current.secret !== "set") throw new AppError("connection_secret_missing", 409);
  const secret = normalizeSecret((command as SetConnectionSecretCommand).payload.secret);
  // Fingerprint first: from here on any echo of the value in outgoing text is redacted, even if the write fails.
  registerSecretFingerprint(secret);
  vault.write(current.id, secret);
  tx.run(`UPDATE connections SET revision = revision + 1, secret_state = 'set'${command.kind === "connection.rotate" ? ", rotated_at = ?" : ""} WHERE id = ?`,
    ...(command.kind === "connection.rotate" ? [now, current.id] : [current.id]));
  audit(tx, current.id, command.kind === "connection.rotate" ? "rotated" : "secret_set", null, channel, now);
  return { connection: readConnection(tx, current.id) };
}

/** The purposes a value may be released for: an approved effect card (EXE07) or an MCP sidecar spawn (EXE12). */
const purposePattern = /^(effect:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mcp:[a-z0-9][a-z0-9._-]{0,63})$/;

/** A released value. It goes to the effect executor or the MCP spawn only, never into text. */
export interface ReleasedConnection { connectionId: string; kind: ConnectionKind; secret: string }

/**
 * The only way to read a stored value (internal API; no route, command or read model calls it). `purpose` must be
 * `effect:<cardId>` or `mcp:<serverId>` (`connection_purpose_invalid` otherwise, with nothing read or recorded). A
 * removed or empty connection is `connection_unavailable`; a connection scoped to other projects is
 * `connection_out_of_scope` when `options.projectId` is given. Every release records a `connection_audit` row in `tx`,
 * which the caller commits with the work that uses the value.
 */
export function releaseConnection(tx: AppTransaction, connectionId: string, purpose: string, vault: ConnectionVault,
  options: { projectId?: string; now?: number } = {}): ReleasedConnection {
  const projectId = options.projectId;
  if (typeof purpose !== "string" || !purposePattern.test(purpose)) throw new AppError("connection_purpose_invalid", 400);
  const connection = readConnection(tx, connectionId);
  if (connection.removedAt !== null || connection.secret !== "set") throw new AppError("connection_unavailable", 409);
  if (projectId !== undefined && connection.projectScope && !connection.projectScope.includes(projectId)) throw new AppError("connection_out_of_scope", 403);
  const secret = vault.read(connection.id);
  audit(tx, connection.id, "released", purpose, "internal", options.now ?? Date.now());
  return { connectionId: connection.id, kind: connection.kind, secret };
}

/** True when `child` is `parent` or lies beneath it. */
function inside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The real location of a path that may not exist yet: the realpath of its deepest existing ancestor plus the rest. */
function realLocation(path: string): string {
  const missing: string[] = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    try { return join(realpathSync(current), ...missing.reverse()); }
    catch { if (dirname(current) === current) return resolve(path); missing.push(basename(current)); }
  }
}

/**
 * The secret files of app.connections/v1 in `execution.secretsDirectory`. The directory must be absolute, outside
 * (and not containing) the state, backup and execution directories by lexical and real location, and reached through
 * no symlinked component — so managed backups and boxes stay credential-free —
 * and is kept mode 0700 and owned by the service uid. Files are 0600, written atomically (`O_EXCL|O_NOFOLLOW`
 * staging file, fsync, rename) and read only after lstat/fstat agree on a regular, owner-only, service-owned file.
 * A symlink, another owner or a mode wider than 0600 is `connection_vault_unsafe`.
 */
export class ConnectionVault {
  readonly directory: string;
  readonly #uid: number | undefined;

  constructor(directory: string, options: { forbidden: readonly (string | null | undefined)[]; uid?: number }) {
    if (!isAbsolute(directory)) throw new AppError("connection_vault_unsafe", 503);
    this.directory = resolve(directory);
    this.#forbidden = options.forbidden.filter((path): path is string => !!path).map(path => resolve(path));
    this.#uid = options.uid ?? process.getuid?.();
    this.#refuseCollision();
  }
  readonly #forbidden: string[];

  /**
   * Refuses a vault inside or around a forbidden directory, comparing both the lexical and the real locations, so a
   * symlinked parent (for example an alias into a workspace) cannot carry values into a box or a backup.
   */
  #refuseCollision(): void {
    const mine = [this.directory, realLocation(this.directory)];
    for (const path of this.#forbidden) for (const other of [path, realLocation(path)]) for (const own of mine) {
      if (inside(own, other) || inside(other, own)) throw new AppError("connection_vault_unsafe", 503);
    }
  }

  #dir(): string {
    this.#refuseCollision();
    // Nothing is created through a symlinked component: the existing part of the path must already be real.
    if (realLocation(this.directory) !== this.directory) throw new AppError("connection_vault_unsafe", 503);
    try { mkdirSync(this.directory, { recursive: true, mode: 0o700 }); } catch { throw new AppError("connection_vault_unsafe", 503); }
    // The directory that will hold values must resolve to itself: no symlinked component anywhere on the path.
    if (realpathSync(this.directory) !== this.directory) throw new AppError("connection_vault_unsafe", 503);
    const stats = lstatSync(this.directory);
    if (stats.isSymbolicLink() || !stats.isDirectory() || (this.#uid !== undefined && stats.uid !== this.#uid) || (stats.mode & 0o777) !== 0o700) {
      throw new AppError("connection_vault_unsafe", 503);
    }
    return this.directory;
  }

  #path(id: string): string { requireId(id); return join(this.#dir(), id); }

  #safe(stats: Stats): boolean {
    return stats.isFile() && !stats.isSymbolicLink() && (stats.mode & 0o177) === 0 && (this.#uid === undefined || stats.uid === this.#uid) &&
      stats.size >= 1 && stats.size <= maximumSecretBytes;
  }

  /** Writes the value atomically with mode 0600; a symlink or foreign file at the path is replaced by rename, never followed. */
  write(id: string, secret: string): void {
    const path = this.#path(id), staging = join(this.directory, `.${id}.${crypto.randomUUID()}.tmp`);
    const fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const bytes = Buffer.from(secret, "utf8");
      for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    try { chmodSync(staging, 0o600); renameSync(staging, path); }
    catch (error) { try { unlinkSync(staging); } catch { /* Already gone. */ } throw error; }
  }

  /** Metadata-only verdict; never opens the file. */
  inspect(id: string): SecretFileState {
    let stats: Stats;
    try { stats = lstatSync(this.#path(id)); } catch (error) { if (error instanceof AppError) throw error; return "missing"; }
    return this.#safe(stats) ? "present" : "unsafe";
  }

  /** Reads one value for {@link releaseConnection} (`connection_unavailable` when missing, `connection_vault_unsafe` when unsafe). */
  read(id: string): string {
    const path = this.#path(id);
    let before: Stats;
    try { before = lstatSync(path); } catch { throw new AppError("connection_unavailable", 409); }
    if (!this.#safe(before)) throw new AppError("connection_vault_unsafe", 503);
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { throw new AppError("connection_vault_unsafe", 503); }
    try {
      const opened = fstatSync(fd);
      if (opened.ino !== before.ino || opened.dev !== before.dev || !this.#safe(opened)) throw new AppError("connection_vault_unsafe", 503);
      const buffer = Buffer.alloc(maximumSecretBytes + 1);
      let length = 0;
      for (;;) { const read = readSync(fd, buffer, length, buffer.length - length, null); if (read === 0) break; length += read; if (length > maximumSecretBytes) break; }
      if (length < 1 || length > maximumSecretBytes) throw new AppError("connection_vault_unsafe", 503);
      return buffer.subarray(0, length).toString("utf8");
    } finally { closeSync(fd); }
  }

  /** Deletes the stored value, if any. */
  remove(id: string): void {
    // Only an already-missing file is success; any other failure aborts the command, which then records nothing.
    try { unlinkSync(this.#path(id)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  /** Fingerprints every stored value of a connection that holds one, so their echoes are redacted from boot on. */
  fingerprintStored(tx: AppTransaction): void {
    for (const row of tx.all<{ id: string }>("SELECT id FROM connections WHERE secret_state = 'set' AND removed_at IS NULL")) {
      try { registerSecretFingerprint(this.read(row.id)); } catch { /* An unreadable value is reported by connection.test. */ }
    }
  }
}
