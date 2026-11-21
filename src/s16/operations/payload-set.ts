import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, opendirSync, openSync, readSync, readdirSync, writeSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { AppError } from '../../errors';
import { opsPath, opsRead, opsSyncDirectory, opsWrite } from '../../s14/ops-files';
import { canonical, identity } from '../../s15/conversation/validation';

const fileBound = 1_073_741_824, totalBound = 4_294_967_296, manifestBound = 4_194_304, filesBound = 20_000;
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function refuse(code = 's16_ops_payload_integrity_failed'): never { throw new AppError(code, 409); }
/** Inert private byte identity. Name is an opaque flat alias, never an execution path or permission. */
export interface S16PayloadIdentity { name: string; bytes: number; sha256: string }
/** A protected owning resolver supplies paths; no client, model or candidate archive may select one. */
export interface S16PayloadSource extends S16PayloadIdentity { path: string }
/** Selected opaque bytes only; this does not certify a complete installation or restore authority. */
export interface S16PayloadSet {
  contract: 's16-payload-set/v1'; scope: 'caller_selected_payloads'; installationId: string; id: string;
  capturedAt: number; bytes: number; files: ReadonlyArray<Readonly<S16PayloadIdentity>>;
}
/** Trusted capture scope. The current owner/maintenance/source guard runs before and after each file. */
export interface S16PayloadCapture {
  directory: string; installationId: string; id: string; sources: readonly S16PayloadSource[];
  guard(): void; now?: () => number; maxBytes?: number;
  /** Original protected staging only: verify matching existing bytes against current sources, never overwrite. */
  resume?: true;
  /** Existing authenticated publication only: refuse missing members instead of repairing them. */
  verifyOnly?: true;
}
/** Expected hash/identities originate in independent protected receipts and verified owning metadata. */
export interface S16PayloadVerification {
  directory: string; installationId: string; id: string; manifestSha256: string; files: readonly S16PayloadIdentity[];
}
function validateFiles(files: readonly S16PayloadIdentity[]): void {
  if (!Array.isArray(files) || files.length > filesBound) refuse('s16_ops_payload_invalid');
  let total = 0; const names = new Set<string>();
  for (const file of files) {
    if (!file || typeof file.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/.test(file.name) || file.name.toLowerCase() === 'manifest.json' || names.has(file.name.toLowerCase()) ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > fileBound || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) refuse('s16_ops_payload_invalid');
    names.add(file.name.toLowerCase());
    total += file.bytes; if (total > totalBound) refuse('s16_ops_capture_bounds');
  }
}
// Payload inventory is bounded independently of a command receipt. Encoding each closed small
// entry preserves canonical bytes without applying the shared 256-entry/128 KiB command limit.
function fileArray(files: readonly S16PayloadIdentity[]): string {
  if (Object.getPrototypeOf(files) !== Array.prototype || Reflect.ownKeys(files).length !== files.length + 1 ||
    Object.entries(Object.getOwnPropertyDescriptors(files)).some(([key, descriptor]) => !('value' in descriptor) || key !== 'length' && !descriptor.enumerable)) refuse('s16_ops_payload_invalid');
  return '[' + files.map(file => canonical(file)).join(',') + ']';
}
function manifestText(manifest: Readonly<S16PayloadSet>): string {
  if (!manifest || Object.getPrototypeOf(manifest) !== Object.prototype || Reflect.ownKeys(manifest).length !== 7 ||
    Object.values(Object.getOwnPropertyDescriptors(manifest)).some(descriptor => !('value' in descriptor) || !descriptor.enumerable) ||
    Object.keys(manifest).sort().join(',') !== 'bytes,capturedAt,contract,files,id,installationId,scope') refuse('s16_ops_payload_invalid');
  validateFiles(manifest.files);
  const text = '{' + Object.keys(manifest).sort().map(key => JSON.stringify(key) + ':' + (key === 'files' ? fileArray(manifest.files) : canonical(manifest[key as keyof S16PayloadSet]))).join(',') + '}';
  if (Buffer.byteLength(text) > manifestBound) refuse('s16_ops_capture_bounds');
  return text;
}
function privateDirectory(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path) refuse('s16_ops_path_untrusted');
  try {
    opsPath(path); const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o7077) refuse('s16_ops_path_untrusted');
  } catch { refuse('s16_ops_path_untrusted'); }
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
/** Streams and optionally copies one immutable file; never decodes or returns its contents. */
function transfer(source: string, expected: S16PayloadIdentity, target?: string): void {
  if (!isAbsolute(source) || normalize(source) !== source) refuse('s16_ops_path_untrusted');
  let input: number | undefined, output: number | undefined;
  try {
    opsPath(source); const before = lstatSync(source, { bigint: true }), uid = process.getuid?.();
    if (uid === undefined || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.uid !== BigInt(uid) || before.mode & 0o7177n) refuse('s16_ops_path_untrusted');
    if (before.size !== BigInt(expected.bytes)) refuse();
    input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!same(before, fstatSync(input, { bigint: true }))) refuse('s16_ops_image_changed');
    if (target) { opsPath(target); output = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    const hash = createHash('sha256'), buffer = Buffer.alloc(Math.min(65_536, expected.bytes || 1)); let position = 0;
    while (position < expected.bytes) {
      const length = readSync(input, buffer, 0, Math.min(buffer.length, expected.bytes - position), position);
      if (!length) refuse('s16_ops_image_changed'); hash.update(buffer.subarray(0, length));
      if (output !== undefined) for (let offset = 0; offset < length;) { const written = writeSync(output, buffer, offset, length - offset); if (!written) refuse('s16_ops_payload_copy_failed'); offset += written; }
      position += length;
    }
    if (readSync(input, buffer, 0, 1, position) !== 0 || !same(before, fstatSync(input, { bigint: true })) || !same(before, lstatSync(source, { bigint: true }))) refuse('s16_ops_image_changed');
    if (hash.digest('hex') !== expected.sha256) refuse();
    if (output !== undefined) fsyncSync(output);
  } catch (error) {
    if (error instanceof AppError && error.code.startsWith('s16_ops_')) throw error;
    return refuse();
  } finally { if (output !== undefined) closeSync(output); if (input !== undefined) closeSync(input); }
}

