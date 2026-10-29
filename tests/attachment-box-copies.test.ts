import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { attachmentBoxBytes, attachmentBoxName } from "../src/attachments/box-copies";
import { attachmentOutboundEntries } from "../src/attachments/run-content";
import { reconcileForgottenAttachments, retireAttachments } from "../src/attachments/lifecycle";
import { backupImageTables } from "../src/ops/backup";
import { TransactionStore, schemaVersion } from "../src/store";
import { runOutboundGuard } from "../src/security/run-outbound";
import { createWebHandler } from "../src/web";
import { dictionaries } from "../src/i18n";
import type { DeletionReceipt, DeletionConfirmReceipt } from "../src/memory/delete";
import type { FakeBoxExec } from "../src/exec/fake-box-runtime";
import { answer, effectFixture, rid, setLevel, settle, type EffectFixture } from "./fixtures/effects";
import { uploadText, sendFiles } from "./fixtures/attachment-run";
import type { RunScript } from "../src/team/scripted-port";

const fixtures: EffectFixture[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.close(); rmSync(f.root, { recursive: true, force: true }); rmSync(dirname(f.box.state), { recursive: true, force: true }); } });
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

// Deterministic fake of the runner's existing read/write/spawn protocol. No Podman, SSH or host execution.
function runner(control: { refuseRemoval?: boolean; onWrite?: () => Promise<void> } = {}): FakeBoxExec {
  return async (_handle, request) => {
    const q = JSON.parse(new TextDecoder().decode(request.input));
    let result: unknown = {};
    try {
      if (q.op === "write") {
        const data = Buffer.from(q.data, "base64"); if (data.length > attachmentBoxBytes) throw Object.assign(new Error(), { code: "EFBIG" });
        if (q.createParents) mkdirSync(dirname(q.path), { recursive: true });
        await control.onWrite?.(); writeFileSync(q.path, data);
      } else if (q.op === "read") {
        const data = readFileSync(q.path), end = Math.min(data.length, q.offset + q.length);
        result = { data: data.subarray(q.offset, end).toString("base64"), eof: end === data.length };
      } else if (q.op === "spawn") {
        expect(q.command).toStartWith("python3 -I -S -c "); expect(q.command).toContain("/bin/rm");
        const args = / '([^']*)' '([^']*)' '([^']*)' '([01])'$/.exec(q.command)!;
        const root = args[1]!, keep = new Set<string>(JSON.parse(args[2]!)), ids: string[] | null = JSON.parse(args[3]!), create = args[4] === "1";
        let path = root;
        for (const part of [".jit", "attachments"]) {
          path = join(path, part);
          if (!existsSync(path)) { if (!create) return ok({ stdout: "", stderr: "", exitCode: 0, timedOut: false }); mkdirSync(path); }
          if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error("symlink");
        }
        for (const name of readdirSync(path)) if (ids ? ids.some(id => name.startsWith(id + "-")) : !keep.has(name)) {
          if (control.refuseRemoval) throw new Error("copy_remains");
          rmSync(join(path, name), { recursive: true, force: true });
        }
        result = { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      } else throw new Error("unexpected op");
      return ok(result);
    } catch (error) {
      return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ v: 1, ok: false, error: { code: (error as NodeJS.ErrnoException).code ?? "EIO" } })), stderr: new Uint8Array() };
    }
  };
}
const ok = (result: unknown) => ({ exitCode: 0, stdout: Buffer.from(JSON.stringify({ v: 1, ok: true, result })), stderr: new Uint8Array() });
async function world(script?: RunScript, control: Parameters<typeof runner>[0] = {}) {
  const f = await effectFixture({ exec: () => runner(control), ...(script ? { script } : {}) }); fixtures.push(f);
  // The fake workspace occupies the same host-owned project volume as production, including stopped cleanup.
  f.box.root = join(f.execution, f.project.id, "workspace"); mkdirSync(f.box.root, { recursive: true });
  const ensure = f.runtime.ensure.bind(f.runtime);
  f.runtime.ensure = async (...args) => Object.freeze({ ...await ensure(...args), workspaceRoot: f.box.root });
  return f;
}
function files(f: EffectFixture) { return readdirSync(join(f.box.root, ".jit", "attachments")); }
function state(f: EffectFixture, id: string) { return f.store.read(tx => tx.get<{ state: string }>("SELECT state FROM attachment_box_copies WHERE attachment_id = ?", id)?.state); }
function derivative(f: EffectFixture, id: string, kind: "pdf" | "image", data: Uint8Array | string, by = "container", media = "image/png") {
  const hash = sha(data), root = join(f.state, "attachments", f.project.id, hash.slice(0, 2)); mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, hash), data, { mode: 0o600 });
  f.store.transaction(tx => tx.run(`UPDATE attachments SET kind = ?, sanitized_by = ?, ${kind === "image" ? "clean" : "text"}_sha256 = ?, ${kind === "image" ? "clean" : "text"}_bytes = ?, clean_media_type = ? WHERE id = ?`, kind, by, hash, Buffer.byteLength(data), media, id));
}

