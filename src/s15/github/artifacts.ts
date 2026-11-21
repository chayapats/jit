import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../errors';
import type { Ref } from '../policy';

/** Existing owning runtime byte sink. Construction creates storage; maintenance must use its raw read-only cohort instead. */
export class GithubBundleStore {
  constructor(readonly directory: string, readonly maxBundleBytes: number) { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  #path(ref: Ref): string { if (!/^bundle_[a-f0-9]{64}$/.test(ref.id) || ref.revision !== 1 || ref.generation !== 1) throw new AppError('artifact_unavailable'); return join(this.directory, ref.id); }
  /** Original immutable owning read; its hash is custody evidence, not permission to push or accept a branch. */
  read(ref: Ref): Buffer {
    const path = this.#path(ref), stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxBundleBytes) throw new AppError('artifact_unavailable');
    const bytes = readFileSync(path); if (createHash('sha256').update(bytes).digest('hex') !== ref.id.slice(7)) throw new AppError('artifact_unavailable'); return bytes;
  }
  /** Called only after the owning workspace validates Git output and computes its original hash. Existing identities never overwrite. */
  capture(bytes: Uint8Array, hash: string): Ref {
    const ref = { id: 'bundle_' + hash, revision: 1, generation: 1 }, file = this.#path(ref);
    try { writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (!this.read(ref).equals(Buffer.from(bytes))) throw new AppError('artifact_conflict'); }
    return ref;
  }
  /** Current artifact fence only; it grants no execution or publication. */
  current(id: string): { ref: Ref; active: boolean } | null {
    if (!/^bundle_[a-f0-9]{64}$/.test(id) || !existsSync(join(this.directory, id))) return null; const ref = { id, revision: 1, generation: 1 };
    try { this.read(ref); return { ref, active: true }; } catch { return { ref, active: false }; }
  }
}
