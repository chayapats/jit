import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, type ApplicationOptions } from "../src/application";
import { readConfig } from "../src/config";
import { TransactionStore } from "../src/store";
import { createWebHandler } from "../src/web";
import { conversationIdentity } from "../src/conversation";
import { dictionaries } from "../src/i18n";
import { assetUrl } from "../src/web-assets";
import { multipartFileName } from "../src/attachments/multipart";
import { attachmentDisposition } from "../src/attachments/serving";

const dirs: string[] = [], stores: TransactionStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) { try { s.close(); } catch {} } for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const host = { memoryBytes: 8 * 1024 ** 3, dataFilesystemBytes: 32 * 1024 ** 3, backupFilesystemBytes: 32 * 1024 ** 3 };
const utf8 = (s: string) => Buffer.from(s);
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const jpeg = Buffer.from("ffd8ffe000104a464946", "hex");
const webp = utf8("RIFF1234WEBPVP8 data");
const th = dictionaries.th, en = dictionaries.en;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const securityHeaders = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin",
  "content-security-policy": "default-src 'none'; sandbox" };

async function fixture(options: ApplicationOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jit-att03-")); dirs.push(dir);
  const path = join(dir, "jit.sqlite"), config = readConfig({ JIT_DATABASE: path }, host);
  // The release gate stays closed in configuration; tests open ingestion by injection, as ATT01 does.
  config.attachments = { ...config.attachments, enabled: true, fileBytes: 1000, projectBytes: 4000, diskReserveBytes: 1000 };
  const store = new TransactionStore(path); stores.push(store); let now = 1_800_000_000_000;
  const app = new Application(store, config, { now: () => now, ...options, attachments: { diskFree: () => 100_000, ...options.attachments } });
  await app.setupOwner("fixture-attachment-owner-password");
  const token = await app.login("fixture-attachment-owner-password"), auth = app.authenticate(token);
  const p = app.execute(auth.actor, { kind: "project.create", projectId: null, requestId: crypto.randomUUID(), expectedRevision: 0, payload: { name: "fixture" } }).project;
  const t = app.execute(auth.actor, { kind: "topic.create", projectId: p.id, requestId: crypto.randomUUID(), expectedRevision: 1, payload: { title: "fixture" } }).topic;
  const web = createWebHandler(app), base = `/projects/${p.id}/topics/${t.id}`;
  const cookie = `jit_session=${token}`;
  const topicRevision = (topicId = t.id) => store.read(tx => tx.get<{ revision: number }>("SELECT revision FROM topics WHERE id = ?", topicId)!.revision);
  /** ATT01's script path: one file per request. */
  async function upload(bytes: Uint8Array = utf8("hello"), name = "test.txt", topicBase = base) {
    const response = await web(new Request(config.origin + `/api${topicBase}/attachments`, { method: "POST", headers: { cookie, origin: config.origin,
      "x-csrf-token": auth.csrf, "content-type": "application/octet-stream", "x-jit-file-name": encodeURIComponent(name) }, body: Buffer.from(bytes) }));
    expect(response.status).toBe(201);
    return (await response.json()).attachment as { id: string; revision: number; state: string; kind: string; name: string };
  }
  function get(path: string, headers: Record<string, string> = {}) {
    return web(new Request(config.origin + path, { headers: { cookie, ...headers } }));
  }
  function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
    return web(new Request(config.origin + path, { method: "POST", headers: { cookie, origin: config.origin, "x-csrf-token": auth.csrf,
      "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  }
  function postForm(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
    return web(new Request(config.origin + path, { method: "POST", headers: { cookie, origin: config.origin,
      "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() }));
  }
  function sendJson(ids: string[], requestId: string = crypto.randomUUID(), text = "with files", topicBase = base, topicId = t.id) {
    return postJson(`/api${topicBase}/messages`, { requestId, expectedRevision: topicRevision(topicId), text, attachmentIds: ids });
  }
  function postMultipart(chunks: Uint8Array[], options: { path?: string; headers?: Record<string, string>; boundary?: string } = {}) {
    const body = counted(chunks);
    const response = web(new Request(config.origin + (options.path ?? `${base}/attachments?send=1`), { method: "POST",
      headers: { cookie, origin: config.origin, "content-type": `multipart/form-data; boundary=${options.boundary ?? boundary}`, ...options.headers }, body: body.stream }));
    return { response, reads: body.reads, cancelled: body.cancelled };
  }
  const rows = () => store.read(tx => tx.all<Record<string, unknown>>("SELECT * FROM attachments ORDER BY created_at, rowid"));
  const events = (kind?: string) => app.attachmentEvents(auth.actor, p.id, { limit: 100 }).filter(e => !kind || e.kind === kind);
  /** Places a container-sanitized derivative, as ATT02 will: the blob in the store and the clean_* columns on the row. */
  function sanitize(id: string, clean: Uint8Array, mediaType: string, sanitizedBy: "container" | "fallback" = "container") {
    const hash = sha(clean), root = join(dir, "attachments", p.id, hash.slice(0, 2));
    mkdirSync(root, { recursive: true, mode: 0o700 }); writeFileSync(join(root, hash), clean, { mode: 0o600 });
    store.transaction(tx => tx.run(`UPDATE attachments SET state = 'ready', sanitized_by = ?, clean_sha256 = ?, clean_media_type = ?, clean_bytes = ?,
      revision = revision + 1 WHERE id = ?`, sanitizedBy, hash, mediaType, clean.length, id));
  }
  return { app, store, config, auth, token, cookie, p, t, web, base, dir, upload, get, postJson, postForm, sendJson, postMultipart, rows, events, sanitize, topicRevision,
    setNow: (value: number) => { now = value; }, getNow: () => now };
}

const boundary = "----JitFormBoundary7MA4YWxkTrZu0gW";
type Part = { name: string; value: string | Uint8Array; filename?: string; type?: string };
/** One chunk per part, each ending with the next delimiter, so a reader that needs part N never pulls part N + 1. */
function multipart(parts: Part[], options: { close?: boolean; b?: string } = {}): Uint8Array[] {
  const b = options.b ?? boundary;
  const chunks = parts.map((part, index) => Buffer.concat([utf8(`${index === 0 ? `--${b}` : ""}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename !== undefined ? `; filename="${part.filename}"` : ""}\r\n${part.filename !== undefined ? `Content-Type: ${part.type ?? "application/octet-stream"}\r\n` : ""}\r\n`),
    typeof part.value === "string" ? utf8(part.value) : Buffer.from(part.value), utf8(`\r\n--${b}`)]));
  if (options.close !== false) chunks.push(utf8("--\r\n"));
  return chunks;
}
function counted(chunks: Uint8Array[]) {
  let read = 0, cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (read < chunks.length) controller.enqueue(chunks[read++]!); else controller.close(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  return { stream, reads: () => read, cancelled: () => cancelled };
}
type F = Awaited<ReturnType<typeof fixture>>;
const fields = (f: F, text = "สวัสดี with files", requestId: string = crypto.randomUUID(), revision = f.topicRevision()): Part[] =>
  [{ name: "csrf", value: f.auth.csrf }, { name: "requestId", value: requestId }, { name: "expectedRevision", value: String(revision) }, { name: "text", value: text }];
const file = (name: string, value: Uint8Array | string, type?: string): Part => ({ name: "file", filename: name, value, ...type ? { type } : {} });
/** The browser's entry for a file control with nothing chosen. */
const noFile: Part = { name: "file", filename: "", value: "" };
/** Status and JSON error of an `/api` response; an HTML error page has only its status and text. */
async function errorOf(response: Response | Promise<Response>) {
  const r = await response;
  if (!r.headers.get("content-type")?.startsWith("application/json")) return { status: r.status, error: undefined as string | undefined, html: await r.text() };
  return { status: r.status, ...(await r.json()) as { error: string; detail?: Record<string, unknown> } };
}
function hidden(html: string, form: RegExp) {
  const match = form.exec(html); if (!match) throw new Error(`no form ${form}`);
  return Object.fromEntries([...match[0].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(m => [m[1]!, m[2]!]));
}

test("gate off: the composer stays a text form, attachmentIds and ?send=1 are refused, existing files still render and download", async () => {
  const f = await fixture();
  const staged = await f.upload(utf8("before the gate closed"), "notes.txt");
  expect((await f.sendJson([staged.id])).status).toBe(200);
  f.config.attachments.enabled = false;
  const html = await (await f.get(f.base)).text();
  expect(html).toContain(`<form class="composer" method="post" action="${f.base}/messages">`);
  for (const absent of ['type="file"', "data-attach-form", assetUrl("attachments.js"), th["attachments.provider_notice"], "?send=1", "multipart/form-data"]) expect(html).not.toContain(absent);
  // The bound file is still shown and can still be downloaded (the gate controls ingestion only).
  expect(html).toContain('<ul class="attachment-list"');
  expect(html).toContain(">notes.txt</span>");
  const download = await f.get(`${f.base}/attachments/${staged.id}/download`);
  expect(download.status).toBe(200);
  expect(await download.text()).toBe("before the gate closed");
  const closed = await f.web(new Request(f.config.origin + `/api${f.base}/attachments`, { method: "POST", headers: { cookie: f.cookie, origin: f.config.origin,
    "x-csrf-token": f.auth.csrf, "content-type": "application/octet-stream", "x-jit-file-name": "x.txt" }, body: "x" }));
  expect(closed.status).toBe(404);
  const refused = f.postMultipart(multipart([...fields(f), file("a.txt", "not read")]), { path: `/api${f.base}/attachments?send=1` });
  expect(await errorOf(refused.response)).toMatchObject({ status: 404, error: "attachments_disabled" });
  expect(refused.reads()).toBe(0);
  expect(await errorOf(f.sendJson([staged.id]))).toMatchObject({ status: 404, error: "attachments_disabled" });
  // An empty list is "no attachments", with the gate off as well.
  expect((await f.sendJson([])).status).toBe(200);
});

test("gate on: the no-script composer is the ordered multipart form with the provider notice in Thai and English", async () => {
  const f = await fixture();
  const html = await (await f.get(f.base)).text();
  const form = /<form class="composer" method="post" action="([^"]+)" enctype="multipart\/form-data" data-attach-form[^>]*>[\s\S]*?<\/form>/.exec(html);
  expect(form?.[1]).toBe(`${f.base}/attachments?send=1`);
  // Tree order is submission order: csrf, requestId, expectedRevision, text, then the file control.
  const names = [...form![0].matchAll(/<(?:input|textarea)\b[^>]*\bname="([^"]+)"/g)].map(m => m[1]);
  expect(names).toEqual(["csrf", "requestId", "expectedRevision", "text", "file"]);
  expect(form![0]).toContain('<input class="attach-input" id="composer-files" type="file" name="file" multiple');
  expect(form![0]).toContain(`data-upload="/api${f.base}/attachments" data-send="/api${f.base}/messages" data-topic="${f.base}" data-page-size="${f.config.pageSize}" data-max-files="5" data-file-bytes="1000"`);
  expect(html).toContain(th["attachments.provider_notice"]);
  expect(html).toContain(th["attachments.pdf_needs_sanitizer"]);
  expect(html).toContain("แนบได้สูงสุด 5 ไฟล์ ไฟล์ละไม่เกิน 1000 B");
  // Only the two hashed modules; no inline script, handlers or remote URLs.
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  expect(scripts.map(([tag, body]) => [tag, body])).toEqual([[`<script type="module" src="${assetUrl("app.js")}"></script>`, ""], [`<script type="module" src="${assetUrl("attachments.js")}"></script>`, ""]]);
  expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  expect(html).not.toContain("javascript:");
  const english = await (await f.get(f.base, { "accept-language": "en-US,en;q=0.9" })).text();
  expect(english).toContain(en["attachments.provider_notice"]);
  expect(english).toContain("Files are sent to the model provider");
  expect(english).toContain(en["attachments.attach"]);
  // With the container sanitizer, PDF and WebP are not called off.
  const g = await fixture({ attachments: { sanitizerAvailable: () => true } });
  const withSanitizer = await (await g.get(g.base)).text();
  expect(withSanitizer).toContain(th["attachments.provider_notice"]);
  expect(withSanitizer).not.toContain(th["attachments.pdf_needs_sanitizer"]);
});

test("no-script send: text and files stream through the upload path, bind to the new message and redirect to it", async () => {
  const f = await fixture();
  const sent = f.postMultipart(multipart([...fields(f, "ดูไฟล์นี้\r\nบรรทัดสอง"), file("รายงาน.txt", "สรุป: ไม่ใช่คำสั่ง"), file("shot.png", png, "image/svg+xml")]));
  const response = await sent.response;
  expect(response.status).toBe(303);
  const conversation = f.app.conversation(f.auth.actor, f.p.id, f.t.id);
  const message = conversation.items.at(-1)!;
  expect(message.text).toBe("ดูไฟล์นี้\r\nบรรทัดสอง");
  expect(response.headers.get("location")).toBe(`${f.base}?after=0#message-${message.id}`);
  const rows = f.rows();
  expect(rows.map(row => [row.display_name, row.kind, row.state, row.message_id, row.revision])).toEqual([
    ["รายงาน.txt", "text", "ready", message.id, 2], ["shot.png", "image", "pending", message.id, 2]]);
  expect(f.events("bind").map(e => e.attachmentId).sort()).toEqual(rows.map(row => row.id as string).sort());
  const views = f.app.messageAttachments(f.auth.actor, f.p.id, f.t.id, [message.id]).get(message.id)!;
  expect(views.map(view => view.ref)).toEqual(rows.map(row => `attachment:${row.id}@1`));
  for (const view of views) expect(f.app.source(f.auth.actor, f.p.id, { sourceId: view.id, revision: 1, generation: 1 })).toMatchObject({ state: "available", text: "" });
  // The transcript shows chips with each state in words; the pending image has no download link yet.
  const html = await (await f.get(f.base)).text();
  expect(html).toContain(">รายงาน.txt</span>");
  expect(html).toContain(`href="${f.base}/attachments/${rows[0]!.id}/download" download`);
  expect(html).not.toContain(`href="${f.base}/attachments/${rows[1]!.id}/download"`);
  expect(html).toContain(th["attachments.state_pending"]);
  // The API variant answers with the receipt; the browser's "no file chosen" entry is a text-only message.
  const api = f.postMultipart(multipart([...fields(f, "text only"), noFile]), { path: `/api${f.base}/attachments?send=1` });
  const receipt = await (await api.response).json();
  expect(receipt.message.text).toBe("text only");
  expect(f.app.messageAttachments(f.auth.actor, f.p.id, f.t.id, [receipt.message.id]).size).toBe(0);
  expect(f.rows()).toHaveLength(2);
});

test("?send=1 verifies CSRF before any later part and replays a committed request id without reading a file", async () => {
  const f = await fixture();
  const api = { path: `/api${f.base}/attachments?send=1` };
  const wrong = f.postMultipart(multipart([{ name: "csrf", value: "f".repeat(64) }, ...fields(f).slice(1), file("a.txt", "never read")]), api);
  expect(await errorOf(wrong.response)).toMatchObject({ status: 403, error: "csrf_rejected" });
  expect(wrong.reads()).toBe(1); expect(wrong.cancelled()).toBe(true);
  const page = f.postMultipart(multipart([{ name: "csrf", value: "f".repeat(64) }, ...fields(f).slice(1), file("a.txt", "never read")]));
  expect(await errorOf(page.response)).toMatchObject({ status: 403, html: expect.stringContaining(th["error.csrf_rejected"]) });
  const misordered = f.postMultipart(multipart([fields(f)[1]!, fields(f)[0]!, ...fields(f).slice(2), file("a.txt", "never read")]), api);
  expect(await errorOf(misordered.response)).toMatchObject({ status: 400, error: "invalid_attachment_upload" });
  expect(misordered.reads()).toBe(1);
  const foreign = f.postMultipart(multipart([...fields(f), file("a.txt", "never read")]), { headers: { origin: "https://evil.example" } });
  expect((await foreign.response).status).toBe(403); expect(foreign.reads()).toBe(0);
  const crossSite = f.postMultipart(multipart([...fields(f), file("a.txt", "never read")]), { headers: { "sec-fetch-site": "cross-site" } });
  expect((await crossSite.response).status).toBe(403); expect(crossSite.reads()).toBe(0);
  const anonymous = f.postMultipart(multipart([...fields(f), file("a.txt", "never read")]), { path: `/api${f.base}/attachments?send=1`, headers: { cookie: "" } });
  expect((await anonymous.response).status).toBe(401); expect(anonymous.reads()).toBe(0);
  expect(f.rows()).toHaveLength(0);
  expect(f.events()).toHaveLength(0);

  const requestId = crypto.randomUUID();
  const first = await f.postMultipart(multipart([...fields(f, "once", requestId), file("a.txt", "first")])).response;
  expect(first.status).toBe(303);
  const again = f.postMultipart(multipart([...fields(f, "once", requestId, 1), file("b.txt", "second"), file("c.txt", "third")]));
  const replayed = await again.response;
  expect(replayed.status).toBe(303);
  expect(replayed.headers.get("location")).toBe(first.headers.get("location"));
  expect(again.reads()).toBe(2); expect(again.cancelled()).toBe(true);
  expect(f.rows()).toHaveLength(1);
  // A request id that belongs to another command, or to a message in another topic, conflicts before any file.
  const other = f.app.execute(f.auth.actor, { kind: "topic.create", projectId: f.p.id, requestId: crypto.randomUUID(), expectedRevision: 2, payload: { title: "other" } }).topic;
  const elsewhere = f.postMultipart(multipart([...fields(f, "once", requestId), file("d.txt", "never read")]), { path: `/projects/${f.p.id}/topics/${other.id}/attachments?send=1` });
  expect((await elsewhere.response).status).toBe(409); expect(elsewhere.reads()).toBe(2);
  const topicRequest = crypto.randomUUID();
  f.app.execute(f.auth.actor, { kind: "topic.create", projectId: f.p.id, requestId: topicRequest, expectedRevision: 3, payload: { title: "third" } });
  const reused = f.postMultipart(multipart([...fields(f, "x", topicRequest), file("e.txt", "never read")]), api);
  expect(await errorOf(reused.response)).toMatchObject({ status: 409, error: "request_id_conflict" });
  expect(f.rows()).toHaveLength(1);
});

test("?send=1: two submits of one form racing past the replay check both land on the message that committed", async () => {
  const f = await fixture();
  const requestId = crypto.randomUUID(), late = multipart([...fields(f, "same form", requestId), file("late.txt", "late")]);
  // The late request stops before its file part, after its replay check has already found nothing.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let read = 0;
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    if (read === 4) await gate;
    if (read < late.length) controller.enqueue(late[read++]!); else controller.close();
  } }, { highWaterMark: 0 });
  const pending = f.web(new Request(f.config.origin + `${f.base}/attachments?send=1`, { method: "POST",
    headers: { cookie: f.cookie, origin: f.config.origin, "content-type": `multipart/form-data; boundary=${boundary}` }, body }));
  while (read < 4) await Bun.sleep(1);
  const first = await f.postMultipart(multipart([...fields(f, "same form", requestId), file("first.txt", "first")])).response;
  expect(first.status).toBe(303);
  release();
  const second = await pending;
  expect(second.status).toBe(303);
  expect(second.headers.get("location")).toBe(first.headers.get("location"));
  expect(f.rows().map(row => [row.display_name, row.state, row.reason])).toEqual([["first.txt", "ready", null], [null, "deleted", "discarded"]]);
  expect(f.app.conversation(f.auth.actor, f.p.id, f.t.id).items).toHaveLength(1);
});

test("?send=1 refuses misordered, extra, oversized or malformed parts and discards the files it staged", async () => {
  const f = await fixture();
  const api = `/api${f.base}/attachments?send=1`;
  const cases: [string, Uint8Array[], number, string][] = [
    ["missing text", multipart([...fields(f).slice(0, 3), file("a.txt", "x")]), 400, "invalid_attachment_upload"],
    ["text after files", multipart([...fields(f), file("a.txt", "x"), { name: "text", value: "late" }]), 400, "invalid_attachment_upload"],
    ["unknown file field", multipart([...fields(f), { name: "upload", filename: "a.txt", value: "x" }]), 400, "invalid_attachment_upload"],
    ["filename on a text field", multipart([...fields(f).slice(0, 3), { name: "text", filename: "t.txt", value: "x" }]), 400, "invalid_attachment_upload"],
    ["no-file entry with bytes", multipart([...fields(f), { name: "file", filename: "", value: "smuggled" }]), 400, "invalid_attachment_upload"],
    ["truncated body", multipart([...fields(f), file("a.txt", "x")], { close: false }), 400, "invalid_attachment_upload"],
    ["preamble", [utf8("preamble\r\n"), ...multipart([...fields(f)])], 400, "invalid_attachment_upload"],
    ["epilogue", [...multipart([...fields(f)]), utf8("trailing")], 400, "invalid_attachment_upload"],
    ["unknown header", [utf8(`--${boundary}\r\nContent-Disposition: form-data; name="csrf"\r\nX-Extra: 1\r\n\r\n${f.auth.csrf}\r\n--${boundary}--\r\n`)], 400, "invalid_attachment_upload"],
    ["header too long", [utf8(`--${boundary}\r\nContent-Disposition: form-data; name="${"c".repeat(5000)}"\r\n\r\nx\r\n--${boundary}--\r\n`)], 400, "invalid_attachment_upload"],
    ["svg file", multipart([...fields(f), file("ok.txt", "fine"), file("x.svg", "<svg/>")]), 415, "attachment_type_unsupported"],
    ["stale revision", multipart([...fields(f, "x", crypto.randomUUID(), 99), file("a.txt", "x")]), 409, "stale_revision"],
    ["oversized text", multipart([...fields(f, "x".repeat(f.config.bodyBytes))]), 413, "request_too_large"],
  ];
  for (const [label, chunks, status, error] of cases) {
    const result = await errorOf(f.postMultipart(chunks, { path: api }).response);
    expect([label, result.status, result.error]).toEqual([label, status, error]);
  }
  expect(await errorOf(f.postMultipart(multipart(fields(f)), { path: api, headers: { "content-type": "application/json" } }).response)).toMatchObject({ status: 415, error: "unsupported_content_type" });
  expect(await errorOf(f.postMultipart(multipart(fields(f)), { path: api, headers: { "content-type": "multipart/form-data" } }).response)).toMatchObject({ status: 400, error: "invalid_attachment_upload" });
  // Every file a refused send staged is discarded at once, so it holds no quota.
  expect(f.rows().every(row => row.state === "deleted" && row.reason === "discarded" && row.message_id === null && row.display_name === null)).toBe(true);
  expect(f.rows().length).toBeGreaterThan(0);
  // One more file than a message may carry is refused before its body is read, in the owner's words.
  f.config.attachments.messageFiles = 2;
  const many = f.postMultipart(multipart([...fields(f), file("1.txt", "one"), file("2.txt", "two"), file("3.txt", "never read"), file("4.txt", "never read")]));
  const tooMany = await many.response;
  expect(tooMany.status).toBe(413);
  expect(await tooMany.text()).toContain(th["error.attachment_quota_exceeded_files"]);
  expect(many.reads()).toBe(7);
  expect(f.rows().filter(row => row.state !== "deleted")).toHaveLength(0);
  expect(f.app.conversation(f.auth.actor, f.p.id, f.t.id).items).toHaveLength(0);
});

test("message.send binds attachmentIds of this project and topic exactly once, inside the receipt identity", async () => {
  const f = await fixture();
  const a = await f.upload(utf8("a"), "a.txt"), b = await f.upload(png, "b.png");
  const requestId = crypto.randomUUID();
  const sent = await f.sendJson([b.id, a.id], requestId);
  expect(sent.status).toBe(200);
  const receipt = await sent.json();
  expect(f.rows().map(row => [row.id, row.message_id])).toEqual([[a.id, receipt.message.id], [b.id, receipt.message.id]]);
  // The same request replays its receipt (ids in any order); other ids under the same request id conflict.
  const replay = await f.postJson(`/api${f.base}/messages`, { requestId, expectedRevision: 1, text: "with files", attachmentIds: [a.id, b.id] });
  expect(await replay.json()).toEqual(receipt);
  const c = await f.upload(utf8("c"), "c.txt");
  expect(await errorOf(f.postJson(`/api${f.base}/messages`, { requestId, expectedRevision: 1, text: "with files", attachmentIds: [c.id] }))).toMatchObject({ status: 409, error: "request_id_conflict" });
  expect(f.events("bind")).toHaveLength(2);
  // Foreign, stale and malformed ids.
  const otherTopic = f.app.execute(f.auth.actor, { kind: "topic.create", projectId: f.p.id, requestId: crypto.randomUUID(), expectedRevision: 2, payload: { title: "other" } }).topic;
  const otherProject = f.app.execute(f.auth.actor, { kind: "project.create", projectId: null, requestId: crypto.randomUUID(), expectedRevision: 1, payload: { name: "other" } }).project;
  const otherProjectTopic = f.app.execute(f.auth.actor, { kind: "topic.create", projectId: otherProject.id, requestId: crypto.randomUUID(), expectedRevision: 1, payload: { title: "x" } }).topic;
  const inTopic = await f.upload(utf8("t"), "t.txt", `/projects/${f.p.id}/topics/${otherTopic.id}`);
  const inProject = await f.upload(utf8("p"), "p.txt", `/projects/${otherProject.id}/topics/${otherProjectTopic.id}`);
  const rejected = await f.upload(utf8("r"), "r.txt"), discarded = await f.upload(utf8("d"), "d.txt");
  f.store.transaction(tx => tx.run("UPDATE attachments SET state = 'rejected', reason = 'sanitize_timeout' WHERE id = ?", rejected.id));
  expect((await f.postJson(`/api${f.base}/attachments/${discarded.id}/discard`, { requestId: crypto.randomUUID(), expectedRevision: 1 })).status).toBe(200);
  const cases: [string[], number, string][] = [
    [[a.id], 409, "attachment_stale"], [[inTopic.id], 404, "attachment_not_found"], [[inProject.id], 404, "attachment_not_found"],
    [[crypto.randomUUID()], 404, "attachment_not_found"], [[rejected.id], 409, "attachment_stale"], [[discarded.id], 409, "attachment_stale"],
    [[c.id, c.id], 409, "attachment_stale"], [["../x"], 400, "invalid_identity"],
  ];
  for (const [ids, status, error] of cases) expect([ids, await errorOf(f.sendJson(ids))]).toMatchObject([ids, { status, error }]);
  expect(await errorOf(f.postJson(`/api${f.base}/messages`, { requestId: crypto.randomUUID(), expectedRevision: f.topicRevision(), text: "x", attachmentIds: "nope" }))).toMatchObject({ status: 400, error: "invalid_conversation_command" });
  f.config.attachments.messageFiles = 1;
  const d = await f.upload(utf8("dd"), "dd.txt");
  expect(await errorOf(f.sendJson([c.id, d.id]))).toMatchObject({ status: 413, error: "attachment_quota_exceeded", detail: { limit: "message_files" } });
  // A refused send binds nothing and commits no message.
  expect(f.rows().filter(row => row.message_id !== null)).toHaveLength(2);
  expect(f.app.conversation(f.auth.actor, f.p.id, f.t.id).items).toHaveLength(1);
  // Url-encoded forms never carry attachment ids.
  const form = await f.postForm(`${f.base}/messages`, { csrf: f.auth.csrf, requestId: crypto.randomUUID(), expectedRevision: String(f.topicRevision()), text: "x", attachmentIds: c.id });
  expect(form.status).toBe(400);
  // A message without attachments keeps its original receipt identity.
  const plain = { kind: "message.send" as const, requestId: "plain-request-1", projectId: f.p.id, expectedRevision: 3, payload: { topicId: f.t.id, text: "hi" } };
  expect(conversationIdentity(plain, 4096)).toBe(JSON.stringify(["message.send", f.p.id, 3, f.t.id, "hi"]));
  expect(conversationIdentity({ ...plain, payload: { ...plain.payload, attachmentIds: [] } }, 4096)).toBe(conversationIdentity(plain, 4096));
  expect(conversationIdentity({ ...plain, payload: { ...plain.payload, attachmentIds: [d.id, c.id] } }, 4096))
    .toBe(JSON.stringify(["message.send", f.p.id, 3, f.t.id, "hi", { attachmentIds: [c.id, d.id].sort() }]));
});

test("discard removes only a staged attachment, idempotently, behind CSRF and Origin, even with the gate off", async () => {
  const f = await fixture();
  const staged = await f.upload(utf8("discard me"), "x.txt");
  const path = `/api${f.base}/attachments/${staged.id}/discard`, requestId = crypto.randomUUID();
  expect((await f.postJson(path, { requestId, expectedRevision: 1 }, { "x-csrf-token": "" })).status).toBe(403);
  expect((await f.postJson(path, { requestId, expectedRevision: 1 }, { origin: "https://evil.example" })).status).toBe(403);
  expect(await errorOf(f.postJson(path, { requestId, expectedRevision: 7 }))).toMatchObject({ status: 409, error: "stale_revision" });
  f.config.attachments.enabled = false;
  const first = await (await f.postJson(path, { requestId, expectedRevision: 1 })).json();
  expect(first.attachment).toMatchObject({ id: staged.id, state: "deleted", name: null, reason: "discarded", revision: 2 });
  expect(await (await f.postJson(path, { requestId, expectedRevision: 1 })).json()).toEqual(first);
  expect(await errorOf(f.postJson(path, { requestId: crypto.randomUUID(), expectedRevision: 2 }))).toMatchObject({ status: 409, error: "attachment_stale" });
  expect(f.events("delete").map(e => [e.attachmentId, e.reason])).toEqual([[staged.id, "discarded"]]);
  // The unreferenced blob goes with the next sweep.
  const blob = join(f.dir, "attachments", f.p.id, sha(utf8("discard me")).slice(0, 2), sha(utf8("discard me")));
  expect(readFileSync(blob, "utf8")).toBe("discard me");
  f.app.sweepAttachments();
  expect(() => readFileSync(blob)).toThrow();
  // A bound file is never discarded; the plain form path redirects back to the topic.
  f.config.attachments.enabled = true;
  const bound = await f.upload(utf8("bound"), "b.txt");
  await f.sendJson([bound.id]);
  expect(await errorOf(f.postJson(`/api${f.base}/attachments/${bound.id}/discard`, { requestId: crypto.randomUUID(), expectedRevision: 2 }))).toMatchObject({ status: 409, error: "attachment_stale" });
  const other = await f.upload(utf8("form"), "f.txt");
  const form = await f.postForm(`${f.base}/attachments/${other.id}/discard`, { csrf: f.auth.csrf, requestId: crypto.randomUUID(), expectedRevision: "1" });
  expect(form.status).toBe(303); expect(form.headers.get("location")).toBe(f.base);
  expect(await errorOf(f.postJson(`/api${f.base}/attachments/${crypto.randomUUID()}/discard`, { requestId: crypto.randomUUID(), expectedRevision: 1 }))).toMatchObject({ status: 404, error: "attachment_not_found" });
});

test("preview serves only a ready container re-encode with the exact D05 headers, never an original or fallback", async () => {
  const f = await fixture({ attachments: { sanitizerAvailable: () => true } });
  const image = await f.upload(png, "photo.png"), photo = await f.upload(webp, "photo.webp"), fallback = await f.upload(jpeg, "f.jpg");
  const text = await f.upload(utf8("words"), "w.txt"), pdf = await f.upload(utf8("%PDF-1.7 body"), "d.pdf"), forged = await f.upload(Buffer.concat([png, utf8("x")]), "forged.png");
  const preview = (id: string, headers: Record<string, string> = {}) => f.get(`${f.base}/attachments/${id}/preview`, headers);
  // Pending: the original is never previewed.
  expect((await preview(image.id)).status).toBe(404);
  const clean = Buffer.concat([png, utf8("re-encoded pixels")]);
  f.sanitize(image.id, clean, "image/png");
  const served = await preview(image.id);
  expect(served.status).toBe(200);
  expect(Object.fromEntries([...served.headers].filter(([key]) => [...Object.keys(securityHeaders), "content-type", "content-disposition"].includes(key))))
    .toEqual({ ...securityHeaders, "content-type": "image/png" });
  expect(Buffer.from(await served.arrayBuffer())).toEqual(clean);
  // A WebP previews as its PNG re-encode, a JPEG as JPEG.
  f.sanitize(photo.id, Buffer.concat([png, utf8("webp as png")]), "image/png");
  expect((await preview(photo.id)).headers.get("content-type")).toBe("image/png");
  // A fallback strip, text, PDF, a non-image derivative or a forged signature never preview.
  f.sanitize(fallback.id, Buffer.concat([jpeg, utf8("stripped")]), "image/jpeg", "fallback");
  f.sanitize(forged.id, utf8("<html><script>alert(1)</script>"), "image/png");
  for (const id of [fallback.id, text.id, pdf.id, forged.id]) {
    expect([id, await errorOf(f.get(`/api${f.base}/attachments/${id}/preview`))]).toMatchObject([id, { status: 404, error: "attachment_preview_unavailable" }]);
    const page = await preview(id);
    expect([page.status, page.headers.get("content-type")]).toEqual([404, "text/html; charset=utf-8"]);
  }
  // Scope, session and fetch-metadata checks.
  const other = f.app.execute(f.auth.actor, { kind: "topic.create", projectId: f.p.id, requestId: crypto.randomUUID(), expectedRevision: 2, payload: { title: "other" } }).topic;
  expect(await errorOf(f.get(`/api/projects/${f.p.id}/topics/${other.id}/attachments/${image.id}/preview`))).toMatchObject({ status: 404, error: "attachment_not_found" });
  expect((await f.get(`/api${f.base}/attachments/${image.id}/preview`, { cookie: "" })).status).toBe(401);
  expect((await preview(image.id, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await preview(image.id, { "sec-fetch-site": "same-site" })).status).toBe(403);
  expect((await preview(image.id, { origin: "https://evil.example" })).status).toBe(403);
  expect((await preview(image.id, { "sec-fetch-site": "same-origin" })).status).toBe(200);
  // Rejected and deleted are gone; previews are not audited.
  f.store.transaction(tx => tx.run("UPDATE attachments SET state = 'rejected', reason = 'image_decode_failed' WHERE id = ?", photo.id));
  expect(await errorOf(f.get(`/api${f.base}/attachments/${photo.id}/preview`))).toMatchObject({ status: 410, error: "attachment_unavailable" });
  expect(f.events("download")).toHaveLength(0);
  // The transcript shows the thumbnail only for the re-encode, and says why a fallback image has none.
  expect((await f.sendJson([image.id, fallback.id, text.id])).status).toBe(200);
  const html = await (await f.get(f.base)).text();
  expect(html).toContain(`<img src="${f.base}/attachments/${image.id}/preview"`);
  expect(html).not.toContain(`/attachments/${fallback.id}/preview`);
  expect(html).toContain(th["attachments.no_preview_fallback"]);
  expect(html).not.toMatch(/<(?:iframe|object|embed)\b/);
});

test("download is always an audited octet-stream attachment with an ASCII filename and an RFC 5987 filename*", async () => {
  const f = await fixture({ attachments: { sanitizerAvailable: () => true } });
  const hostile = await f.upload(utf8("<script>alert(1)</script>"), '"><img src=x onerror=alert(1)>.txt');
  const thai = await f.upload(utf8("ไทย"), "รายงาน ประจำเดือน.md"), pdf = await f.upload(utf8("%PDF-1.7 body"), "spec.pdf");
  const photo = await f.upload(webp, "holiday.webp"), pending = await f.upload(png, "wait.png"), fallback = await f.upload(jpeg, "cam.jpeg");
  const download = (id: string, headers: Record<string, string> = {}) => f.get(`${f.base}/attachments/${id}/download`, headers);
  const first = await download(hostile.id);
  expect(first.status).toBe(200);
  expect(Object.fromEntries([...first.headers].filter(([key]) => [...Object.keys(securityHeaders), "content-type", "content-disposition"].includes(key)))).toEqual({
    ...securityHeaders, "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="img src_x onerror_alert(1).txt"; filename*=UTF-8''%22%3E%3Cimg%20src%3Dx%20onerror%3Dalert%281%29%3E.txt` });
  expect(await first.text()).toBe("<script>alert(1)</script>");
  expect((await download(thai.id)).headers.get("content-disposition")).toBe(`attachment; filename="file.md"; filename*=UTF-8''${encodeURIComponent("รายงาน ประจำเดือน.md")}`);
  // PDFs are never rendered: the original goes out as an octet-stream attachment, and no preview exists.
  const spec = await download(pdf.id);
  expect(spec.headers.get("content-type")).toBe("application/octet-stream");
  expect(spec.headers.get("content-disposition")).toStartWith("attachment;");
  expect(await spec.text()).toBe("%PDF-1.7 body");
  // An image is downloadable only once sanitized; the extension follows the served file.
  expect(await errorOf(f.get(`/api${f.base}/attachments/${pending.id}/download`))).toMatchObject({ status: 409, error: "attachment_processing" });
  const reencoded = Buffer.concat([png, utf8("from webp")]);
  f.sanitize(photo.id, reencoded, "image/png");
  const holiday = await download(photo.id);
  expect(holiday.headers.get("content-disposition")).toBe(`attachment; filename="holiday.png"; filename*=UTF-8''holiday.png`);
  expect(Buffer.from(await holiday.arrayBuffer())).toEqual(reencoded);
  const stripped = Buffer.concat([jpeg, utf8("no exif")]);
  f.sanitize(fallback.id, stripped, "image/jpeg", "fallback");
  const cam = await download(fallback.id);
  expect(cam.headers.get("content-disposition")).toBe(`attachment; filename="cam.jpeg"; filename*=UTF-8''cam.jpeg`);
  expect(Buffer.from(await cam.arrayBuffer())).toEqual(stripped);
  expect(f.events("download").map(e => [e.attachmentId, e.status, e.bytes])).toEqual([
    [fallback.id, "ok", stripped.length], [photo.id, "ok", reencoded.length], [pdf.id, "ok", 13], [thai.id, "ok", 9], [hostile.id, "ok", 25]]);
  // Fetch metadata and Origin, session, scope, and gone files.
  expect((await download(hostile.id, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await download(hostile.id, { origin: "https://evil.example" })).status).toBe(403);
  expect((await download(hostile.id, { cookie: "" })).status).toBe(303);
  f.store.transaction(tx => tx.run("UPDATE attachments SET state = 'deleted', display_name = NULL, sha256 = NULL WHERE id = ?", thai.id));
  expect(await errorOf(f.get(`/api${f.base}/attachments/${thai.id}/download`))).toMatchObject({ status: 410, error: "attachment_unavailable" });
  expect(f.events("download")).toHaveLength(5);
  // SVG and HTML never get stored, so they cannot be served at all.
  for (const [name, body] of [["x.svg", "<svg onload=alert(1)/>"], ["x.html", "<!doctype html><script>1</script>"], ["x.txt", "<svg/>"]] as const) {
    const r = await f.web(new Request(f.config.origin + `/api${f.base}/attachments`, { method: "POST", headers: { cookie: f.cookie, origin: f.config.origin,
      "x-csrf-token": f.auth.csrf, "content-type": "application/octet-stream", "x-jit-file-name": encodeURIComponent(name) }, body }));
    expect(r.status).toBe(415);
  }
  // The transcript escapes the hostile name everywhere.
  expect((await f.sendJson([hostile.id, pdf.id])).status).toBe(200);
  const html = await (await f.get(f.base)).text();
  expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;.txt");
  expect(html).not.toContain("<img src=x");
  expect(html).not.toContain('"><img');
});

test("transcript chips say each state in words: rejected with its reason, deleted, pending, fallback", async () => {
  const f = await fixture();
  const ok = await f.upload(utf8("fine"), "fine.txt"), bad = await f.upload(png, "bad.png"), gone = await f.upload(utf8("gone"), "gone.txt");
  expect((await f.sendJson([ok.id, bad.id, gone.id])).status).toBe(200);
  f.store.transaction(tx => {
    tx.run("UPDATE attachments SET state = 'rejected', reason = 'image_too_many_pixels' WHERE id = ?", bad.id);
    tx.run("UPDATE attachments SET state = 'deleted', reason = 'owner_delete', display_name = NULL, sha256 = NULL WHERE id = ?", gone.id);
  });
  const html = await (await f.get(f.base)).text();
  expect(html).toContain(`${th["attachments.state_rejected"]}: ${th["attachments.reason_image_too_many_pixels"]}`);
  expect(html).toContain(`<span class="attachment-name">${th["attachments.state_deleted"]}</span>`);
  expect(html).not.toContain(`/attachments/${bad.id}/download`);
  expect(html).not.toContain(`/attachments/${gone.id}/download`);
  expect(html).toContain(`/attachments/${ok.id}/download`);
  const english = await (await f.get(f.base, { "accept-language": "en" })).text();
  expect(english).toContain(`${en["attachments.state_rejected"]}: ${en["attachments.reason_image_too_many_pixels"]}`);
  const api = await (await f.get(`/api${f.base}`)).json();
  const listed = Object.values(api.attachments as Record<string, { id: string; state: string }[]>)[0]!;
  expect(listed.map(view => [view.id, view.state])).toEqual([[ok.id, "ready"], [bad.id, "rejected"], [gone.id, "deleted"]]);
});

test("helpers: browser multipart names and Content-Disposition never carry a path or break the header", () => {
  expect(decodeURIComponent(multipartFileName("a%22b.txt"))).toBe('a"b.txt');
  expect(decodeURIComponent(multipartFileName("100%.txt"))).toBe("100%.txt");
  expect(decodeURIComponent(multipartFileName("line%0D%0Abreak.txt"))).toBe("line\r\nbreak.txt");
  const long = decodeURIComponent(multipartFileName("ก".repeat(400) + ".md"));
  expect(Buffer.byteLength(long)).toBeLessThanOrEqual(128); expect(long.endsWith(".md")).toBe(true);
  for (const name of ["../../etc/passwd", 'a";b\r\n.txt', "x\\y.txt", "ไทย.txt", "a'b(c)*.txt"]) {
    const header = attachmentDisposition(name);
    expect(header).toMatch(/^attachment; filename="[A-Za-z0-9._ ()-]+"; filename\*=UTF-8''[A-Za-z0-9!#$&+\-.^_`|~%]+$/);
    expect(decodeURIComponent(header.split("filename*=UTF-8''")[1]!)).toBe(name);
  }
  expect(attachmentDisposition("ไทย.txt")).toStartWith('attachment; filename="file.txt";');
});

test("attachments.js contract: picks, pastes and drops upload one file per request; Send posts JSON with the staged ids", async () => {
  const script = readFileSync(join(import.meta.dir, "../src/web-assets/attachments.js"), "utf8");
  expect(script).not.toMatch(/\beval\s*\(|new Function|innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|document\.cookie|createObjectURL|FileReader/);
  // Every request goes to the topic's own attachment or message API path, with same-origin credentials.
  expect([...script.matchAll(/\bfetch\(([^,]+),/g)].map(m => m[1])).toEqual(["`${upload}/${entry.id}`", "`${upload}/${entry.id}/discard`", "send"]);
  for (const call of script.matchAll(/\bfetch\([^,]+, \{([^}]*)/g)) expect(call[1]).toContain('credentials: "same-origin"');
  expect([...script.matchAll(/xhr\.open\(([^)]*)\)/g)].map(m => m[1])).toEqual(['"POST", upload']);

  // A small stub DOM: elements keep their children, attributes, listeners and text.
  class El {
    children: El[] = []; dataset: Record<string, string> = {}; attributes: Record<string, string> = {}; listeners: Record<string, ((event: any) => unknown)[]> = {};
    textContent = ""; hidden = false; className = ""; value = ""; parent: El | null = null; focused = false; type = ""; max = 0; src = ""; alt = ""; width = 0; height = 0;
    files: unknown[] = [];
    constructor(readonly tag: string, readonly selectors: Record<string, El | null> = {}) {}
    querySelector(selector: string): El | null { return this.selectors[selector] ?? null; }
    append(...nodes: El[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    replaceChildren(...nodes: El[]) { this.children = []; this.append(...nodes); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
    setAttribute(key: string, value: string) { this.attributes[key] = value; }
    removeAttribute(key: string) { delete this.attributes[key]; }
    addEventListener(type: string, fn: (event: any) => unknown) { (this.listeners[type] ??= []).push(fn); }
    async fire(type: string, event: any = {}) { for (const fn of this.listeners[type] ?? []) await fn(event); }
    focus() { this.focused = true; }
    cloneNode() { return new El(this.tag); }
  }
  const strings: Record<string, string> = Object.fromEntries(Object.entries({
    "attachments.remove": "Remove {name}", "attachments.state_uploading": "Uploading", "attachments.state_pending": "Waiting for the safety check",
    "attachments.state_ready": "Ready to send", "attachments.state_failed": "Not attached", "attachments.too_large": "Larger than {size}",
    "attachments.too_many": "Up to {count}", "attachments.wait_uploads": "Wait for uploads", "attachments.uploaded": "Attached {name}",
    "attachments.send_failed": "Not sent", "attachments.drop_here": "Drop here", "error.attachment_type_unsupported": "Unsupported",
    "reason.svg": "SVG files are not accepted", "error.default": "Invalid", "error.stale_revision": "Reload",
  }));
  const words = new El("ul");
  words.querySelector = (selector: string) => { const key = /data-key="([^"]+)"/.exec(selector)?.[1]; const el = new El("li"); el.textContent = key && strings[key] ? strings[key]! : ""; return key && strings[key] ? el : null; };
  const iconSet = new El("span"); iconSet.querySelector = () => new El("svg");
  const topic = "/projects/11111111-1111-1111-1111-111111111111/topics/22222222-2222-2222-2222-222222222222";
  const hiddenField = (value: string) => { const el = new El("input"); el.value = value; return el; };
  const input = new El("input"), chips = new El("ul"), notice = new El("p"), status = new El("p"), textarea = new El("textarea");
  chips.hidden = true; notice.hidden = true;
  const form = new El("form", {
    'input[type="file"][name="file"]': input, "[data-attach-chips]": chips, "[data-attach-notice]": notice, "[data-attach-status]": status, textarea,
    'input[type="hidden"][name="csrf"]': hiddenField("c".repeat(64)), 'input[type="hidden"][name="requestId"]': hiddenField("request-0001"),
    'input[type="hidden"][name="expectedRevision"]': hiddenField("4"),
  });
  Object.assign(form.dataset, { topic, upload: `/api${topic}/attachments`, send: `/api${topic}/messages`, pageSize: "50", maxFiles: "2", fileBytes: "1000" });
  const documentListeners: Record<string, ((event: any) => unknown)[]> = {};
  const xhrs: FakeXhr[] = [];
  class FakeXhr {
    headers: Record<string, string> = {}; method = ""; url = ""; body: unknown = null; status = 0; responseText = ""; aborted = false;
    listeners: Record<string, () => void> = {}; upload = { listeners: {} as Record<string, (event: any) => void>, addEventListener(type: string, fn: (event: any) => void) { this.listeners[type] = fn; } };
    constructor() { xhrs.push(this); }
    open(method: string, url: string) { this.method = method; this.url = url; }
    setRequestHeader(key: string, value: string) { this.headers[key] = value; }
    addEventListener(type: string, fn: () => void) { this.listeners[type] = fn; }
    send(body: unknown) { this.body = body; }
    abort() { this.aborted = true; }
    respond(status: number, body: unknown) { this.status = status; this.responseText = JSON.stringify(body); this.listeners.load!(); }
  }
  const fetches: { url: string; init: any }[] = [];
  let sendResponse: { ok: boolean; body: unknown } = { ok: true, body: { message: { id: "33333333-3333-3333-3333-333333333333", sequence: 61 } } };
  const assigned: string[] = [];
  const timers: (() => void)[] = [];
  const globals: Record<string, unknown> = {
    document: { querySelector: (s: string) => s === "form[data-attach-form]" ? form : s === "[data-attach-text]" ? words : s === "[data-attach-icons]" ? iconSet : null,
      createElement: (tag: string) => new El(tag), addEventListener: (type: string, fn: (event: any) => unknown) => { (documentListeners[type] ??= []).push(fn); } },
    window: { setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout: () => {} },
    XMLHttpRequest: FakeXhr,
    fetch: async (url: string, init: any) => { fetches.push({ url, init }); return url.endsWith("/messages") ? { ok: sendResponse.ok, json: async () => sendResponse.body } : { ok: true, json: async () => ({}) }; },
    location: { pathname: topic, search: "?after=0", hash: "", assign: (url: string) => { assigned.push(url); }, reload: () => { assigned.push("reload"); } },
  };
  const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try {
    await import(`../src/web-assets/attachments.js?case=${crypto.randomUUID()}`);
    expect(form.dataset.attachReady).toBe("true");
    expect(form.dataset.dropLabel).toBe("Drop here");
    const blob = (bytes: Uint8Array | string, name = "") => Object.assign(new Blob([typeof bytes === "string" ? bytes : new Uint8Array(bytes)]), { name });
    // Pick two files: the oversized one is refused here without a request; the other uploads with exact headers.
    input.files = [blob("x".repeat(1001), "big.txt"), blob('<b>"x"</b>', '<img src=x onerror=1>.txt')];
    input.value = "C:\\fakepath\\big.txt";
    await input.fire("change");
    expect(input.value).toBe("");
    expect(xhrs).toHaveLength(1);
    expect(xhrs[0]).toMatchObject({ method: "POST", url: `/api${topic}/attachments`, headers: { "Content-Type": "application/octet-stream",
      "X-CSRF-Token": "c".repeat(64), "X-Jit-File-Name": encodeURIComponent("<img src=x onerror=1>.txt") } });
    expect(chips.hidden).toBe(false); expect(notice.hidden).toBe(false);
    const [big, hostile] = chips.children;
    expect(big!.dataset.state).toBe("failed");
    expect(big!.children[1]!.children[1]!.textContent).toBe("1001 B · Not attached: Larger than 1000 B");
    // Names are text, never markup.
    expect(hostile!.children[1]!.children[0]!.textContent).toBe("<img src=x onerror=1>.txt");
    expect(hostile!.children[2]!.attributes["aria-label"]).toBe("Remove <img src=x onerror=1>.txt");
    xhrs[0]!.upload.listeners.progress!({ lengthComputable: true, loaded: 5, total: 10 });
    expect(hostile!.children[1]!.children[1]!.textContent).toBe("10 B · Uploading 50%");
    // Sending while a file uploads waits.
    let prevented = false;
    await form.fire("submit", { preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true); expect(status.textContent).toBe("Wait for uploads");
    const staged = "44444444-4444-4444-4444-444444444444";
    xhrs[0]!.respond(201, { attachment: { id: staged, revision: 1, state: "pending", kind: "text", preview: false, sanitizedBy: null, reason: null } });
    expect(hostile!.dataset.state).toBe("pending");
    expect(hostile!.children[1]!.children[1]!.textContent).toBe("10 B · Waiting for the safety check");
    // A pasted screenshot is named from its signature; copied text is left to the textarea.
    let pastePrevented = false;
    await textarea.fire("paste", { clipboardData: { files: [blob(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))], getData: () => "copied cells" }, preventDefault: () => { pastePrevented = true; } });
    expect(pastePrevented).toBe(false); expect(xhrs).toHaveLength(1);
    await textarea.fire("paste", { clipboardData: { files: [blob(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))], getData: () => "" }, preventDefault: () => { pastePrevented = true; } });
    await Bun.sleep(0);
    expect(pastePrevented).toBe(true);
    expect(xhrs[1]!.headers["X-Jit-File-Name"]).toBe("pasted-image-1.png");
    xhrs[1]!.respond(415, { error: "attachment_type_unsupported", detail: { reason: "svg" } });
    expect(chips.children[2]!.children[1]!.children[1]!.textContent).toBe("8 B · Not attached: SVG files are not accepted");
    // A third live file exceeds the limit of two.
    for (const fn of documentListeners.drop ?? []) await fn({ dataTransfer: { types: ["Files"], files: [blob("a", "a.txt"), blob("b", "b.txt")] }, preventDefault: () => {} });
    expect(xhrs).toHaveLength(3);
    expect(status.textContent).toBe("Up to 2");
    // Removing a chip aborts its upload; removing a staged one discards it on the server.
    const dropped = chips.children.at(-1)!;
    await dropped.children[2]!.fire("click");
    expect(xhrs[2]!.aborted).toBe(true);
    // Send: JSON message.send with the form's request id and the staged ids only.
    prevented = false;
    await form.fire("submit", { preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
    const sent = fetches.find(call => call.url === `/api${topic}/messages`)!;
    expect(sent.init.method).toBe("POST");
    expect(sent.init.headers["x-csrf-token"]).toBe("c".repeat(64));
    expect(JSON.parse(sent.init.body)).toEqual({ requestId: "request-0001", expectedRevision: 4, text: "", attachmentIds: [staged] });
    expect(assigned).toEqual([`${topic}?after=11#message-33333333-3333-3333-3333-333333333333`]);
    // Discard posts the chip's revision; a failed send shows the server's reason in words.
    sendResponse = { ok: false, body: { error: "stale_revision" } };
    input.files = [blob("c", "c.txt")];
    await input.fire("change");
    xhrs.at(-1)!.respond(201, { attachment: { id: "55555555-5555-5555-5555-555555555555", revision: 1, state: "ready", kind: "text", preview: false, sanitizedBy: "service", reason: null } });
    await form.fire("submit", { preventDefault: () => {} });
    expect(status.textContent).toBe("Not sent: Reload");
    await chips.children.at(-1)!.children[2]!.fire("click");
    const discard = fetches.find(call => call.url.endsWith("/55555555-5555-5555-5555-555555555555/discard"))!;
    expect(JSON.parse(discard.init.body)).toMatchObject({ expectedRevision: 1 });
    expect(discard.init.headers["x-csrf-token"]).toBe("c".repeat(64));
  } finally {
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
  }
});
