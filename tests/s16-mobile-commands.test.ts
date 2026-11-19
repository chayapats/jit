import { expect, test } from "bun:test";
import { MobileCommands } from "../src/s16/mobile/commands";
import { MobileSession } from "../src/s16/mobile/session";
import { MobileTransport, type MobileSecureStore } from "../src/s16/mobile/transport";
import { mobileAppFixture } from "./fixtures/s16-mobile-app";
import { mail } from "./fixtures/s15-effects";

async function fixture() {
  const m = await mobileAppFixture(), records = new Map<string, string>();
  let dropReply = false, failStorage = false, posts = 0, refuseBeforeSend = false;
  const requestIds: string[] = [];
  const store: MobileSecureStore = { async get(key) { return records.get(key) ?? null; }, async set(key, value) { if (failStorage && key.includes("pending")) throw Error("Controlled native storage failure"); records.set(key, value); }, async delete(key) { records.delete(key); } };
  const transport = new MobileTransport({ origin: m.origin, store, async fetch(url, init) {
    const message = url.endsWith("/messages") && init.method === "POST";
    if (message) {
      posts++; const body = init.body;
      const text = typeof body === "string" ? body : body instanceof ArrayBuffer ? new TextDecoder().decode(body) : body && ArrayBuffer.isView(body) ? new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)) : null;
      if (text === null) throw Error("Unexpected fixture body representation");
      requestIds.push(JSON.parse(text).requestId);
      if (refuseBeforeSend) { refuseBeforeSend = false; throw Error("Controlled connection loss before admission"); }
    }
    const result = await fetch(url, init);
    if (message && dropReply) { dropReply = false; await result.body?.cancel(); throw Error("Controlled lost accepted reply"); }
    return result;
  } });
  const session = new MobileSession(transport), commands = new MobileCommands(session, store);
  await session.signIn(m.password); await session.selectConversation("native_commands");
  return { m, records, store, session, commands, transport, requestIds, get posts() { return posts; }, set refuseBeforeSend(value: boolean) { refuseBeforeSend = value; }, set dropReply(value: boolean) { dropReply = value; }, set failStorage(value: boolean) { failStorage = value; } };
}

test("native current-card decisions refuse a changed reference and one fresh press dispatches the owning effect once", async () => {
  const f = await fixture();
  try {
    f.m.f.interpretation = { intent: "execute", purposeId: "purpose", resourceIds: ["account"], access: "effect", subject: null };
    f.m.f.script = [{ type: "tool_call", id: "native_email", name: "gmail_prepare_send", arguments: { ...mail() } }];
    await f.commands.send("native_commands", "Send the prepared email to the recipient"); await f.m.f.service.conversation.drain(); await f.session.poll();
    const original = f.session.projection.snapshot!.conversation.rows.flatMap(row => row.slips)[0]!;
    expect(original).toMatchObject({ state: "pending", canApprove: true }); expect(f.m.f.google.sent.size).toBe(0);
    await expect(f.commands.decide("native_commands", { ...original, action: { ...original.action, revision: original.action.revision + 1 } }, "approve")).rejects.toMatchObject({ code: "stale_action" });
    await f.session.perform((client, signal) => client.decide({ contract: "s15-conversation-decision/v1", requestId: "other_device_declined", conversationId: "native_commands", action: { id: original.action.id, revision: original.action.revision, actionHash: original.action.actionHash }, decision: "deny" }, signal));
    await f.m.f.service.conversation.drain(); await f.session.poll();
    await expect(f.commands.decide("native_commands", original, "approve")).rejects.toMatchObject({ code: "stale_action" }); expect(f.m.f.google.sent.size).toBe(0);
    f.m.f.script = [{ type: "tool_call", id: "native_email_fresh", name: "gmail_prepare_send", arguments: { ...mail(), subject: "Fresh exact native card" } }];
    await f.commands.send("native_commands", "Send the prepared email to the recipient"); await f.m.f.service.conversation.drain(); await f.session.poll();
    const fresh = f.session.projection.snapshot!.conversation.rows.flatMap(row => row.slips).find(slip => slip.state === "pending")!;
    const press = f.commands.decide("native_commands", fresh, "approve");
    await expect(f.commands.decide("native_commands", fresh, "deny")).rejects.toMatchObject({ code: "mobile_command_busy" });
    await press; await f.m.f.service.conversation.drain(); expect(f.m.f.google.sent.size).toBe(1);
    await expect(f.commands.decide("native_commands", fresh, "approve")).rejects.toMatchObject({ code: "stale_action" }); expect(f.m.f.google.sent.size).toBe(1);
  } finally { await f.m.close(); }
});

test("an authenticated absent original permits only an explicit identical RAM retry or an explicit blank replacement", async () => {
  const f = await fixture();
  try {
    f.refuseBeforeSend = true;
    await expect(f.commands.send("native_commands", "Controlled original request bytes")).rejects.toBeDefined();
    await f.session.restore(); const original = (await f.commands.pending())[0]!;
    await expect(f.commands.retry(original.requestId)).rejects.toMatchObject({ code: "mobile_command_unavailable" });
    await expect(f.commands.recover(original)).rejects.toMatchObject({ status: 404 }); expect(f.session.projection.phase).toBe("ready");
    expect(f.commands.canRetry(original)).toBe(true); await f.commands.retry(original.requestId);
    expect(f.requestIds).toEqual([original.requestId, original.requestId]); expect(await f.commands.pending()).toEqual([]);
    f.refuseBeforeSend = true; await expect(f.commands.send("native_commands", "Second controlled original bytes")).rejects.toBeDefined(); await f.session.restore();
    const restarted = new MobileCommands(f.session, f.store), entry = (await restarted.pending())[0]!;
    await expect(restarted.forgetAbsent(entry)).rejects.toMatchObject({ code: "mobile_command_unavailable" });
    await expect(restarted.recover(entry)).rejects.toMatchObject({ status: 404 }); expect(restarted.canRetry(entry)).toBe(false);
    const sends = f.posts; await restarted.forgetAbsent(entry); expect(await restarted.pending()).toEqual([]); expect(f.posts).toBe(sends);
  } finally { await f.m.close(); }
});

