import type { Database } from 'bun:sqlite';
import { lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { AppError } from '../../errors';
import { opsPath } from '../../s14/ops-files';
import { identity } from '../../s15/conversation/validation';
import type { S16PayloadSource } from '../operations/payload-set';

function refuse(): never { throw new AppError('s16_ops_file_custody_invalid', 409); }
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const size = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_048_576;
/** Protected custody inventory only; it never publishes an artifact, interprets a file or releases source restrictions. */
export interface FileCustodyPayloads {
  readonly sources: readonly S16PayloadSource[];
  readonly pending: ReadonlyArray<{ readonly id: string; readonly state: 'uploading' | 'validating' }>;
  readonly untracked: readonly string[];
}
/**
 * Enumerates immutable original/representation/artifact bytes from the owning current file journal.
 * The caller holds/rechecks the protected runtime/owner fence. Staging, withdrawn and rejected input
 * bytes are never promoted; pending/untracked custody must be reconciled before aggregate completion.
 * Raw descriptors are host-only and must never become client/model paths or ordinary export authority.
 */
export function fileCustodyPayloads(database: Database, directory: string, installationId: string, guard: () => void): FileCustodyPayloads {
  identity(installationId);
  const current = () => { if ((guard() as unknown) !== undefined) refuse(); }; current();
  if (!isAbsolute(directory) || normalize(directory) !== directory) refuse();
  try {
    opsPath(directory); const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o7077) refuse();
  } catch { return refuse(); }
  if (database.query<{ application_id: number }, []>('PRAGMA application_id').get()?.application_id !== 0x4a495446 || ![1, 2, 3].includes(database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? -1)) refuse();
  const identities = database.query<{ installation: string }, []>('SELECT installation FROM identity LIMIT 2').all();
  if (identities.length !== 1 || identities[0]!.installation !== installationId) refuse();
  // Bound before loading JSON bodies; a corrupt journal must not allocate an unbounded result set.
  const bounds = database.query<{ rows: number; bytes: number; largest: number; invalid: number }, []>("SELECT count(*) AS rows,coalesce(sum(length(CAST(json AS BLOB))),0) AS bytes,coalesce(max(length(CAST(json AS BLOB))),0) AS largest,coalesce(sum(typeof(json)!='text' OR typeof(id)!='text' OR length(id)>128),0) AS invalid FROM records").get();
  if (!bounds || bounds.rows > 10000 || bounds.bytes > 16_777_216 || bounds.largest > 131072 || bounds.invalid) refuse();
  const rows = database.query<{ id: string; json: string }, []>('SELECT id,json FROM records ORDER BY id LIMIT 10001').all();
  if (rows.length > 10000) refuse();
  const sources: S16PayloadSource[] = [], pending: { id: string; state: 'uploading' | 'validating' }[] = [];
  const add = (id: string, bytes: unknown, sha256: unknown, derived = false) => {
    if (!size(bytes) || !hash(sha256)) refuse();
    const name = id + '.blob' + (derived ? '.derived' : '');
    sources.push(Object.freeze({ name, path: join(directory, name), bytes, sha256 }));
  };
  for (const row of rows) {
    current(); if (typeof row.json !== 'string' || Buffer.byteLength(row.json) > 131072) refuse();
    let value: Record<string, unknown>; try { value = JSON.parse(row.json); } catch { return refuse(); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.id !== row.id) refuse();
    identity(row.id); if (/[\/\\\0]/.test(row.id)) refuse();
    if (value.kind === 'artifact') {
      if (value.contract !== 's16-file-artifact/v1') refuse(); add(row.id, value.bytes, value.sha256); continue;
    }
    if (value.kind !== 'upload' || value.contract !== 's16-file-upload/v1' || !['created', 'uploading', 'validating', 'ready', 'rejected', 'cancelled', 'expired', 'withdrawn'].includes(value.state as string)) refuse();
    if (value.state === 'uploading' || value.state === 'validating') pending.push(Object.freeze({ id: row.id, state: value.state }));
    if (value.state !== 'ready') continue;
    const receipt = value.receipt as Record<string, unknown> | null;
    if (!receipt || !['s16-file-receipt/v1', 's16-file-receipt/v2'].includes(receipt.contract as string) || receipt.id !== row.id || receipt.sha256 !== value.expectedHash || receipt.bytes !== value.bytes || value.expectedBytes !== value.bytes) refuse();
    add(row.id, receipt.bytes, receipt.sha256);
    if (receipt.contract === 's16-file-receipt/v2') {
      const representation = receipt.representation as Record<string, unknown> | null;
      if (receipt.validation !== 's16-isolated-file/v1' || typeof receipt.parserGeneration !== 'string' || !receipt.parserGeneration || !representation || !['text/plain', 'image/png', 'image/jpeg'].includes(representation.mime as string)) refuse();
      add(row.id, representation.bytes, representation.sha256, true);
    }
  }
  const selected = new Set(sources.map(source => source.name));
  const untracked = readdirSync(directory).filter(name => !selected.has(name)).sort(); current();
  return Object.freeze({ sources: Object.freeze(sources), pending: Object.freeze(pending), untracked: Object.freeze(untracked) });
}
