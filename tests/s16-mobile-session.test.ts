import { expect, test } from "bun:test";
import { mobileFixture } from "./fixtures/s16-mobile";

async function conversations(m: Awaited<ReturnType<typeof mobileFixture>>) {
  await m.session.restore();
  for (const [id, text] of [["private_a", "Controlled private owner text A"], ["private_b", "Controlled private owner text B"]] as const) {
    // A model-only success is correctly withheld by the service. The private owner message itself is the projection
    // under test; this fixture makes no claim that an unevidenced model result was published.
    m.f.script = [{ type: "text", text: "No verified tool result" }]; await m.session.perform((client, signal) => client.send(client.prepareMessage(id, "Run the requested work. " + text), signal)); await m.f.service.conversation.drain();
  }
  await m.session.selectConversation("private_a");
}
// Fresh bootstrap navigation may legitimately include both conversations. The target snapshot must contain only
// the selected conversation; loading/background assertions independently require bootstrap and snapshot to be null.
const privateText = (m: Awaited<ReturnType<typeof mobileFixture>>) => JSON.stringify(m.session.projection.snapshot);

test("a retired service handle cannot reconnect, sign in/out or select a target through a stale callback", async () => {
  const m = await mobileFixture();
  try {
    await m.session.restore(); const credentials = [...m.records], before = m.session.selectionRevision; let requests = 0;
    m.intercept = () => { requests++; return null; }; m.session.retire(); m.session.retire(); m.session.background();
    expect(m.session.selectionRevision).toBe(before + 1);
    for (const operation of [() => m.session.restore(), () => m.session.foreground(), () => m.session.selectConversation("old_target"), () => m.session.signIn("controlled obsolete input"), () => m.session.signOut()]) await expect(operation()).rejects.toMatchObject({ code: "mobile_response_stale" });
    expect(requests).toBe(0); expect([...m.records]).toEqual(credentials); expect(m.session.projection).toMatchObject({ phase: "background", bootstrap: null, snapshot: null });
  } finally { await m.close(); }
});

test("mobile background/foreground withholds all private projections until fresh owning reads finish", async () => {
  const m = await mobileFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let hold = true;
  try {
    await conversations(m); expect(privateText(m)).toContain("Controlled private owner text A");
    m.session.background(); expect(m.session.projection).toMatchObject({ phase: "background", bootstrap: null, snapshot: null, conversationId: null }); expect(privateText(m)).not.toContain("Controlled private");
    m.intercept = async request => { if (hold && new URL(request.url).pathname.endsWith("/conversations/private_a")) { const result = await m.f.service.fetch(request); entered.resolve(); await release.promise; return result; } return null; };
    const pending = m.session.foreground(); await entered.promise;
    expect(m.session.projection).toMatchObject({ phase: "loading", bootstrap: null, snapshot: null }); expect(privateText(m)).not.toContain("Controlled private");
    hold = false; release.resolve(); await pending; expect(m.session.projection.phase).toBe("ready"); expect(privateText(m)).toContain("Controlled private owner text A");
  } finally { release.resolve(); await m.close(); }
});

test("mobile target switch and background fence a late old private response without reviving the view", async () => {
  const m = await mobileFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let hold = true;
  try {
    await conversations(m); const callsBeforeLifecycle = [...m.f.vmCalls];
    m.intercept = async request => { if (hold && new URL(request.url).pathname.endsWith("/conversations/private_b")) { const result = await m.f.service.fetch(request); entered.resolve(); await release.promise; return result; } return null; };
    const pending = m.session.selectConversation("private_b"); await entered.promise;
    expect(m.session.projection).toMatchObject({ phase: "loading", bootstrap: null, snapshot: null }); expect(privateText(m)).not.toContain("Controlled private owner text A");
    m.session.background(); await expect(pending).rejects.toBeDefined(); expect(m.session.projection.phase).toBe("background");
    hold = false; release.resolve(); await m.session.foreground();
    expect(m.session.projection).toMatchObject({ phase: "ready", conversationId: "private_b" }); expect(privateText(m)).toContain("Controlled private owner text B"); expect(privateText(m)).not.toContain("Controlled private owner text A");
    expect(m.f.vmCalls).toEqual(callsBeforeLifecycle);
  } finally { release.resolve(); await m.close(); }
});

