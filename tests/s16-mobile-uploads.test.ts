import { expect, test } from "bun:test";
import { MobileDrafts, mobileIntent } from "../src/s16/mobile/drafts";
import { MobileUploads } from "../src/s16/mobile/uploads";
import { MobileSession } from "../src/s16/mobile/session";
import { MobileTransport, type MobileSecureStore } from "../src/s16/mobile/transport";
import { mobileAppFixture } from "./fixtures/s16-mobile-app";

const file = () => ({ name: "original.txt", bytes: new TextEncoder().encode("Controlled immutable original file.\n") });
async function fixture() {
  const m = await mobileAppFixture(), records = new Map<string, string>();
  const store: MobileSecureStore = { async get(key) { return records.get(key) ?? null; }, async set(key, value) { records.set(key, value); }, async delete(key) { records.delete(key); } };
  let lose: "create" | "bytes" | null = null, hold: ((path: string, result: Response) => Promise<Response>) | null = null;
  const calls: { path: string; method: string }[] = [];
  const transport = new MobileTransport({ origin: m.origin, store, async fetch(url, init) {
    const path = new URL(url).pathname; calls.push({ path, method: init.method ?? "GET" }); const result = await fetch(url, init);
    if (lose && init.method === "POST" && (lose === "create" ? path.endsWith("/uploads") : path.endsWith("/bytes"))) { lose = null; await result.body?.cancel(); throw Error("Controlled lost committed upload reply"); }
    return hold ? hold(path, result) : result;
  } });
  const session = new MobileSession(transport), drafts = new MobileDrafts(), uploads = new MobileUploads(session, drafts);
  await session.signIn(m.password); await session.selectConversation("upload_scope"); const intent = mobileIntent(session);
  return { m, session, drafts, uploads, intent, calls, records,
    chip: () => drafts.get(intent.scope, intent.conversationId).files[0]!,
    get creations() { return calls.filter(call => call.method === "POST" && call.path.endsWith("/uploads")).length; },
    get writes() { return calls.filter(call => call.method === "POST" && call.path.endsWith("/bytes")).length; },
    set lose(value: typeof lose) { lose = value; }, set hold(value: typeof hold) { hold = value; },
    async close() { session.background(); await m.close(); },
  };
}

test("lost upload creation is recovered read-only after restart, then an explicit identical selection finishes the original ID", async () => {
  const f = await fixture();
  try {
    f.lose = "create"; await expect(f.uploads.begin(f.intent, file())).rejects.toBeDefined();
    const original = f.chip(); expect(original.uploadId).toBeNull(); expect(original.sha256).toMatch(/^[a-f0-9]{64}$/); expect(f.session.projection.phase).toBe("unavailable"); expect(f.creations).toBe(1); expect(f.writes).toBe(0);
    await f.m.f.reopen(); await f.session.restore();
    const waiting = await f.uploads.check(original); expect(waiting).toMatchObject({ requestId: original.requestId, phase: "failed", code: "mobile_upload_select_again" }); expect(waiting.uploadId).toMatch(/^file_/); expect(f.creations).toBe(1); expect(f.writes).toBe(0);
    const ready = await f.uploads.resume(mobileIntent(f.session), waiting, file());
    expect(ready).toMatchObject({ requestId: original.requestId, uploadId: waiting.uploadId, phase: "ready", code: null }); expect(ready.receipt).toMatchObject({ id: waiting.uploadId, sha256: original.sha256, bytes: original.bytes });
    expect(f.creations).toBe(1); expect(f.writes).toBe(1); expect(f.m.f.vmCalls).toEqual([]);
    expect(f.calls.filter(call => call.path.includes("/uploads/commands/")).map(call => call.path)).toEqual([`/api/s16/client/conversations/upload_scope/uploads/commands/${original.requestId}`]);
  } finally { await f.close(); }
});

test("lost bytes reply recovers the completed original receipt without replaying either mutation", async () => {
  const f = await fixture();
  try {
    f.lose = "bytes"; await expect(f.uploads.begin(f.intent, file())).rejects.toBeDefined();
    const original = f.chip(); expect(original.uploadId).not.toBeNull(); expect(f.creations).toBe(1); expect(f.writes).toBe(1);
    await f.session.restore(); const ready = await f.uploads.check(original); expect(ready.phase).toBe("ready"); expect(ready.receipt?.sha256).toBe(original.sha256);
    await expect(f.uploads.resume(mobileIntent(f.session), ready, file())).rejects.toMatchObject({ code: "mobile_upload_not_created" });
    expect(f.creations).toBe(1); expect(f.writes).toBe(1); expect(f.m.f.vmCalls).toEqual([]);
  } finally { await f.close(); }
});

test("an explicit re-selection cannot substitute a name, size or same-size different bytes for the original upload", async () => {
  const f = await fixture();
  try {
    f.lose = "create"; await expect(f.uploads.begin(f.intent, file())).rejects.toBeDefined(); await f.session.restore(); const waiting = await f.uploads.check(f.chip());
    const changed = file(); changed.bytes[0] = changed.bytes[0]! ^ 1;
    for (const selected of [{ ...file(), name: "other.txt" }, { ...file(), bytes: file().bytes.slice(1) }, changed]) await expect(f.uploads.resume(mobileIntent(f.session), waiting, selected)).rejects.toMatchObject({ code: "mobile_upload_bytes_changed" });
    expect(f.chip()).toEqual(waiting); expect(f.creations).toBe(1); expect(f.writes).toBe(0);
  } finally { await f.close(); }
});

