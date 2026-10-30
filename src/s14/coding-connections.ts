import { AppError } from "../errors";
import { normalizeSecret } from "../exec/connections";
import { containsCredential } from "../security/credentials";
import { registerSecretFingerprint } from "../security/secret-fingerprints";
import type { AppTransaction } from "../store";
import type { S14Application } from "./application";
import type { GitConnection, GitConnectionCommand, GitOptions, GitReceipt } from "./coding-git-types";
import { canonical, exact, identity, text } from "./validation";

/** Reads only resource-scoped metadata; callers separately enforce owner access or an exact effect purpose. */
export function gitConnection(tx: AppTransaction, id: string): GitConnection {
  identity(id);
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM git_connections WHERE id=?", id);
  if (!row) throw new AppError("connection_not_found", 404);
  return JSON.parse(row.record_json);
}

/** Applies the existing one-way vault lifecycle with repository scope replacing legacy Project scope. */
export function applyGitConnection(app: S14Application, tx: AppTransaction, command: GitConnectionCommand, options: GitOptions): GitReceipt {
  const vault = options.vault;
  if (!vault) throw new AppError("connection_vault_not_configured", 503);
  if (command.kind === "git.connection.create") {
    exact(command.payload, ["repositoryId", "label"]);
    identity(command.payload.repositoryId);
    if (command.expectedRevision !== 0) throw new AppError("stale_revision", 409);
    if (text(command.payload.label, 80) !== command.payload.label || containsCredential(command.payload.label)) throw new AppError("invalid_connection_label");
    const scope = app.coding.scope(tx, { kind: "resource", id: command.payload.repositoryId, revision: 1 });
    if (!scope?.active) throw new AppError("connection_out_of_scope", 403);
    const connection: GitConnection = { id: crypto.randomUUID(), revision: 1, kind: "github_token", label: command.payload.label,
      repositoryId: command.payload.repositoryId, secret: "empty", removed: false };
    tx.run("INSERT INTO git_connections VALUES (?,?,NULL)", connection.id, canonical(connection));
    return { kind: command.kind, requestId: command.requestId, connection };
  }
  const hasSecret = command.kind === "git.connection.secret.set" || command.kind === "git.connection.rotate";
  exact(command.payload, hasSecret ? ["connectionId", "secret"] : ["connectionId"]);
  const connection = gitConnection(tx, command.payload.connectionId);
  if (connection.revision !== command.expectedRevision || connection.removed) throw new AppError("stale_revision", 409);
  const currentVault = tx.get<{ vault_id: string | null }>("SELECT vault_id FROM git_connections WHERE id=?", connection.id)?.vault_id;
  if (command.kind === "git.connection.test") return { kind: command.kind, requestId: command.requestId, connection,
    test: !currentVault || connection.secret === "empty" ? "missing" : vault.inspect(currentVault) };
  if (command.kind === "git.connection.remove") {
    if (currentVault) vault.remove(currentVault);
    tx.run("UPDATE git_connections SET vault_id=NULL WHERE id=?", connection.id);
    connection.removed = true;
    connection.secret = "empty";
  } else {
    if (command.kind === "git.connection.secret.set" && connection.secret !== "empty") throw new AppError("connection_secret_exists", 409);
    if (command.kind === "git.connection.rotate" && connection.secret !== "set") throw new AppError("connection_secret_missing", 409);
    const secret = normalizeSecret((command.payload as { secret: string }).secret);
    registerSecretFingerprint(secret);
    // A file ahead of a rolled-back SQLite revision cannot replace an older approval's credential.
    const key = crypto.randomUUID();
    vault.write(key, secret);
    if (currentVault) vault.remove(currentVault);
    tx.run("UPDATE git_connections SET vault_id=? WHERE id=?", key, connection.id);
    connection.secret = "set";
  }
  connection.revision++;
  tx.run("UPDATE git_connections SET record_json=? WHERE id=?", canonical(connection), connection.id);
  return { kind: command.kind, requestId: command.requestId, connection };
}