test("an old explicit native operation cannot return its private value under the next target", async () => {
  const m = await mobileFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let hold = true;
  try {
    await conversations(m);
    m.intercept = async request => { if (hold && new URL(request.url).pathname.endsWith("/conversations/private_a")) { const result = await m.f.service.fetch(request); entered.resolve(); await release.promise; return result; } return null; };
    const old = m.session.perform((client, signal) => client.snapshot("private_a", signal)).then(value => ({ value, error: null }), error => ({ value: null, error })); await entered.promise;
    await m.session.selectConversation("private_b"); expect((await old).error).toBeDefined(); expect(m.session.projection.conversationId).toBe("private_b");
    hold = false; release.resolve(); expect(privateText(m)).not.toContain("Controlled private owner text A"); expect(privateText(m)).toContain("Controlled private owner text B");
  } finally { release.resolve(); await m.close(); }
});

test("native authentication loss synchronously removes private views and the retained device credential", async () => {
  const m = await mobileFixture();
  try {
    await conversations(m); m.intercept = request => new URL(request.url).pathname.endsWith("/conversations/private_a") ? Response.json({ error: "authentication_required" }, { status: 401 }) : null;
    await expect(m.session.perform((client, signal) => client.snapshot("private_a", signal))).rejects.toMatchObject({ status: 401 });
    expect(m.session.projection).toMatchObject({ phase: "locked", snapshot: null, bootstrap: null, conversationId: null }); expect(m.transport.authenticated).toBe(false); expect(m.records.size).toBe(0); expect(privateText(m)).not.toContain("Controlled private");
  } finally { await m.close(); }
});

test("validated cookie rotation with shared CSRF changes the native draft continuity marker", async () => {
  let original = "";
  const m = await mobileFixture(options => { const authenticate = options.owner.authenticate; return { ...options, owner: { ...options.owner, authenticate: token => authenticate(token === "fixture_rotated_mobile_session" ? original : token) } }; });
  original = m.f.ownerCookie.slice("jit_s14=".length);
  try {
    await conversations(m); const before = m.session.projection.authenticationRevision;
    m.session.background(); m.seed("fixture_rotated_mobile_session"); await m.session.restore();
    expect(m.session.projection.phase).toBe("ready"); expect(m.session.projection.authenticationRevision).toBeGreaterThan(before);
    await m.session.foreground(); expect(m.session.projection.authenticationRevision).toBe(before + 1);
  } finally { await m.close(); }
});

test("native binary upload uses the same owning identity with an ArrayBuffer-incompatible platform Request", async () => {
  const m = await mobileFixture(options => ({ ...options, files: {} })), original = globalThis.Request;
  try {
    await m.session.restore(); const bytes = new TextEncoder().encode("Controlled native picker file bytes"), sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const upload = await m.session.perform((client, signal) => client.createUpload({ requestId: "native_upload_once", conversationId: "conversation", name: "native.txt", bytes: bytes.byteLength, sha256 }, signal));
    globalThis.Request = new Proxy(original, { construct(target, args) {
      const init = args[1] as RequestInit | undefined;
      if (init?.body instanceof ArrayBuffer || ArrayBuffer.isView(init?.body)) throw Error("Legacy RN Request cannot construct an ArrayBuffer Blob");
      return Reflect.construct(target, args);
    } });
    const ready = await m.session.perform((client, signal) => client.uploadBytes(upload.id, bytes, signal));
    expect(ready).toMatchObject({ id: upload.id, state: "ready", bytes: bytes.byteLength, receipt: { id: upload.id, sha256, bytes: bytes.byteLength } });
    expect(m.f.service.files!.read(m.f.owner, "conversation", { id: upload.id, sha256 }).text).toBe(new TextDecoder().decode(bytes));
    expect((await m.session.perform((client, signal) => client.uploadStatus(upload.id, signal))).state).toBe("ready"); expect(m.f.vmCalls).toEqual([]);
  } finally { globalThis.Request = original; await m.close(); }
});
