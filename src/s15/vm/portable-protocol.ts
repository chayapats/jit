import { vmCanonical, vmFail, vmHash, vmInteger, vmRecord } from './validation';

/** Fixed ordinary-file transfer profile, independent of raw disk/hypervisor snapshots. */
export const portableLimits = Object.freeze({ files: 64, fileBytes: 1048576, totalBytes: 16 * 1048576, components: 16, pathBytes: 240 });
/** Exact reviewed guest-relative file identity. Hashes describe bytes, never execution authority. */
export interface PortableFile { path: string; bytes: number; sha256: string }
/** Protected byte buffer; it never enters a model result or an ordinary manifest response. */
export interface PortableFileBytes extends PortableFile { data: Uint8Array }
/** Small regular work paths only. Homes, credentials, browser/control state and caches are outside this profile. */
export function portablePath(value: unknown): string {
  if (typeof value !== 'string' || !value || !value.isWellFormed() || value.normalize('NFC') !== value || Buffer.byteLength(value) > portableLimits.pathBytes || /[\x00-\x20\x7f\\:%]/.test(value)) vmFail('vm_portable_path_denied', 403);
  const parts = value.split('/');
  if (parts.length > portableLimits.components || parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.') || /^(?:home|root|etc|proc|sys|dev|run|tmp|inputs|node_modules|vendor|__pycache__|cache|caches|browser|profiles?|credentials?|cookies?|sessions?|id_rsa|id_ed25519)$/i.test(p) || /\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|qcow2|ext4|img)$/i.test(p))) vmFail('vm_portable_path_denied', 403);
  return value;
}
/** Closed canonical manifest, with no duplicate, alias or file/directory-prefix collisions. */
export function portableFiles(value: unknown): PortableFile[] {
  if (!Array.isArray(value) || !value.length || value.length > portableLimits.files) vmFail('vm_portable_limit');
  let total = 0; const paths = new Set<string>();
  const files = value.map(raw => { const r = vmRecord(raw, ['path', 'bytes', 'sha256']), path = portablePath(r.path); vmInteger(r.bytes, portableLimits.fileBytes, 0);
    if (typeof r.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(r.sha256)) vmFail('vm_protocol_invalid'); total += Number(r.bytes);
    const alias = path.toLowerCase(); if (paths.has(alias)) vmFail('vm_portable_path_denied'); paths.add(alias); return { path, bytes: Number(r.bytes), sha256: r.sha256 };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (total > portableLimits.totalBytes || [...paths].some(p => p.split('/').slice(0, -1).some((_, i) => paths.has(p.split('/').slice(0, i + 1).join('/'))))) vmFail('vm_portable_limit');
  return files;
}
/** Guest tree identity is independent of the protected package/source-lineage identity. */
export function portableTreeHash(files: readonly PortableFile[]): string { return vmHash(vmCanonical({ contract: 's16-working-tree/v1', files: portableFiles(files) })); }
/** Original guest mutation identity, selected by the protected service rather than file content. */
export function portableId(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) vmFail('vm_protocol_invalid'); return value; }
