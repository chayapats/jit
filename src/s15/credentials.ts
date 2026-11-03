import { createHash } from 'node:crypto';
import type { ConnectionVault } from '../exec/connections';
import { AppError } from '../errors';
import { registerSecretFingerprint } from '../security/secret-fingerprints';

/** Resolve a non-secret protected configuration alias to the UUID identity required by S14's vault.
 * This changes neither its storage format nor its owner/mode/symlink/backup protections. */
export function s15CredentialKey(installationId: string, alias: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(alias)) throw new AppError('invalid_credential_ref');
  if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(alias)) return alias;
  const hex = createHash('sha256').update(JSON.stringify(['s15.credential.alias/v1', installationId, alias])).digest('hex').slice(0, 32);
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/** Host-only read; register the actual value for prompt/export screening before any protected use. */
export function readS15Credential(vault: ConnectionVault, installationId: string, alias: string): string {
  const secret = vault.read(s15CredentialKey(installationId, alias)); registerSecretFingerprint(secret); return secret;
}

/**
 * Resolve a pinned Google effect binding to its exact configured personal connection. Gmail and Calendar
 * connections for one account can share a revision, so the configured resource->connection binding is the
 * only identity; revision, account and scope are then checked on that exact connection.
 */
export function s15GoogleConnection<C extends { id: string; account: string; revision: number; scopes: readonly string[] }>(
  bindings: readonly { connectionId: string; resource: { id: string; generation: number } }[],
  binding: { resource: { id: string; revision: number; generation: number }; account: string },
  scope: string, read: (connectionId: string) => C): C {
  const matches = bindings.filter(r => r.resource.id === binding.resource.id && r.resource.generation === binding.resource.generation);
  if (matches.length !== 1) throw new AppError('personal_connection_unavailable');
  const connection = read(matches[0]!.connectionId);
  if (connection.id !== matches[0]!.connectionId || connection.revision !== binding.resource.revision || connection.account !== binding.account) throw new AppError('personal_account_changed');
  if (!connection.scopes.includes(scope)) throw new AppError('personal_consent_required');
  return connection;
}