test("native duplicate Send and process-loss recovery retain one owning admission without persisted command bytes", async () => {
  const f = await fixture();
  try {
    const bytes = new TextEncoder().encode("Controlled attached source"), sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const upload = await f.session.perform((client, signal) => client.createUpload({ requestId: "native_input_once", conversationId: "native_commands", name: "input.txt", bytes: bytes.length, sha256 }, signal));
    await f.session.perform((client, signal) => client.uploadBytes(upload.id, bytes, signal));
    f.m.f.script = [{ type: "tool_call", id: "native_read_once", name: "file_read", arguments: { id: upload.id, offset: 0 } }, { type: "tool_call", id: "native_artifact_once", name: "file_create", arguments: { name: "native-proof.txt", text: "Committed native artifact bytes" } }];
    f.dropReply = true;
    const first = f.commands.send("native_commands", "Summarize these notes and create a downloadable Markdown brief.", [{ id: upload.id, sha256 }]);
    await expect(f.commands.send("native_commands", "A duplicate gesture must never become another command")).rejects.toMatchObject({ code: "mobile_command_busy" });
    await expect(first).rejects.toBeDefined(); await f.m.f.service.conversation.drain();
    expect(f.posts).toBe(1); expect(f.session.projection.phase).toBe("unavailable");
    const saved = [...f.records.entries()].filter(([key]) => key.includes("pending")); expect(saved).toHaveLength(1);
    expect(saved[0]![1]).not.toContain("Controlled attached source"); expect(saved[0]![1]).not.toContain("downloadable");
    f.session.background(); await f.session.restore();
    const restarted = new MobileCommands(f.session, f.store), pending = await restarted.pending(); expect(pending).toHaveLength(1);
    await expect(restarted.retry(pending[0]!.requestId)).rejects.toMatchObject({ code: "mobile_command_unavailable" });
    const calls = [...f.m.f.vmCalls], modelCalls = f.m.f.modelPrompts.length;
    const recovered = await restarted.recover(pending[0]!);
    expect(recovered.row.ownerMessage).toBe("Summarize these notes and create a downloadable Markdown brief.");
    expect(recovered.row.files?.artifacts).toHaveLength(1);
    const artifact = recovered.row.files!.artifacts[0]!;
    expect(new TextDecoder().decode(await f.session.perform((client, signal) => client.artifactBytes(artifact, signal)))).toBe("Committed native artifact bytes");
    expect(await restarted.pending()).toEqual([]); expect(f.posts).toBe(1); expect(f.m.f.vmCalls).toEqual(calls); expect(f.m.f.modelPrompts.length).toBe(modelCalls);
  } finally { await f.m.close(); }
});

test("native identity-store failure starts no work and a new session cannot reuse another binding's pending identity", async () => {
  const f = await fixture();
  try {
    f.failStorage = true;
    await expect(f.commands.send("native_commands", "Controlled private command")).rejects.toBeDefined(); expect(f.posts).toBe(0); expect(f.m.f.vmCalls).toEqual([]);
    f.failStorage = false; f.dropReply = true;
    await expect(f.commands.send("native_commands", "Controlled accepted private command")).rejects.toBeDefined();
    await f.session.restore(); const old = (await f.commands.pending())[0]!; expect(old).toBeDefined();
    await f.session.signIn(f.m.password); await f.session.selectConversation("native_commands");
    expect(await f.commands.pending()).toEqual([]);
    await expect(f.commands.recover(old)).rejects.toMatchObject({ code: "mobile_binding_changed" });
    await expect(f.commands.retry(old.requestId)).rejects.toMatchObject({ code: "mobile_binding_changed" }); expect(f.posts).toBe(1);
  } finally { await f.m.close(); }
});

test("active read-only refresh does not clear command CSRF while the owning bootstrap reply is held", async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    let held = true;
    f.m.intercept = async request => {
      if (held && new URL(request.url).pathname.endsWith("/bootstrap")) { const response = await f.m.f.service.fetch(request); entered.resolve(); await release.promise; return response; }
      return null;
    };
    const poll = f.session.poll(); await entered.promise; expect(f.session.poll()).toBe(poll);
    const receipt = await f.commands.send("native_commands", "Controlled command during active refresh");
    expect(receipt.conversationId).toBe("native_commands"); expect(f.posts).toBe(1);
    held = false; release.resolve(); await poll; expect(f.session.projection.phase).toBe("ready");
    expect(f.session.projection.snapshot?.conversation.rows.some(row => row.requestId === receipt.requestId)).toBe(true);
    f.m.intercept = request => new URL(request.url).pathname.endsWith("/bootstrap") ? Response.json({ error: "authentication_required" }, { status: 401 }) : null;
    await expect(f.session.poll()).rejects.toBeDefined(); expect(f.session.projection).toMatchObject({ phase: "locked", bootstrap: null, snapshot: null });
  } finally { release.resolve(); await f.m.close(); }
});