test("Workspace/Full copy live sanitized derivatives before tools, preserve bytes, names, mounts and idempotency", async () => {
  for (const level of ["workspace", "full"] as const) {
    let observed = 0;
    const f = await world(request => { observed++; expect(files(f)).toHaveLength(3); expect(runOutboundGuard(f.store, { ...request, attachments: [] })("Private PDF extracted marker long enough to guard")).not.toBeNull(); return answer(request, "Read copies."); });
    setLevel(f, level);
    const text = await uploadText(f, "Private text file contents", "..---notes.txt");
    const pdf = await uploadText(f, "ORIGINAL PDF MUST STAY OUT", "report.txt"); derivative(f, pdf.id, "pdf", "Private PDF extracted marker long enough to guard");
    const image = await uploadText(f, "ORIGINAL IMAGE MUST STAY OUT", "picture.txt");
    const binary = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128, 1]); derivative(f, image.id, "image", binary);
    const fallback = await uploadText(f, "FALLBACK MUST STAY OUT"); derivative(f, fallback.id, "image", binary, "fallback");
    sendFiles(f, [text.id, pdf.id, image.id, fallback.id]); await settle(f); expect(observed).toBe(1);
    expect(readFileSync(join(f.box.root, ".jit", ".gitignore"), "utf8")).toBe("*\n");
    expect(readFileSync(join(f.box.root, ".jit", "attachments", `${image.id}-picture.png`))).toEqual(Buffer.from(binary));
    expect(readFileSync(join(f.box.root, ".jit", "attachments", `${pdf.id}-report.txt`), "utf8")).toStartWith("Private PDF extracted");
    expect(files(f)).toContain(`${text.id}-notes.txt`); expect(state(f, text.id)).toBe("present"); expect(state(f, fallback.id)).toBeUndefined();
    sendFiles(f, []); await settle(f); expect(observed).toBe(2);
    expect(f.app.attachmentEvents(f.auth.actor, f.project.id).filter(e => e.kind === "box_copy" && e.status === "ok")).toHaveLength(3);
    expect(f.runtime.boxes.get(f.project.id)!.mounts).toEqual([{ source: f.box.root, destination: "/workspace" }]);
    const imageOnly = { ...f.port.requests[0]!, attachments: [], execution: { level, boxProjectId: f.project.id } };
    expect(attachmentOutboundEntries(f.store, imageOnly).map(e => e.attachmentId).sort()).toEqual([text.id, pdf.id].sort());
  }
});

test("Read never opens a box; a derivative above 16 MiB is audited and refused before reading its blob", async () => {
  const f = await world(); const a = await uploadText(f, "private"); sendFiles(f, [a.id]); await settle(f);
  expect(f.runtime.calls).toEqual([]);
  const request = f.port.requests[0]!;
  await expect(f.boxes.attachmentCopies.copy({ handle: { projectId: f.project.id } as never, backend: {} as never }, request, () => true)).rejects.toMatchObject({ code: "access_level_insufficient" });
  setLevel(f, "workspace"); f.store.transaction(tx => tx.run("UPDATE attachments SET text_bytes = ? WHERE id = ?", attachmentBoxBytes + 1, a.id));
  sendFiles(f, []); await settle(f);
  expect(state(f, a.id)).toBeUndefined();
  expect(f.app.attachmentEvents(f.auth.actor, f.project.id).some(e => e.kind === "box_copy" && e.status === "refused" && e.reason === "attachment_copy_too_large")).toBe(true);
});

