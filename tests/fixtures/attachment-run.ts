import type { EffectFixture } from "./effects";
import { rid } from "./effects";

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