/**
 * Verifies existing owning byte descriptors without creating output or a manifest. The protected
 * caller supplies current scope/expected hashes and retains exclusion; this is not archive authority.
 */
export function verifyS16PayloadSources(sources: readonly S16PayloadSource[], guard: () => void): void {
  if (!Array.isArray(sources) || sources.length > filesBound) refuse('s16_ops_payload_invalid');
  const selected = sources.map(source => ({ ...source })); validateFiles(selected);
  const current = () => { if ((guard() as unknown) !== undefined) refuse('s16_ops_payload_invalid'); }; current();
  for (const source of selected) { current(); transfer(source.path, source); current(); }
  current();
}

/**
 * Captures a protected resolver's exact immutable bytes into exclusive private files, verifies the
 * actual copied bytes, and publishes metadata last after current revalidation. Partial points remain
 * private/unpublished and are never overwritten or resumed. No file becomes an artifact or authority.
 */
export function captureS16PayloadSet(options: S16PayloadCapture): Readonly<S16PayloadSet> {
  identity(options.installationId);
  if (!/^[a-f0-9]{32}$/.test(options.id) || typeof options.guard !== 'function' || options.resume !== undefined && options.resume !== true || options.verifyOnly !== undefined && (options.verifyOnly !== true || !options.resume)) refuse('s16_ops_payload_invalid');
  validateFiles(options.sources); privateDirectory(options.directory);
  const sources = options.sources.map(source => ({ ...source })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0), bytes = sources.reduce((n, source) => n + source.bytes, 0), limit = options.maxBytes ?? totalBound;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > totalBound || bytes > limit) refuse('s16_ops_capture_bounds');
  const capturedAt = (options.now ?? Date.now)(); if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) refuse('s16_ops_payload_invalid');
  const current = () => { if ((options.guard() as unknown) !== undefined) refuse('s16_ops_payload_invalid'); };
  const files = sources.map(source => Object.freeze({ name: source.name, bytes: source.bytes, sha256: source.sha256 }));
  const manifest = Object.freeze({ contract: 's16-payload-set/v1' as const, scope: 'caller_selected_payloads' as const, installationId: options.installationId, id: options.id, capturedAt, bytes, files: Object.freeze(files) });
  const text = manifestText(manifest);
  current(); const target = join(options.directory, options.id);
  if (lstatSync(target, { throwIfNoEntry: false })) { if (!options.resume) refuse('s16_ops_point_unavailable'); }
  else { if (options.verifyOnly) refuse('s16_ops_point_unavailable'); try { mkdirSync(target, { mode: 0o700 }); } catch { refuse('s16_ops_point_unavailable'); } }
  privateDirectory(target); const original = lstatSync(target); opsSyncDirectory(options.directory);
  const targetCurrent = () => { current(); privateDirectory(target); const now = lstatSync(target); if (original.dev !== now.dev || original.ino !== now.ino || original.mode !== now.mode) refuse('s16_ops_image_changed'); };
  const inventory = () => { const names = new Set([...files.map(file => file.name), 'manifest.json']), dir = opendirSync(target); let count = 0;
    try { for (;;) { const item = dir.readSync(); if (!item) break; if (++count > files.length + 1 || !names.has(item.name)) refuse('s16_ops_inventory_changed'); } } finally { dir.closeSync(); } }; inventory();
  for (const source of sources) {
    targetCurrent(); const file = join(target, source.name);
    if (lstatSync(file, { throwIfNoEntry: false })) transfer(source.path, source); else { if (options.verifyOnly) refuse('s16_ops_image_changed'); transfer(source.path, source, file); }
    transfer(file, source); opsSyncDirectory(target); targetCurrent();
  }
  targetCurrent(); inventory(); const path = join(target, 'manifest.json');
  if (lstatSync(path, { throwIfNoEntry: false })) transfer(path, { name: 'manifest', bytes: Buffer.byteLength(text), sha256: sha(text) }); else { if (options.verifyOnly) refuse('s16_ops_image_changed'); opsWrite(path, text); }
  targetCurrent(); inventory(); return manifest;
}
/** Hash to retain in the outer current receipt; candidate self-hashing is never independent provenance. */
export function s16PayloadSetManifestHash(manifest: Readonly<S16PayloadSet>): string { return sha(manifestText(manifest)); }
/** Exact bounded index bytes for protected aggregate budget planning; this supplies no capture/receipt authority. */
export function s16PayloadSetManifestText(manifest: Readonly<S16PayloadSet>): string { return manifestText(manifest); }
/** Verifies receipt-bound exact opaque files read-only; it neither restores them nor registers sources/grants. */
export function verifyS16PayloadSet(options: S16PayloadVerification): Readonly<S16PayloadSet> {
  identity(options.installationId); validateFiles(options.files);
  if (!/^[a-f0-9]{32}$/.test(options.id) || !/^[a-f0-9]{64}$/.test(options.manifestSha256)) refuse('s16_ops_payload_invalid');
  privateDirectory(options.directory); const path = join(options.directory, options.id); privateDirectory(path);
  try {
    const manifestPath = join(path, 'manifest.json'), stat = lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o7177) refuse('s16_ops_path_untrusted');
    const text = opsRead(manifestPath, manifestBound); if (sha(text) !== options.manifestSha256) refuse();
    const value: unknown = JSON.parse(text.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'bytes,capturedAt,contract,files,id,installationId,scope') refuse();
    const manifest = value as S16PayloadSet;
    validateFiles(manifest.files);
    const files = options.files.map(file => ({ name: file.name, bytes: file.bytes, sha256: file.sha256 })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const inventory = readdirSync(path).sort(), expectedInventory = [...files.map(file => file.name), 'manifest.json'].sort();
    if (manifest.contract !== 's16-payload-set/v1' || manifest.scope !== 'caller_selected_payloads' || manifest.installationId !== options.installationId || manifest.id !== options.id ||
      !Number.isSafeInteger(manifest.capturedAt) || manifest.capturedAt < 0 || manifest.bytes !== files.reduce((n, file) => n + file.bytes, 0) || fileArray(manifest.files) !== fileArray(files) || manifestText(manifest) !== text.toString('utf8') ||
      inventory.length !== expectedInventory.length || inventory.some((name, index) => name !== expectedInventory[index])) refuse();
    for (const file of files) transfer(join(path, file.name), file);
    if (sha(opsRead(manifestPath, manifestBound)) !== options.manifestSha256) refuse();
    return Object.freeze({ ...manifest, files: Object.freeze(files.map(file => Object.freeze(file))) });
  } catch (error) {
    if (error instanceof AppError && error.code.startsWith('s16_ops_')) throw error;
    return refuse();
  }
}
