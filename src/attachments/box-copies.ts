import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { AppError } from "../errors";
import { projectDeleted } from "../project-lifecycle";
import { requireId } from "../sources";
import type { AppTransaction, TransactionStore } from "../store";
import type { ApplicationRunRequest } from "../team/types";
import { createBoxBackend, type BoxBackend } from "../exec/box-backend";
import type { BoxHandle, BoxRuntime } from "../exec/box-runtime";
import type { AttachmentCopyCleanup } from "./lifecycle";
import { writeAttachmentEvent } from "./records";
import { runAttachmentCurrent } from "./run-references";

/** The existing runner write cap; a derivative above it is refused without copying any original. */
export const attachmentBoxBytes = 16 * 1024 * 1024;
interface Copy { id: string; name: string; hash: string; bytes: number; extension: string }
/** Box-manager ownership used by cleanup; it blocks opens and resets until verified removal finishes. */
export interface AttachmentBoxOwner {
  runtime: BoxRuntime; directory: string | null;
  hold<T>(projectId: string, action: () => Promise<T>): Promise<T>;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function eligible(tx: AppTransaction, projectId: string): Copy[] {
  if (projectDeleted(tx, projectId)) return [];
  return tx.all<{ id: string; name: string | null; kind: string; hash: string | null; bytes: number | null; media: string | null }>(`SELECT id, display_name AS name, kind,
    CASE WHEN kind = 'image' THEN clean_sha256 ELSE text_sha256 END AS hash,
    CASE WHEN kind = 'image' THEN clean_bytes ELSE text_bytes END AS bytes, clean_media_type AS media
    FROM attachments WHERE project_id = ? AND state = 'ready' AND message_id IS NOT NULL
      AND (sanitized_by = 'container' OR (sanitized_by = 'service' AND kind = 'text'))`, projectId)
    .filter((r): r is typeof r & { hash: string; bytes: number } => !!r.hash && /^[a-f0-9]{64}$/.test(r.hash) && r.bytes !== null && r.bytes >= 0 &&
      (r.kind !== "image" || r.media === "image/png" || r.media === "image/jpeg"))
    .map(r => ({ id: r.id, name: r.name ?? "", hash: r.hash, bytes: r.bytes, extension: r.kind === "image" ? r.media === "image/jpeg" ? "jpg" : "png" : "txt" }));
}
/** ASCII filename from a display label, capped at 64 bytes including the derivative's actual extension. */
export function attachmentBoxName(copy: { id: string; name: string; extension: string }): string {
  requireId(copy.id);
  if (!["png", "jpg", "txt"].includes(copy.extension)) throw new AppError("attachment_unavailable", 410);
  const safe = copy.name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/_+/g, "_").replace(/^[.-]+/, "");
  const dot = safe.lastIndexOf("."), stem = (dot > 0 ? safe.slice(0, dot) : safe).slice(0, 63 - copy.extension.length);
  return `${copy.id}-${stem || "file"}.${copy.extension}`;
}
function blob(store: TransactionStore, projectId: string, copy: Copy): Buffer {
  const root = join(dirname(resolve(store.path)), "attachments");
  for (const p of [root, join(root, projectId), join(root, projectId, copy.hash.slice(0, 2))]) {
    const st = lstatSync(p); if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077)) throw new AppError("attachment_unavailable", 410);
  }
  const fd = openSync(join(root, projectId, copy.hash.slice(0, 2), copy.hash), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size !== copy.bytes || (st.mode & 0o077)) throw new AppError("attachment_unavailable", 410);
    const data = readFileSync(fd);
    if (data.length !== copy.bytes || createHash("sha256").update(data).digest("hex") !== copy.hash) throw new AppError("attachment_unavailable", 410);
    return data;
  } finally { closeSync(fd); }
}
// The script runs only inside the box, through spawn. No file label is interpolated as shell code. Directory
// descriptors pin every component so another box process cannot redirect rm through a swapped symlink.
const pruneScript = `import os,sys,json,subprocess,hashlib,stat
root,list_name,digest,create=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4]=='1'
flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
fd=os.open(root,flags)
fds=[fd]
try:
 try:
  with os.fdopen(os.open(list_name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd),'rb') as source:
   info=os.fstat(source.fileno())
   if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1: raise RuntimeError('invalid_copy_list')
   data=source.read(16*1024*1024+1)
  if len(data)>16*1024*1024 or hashlib.sha256(data).hexdigest()!=digest: raise RuntimeError('copy_list_changed')
  payload=json.loads(data);keep=set(payload['keep']);ids=payload['ids']
 finally:
  os.unlink(list_name,dir_fd=fd)
 for part in ['.jit','attachments']:
  try: child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
  except FileNotFoundError:
   if not create: sys.exit(0)
   os.mkdir(part,mode=0o700,dir_fd=fd)
   child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
  fds.append(child);fd=child
 os.fchdir(fd)
 for name in os.listdir(fd):
  if (ids is not None and not any(name.startswith(i+'-') for i in ids)) or (ids is None and name in keep): continue
  path='./'+name
  subprocess.run(['/bin/rm','-rf','--',path],pass_fds=(fd,),check=True)
  try: os.stat(name,dir_fd=fd,follow_symlinks=False)
  except FileNotFoundError: continue
  raise RuntimeError('copy_remains')
 # Reopen the canonical chain: a renamed directory must not make pinned-fd removal look complete.
 check=os.open(root,flags)
 checks=[check]
 try:
  for i,part in enumerate(['.jit','attachments']):
   check=os.open(part,flags,dir_fd=check);checks.append(check)
  for before,after in zip(fds,checks):
   a,b=os.fstat(before),os.fstat(after)
   if (a.st_dev,a.st_ino)!=(b.st_dev,b.st_ino): raise RuntimeError('copy_path_changed')
 finally:
  for check in reversed(checks): os.close(check)
finally:
 for fd in reversed(fds): os.close(fd)
`;

