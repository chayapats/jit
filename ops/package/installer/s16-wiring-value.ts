import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonical } from '../../../src/s15/conversation/validation';
import { assertRootPath, type RootPathPolicy } from '../trusted-paths';

/** Fixed installer-owned units only. Configuration, credentials and application data are never wiring. */
export interface S16WiringLayout {
  root: string; prefix: string; home: string; state: string; config: string;
  files: Readonly<Record<'controller' | 'journal' | 'proxy' | 'keyring', string>>;
}
/** Alternate root is an explicit disposable-fixture boundary, never a production CLI argument. */
export function s16WiringLayout(root = '/'): Readonly<S16WiringLayout> {
  if (resolve(root) !== root) throw Error('s16_wiring_layout_invalid');
  const at = (path: string) => root === '/' ? path : join(root, path);
  const home = at('/var/lib/jit-s15');
  return Object.freeze({ root, prefix: at('/opt/jit-s15'), home, state: join(home, 'state'), config: at('/etc/jit-s15/s15-runtime.json'),
    files: Object.freeze({ controller: at('/etc/systemd/system/jit-s15.service'), journal: at('/etc/systemd/journald@jit-s15.conf'), proxy: at('/etc/systemd/system/jit-s15-vm-proxy.socket'), keyring: join(home, '.config/systemd/user/gnome-keyring-daemon.service') }) });
}
/** Public unit bytes and ownership/mode, without transient inode identity or controller authority. */
export interface S16WiringFile { bytes: string; uid: number; gid: number; mode: number }
/** Absence is an explicit hashed value; null is never an unrecorded deletion acknowledgement. */
export interface S16WiringValue { contract: 's16-installed-wiring-value/v1'; files: Record<keyof S16WiringLayout['files'], S16WiringFile | null> }
/** Checks only the bounded unit-value schema; it grants no path, owner or mutation authority. */
export function validateS16WiringValue(value: S16WiringValue): void {
  if (!value || Object.keys(value).sort().join(',') !== 'contract,files' || value.contract !== 's16-installed-wiring-value/v1' || !value.files || Object.keys(value.files).sort().join(',') !== 'controller,journal,keyring,proxy') throw Error('s16_wiring_value_invalid');
  for (const file of Object.values(value.files)) {
    if (file === null) continue;
    if (!file || Object.keys(file).sort().join(',') !== 'bytes,gid,mode,uid' || typeof file.bytes !== 'string' || file.bytes.length > 10924 || Buffer.from(file.bytes, 'base64').toString('base64') !== file.bytes ||
      ![file.uid, file.gid, file.mode].every(n => Number.isSafeInteger(n) && n >= 0) || file.uid > 4294967294 || file.gid > 4294967294 || file.mode > 0o7777 || file.mode & 0o7133 || Buffer.from(file.bytes, 'base64').length > 8192) throw Error('s16_wiring_value_invalid');
  }
  if (Buffer.byteLength(canonical(value)) > 49152) throw Error('s16_wiring_bounds');
}
/** Stable physical value only. It does not prove owner/configuration, SQL/native preservation or effect settlement. */
export function s16WiringSha256(value: S16WiringValue): string { validateS16WiringValue(value); return new Bun.CryptoHasher('sha256').update(canonical(value)).digest('hex'); }
/** Root-owned units absent; protected credential-service wiring retains its original custody. */
export function s16AbsentWiring(keyring: S16WiringFile | null = null): S16WiringValue { return { contract: 's16-installed-wiring-value/v1', files: { controller: null, journal: null, proxy: null, keyring } }; }
/** Reads bounded regular single-link unit files, refusing links, writable or foreign custody. */
export function readS16Wiring(layout: S16WiringLayout, serviceUid: number, policy: RootPathPolicy = {}): Readonly<S16WiringValue> {
  if (canonical(layout) !== canonical(s16WiringLayout(layout.root))) throw Error('s16_wiring_layout_invalid');
  const value = s16AbsentWiring();
  for (const [key, path] of Object.entries(layout.files) as [keyof S16WiringLayout['files'], string][]) {
    if (key !== 'keyring') assertRootPath(path, policy);
    else {
      assertRootPath(dirname(layout.home), policy);
      const entries = [path]; while (entries.at(-1) !== layout.home) entries.push(dirname(entries.at(-1)!));
      for (const entry of entries.reverse()) {
        const stat = lstatSync(entry, { throwIfNoEntry: false }); if (!stat) continue;
        if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile() || ![policy.uid ?? 0, serviceUid].includes(stat.uid) || stat.mode & 0o022) throw Error('s16_wiring_path_untrusted');
      }
    }
    const before = lstatSync(path, { bigint: true, throwIfNoEntry: false }); if (!before) continue;
    const uid = key === 'keyring' ? serviceUid : policy.uid ?? 0;
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(uid) || before.size > 8192n || before.mode & 0o7133n) throw Error('s16_wiring_path_untrusted');
    const bytes = readFileSync(path), after = lstatSync(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || before.size !== BigInt(bytes.length)) throw Error('s16_wiring_changed');
    value.files[key] = { bytes: bytes.toString('base64'), uid: Number(before.uid), gid: Number(before.gid), mode: Number(before.mode & 0o7777n) };
  }
  if (Buffer.byteLength(canonical(value)) > 49152) throw Error('s16_wiring_bounds');
  return Object.freeze(value);
}
