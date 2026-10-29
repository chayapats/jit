import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createImageContent, HostImageError, MAX_IMAGE_BYTES, MAX_INPUT_IMAGES, type HostImageOptions, type ImageContent } from "schway/host";
import { AppError } from "../errors";
import { serviceToolCurrent } from "../security/service-tools";
import type { AppTransaction, TransactionStore } from "../store";
import type { ApplicationRunRequest } from "../team/types";
import { readImageProbes, imageRoutePassed } from "./image-probes";
import { writeAttachmentEvent } from "./records";
import { runAttachmentCurrent, type RunAttachmentRef } from "./run-references";

interface Derivative { hash: string; bytes: number; mediaType: "image/png" | "image/jpeg" }
function derivative(tx: AppTransaction, request: ApplicationRunRequest, ref: RunAttachmentRef): Derivative | null {
  if (!runAttachmentCurrent(tx, request, ref)) return null;
  return tx.get<Derivative>(`SELECT model_sha256 AS hash, model_bytes AS bytes, clean_media_type AS mediaType FROM attachments
    WHERE id = ? AND project_id = ? AND state = 'ready' AND kind = 'image' AND sanitized_by = 'container'
    AND clean_media_type IN ('image/png', 'image/jpeg') AND model_sha256 IS NOT NULL`, ref.attachmentId, request.projectId);
}
function bytesOf(store: TransactionStore, projectId: string, row: Derivative): Buffer {
  if (!/^[a-f0-9]{64}$/.test(row.hash) || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > MAX_IMAGE_BYTES) throw new AppError("images_unavailable");
  const root = join(dirname(resolve(store.path)), "attachments");
  for (const path of [root, join(root, projectId), join(root, projectId, row.hash.slice(0, 2))]) {
    const st = lstatSync(path);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077)) throw new AppError("images_unavailable");
  }
  const fd = openSync(join(root, projectId, row.hash.slice(0, 2), row.hash), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size !== row.bytes || (st.mode & 0o077)) throw new AppError("images_unavailable");
    const data = Buffer.alloc(row.bytes);
    let offset = 0;
    while (offset < data.length) {
      const read = readSync(fd, data, offset, data.length - offset, offset);
      if (!read) throw new AppError("images_unavailable");
      offset += read;
    }
    if (fstatSync(fd).size !== row.bytes) throw new AppError("images_unavailable");
    return data;
  } finally { closeSync(fd); }
}
function content(ref: RunAttachmentRef, row: Derivative, bytes: Uint8Array): ImageContent {
  const image = createImageContent(`attachment:${ref.attachmentId}@${ref.revision}g${ref.generation}`, row.mediaType, bytes);
  if (image.sha256 !== row.hash || image.byteLength !== row.bytes) throw new AppError("images_unavailable");
  return image;
}

/** Reference-only images for the newest owner's message; every resolver call rechecks live authority, evidence and derivative identity. No byte cache or durable payload exists. */
export function prepareModelImages(store: TransactionStore, request: ApplicationRunRequest, revision: string, now = Date.now): { images: ImageContent[]; sentIds: ReadonlySet<string>; options: HostImageOptions; guardSend: (start: () => Promise<Response>) => Promise<Response> } {
  const probes = store.read(tx => readImageProbes(tx, revision));
  const supported = imageRoutePassed(probes, request.route);
  const carried = new Map<string, { ref: RunAttachmentRef; image: ImageContent }>();
  const images = supported ? store.read(tx => {
    if (!serviceToolCurrent(tx, request)) throw new AppError("images_unavailable");
    return (request.attachments ?? []).filter(ref => ref.inline && ref.kind === "image").flatMap(ref => {
      const row = derivative(tx, request, ref);
      if (!row) return [];
      try {
        const image = content(ref, row, bytesOf(store, request.projectId, row));
        carried.set(image.reference, { ref, image }); return [image];
      } catch { throw new AppError("images_unavailable"); }
    });
  }) : [];
  if (images.length > MAX_INPUT_IMAGES) throw new AppError("images_unavailable");
  const currentIn = (tx: AppTransaction) => serviceToolCurrent(tx, request) && imageRoutePassed(readImageProbes(tx, revision), request.route) &&
    [...carried.values()].every(({ ref, image }) => {
      const row = derivative(tx, request, ref);
      return row?.hash === image.sha256 && row.bytes === image.byteLength && row.mediaType === image.mediaType;
    });
  return { images, sentIds: new Set([...carried.values()].map(entry => entry.ref.attachmentId)), guardSend: start => {
    let pending!: Promise<Response>;
    // Hold the same writer serialization as deletion only until fetch starts, never across the network wait.
    store.transaction(tx => { if (!currentIn(tx)) throw new HostImageError("images-unavailable"); pending = start(); });
    return pending;
  }, options: { probes, resolve: async (image, signal) => {
    // Keep the async boundary ahead of the final synchronous read/check/release, just like read_attachment.
    await Promise.resolve();
    return store.transaction(tx => {
      const entry = carried.get(image.reference);
      if (signal?.aborted || !entry || JSON.stringify(image) !== JSON.stringify(entry.image) || !currentIn(tx)) return null;
      try {
        const row = derivative(tx, request, entry.ref)!;
        const bytes = bytesOf(store, request.projectId, row);
        const verified = content(entry.ref, row, bytes);
        if (JSON.stringify(verified) !== JSON.stringify(entry.image)) return null;
        writeAttachmentEvent(tx, { projectId: request.projectId, attachmentId: entry.ref.attachmentId, kind: "send_model", status: "ok",
          runId: request.runId, jobId: request.fence.jobId, route: `${request.route.provider}/${request.route.model}`, bytes: bytes.length,
          detail: { part: "image" }, createdAt: now() });
        return bytes;
      } catch { return null; }
    });
  } } };
}