test("every open removes unknown and retiring entries, including crash orphans; wipe records wiped", async () => {
  const f = await world(); setLevel(f, "workspace"); const a = await uploadText(f, "kept"); sendFiles(f, [a.id]); await settle(f);
  const path = join(f.box.root, ".jit", "attachments"); writeFileSync(join(path, `${rid()}-orphan.txt`), "stale"); writeFileSync(join(path, "untracked"), "stale");
  f.store.transaction(tx => tx.run("UPDATE attachment_box_copies SET state = 'removing' WHERE attachment_id = ?", a.id));
  const session = await f.boxes.open(f.project.id, null); session.release(); expect(files(f)).toEqual([]); expect(state(f, a.id)).toBe("removed");
  sendFiles(f, []); await settle(f); expect(state(f, a.id)).toBe("present");
  await f.boxes.reset(f.project.id, true, { commit: () => {} }); expect(state(f, a.id)).toBe("wiped");
});

test("running cleanup uses runner spawn, verifies failure, retries, and fences copying after deletion", async () => {
  const control = { refuseRemoval: false }; const f = await world(undefined, control); setLevel(f, "workspace");
  const a = await uploadText(f, "delete me"); sendFiles(f, [a.id]); await settle(f);
  f.store.transaction(tx => retireAttachments(tx, f.project.id, [a.id], "delete", f.clock.now));
  control.refuseRemoval = true; await expect(f.boxes.attachmentCopies.reconcile(f.project.id, [a.id])).rejects.toThrow();
  expect(state(f, a.id)).toBe("removing"); expect(files(f)).toHaveLength(1);
  control.refuseRemoval = false; await f.boxes.attachmentCopies.reconcile(f.project.id, [a.id]); await f.boxes.attachmentCopies.reconcile(f.project.id, [a.id]);
  expect(files(f)).toEqual([]); expect(state(f, a.id)).toBe("removed");
  const session = await f.boxes.open(f.project.id, null);
  await f.boxes.prepareAttachments(session, f.port.requests[0]!, () => true); session.release(); expect(files(f)).toEqual([]);
});

test("stopped cleanup holds the project, removes host copies without starting it, and refuses every symlink component", async () => {
  const f = await world(); setLevel(f, "workspace"); const a = await uploadText(f, "stopped copy"); sendFiles(f, [a.id]); await settle(f);
  await f.boxes.stop(f.project.id); const before = f.runtime.calls.filter(c => c.op === "exec").length;
  for (const component of ["attachments", ".jit", "workspace"] as const) {
    const path = component === "workspace" ? f.box.root : join(f.box.root, ".jit", ...(component === "attachments" ? ["attachments"] : []));
    const target = path + ".kept"; const { renameSync } = await import("node:fs"); renameSync(path, target); symlinkSync(target, path);
    await expect(f.boxes.attachmentCopies.reconcile(f.project.id, [a.id])).rejects.toMatchObject({ code: "attachment_copy_cleanup_failed" });
    expect(existsSync(join(f.box.root, ".jit", "attachments", `${a.id}-notes.txt`))).toBe(true);
    rmSync(path); renameSync(target, path);
  }
  let unblock!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = f.boxes.holdProject(f.project.id, async () => { entered(); await new Promise<void>(resolve => { unblock = resolve; }); }); await ready;
  let opened = false; const opening = f.boxes.open(f.project.id, null).then(s => { opened = true; s.release(); });
  await Promise.resolve(); expect(opened).toBe(false); await expect(f.boxes.reset(f.project.id, true, { commit: () => {} })).rejects.toMatchObject({ code: "box_busy" });
  unblock(); await held;
  // Run the host cleanup before releasing the queued open into the fake runtime.
  await opening; await f.boxes.stop(f.project.id);
  const calls = f.runtime.calls.length; await f.boxes.attachmentCopies.reconcile(f.project.id, [a.id]);
  expect(files(f)).toEqual([]); expect(f.runtime.calls.slice(calls).map(c => c.op)).toEqual(["status"]);
  expect(f.runtime.calls.filter(c => c.op === "exec").length).toBeGreaterThanOrEqual(before);
});

