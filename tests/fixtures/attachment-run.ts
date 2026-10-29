import type { EffectFixture } from "./effects";
import { rid } from "./effects";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attachmentBoxName } from "../../src/attachments/box-copies";

/** Injects the ingestion gate for deterministic tests only and stages a UTF-8 file through the owner upload API. */
export async function uploadText(f: EffectFixture, text: string, name = "notes.txt") {
  f.config.attachments.enabled = true; f.config.attachments.diskReserveBytes = 1;
  return f.app.uploadAttachment(f.auth.actor, f.project.id, f.topic.id, { body: new Blob([text]).stream(), encodedName: name });
}
/** Binds staged files with an ordinary owner message; it grants no execution access and does not pump the queue. */
export function sendFiles(f: EffectFixture, ids: string[], text = "Read the attached files.") {
  return f.app.execute(f.auth.actor, { kind: "message.send", requestId: rid(), projectId: f.project.id,
    expectedRevision: f.app.topic(f.auth.actor, f.project.id, f.topic.id).topic.revision, payload: { topicId: f.topic.id, text, attachmentIds: ids } });
}

/**
 * While run A awaits in its script with tools already open, admit run B in another topic of the same project.
 * Resolve only after B's production copy pass publishes its bytes into their shared box; no synthetic tracking rows.
 */
export async function copyFromConcurrentRun(f: EffectFixture, text: string) {
  const topic = f.app.execute(f.auth.actor, { kind: "topic.create", requestId: rid(), projectId: f.project.id,
    expectedRevision: f.app.project(f.auth.actor, f.project.id).revision, payload: { title: "Concurrent attachment writer" } }).topic;
  const scope = { ...f, topic }, file = await uploadText(scope, text);
  sendFiles(scope, [file.id]);
  await new Promise<void>((resolve, reject) => {
    const check = () => {
      const present = f.store.read(tx => tx.get<{ state: string }>("SELECT state FROM attachment_box_copies WHERE attachment_id = ?", file.id)?.state === "present");
      if (!present) return;
      unsubscribe();
      try {
        const path = join(f.box.root, ".jit", "attachments", attachmentBoxName({ id: file.id, name: file.name!, extension: "txt" }));
        if (readFileSync(path, "utf8") !== text) throw new Error("concurrent copy bytes missing");
        resolve();
      } catch (error) { reject(error); }
    };
    const unsubscribe = f.store.onCommit(() => queueMicrotask(check));
    f.queue.pump();
  });
  return file;
}

/** Corrupts a newly copied source so the next corpus refresh must take the owner-approval path. */
export function corruptAttachmentText(f: EffectFixture, id: string) {
  const hash = f.store.read(tx => tx.get<{ hash: string }>("SELECT text_sha256 AS hash FROM attachments WHERE id = ?", id)!.hash);
  writeFileSync(join(f.state, "attachments", f.project.id, hash.slice(0, 2), hash), "corrupt");
}