/** Sanitized derivative copies and ATT06 cleanup; only a granted run can copy, cleanup itself grants no execution. */
export class AttachmentBoxCopies implements AttachmentCopyCleanup {
  readonly #handles = new Map<string, BoxHandle>();
  constructor(readonly store: TransactionStore, readonly owner: AttachmentBoxOwner, readonly now: () => number = Date.now) {}

  async #prune(handle: BoxHandle, keep: string[], ids: readonly string[] | null, create = false): Promise<void> {
    const backend = createBoxBackend(this.owner.runtime, handle);
    // Lists travel in runner write data, never bash -c/exec argv. Pin their digest so a box process cannot change
    // cleanup authority between write and spawn. Only copy identities/names enter this short-lived box file.
    const data = JSON.stringify({ keep, ids }), name = `.jit-copy-list-${crypto.randomUUID()}.json`;
    await backend.writeFileAtomically(join(handle.workspaceRoot, name), data, { observed: null });
    const result = await backend.spawn({ cwd: handle.workspaceRoot, timeoutMs: 30_000,
      command: `python3 -I -S -c ${quote(pruneScript)} ${[handle.workspaceRoot, name, createHash("sha256").update(data).digest("hex"), create ? "1" : "0"].map(quote).join(" ")}` });
    if (result.exitCode !== 0 || result.timedOut) throw new AppError("attachment_copy_cleanup_failed", 503);
  }

  /** Reconciles stale, untracked and restored entries on every box open; unavailable originals are never copied here. */
  async opened(handle: BoxHandle): Promise<void> {
    const projectId = handle.projectId;
    this.#handles.set(projectId, handle);
    // A fresh workspace has nothing to reconcile. This avoids a runner call until attachments have ever existed.
    const rows = this.store.read(tx => tx.get("SELECT 1 FROM attachments WHERE project_id = ? LIMIT 1", projectId) ||
      tx.get("SELECT 1 FROM attachment_box_copies WHERE project_id = ? LIMIT 1", projectId));
    if (!rows && this.owner.directory) {
      try { lstatSync(join(this.owner.directory, projectId, "workspace", ".jit")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    }
    if (!rows && !this.owner.directory) return;
    await this.owner.hold(projectId, async () => {
      const keep = this.store.read(tx => {
        const present = new Set(tx.all<{ id: string }>("SELECT attachment_id AS id FROM attachment_box_copies WHERE project_id = ? AND state = 'present'", projectId).map(r => r.id));
        return eligible(tx, projectId).filter(c => c.bytes <= attachmentBoxBytes && present.has(c.id)).map(attachmentBoxName);
      });
      await this.#prune(handle, keep, null);
      this.store.transaction(tx => {
        const live = new Set(eligible(tx, projectId).filter(c => keep.includes(attachmentBoxName(c))).map(c => c.id));
        for (const r of tx.all<{ id: string }>("SELECT attachment_id AS id FROM attachment_box_copies WHERE project_id = ? AND state IN ('present','removing')", projectId))
          if (!live.has(r.id)) this.#removed(tx, projectId, r.id);
      });
    });
  }

  /** Copies only this current granted run's live derivatives, verifying runner bytes before recording present. */
  async copy(session: { handle: BoxHandle; backend: BoxBackend }, request: ApplicationRunRequest, current: (tx: AppTransaction) => boolean): Promise<void> {
    if (!request.execution || request.execution.boxProjectId !== request.projectId || session.handle.projectId !== request.projectId ||
      !["workspace", "full"].includes(request.execution.level)) throw new AppError("access_level_insufficient", 403);
    await this.owner.hold(request.projectId, async () => {
      const copies = this.store.read(tx => eligible(tx, request.projectId).filter(c => request.attachments?.some(ref => ref.attachmentId === c.id && runAttachmentCurrent(tx, request, ref))));
      for (const copy of copies) {
        const valid = () => this.store.read(tx => current(tx) && request.attachments!.some(ref => ref.attachmentId === copy.id && runAttachmentCurrent(tx, request, ref)) && eligible(tx, request.projectId).some(c => c.id === copy.id && c.hash === copy.hash));
        if (!valid()) throw new AppError("execution_halted", 409);
        if (copy.bytes > attachmentBoxBytes) {
          this.store.transaction(tx => writeAttachmentEvent(tx, { projectId: request.projectId, attachmentId: copy.id, kind: "box_copy", status: "refused", reason: "attachment_copy_too_large", runId: request.runId, jobId: request.fence.jobId, createdAt: this.now() }));
          continue;
        }
        const path = join(session.handle.workspaceRoot, ".jit", "attachments", attachmentBoxName(copy));
        const matches = async () => {
          let size = 0; const hash = createHash("sha256");
          try { for await (const part of session.backend.readFile(path)) { size += part.length; if (size > copy.bytes) return false; hash.update(part); } }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
          return size === copy.bytes && hash.digest("hex") === copy.hash;
        };
        const present = this.store.read(tx => tx.get<{ state: string }>("SELECT state FROM attachment_box_copies WHERE project_id = ? AND attachment_id = ?", request.projectId, copy.id)?.state === "present");
        // Reject symlinked directories even when they point somewhere else inside this same workspace.
        await this.#prune(session.handle, [], [], true);
        await session.backend.writeFileAtomically(join(session.handle.workspaceRoot, ".jit", ".gitignore"), "*\n");
        if (present && await matches()) { if (!valid()) throw new AppError("execution_halted", 409); continue; }
        const data = blob(this.store, request.projectId, copy);
        this.store.transaction(tx => tx.run(`INSERT INTO attachment_box_copies (project_id, attachment_id, state, bytes, created_at, updated_at) VALUES (?, ?, 'removing', ?, ?, ?)
          ON CONFLICT(project_id, attachment_id) DO UPDATE SET state = 'removing', bytes = excluded.bytes, updated_at = excluded.updated_at`, request.projectId, copy.id, copy.bytes, this.now(), this.now()));
        try {
          if (!valid()) throw new AppError("execution_halted", 409);
          await session.backend.writeFileAtomically(path, data);
          if (!await matches()) throw new AppError("attachment_copy_failed", 503);
          if (!valid()) throw new AppError("execution_halted", 409);
          this.store.transaction(tx => {
            tx.run("UPDATE attachment_box_copies SET state = 'present', updated_at = ? WHERE project_id = ? AND attachment_id = ?", this.now(), request.projectId, copy.id);
            writeAttachmentEvent(tx, { projectId: request.projectId, attachmentId: copy.id, kind: "box_copy", status: "ok", bytes: copy.bytes, runId: request.runId, jobId: request.fence.jobId, createdAt: this.now() });
          });
        } catch (error) {
          this.store.transaction(tx => writeAttachmentEvent(tx, { projectId: request.projectId, attachmentId: copy.id, kind: "box_copy", status: "failed", reason: "attachment_copy_failed", runId: request.runId, jobId: request.fence.jobId, createdAt: this.now() }));
          await this.#prune(session.handle, [], [copy.id]);
          this.store.transaction(tx => this.#removed(tx, request.projectId, copy.id));
          throw error;
        }
      }
    });
  }

  #removed(tx: AppTransaction, projectId: string, id: string): void {
    tx.run("UPDATE attachment_box_copies SET state = 'removed', updated_at = ? WHERE project_id = ? AND attachment_id = ?", this.now(), projectId, id);
    writeAttachmentEvent(tx, { projectId, attachmentId: id, kind: "box_remove", status: "ok", createdAt: this.now() });
  }

  /** Removes every matching entry, including crash orphans, and verifies absence before ATT06 can complete. */
  async reconcile(projectId: string, attachmentIds: readonly string[]): Promise<void> {
    requireId(projectId); for (const id of attachmentIds) requireId(id);
    if (!attachmentIds.length) return;
    await this.owner.hold(projectId, async () => {
      this.store.transaction(tx => { for (const id of attachmentIds) tx.run("UPDATE attachment_box_copies SET state = 'removing', updated_at = ? WHERE project_id = ? AND attachment_id = ? AND state IN ('present','removing')", this.now(), projectId, id); });
      const status = await this.owner.runtime.status(projectId);
      if (status.state === "running") {
        await this.#prune(this.#handles.get(projectId) ?? { projectId, name: status.name, mode: status.mode!, profile: status.profile === true, workspaceRoot: "/workspace", temporaryDirectory: "/tmp" }, [], attachmentIds);
      } else {
        if (!this.owner.directory) throw new AppError("attachment_copy_cleanup_failed", 503);
        const path = join(resolve(this.owner.directory), projectId, "workspace", ".jit", "attachments");
        // All checks and unlinks are synchronous under the project hold, with the runtime confirmed stopped.
        let component: string = sep, missing = false;
        for (const part of path.split(sep).filter(Boolean)) {
          component = join(component, part);
          try { const st = lstatSync(component); if (!st.isDirectory() || st.isSymbolicLink()) throw new AppError("attachment_copy_cleanup_failed", 503); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { missing = true; break; } throw error; }
        }
        if (!missing) {
          const selected = (name: string) => attachmentIds.some(id => name.startsWith(`${id}-`));
          for (const name of readdirSync(path).filter(selected)) rmSync(join(path, name), { recursive: true, force: true });
          if (readdirSync(path).some(selected)) throw new AppError("attachment_copy_cleanup_failed", 503);
        }
      }
      this.store.transaction(tx => { for (const id of attachmentIds) this.#removed(tx, projectId, id); });
    });
  }
}