test("running open and copy refuse a symlink into another workspace directory", async () => {
  const f = await world(); setLevel(f, "workspace"); const a = await uploadText(f, "must not write"); sendFiles(f, [a.id]); await settle(f);
  const target = join(f.box.root, "other"); mkdirSync(target); const path = join(f.box.root, ".jit", "attachments"); rmSync(path, { recursive: true }); symlinkSync(target, path);
  await expect(f.boxes.open(f.project.id, null)).rejects.toThrow(); expect(readdirSync(target)).toEqual([]); expect(f.boxes.busy(f.project.id)).toBe(false);
});

for (const operation of ["delete", "forget", "project-delete"] as const) test(`ATT06 ${operation} hook removes real box copies before completion`, async () => {
  const f = await world(); setLevel(f, "workspace"); const a = await uploadText(f, "lifecycle bytes"); const sent = sendFiles(f, [a.id]); await settle(f);
  if (operation === "forget") {
    const claimId = rid(), extractionId = rid(), jobId = f.port.requests[0]!.fence.jobId;
    const claim = { claimId, projectId: f.project.id, extractionId, revision: 1, generation: 1, kind: "explicit_fact", text: "remember file", quote: "remember file", source: sent.message.source,
      dependencies: [], conflicts: [], status: "active", createdAt: f.clock.now, decision: null };
    f.store.transaction(tx => {
      tx.run("INSERT INTO memory_extractions (id, project_id, job_id, source_id, source_revision, source_generation, extractor, policy, record_json) VALUES (?, ?, ?, ?, 1, 1, 'claims/v1', 1, ?)", extractionId, f.project.id, jobId, sent.message.source.sourceId, JSON.stringify({ id: extractionId, source: sent.message.source, dependencies: [], request: { manifest: { sources: [], claims: [] } } }));
      tx.run("INSERT INTO memory_claims (id, project_id, extraction_id, revision, generation, record_json) VALUES (?, ?, ?, 1, 1, ?)", claimId, f.project.id, extractionId, JSON.stringify(claim));
    });
    f.app.execute(f.auth.actor, { kind: "memory.forget", requestId: rid(), projectId: f.project.id, expectedRevision: f.app.project(f.auth.actor, f.project.id).revision,
      payload: { claim: { claimId, revision: 1, generation: 1 }, reason: "forget", acknowledged: true } });
    await f.queue.reconcile(f.port);
    expect(f.app.suppressionLedger(f.auth.actor, f.project.id, claimId)?.retire.state).toBe("complete");
  } else {
    const preview = f.app.execute(f.auth.actor, { kind: operation === "delete" ? "memory.delete.preview" : "project.delete.preview", requestId: rid(), projectId: f.project.id,
      expectedRevision: f.app.project(f.auth.actor, f.project.id).revision, payload: { scope: operation === "delete" ? { kind: "source", projectId: f.project.id, source: sent.message.source } : { kind: "project", projectId: f.project.id } } }) as DeletionReceipt;
    const receipt = f.app.execute(f.auth.actor, { kind: operation === "delete" ? "memory.delete.confirm" : "project.delete.confirm", requestId: rid(), projectId: f.project.id,
      expectedRevision: f.app.project(f.auth.actor, f.project.id).revision, payload: { previewId: preview.preview.id, acknowledged: true, acknowledgedWholeSession: true, ...(operation === "project-delete" ? { inventoryDigest: preview.preview.inventoryDigest, projectName: f.project.name } : {}) } }) as DeletionConfirmReceipt;
    await f.queue.reconcile(f.port);
    expect(f.app.deletionOperation(f.auth.actor, f.project.id, receipt.operation.id).operation?.state).toBe("complete");
  }
  expect(existsSync(join(f.box.root, ".jit", "attachments", `${a.id}-notes.txt`))).toBe(false);
  expect(["removed", "wiped"]).toContain(state(f, a.id)!);
});

