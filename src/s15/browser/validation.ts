import { createHash } from 'node:crypto';
import type { BrowserOperation, BrowserRequest } from './types';
/** Safe stable boundary error; raw browser/network errors must never enter logs or tool results. */
export class BrowserError extends Error { constructor(readonly code: string) { super(code); } }
/** Credential-free bounded HTTP(S); userinfo, fragments and control bytes are refused, not normalized away. */
export function browserUrl(input: string): URL {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 4096 || /[\x00-\x20\x7f]/.test(input)) throw new BrowserError('invalid_url');
  let url: URL; try { url = new URL(input); } catch { throw new BrowserError('invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new BrowserError('invalid_url');
  return url;
}
/** Reject unknown operation fields and arbitrary JS/protocol/file operations before touching the engine. */
export function operation(input: unknown): asserts input is BrowserOperation {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) throw new BrowserError('invalid_operation');
  if (Object.values(Object.getOwnPropertyDescriptors(input)).some(d => !Object.hasOwn(d, 'value'))) throw new BrowserError('invalid_operation');
  const v = input as Record<string, unknown>;
  const fields: Record<string, string[]> = { navigate: ['url'], read: [], screenshot: [], find: ['text'], click: ['target'], submit: ['target'], type: ['target', 'value'], select: ['target', 'value'] };
  const keys = typeof v.kind === 'string' ? fields[v.kind] : null;
  if (!keys || Object.keys(v).sort().join() !== ['kind', 'generation', ...keys].sort().join()) throw new BrowserError('invalid_operation');
  if (!Number.isSafeInteger(v.generation) || (v.generation as number) < 1) throw new BrowserError('stale_input');
  for (const k of keys) if (typeof v[k] !== 'string' || !v[k] || Buffer.byteLength(v[k] as string) > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v[k] as string)) throw new BrowserError('invalid_operation');
  if (v.kind === 'navigate') browserUrl(v.url as string);
  if (typeof v.target === 'string' && !/^e[0-9]+_[0-9]+$/.test(v.target)) throw new BrowserError('stale_target');
}
/** Validates actual complete request bytes, denying multipart/file and opaque/streaming bodies. */
export function validateRequest(r: BrowserRequest): void {
  if (!r || typeof r !== 'object' || Object.getPrototypeOf(r) !== Object.prototype || Object.keys(r).sort().join() !== ['method', 'url', 'contentType', 'bodyBase64', 'navigation'].sort().join() || typeof r.method !== 'string' || typeof r.url !== 'string' || typeof r.contentType !== 'string' || typeof r.bodyBase64 !== 'string' || typeof r.navigation !== 'boolean') throw new BrowserError('invalid_operation');
  browserUrl(r.url);
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(r.method)) throw new BrowserError('protocol_unsupported');
  if (Buffer.from(r.bodyBase64, 'base64').toString('base64') !== r.bodyBase64 || Buffer.from(r.bodyBase64, 'base64').length > 65536) throw new BrowserError('body_unsupported');
  if (/[\r\n]/.test(r.contentType) || !['', 'application/x-www-form-urlencoded', 'application/json', 'text/plain'].includes(r.contentType.split(';')[0] ?? '')) throw new BrowserError('upload_unsupported');
  if (['GET', 'HEAD'].includes(r.method) && r.bodyBase64) throw new BrowserError('body_unsupported');
}
/** Evidence hashes bind actual captured safe bytes; never hash or persist login secrets. */
export const bytesHash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
