import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { AppError } from '../../../errors';

/** Test-only lock syscall seam. An injected lock never certifies a native protected helper. */
export interface FirecrackerLockFixture { basis: 'protocol_fixture'; acquire(fd: number): boolean; release(fd: number): void }
const refuse = (): never => { throw new AppError('vm_firecracker_helper_locked', 503); };
/**
 * Process-lifetime singleton for the installed root helper. flock belongs to the retained open file
 * description, not a PID file or stale timestamp. The protected empty file is never unlinked/replaced.
 * All helper dispatch/recovery must check this lease; closing it is not a VM stop/settlement result.
 */
export class FirecrackerHostLock {
  readonly basis: 'protected_host' | 'protocol_fixture';
  readonly #path: string;
  readonly #fd: number;
  readonly #uid: number;
  readonly #release: (fd: number) => void;
  readonly #dispose: () => void;
  readonly #identity: { dev: bigint; ino: bigint };
  #closed = false;
  private constructor(path: string, fd: number, uid: number, release: (fd: number) => void, dispose: () => void, fixture: boolean) {
    this.#path = path; this.#fd = fd; this.#uid = uid; this.#release = release; this.#dispose = dispose;
    this.#identity = fstatSync(fd, { bigint: true }); this.basis = fixture ? 'protocol_fixture' : 'protected_host';
  }
  /** No waiting, stale-lock stealing, owner-account changes or fallback when another helper owns it. */
  static async open(directory: string, fixture?: FirecrackerLockFixture): Promise<FirecrackerHostLock> {
    let fd: number | undefined, dispose = () => {}, cleanup: ((fd: number) => void) | undefined;
    try {
      if (typeof directory !== 'string' || !directory.startsWith('/') || normalize(directory) !== directory || directory.endsWith('/') || fixture && fixture.basis !== 'protocol_fixture') return refuse();
      if (!fixture && (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) || process.getuid?.() !== 0)) return refuse();
      const uid = fixture ? process.getuid!() : 0;
      for (let parent = directory;; parent = dirname(parent)) {
        const s = lstatSync(parent);
        if (!s.isDirectory() || s.isSymbolicLink() || ![0, uid].includes(s.uid) || s.mode & 0o7022) return refuse();
        if (parent === '/') break;
      }
      const path = join(directory, '.jit-host.lock');
      try { fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW); }
      const s = fstatSync(fd);
      if (!s.isFile() || s.uid !== uid || s.nlink !== 1 || s.size !== 0 || s.mode & 0o7077) return refuse();
      let acquire: (fd: number) => boolean, release: (fd: number) => void;
      if (fixture) { acquire = fixture.acquire.bind(fixture); release = fixture.release.bind(fixture); }
      else {
        const { dlopen } = await import('bun:ffi');
        const library = dlopen(process.arch === 'x64' ? '/lib/x86_64-linux-gnu/libc.so.6' : '/lib/aarch64-linux-gnu/libc.so.6', { flock: { args: ['i32', 'i32'], returns: 'i32' } });
        dispose = () => library.close(); acquire = fd => library.symbols.flock(fd, 2 | 4) === 0;
        release = fd => { if (library.symbols.flock(fd, 8) !== 0) return refuse(); };
      }
      if (!acquire(fd)) return refuse();
      cleanup = release;
      const lease = new FirecrackerHostLock(path, fd, uid, release, dispose, !!fixture); lease.current(); fd = undefined; dispose = () => {}; return lease;
    } catch { return refuse(); }
    finally { if (fd !== undefined) { try { cleanup?.(fd); } finally { closeSync(fd); } } dispose(); }
  }
  /** Rechecks the retained descriptor and protected pathname before every dispatch/recovery boundary. */
  current(): void {
    if (this.#closed) return refuse();
    try {
      const file = fstatSync(this.#fd, { bigint: true }), path = lstatSync(this.#path, { bigint: true });
      for (const s of [file, path]) if (!s.isFile() || s.uid !== BigInt(this.#uid) || s.nlink !== 1n || s.size !== 0n || s.mode & 0o7077n || s.dev !== this.#identity.dev || s.ino !== this.#identity.ino) return refuse();
    } catch { return refuse(); }
  }
  /** Releases only this helper's lock. The file remains, so a second helper cannot lock a new inode. */
  close(): void {
    if (this.#closed) return; this.#closed = true;
    try { this.#release(this.#fd); } finally { try { closeSync(this.#fd); } finally { this.#dispose(); } }
  }
}
