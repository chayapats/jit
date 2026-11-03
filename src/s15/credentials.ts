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
