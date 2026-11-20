import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../src/errors';
import { canonical } from '../src/s15/conversation/validation';
import { captureS16PayloadSet, s16PayloadSetManifestHash, verifyS16PayloadSet, type S16PayloadCapture, type S16PayloadVerification } from '../src/s16/operations/payload-set';

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });
const hash = (value: Uint8Array | string) => new Bun.CryptoHasher('sha256').update(value).digest('hex');
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-payload-set-'))); cleanup.push(root);
  const directory = join(root, 'points'); mkdirSync(directory, { mode: 0o700 });
  const binary = Uint8Array.from({ length: 196625 }, (_, i) => i % 251), empty = new Uint8Array();
  const sources = [binary, empty].map((bytes, i) => {
    const path = join(root, `input${i}`); writeFileSync(path, bytes, { mode: 0o600 });
    return { name: i ? 'b_empty' : 'a-binary', path, bytes: bytes.length, sha256: hash(bytes) };
  });
  const options: S16PayloadCapture = { directory, installationId: 'installation', id: 'a'.repeat(32), sources, now: () => 123, guard() {} };
  return { root, directory, binary, sources, options, target: join(directory, options.id) };
}

test('original partial payload staging resumes matching current sources without overwriting existing members', () => {
  const f = fixture(), first = captureS16PayloadSet(f.options), path = join(f.target, first.files[0]!.name), before = statSync(path);
  unlinkSync(join(f.target, 'manifest.json')); unlinkSync(join(f.target, first.files[1]!.name));
  expect(captureS16PayloadSet({ ...f.options, resume: true })).toEqual(first); expect(statSync(path).ino).toBe(before.ino);
});

test('published payload verification refuses a missing member without repair and refuses changed current source bytes', () => {
  const f = fixture(), first = captureS16PayloadSet(f.options), target = join(f.target, first.files[0]!.name);
  writeFileSync(f.sources[0]!.path, 'changed current source', { mode: 0o600 }); expect(() => captureS16PayloadSet({ ...f.options, resume: true })).toThrow();
  unlinkSync(target); expect(() => captureS16PayloadSet({ ...f.options, resume: true, verifyOnly: true })).toThrow(); expect(existsSync(target)).toBe(false);
});
function capture(f: ReturnType<typeof fixture>) {
  const manifest = captureS16PayloadSet(f.options);
  const verification: S16PayloadVerification = { ...f.options, files: manifest.files, manifestSha256: s16PayloadSetManifestHash(manifest) };
  return { manifest, verification };
}

test('multiblock binary and empty payloads retain exact bytes and independent receipt identity without exposing paths or decoding contents', () => {
  const f = fixture(), before = f.sources.map(source => readFileSync(source.path)), { manifest, verification } = capture(f);
  expect(verifyS16PayloadSet(verification)).toEqual(manifest);
  expect(readFileSync(join(f.target, 'a-binary'))).toEqual(Buffer.from(f.binary)); expect(readFileSync(join(f.target, 'b_empty')).length).toBe(0);
  expect(f.sources.map(source => readFileSync(source.path))).toEqual(before);
  expect(manifest).toMatchObject({ contract: 's16-payload-set/v1', scope: 'caller_selected_payloads', installationId: 'installation', capturedAt: 123, bytes: f.binary.length });
  expect(readFileSync(join(f.target, 'manifest.json'), 'utf8')).not.toContain(f.root);
  expect(readFileSync(join(f.target, 'manifest.json'), 'utf8')).toBe(canonical(manifest)); expect(s16PayloadSetManifestHash(manifest)).toBe(hash(canonical(manifest)));
  const retained = readFileSync(join(f.target, 'manifest.json'));
  expect(() => captureS16PayloadSet(f.options)).toThrow(expect.objectContaining({ code: 's16_ops_point_unavailable' })); expect(readFileSync(join(f.target, 'manifest.json'))).toEqual(retained);
});

test('actual 512-file capture and receipt-bound verification exceed command limits without changing canonical bytes or weakening inventory checks', () => {
  const f = fixture(), empty = f.sources[1]!;
  f.options.sources = Array.from({ length: 512 }, (_, index) => ({ ...empty, name: 'payload_' + index.toString().padStart(4, '0') + '_'.repeat(170) }));
  const { manifest, verification } = capture(f), bytes = readFileSync(join(f.target, 'manifest.json'));
  expect(manifest.files).toHaveLength(512); expect(bytes.length).toBeGreaterThan(131_072); expect(s16PayloadSetManifestHash(manifest)).toBe(hash(bytes));
  expect(verifyS16PayloadSet(verification)).toEqual(manifest);
  expect(() => canonical(manifest)).toThrow(); // Application command/record limits remain unchanged.
  writeFileSync(join(f.target, 'unowned'), '', { mode: 0o600 }); expect(() => verifyS16PayloadSet(verification)).toThrow(); unlinkSync(join(f.target, 'unowned'));
  const selected = verification.files[300]!; writeFileSync(join(f.target, selected.name), 'changed'); expect(() => verifyS16PayloadSet(verification)).toThrow();
});