test("authentication and target selection changes cannot recover or resume another binding's original upload", async () => {
  const f = await fixture();
  try {
    f.lose = "create"; await expect(f.uploads.begin(f.intent, file())).rejects.toBeDefined(); await f.session.restore(); const waiting = await f.uploads.check(f.chip()), selected = mobileIntent(f.session);
    await f.session.selectConversation("other"); await f.session.selectConversation("upload_scope");
    await expect(f.uploads.resume(selected, waiting, file())).rejects.toMatchObject({ code: "mobile_binding_changed" }); expect(f.writes).toBe(0);
    await f.session.signIn(f.m.password); await f.session.selectConversation("upload_scope"); const before = f.calls.length;
    await expect(f.uploads.check(waiting)).rejects.toMatchObject({ code: "mobile_upload_scope_invalid" }); expect(f.calls.length).toBe(before); expect(f.creations).toBe(1);
  } finally { await f.close(); }
});

test("a late creation reply after background never publishes private metadata or starts its byte upload", async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    f.hold = async (path, response) => { if (path.endsWith("/uploads")) { entered.resolve(); await release.promise; } return response; };
    const original = f.uploads.begin(f.intent, file()).catch(error => error); await entered.promise; f.session.background(); release.resolve();
    expect(await original).toBeInstanceOf(Error); expect(f.chip().uploadId).toBeNull(); expect(f.writes).toBe(0);
    await f.session.restore(); const waiting = await f.uploads.check(f.chip()); expect(waiting.code).toBe("mobile_upload_select_again"); expect(f.creations).toBe(1); expect(f.writes).toBe(0);
  } finally { release.resolve(); await f.close(); }
});

test("duplicate Check gestures hold one original lookup and never race into a write", async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    f.lose = "create"; await expect(f.uploads.begin(f.intent, file())).rejects.toBeDefined(); await f.session.restore(); const original = f.chip();
    f.hold = async (path, response) => { if (path.includes("/uploads/commands/")) { entered.resolve(); await release.promise; } return response; };
    const first = f.uploads.check(original); await entered.promise;
    await expect(f.uploads.check(original)).rejects.toMatchObject({ code: "mobile_file_busy" }); release.resolve(); expect((await first).code).toBe("mobile_upload_select_again");
    expect(f.calls.filter(call => call.path.includes("/uploads/commands/")).length).toBe(1); expect(f.writes).toBe(0);
  } finally { release.resolve(); await f.close(); }
});

test("original create lookup accepts maximum request IDs, refuses missing/wrong conversations, and survives restart without a new command", async () => {
  const f = await fixture();
  try {
    const bytes = file().bytes, sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), requestId = "r".repeat(128);
    const created = await f.session.perform((client, signal) => client.createUpload({ requestId, conversationId: "upload_scope", name: file().name, bytes: bytes.length, sha256 }, signal));
    expect(await f.session.perform((client, signal) => client.uploadCreation("upload_scope", requestId, signal))).toEqual(created);
    await expect(f.session.perform((client, signal) => client.uploadCreation("wrong_scope", requestId, signal))).rejects.toMatchObject({ status: 404 });
    await expect(f.session.perform((client, signal) => client.uploadCreation("upload_scope", "absent", signal))).rejects.toMatchObject({ status: 404 }); expect(f.session.projection.phase).toBe("ready");
    await f.m.f.reopen(); await f.session.restore(); expect((await f.session.perform((client, signal) => client.uploadCreation("upload_scope", requestId, signal))).id).toBe(created.id);
    expect(f.creations).toBe(1); expect(f.writes).toBe(0); expect(f.m.f.vmCalls).toEqual([]);
  } finally { await f.close(); }
});

test("an older service without creation lookup reports its limit without guessing an ID or sending an unsupported request", async () => {
  const f = await fixture();
  try {
    f.lose = "create"; await expect(f.uploads.begin(f.intent, file())).rejects.toBeDefined();
    f.m.intercept = async request => { if (new URL(request.url).pathname.endsWith("/bootstrap")) { const response = await f.m.f.service.fetch(request), data = await response.json() as any; delete data.capabilities.uploads.creationLookup; return Response.json(data); } return null; };
    await f.session.restore(); const before = f.calls.length;
    await expect(f.uploads.check(f.chip())).rejects.toMatchObject({ code: "mobile_upload_recovery_unavailable" });
    expect(f.calls.length).toBe(before); expect(f.chip().uploadId).toBeNull(); expect(f.creations).toBe(1); expect(f.writes).toBe(0);
  } finally { await f.close(); }
});

test("a replaced service's late picker cannot restore its retired session and upload into the old service", async () => {
  const f = await fixture();
  try {
    const sheet = f.intent, before = f.calls.length, credentials = [...f.records]; f.session.retire();
    await expect(f.session.restore()).rejects.toMatchObject({ code: "mobile_response_stale" });
    await expect(f.uploads.begin(sheet, file())).rejects.toMatchObject({ code: "mobile_binding_changed" });
    expect(f.calls.length).toBe(before); expect([...f.records]).toEqual(credentials); expect(f.creations).toBe(0); expect(f.writes).toBe(0);
    expect(f.session.projection).toMatchObject({ phase: "background", bootstrap: null, snapshot: null, conversationId: null });
  } finally { await f.close(); }
});
