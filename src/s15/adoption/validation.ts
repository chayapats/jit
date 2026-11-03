import { createHash } from 'node:crypto';
import { isAbsolute, resolve, sep } from 'node:path';
import { AppError } from '../../errors';
import { opsPath } from '../../s14/ops-files';
import type { AdoptionOptions } from './types';

/** Safe fixed refusal vocabulary; raw SQLite, provider and filesystem errors must not escape owner projections. */
export function adoptionFail(code: string): never { throw new AppError(code, 409); }
/** Canonical bounded transition JSON; SQL integers are already decimal strings and array order is retained. */
export function encode(value: unknown): string {
  const walk = (v: unknown, depth: number): string => {
    if (depth > 24) adoptionFail('transition_bounds');
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isSafeInteger(v) && !Object.is(v, -0)) return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(x => walk(x, depth + 1)).join(',')}]`;
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${walk((v as Record<string, unknown>)[k], depth + 1)}`).join(',')}}`;
    return adoptionFail('transition_invalid_record');
  };
  const result = walk(value, 0);
  if (Buffer.byteLength(result) > 128 * 1024 * 1024) adoptionFail('transition_bounds');
  return result;
}
/** Hashes original bytes or canonical transition metadata, not authentication or remote truth. */
export const hashBytes = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const hashValue = (value: unknown): string => hashBytes(encode(value));
export function hash(value: string): void { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) adoptionFail('transition_invalid_hash'); }
export function id(value: string): void { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) adoptionFail('transition_invalid_identity'); }
export function nat(value: number): void { if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) adoptionFail('transition_invalid_revision'); }
export const containsPath = (parent: string, child: string): boolean => child === parent || child.startsWith(parent + sep);
/** Validates explicit, nonoverlapping host paths before creating any target file. */
export function validateOptions(o: AdoptionOptions): void {
  if (o.runtime !== 's15') adoptionFail('s15_opt_in_required');
  id(o.source.installationId);
  for (const b of [o.source.build, o.target]) {
    if (!/^[a-f0-9]{40}$/.test(b.commit)) adoptionFail('transition_source_unsupported');
    hash(b.sha256);
  }
  const roots = [o.source.database, o.source.configPath, o.source.build.path, o.target.path, ...o.source.preservedPaths];
  if (roots.length > 128 || roots.some(p => !isAbsolute(p) || resolve(p) !== p) || !isAbsolute(o.directory) || resolve(o.directory) !== o.directory) adoptionFail('transition_path_untrusted');
  [o.directory, ...roots].forEach(opsPath);
  if (roots.some(p => containsPath(p, o.directory) || containsPath(o.directory, p)) ||
      containsPath(`${o.source.database}.ops`, o.directory) || o.directory.startsWith(o.source.database + '.')) adoptionFail('transition_path_overlap');
  if (!Array.isArray(o.source.argv) || o.source.argv.length > 16 || o.source.argv.some(x => typeof x !== 'string' || x.length > 4096 || /[\x00-\x1f]/.test(x)) || o.source.argv[0] !== 'serve') adoptionFail('transition_selection_unsupported');
  if (o.source.runtime !== 's14' && o.source.runtime !== 'legacy') adoptionFail('transition_source_unsupported');
}
