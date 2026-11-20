import { createHash } from 'node:crypto';
import { AppError } from '../../errors';
import type { SearchKind, SearchQuery, SearchTarget } from './contracts';

/** Closed owning object families; an arbitrary model- or client-supplied kind cannot select a service. */
export const searchKinds: readonly SearchKind[] = ['history', 'work', 'routine', 'memory', 'artifact'];
/** Maximum candidate identities; exceeding it refuses rather than presenting a partial complete result. */
export const searchCapacity = 10000;
/** Owning opaque identifier grammar; labels and paths are never object IDs. */
export const searchId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
/** SHA-256 of an explicitly ordered trusted shape; used for cursors/command identity, never authority. */
export const searchHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Kind-qualified organization key; original owning IDs remain intact. */
export const searchKey = (target: SearchTarget) => `${target.kind}:${target.id}`;
/** Locale-stable lexical matching only; normalization cannot create owner or source authority. */
export const searchNormalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/gu, ' ').trim();
/** Exact object shape, refusing extra fields, paths, unknown service kinds and malformed IDs. */
export function searchTarget(raw: unknown): SearchTarget {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 2 || !('kind' in raw) || !('id' in raw) || !searchKinds.includes(raw.kind as SearchKind) || !searchId(raw.id)) throw new AppError('invalid_search_target');
  return { kind: raw.kind as SearchKind, id: raw.id };
}
/** Owner labels use a single canonical spelling; controls, duplicates and unbounded text refuse. */
export function searchLabel(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.isWellFormed()) throw new AppError('invalid_search_label');
  const value = raw.normalize('NFKC').trim();
  if (!value || Array.from(value).length > 48 || Buffer.byteLength(value) > 192 || /[\p{Cc}\p{Cf}]/u.test(value)) throw new AppError('invalid_search_label');
  return value;
}
/** Known keys exactly once. Malformed filters cannot silently widen a private search. */
export function parseSearchQuery(params: URLSearchParams): SearchQuery {
  const keys = ['q', 'kind', 'bot', 'label', 'from', 'to', 'after'];
  if ([...params.keys()].some(key => !keys.includes(key)) || keys.some(key => params.getAll(key).length > 1)) throw new AppError('invalid_search_query');
  const q = params.get('q') ?? '', kind = params.get('kind') ?? 'all', bot = params.get('bot'), label = params.get('label'), after = params.get('after');
  if (q.length > 256 || !q.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(q) || kind !== 'all' && !searchKinds.includes(kind as SearchKind) || bot !== null && !searchId(bot)) throw new AppError('invalid_search_query');
  const timestamp = (key: string) => { const value = params.get(key); if (value === null) return null; if (!/^(?:0|[1-9]\d{0,15})$/.test(value) || !Number.isSafeInteger(Number(value))) throw new AppError('invalid_search_query'); return Number(value); };
  const from = timestamp('from'), to = timestamp('to');
  if (from !== null && to !== null && from > to || after !== null && (!/^[A-Za-z0-9_-]{1,512}$/.test(after))) throw new AppError('invalid_search_query');
  return { q, kind: kind as SearchQuery['kind'], bot, label: label === null ? null : searchLabel(label), from, to, after };
}
/** Cursor is a versioned filter-bound position, not a retained result or authorization token. */
export interface SearchPosition { version: 1; filter: string; score: number; at: number; key: string }
/** Bind a position to every filter, excluding only its own cursor. */
export function searchFilter(query: SearchQuery): string { const { after: _, ...filters } = query; return searchHash(filters); }
/** Validate a finite, content-free current-view position. A position never skips owning guards. */
export function searchPosition(query: SearchQuery): SearchPosition | null {
  if (!query.after) return null;
  try {
    const p = JSON.parse(Buffer.from(query.after, 'base64url').toString('utf8')) as SearchPosition;
    if (Object.keys(p).sort().join(',') !== 'at,filter,key,score,version' || p.version !== 1 || p.filter !== searchFilter(query) || !Number.isSafeInteger(p.score) || p.score < 0 || !Number.isSafeInteger(p.at) || p.at < 0 || typeof p.key !== 'string' || !/^(?:history|work|routine|memory|artifact):[A-Za-z0-9_-]{1,128}$/.test(p.key)) throw new Error();
    return p;
  } catch { throw new AppError('search_cursor_invalid', 409); }
}
