import type { WorkingStateImport, WorkingStateManifest, WorkingStateView } from '../computers/working-state';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const original = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const count = (v: unknown, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= max;
const ref = (v: unknown) => record(v) && id(v.id) && count(v.revision) && count(v.generation);
const ids = (v: unknown, max = 128) => Array.isArray(v) && v.length <= max && v.every(id);
const refs = (v: unknown) => Array.isArray(v) && v.length <= 128 && v.every(ref);
const canonical = (v: unknown): string => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : record(v) ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v);
/** Validate bounded exact owner review bytes in browser/native clients, without importing a host runtime. */
export async function workingStateManifest(v: unknown): Promise<boolean> {
  if (!record(v) || v.contract !== 's16-working-state/v1' || !original(v.id) || !hash(v.manifestSha256) || !hash(v.treeSha256) || !Array.isArray(v.files) || !v.files.length || v.files.length > 64 || !ref(v.dataRef) || !record(v.source)) return false;
  let total = 0; const names = new Set<string>();
  for (const f of v.files) {
    if (!record(f) || typeof f.path !== 'string' || !f.path || new TextEncoder().encode(f.path).length > 240 || f.path.startsWith('/') || f.path.split('/').length > 16 || /[\x00-\x20\x7f\\:%]/.test(f.path) || f.path.split('/').some(p => !p || p.startsWith('.')) || !count(f.bytes, 1048576) || !hash(f.sha256) || names.has(f.path.toLowerCase())) return false;
    total += Number(f.bytes); names.add(f.path.toLowerCase());
  }
  const s = v.source;
  const c = v.compatibility;
  if (!count(v.capturedAt) || !count(s.ownerGeneration) || !record(c) || c.format !== 's16-working-files/v1' || c.scope !== 'same_installation' || c.execution !== 'unverified' || c.sourceBackend !== null && !['qemu', 'firecracker'].includes(c.sourceBackend as string) || c.platform !== null && (!record(c.platform) || typeof c.platform.os !== 'string' || c.platform.os.length > 80 || typeof c.platform.architecture !== 'string' || c.platform.architecture.length > 32 || c.platform.basis !== 'guest_reported')) return false;
  if (total > 16777216 || !id(s.vmId) || !id(s.workId) || !id(s.attemptId) || !count(s.generation) || !hash(s.authoritySha256) || !id(s.requestId) || !id(s.conversationId) || !ids(s.responsibilityIds) || !ids(s.sourceIds) || !refs(s.resources) || !refs(s.dataRefs) || !ref(s.bot) || !record(s.selection) || !ref(s.selection.route) || !ref(s.selection.model) || !id(s.selection.effort) || !ref(s.purpose) || s.privateBotId !== null && !id(s.privateBotId) || !Array.isArray(s.filePins) || s.filePins.length > 128 || !s.filePins.every(p => record(p) && p.contract === 's16-file-source/v1' && ref(p.source) && ref(p.resource) && hash(p.sha256) && (p.representationSha256 === null || hash(p.representationSha256)))) return false;
  try { const { manifestSha256, ...body } = v, bytes = new TextEncoder().encode(canonical(body)); if (bytes.length > 65536) return false; const digest = await crypto.subtle.digest('SHA-256', bytes); return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('') === manifestSha256; } catch { return false; }
}
/** Original receipt validation never upgrades a guest observation into native isolation evidence. */
export function workingStateImport(v: unknown): v is WorkingStateImport {
  return record(v) && v.contract === 's16-working-state-import/v1' && original(v.id) && original(v.packageId) && hash(v.manifestSha256) && hash(v.treeSha256) && record(v.destination) && id(v.destination.vmId) && id(v.destination.workId) && id(v.destination.attemptId) && count(v.destination.generation) && ['accepted', 'dispatched', 'not_sent', 'unknown', 'committed'].includes(v.state as string) && (v.state === 'committed' ? v.path === `/var/lib/jit-work/${v.destination.workId}/${v.destination.attemptId}/restored-${v.id}` : v.path === null);
}
/** Finite directory validation; no raw package bytes enter this projection. */
export async function workingStateView(v: unknown): Promise<boolean> {
  if (!record(v) || v.contract !== 's16-working-state-view/v1' || !record(v.limits) || v.limits.files !== 64 || v.limits.fileBytes !== 1048576 || v.limits.totalBytes !== 16777216 || v.limits.components !== 16 || v.limits.pathBytes !== 240 || !Array.isArray(v.sources) || v.sources.length > 64 || !v.sources.every(s => record(s) && id(s.workId) && id(s.vmId) && typeof s.label === 'string' && s.label.length <= 120) || !Array.isArray(v.packages) || v.packages.length > 32 || !Array.isArray(v.imports) || v.imports.length > 64 || !v.imports.every(workingStateImport)) return false;
  return (await Promise.all(v.packages.map(workingStateManifest))).every(Boolean);
}
export type { WorkingStateImport, WorkingStateManifest, WorkingStateView };