test("Workspace and Full residual notices render in Settings, confirmation and composer in both locales with ingestion off", async () => {
  const f = await world(); const web = createWebHandler(f.app);
  for (const language of ["th", "en"] as const) {
    f.store.transaction(tx => tx.run("INSERT OR REPLACE INTO owner_preferences (id, revision, theme, language, updated_at) VALUES (1, 1, 'system', ?, 0)", language));
    for (const level of ["workspace", "full"] as const) {
      setLevel(f, "read");
      const revision = f.app.projectAccess(f.auth.actor, f.project.id).revision;
      const confirmation = await web(new Request(`${f.config.origin}/settings/access/${f.project.id}/confirm?to=${level}&rev=${revision}`, { headers: { Cookie: `jit_session=${f.token}`, "Accept-Language": language } }));
      expect(await confirmation.text()).toContain(dictionaries[language][`attachments.box_notice_${level}`]);
      setLevel(f, level); f.config.attachments.enabled = false;
      for (const path of ["/settings/access", `/projects/${f.project.id}/topics/${f.topic.id}`]) {
        const response = await web(new Request(`${f.config.origin}${path}`, { headers: { Cookie: `jit_session=${f.token}`, "Accept-Language": language } }));
        expect(await response.text()).toContain(dictionaries[language][`attachments.box_notice_${level}`]);
      }
    }
  }
});

test("migration 45 adds classified identity-only copies to a real v44 database", async () => {
  const f = await world(); const path = join(f.root, "migration.sqlite");
  const old = new TransactionStore(path); old.close(); const db = new Database(path); db.exec("DROP TABLE attachment_box_copies; PRAGMA user_version = 44"); db.close();
  const migrated = new TransactionStore(path);
  expect(schemaVersion).toBe(45); expect(migrated.read(tx => tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version)).toBe(45);
  expect(migrated.read(tx => tx.all<{ name: string }>("PRAGMA table_info(attachment_box_copies)").map(c => c.name))).toEqual(["project_id", "attachment_id", "state", "bytes", "created_at", "updated_at"]);
  expect(backupImageTables.attachment_box_copies).toBe("include"); migrated.close();
  const safe = attachmentBoxName({ id: rid(), name: ".--" + "ก /".repeat(100) + ".pdf", extension: "txt" }).slice(37);
  expect(Buffer.byteLength(safe)).toBeLessThanOrEqual(64); expect(safe).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]*\.txt$/);
});

// Exercise the shipped script too, against a local runner fixture rather than a container runtime.
test("the runner fixture preserves binary writes and executes verified rm through spawn", async () => {
  const f = await effectFixture(); fixtures.push(f); setLevel(f, "workspace");
  for (const name of ["json.py", "subprocess.py", "sitecustomize.py"]) writeFileSync(join(f.box.root, name), "raise RuntimeError('workspace module must not be imported')\n");
  const a = await uploadText(f, "runner bytes"), binary = Uint8Array.from([137,80,78,71,13,10,26,10,255,0,128]);
  derivative(f, a.id, "image", binary); sendFiles(f, [a.id]); await settle(f);
  const path = join(f.box.root, ".jit", "attachments", `${a.id}-notes.png`);
  expect(readFileSync(path)).toEqual(Buffer.from(binary));
  await f.boxes.attachmentCopies.reconcile(f.project.id, [a.id]); expect(existsSync(path)).toBe(false);
});

test("deletion during the runner write removes late bytes and never exposes tools to the model", async () => {
  let observed = false, writes = 0;
  const control: { onWrite?: () => Promise<void> } = {};
  const f = await world(request => { observed = true; return answer(request, "must not run"); }, control);
  setLevel(f, "workspace"); const a = await uploadText(f, "late bytes");
  control.onWrite = async () => { if (++writes === 2) f.store.transaction(tx => retireAttachments(tx, f.project.id, [a.id], "delete", f.clock.now)); };
  sendFiles(f, [a.id]); await settle(f);
  expect(observed).toBe(false); expect(files(f)).toEqual([]); expect(state(f, a.id)).toBe("removed"); expect(f.boxes.busy(f.project.id)).toBe(false);
});