test.each(['files', 'manifest'] as const)('payload %s capacity refuses before creating output or calling source guards', kind => {
  const f = fixture(), empty = f.sources[1]!;
  f.options.sources = Array.from({ length: kind === 'files' ? 20_001 : 20_000 }, (_, index) => ({ ...empty, name: 'payload_' + index.toString().padStart(5, '0') + '_'.repeat(170) }));
  f.options.guard = () => { throw Error('must refuse before maintenance/copy'); };
  expect(() => captureS16PayloadSet(f.options)).toThrow(expect.objectContaining({ code: kind === 'files' ? 's16_ops_payload_invalid' : 's16_ops_capture_bounds' }));
  expect(existsSync(f.target)).toBe(false);
});

test.each(['missing', 'hash', 'size', 'symlink', 'hardlink', 'mode', 'ancestor'] as const)('untrusted or changed source %s cannot publish a payload set', kind => {
  const f = fixture(), source = f.sources[0]!;
  if (kind === 'missing') unlinkSync(source.path);
  if (kind === 'hash') source.sha256 = '0'.repeat(64);
  if (kind === 'size') source.bytes++;
  if (kind === 'symlink') { const original = source.path; source.path += '-link'; symlinkSync(original, source.path); }
  if (kind === 'hardlink') linkSync(source.path, source.path + '-link');
  if (kind === 'mode') chmodSync(source.path, 0o644);
  if (kind === 'ancestor') { const link = join(f.root, 'alias'); symlinkSync(f.root, link); source.path = join(link, 'input0'); }
  expect(() => captureS16PayloadSet(f.options)).toThrow(); expect(existsSync(join(f.target, 'manifest.json'))).toBe(false);
});

test.each(['receipt', 'manifest', 'body', 'missing', 'extra', 'symlink', 'hardlink', 'mode', 'inventory', 'installation'] as const)('receipt-bound verification refuses changed %s and never repairs the candidate', kind => {
  const f = fixture(), { verification } = capture(f), body = join(f.target, 'a-binary');
  if (kind === 'receipt') verification.manifestSha256 = '0'.repeat(64);
  if (kind === 'manifest') writeFileSync(join(f.target, 'manifest.json'), readFileSync(join(f.target, 'manifest.json'), 'utf8') + '\n');
  if (kind === 'body') { const bytes = readFileSync(body); bytes[0] = 255; writeFileSync(body, bytes); }
  if (kind === 'missing') unlinkSync(body);
  if (kind === 'extra') writeFileSync(join(f.target, 'orphan'), 'private', { mode: 0o600 });
  if (kind === 'symlink') { unlinkSync(body); symlinkSync(f.sources[0]!.path, body); }
  if (kind === 'hardlink') linkSync(body, join(f.root, 'extra-link'));
  if (kind === 'mode') chmodSync(body, 0o644);
  if (kind === 'inventory') verification.files = verification.files.slice(1);
  if (kind === 'installation') verification.installationId = 'other';
  expect(() => verifyS16PayloadSet(verification)).toThrow(); if (kind === 'missing') expect(existsSync(body)).toBe(false);
});

test.each(['traversal', 'reserved', 'casefold', 'name-type', 'hash-type', 'bytes', 'total', 'async'] as const)('invalid %s input refuses before creating an output point', kind => {
  const f = fixture();
  if (kind === 'traversal') f.sources[0]!.name = '../outside';
  if (kind === 'reserved') f.sources[0]!.name = 'MANIFEST.JSON';
  if (kind === 'casefold') f.sources[1]!.name = 'A-BINARY';
  if (kind === 'name-type') f.sources[0]!.name = 123 as unknown as string;
  if (kind === 'hash-type') f.sources[0]!.sha256 = 123 as unknown as string;
  if (kind === 'bytes') f.sources[0]!.bytes = 1_073_741_825;
  if (kind === 'total') f.options.maxBytes = 1;
  if (kind === 'async') f.options.guard = async () => {};
  expect(() => captureS16PayloadSet(f.options)).toThrow(); expect(existsSync(f.target)).toBe(false);
});

test('current withdrawal after the first durable file leaves an unpublished point that cannot be resumed or overwritten', () => {
  const f = fixture(); f.options.guard = () => { if (existsSync(join(f.target, 'a-binary'))) throw new AppError('fixture_source_withdrawn', 409); };
  expect(() => captureS16PayloadSet(f.options)).toThrow(expect.objectContaining({ code: 'fixture_source_withdrawn' }));
  expect(existsSync(join(f.target, 'a-binary'))).toBe(true); expect(existsSync(join(f.target, 'b_empty'))).toBe(false); expect(existsSync(join(f.target, 'manifest.json'))).toBe(false);
  f.options.guard = () => {}; expect(() => captureS16PayloadSet(f.options)).toThrow(expect.objectContaining({ code: 's16_ops_point_unavailable' }));
});

test('a source body replaced during the current guard cannot be certified by an old metadata hash', () => {
  const f = fixture(); let checks = 0;
  f.options.guard = () => { if (++checks === 2) writeFileSync(f.sources[0]!.path, new Uint8Array(f.binary.length)); };
  expect(() => captureS16PayloadSet(f.options)).toThrow(expect.objectContaining({ code: 's16_ops_payload_integrity_failed' }));
  expect(existsSync(join(f.target, 'manifest.json'))).toBe(false);
});

test('an explicitly empty byte inventory remains a component rather than an inferred complete installation', () => {
  const f = fixture(); f.options.sources = []; const { manifest, verification } = capture(f);
  expect(manifest.scope).toBe('caller_selected_payloads'); expect(manifest.files).toEqual([]); expect(manifest.bytes).toBe(0); expect(verifyS16PayloadSet(verification)).toEqual(manifest);
});
