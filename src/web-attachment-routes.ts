import type { Application, OwnerActor } from "./application";
import type { AppConfig } from "./config";
import type { MessageReceipt } from "./conversation";
import { AppError } from "./errors";
import { multipartBoundary, multipartFileName, OrderedMultipart } from "./attachments/multipart";
import { attachmentDisposition, attachmentSecurityHeaders, blobStream } from "./attachments/serving";

/** What the attachment routes need from the Web handler: the request, its session and the shared response helpers. */
export interface AttachmentHttp {
  app: Application; config: AppConfig; request: Request; url: URL; api: boolean;
  auth: { actor: OwnerActor; csrf: string };
  json(body: unknown, status?: number): Response;
  respond(body: BodyInit | null, status?: number, extra?: Record<string, string>): Response;
  payload(request: Request): Promise<Record<string, unknown>>;
  /** Response headers every Jit response carries besides its CSP and cache policy (HSTS, Referrer-Policy). */
  transportHeaders: Record<string, string>;
}

const invalid = () => new AppError("invalid_attachment_upload");

/** The topic location a committed message redirects to, the same as the plain message form. */
export function messageLocation(receipt: MessageReceipt, pageSize: number): string {
  const { message } = receipt;
  return `/projects/${message.projectId}/topics/${message.topicId}?after=${Math.max(0, message.sequence - pageSize)}#message-${message.id}`;
}

/**
 * app.attachments/v1 routes added by ATT03, after the session check and (for POST) the exact-Origin check:
 * - `POST …/attachments?send=1`: the no-script composer (see {@link noScriptSend}).
 * - `POST …/attachments/:id/discard`: form or JSON `{ requestId, expectedRevision }` with CSRF.
 * - `GET …/attachments/:id/preview` and `…/download`: D05 serving. A cross-site fetch (`Sec-Fetch-Site`) or a
 *   foreign `Origin` is 403 `origin_rejected`, on top of the SameSite=Strict session cookie.
 * Returns null for any other method or path, which the caller answers as not found.
 */
export async function attachmentAction(http: AttachmentHttp, projectId: string, topicId: string, id: string | undefined, action: string | undefined): Promise<Response | null> {
  const { app, request, auth, api } = http;
  if (request.method === "POST" && !id && !action) return noScriptSend(http, projectId, topicId);
  if (!id) return null;
  if (request.method === "GET" && (action === "preview" || action === "download")) {
    const site = request.headers.get("sec-fetch-site"), origin = request.headers.get("origin");
    if ((site !== null && site !== "same-origin" && site !== "none") || (origin !== null && origin !== http.config.origin)) throw new AppError("origin_rejected", 403);
    const served = app.attachmentContent(auth.actor, projectId, topicId, id, action);
    return new Response(blobStream(served.fd, served.bytes), { status: 200, headers: {
      ...http.transportHeaders, ...attachmentSecurityHeaders, "Content-Length": String(served.bytes),
      ...action === "preview" ? { "Content-Type": served.mediaType }
        : { "Content-Type": "application/octet-stream", "Content-Disposition": attachmentDisposition(served.name) },
    } });
  }
  if (request.method === "POST" && action === "discard") {
    const body = await http.payload(request);
    app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
    if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision"].includes(key))) throw new AppError("invalid_body");
    const revision = typeof body.expectedRevision === "string" && /^\d{1,15}$/.test(body.expectedRevision) ? Number(body.expectedRevision) : body.expectedRevision;
    const receipt = app.discardAttachment(auth.actor, projectId, topicId, id, { requestId: body.requestId as string, expectedRevision: revision as number });
    return api ? http.json(receipt) : http.respond(null, 303, { Location: `/projects/${projectId}/topics/${topicId}` });
  }
  return null;
}

/**
 * The no-script composer (S13-D01): `multipart/form-data` with exactly the parts `csrf`, `requestId`,
 * `expectedRevision`, `text`, then 0..`messageFiles` `file` parts, in that order. The CSRF part is verified before any
 * later part is read; a `requestId` that already has a committed message redirects to it without reading a file. Each
 * file streams through the ATT01 upload path, then `message.send` binds them all; a failure discards the files this
 * request staged. The text fields together stay within `config.bodyBytes`, and the body never goes through `payload()`.
 * A file part with an empty filename and an empty body is the browser's "no file chosen" entry and is skipped.
 */
async function noScriptSend(http: AttachmentHttp, projectId: string, topicId: string): Promise<Response> {
  const { app, config, request, auth } = http;
  const boundary = multipartBoundary(request.headers.get("content-type"));
  if (!request.body) throw invalid();
  const form = new OrderedMultipart(request.body, boundary), staged: string[] = [];
  let requestId: string | null = null;
  const sent = (receipt: MessageReceipt) => http.api ? http.json(receipt) : http.respond(null, 303, { Location: messageLocation(receipt, config.pageSize) });
  try {
    const field = async (name: string) => {
      const part = await form.next();
      if (!part || part.name !== name || part.filename !== null) throw invalid();
      const value = await form.text(Math.max(0, config.bodyBytes - form.consumed));
      if (form.consumed > config.bodyBytes) throw new AppError("request_too_large", 413);
      return value;
    };
    app.verifyCsrf(auth.csrf, await field("csrf"));
    requestId = await field("requestId");
    const replay = app.sendReplay(auth.actor, projectId, topicId, requestId);
    if (replay) { await form.cancel(); return sent(replay); }
    const revision = await field("expectedRevision"), text = await field("text");
    if (!/^\d{1,15}$/.test(revision)) throw invalid();
    for (let part = await form.next(); part; part = await form.next()) {
      if (part.name !== "file" || part.filename === null) throw invalid();
      if (part.filename === "") { if (!await form.empty()) throw invalid(); continue; }
      if (staged.length >= config.attachments.messageFiles) throw new AppError("attachment_quota_exceeded", 413, { limit: "message_files" });
      const attachment = await app.uploadAttachment(auth.actor, projectId, topicId, { body: form.body(), encodedName: multipartFileName(part.filename) });
      staged.push(attachment.id);
    }
    return sent(app.execute(auth.actor, { kind: "message.send", requestId, projectId, expectedRevision: Number(revision),
      payload: { topicId, text, ...staged.length ? { attachmentIds: staged } : {} } }));
  } catch (error) {
    await form.cancel();
    // Best effort: staged-file GC removes anything left after the staged lifetime.
    try { app.abandonStagedAttachments(auth.actor, projectId, topicId, staged); } catch { /* Keep the original rejection. */ }
    // A concurrent submit of the same form committed first (its files differ, so its identity does): answer with it.
    if (error instanceof AppError && error.code === "request_id_conflict" && requestId) {
      const winner = app.sendReplay(auth.actor, projectId, topicId, requestId);
      if (winner) return sent(winner);
    }
    throw error;
  }
}
