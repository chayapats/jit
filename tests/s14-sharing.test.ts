import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { record, S14Application, type S14Options } from "../src/s14/application";
import { S14Store } from "../src/s14/store";
import type { ScopeRef, StartPayload } from "../src/s14/authority-types";
import type { Bot } from "../src/s14/types";
import type { CreateSnapshotShare, SnapshotTarget } from "../src/s14/sharing-types";
import { canonical } from "../src/s14/validation";
import { artifactHash } from "../src/s14/artifacts";
import { createS14Handler } from "../src/s14/web";

const roots: string[] = [], stores = new Set<S14Store>();
const rid = () => crypto.randomUUID().replaceAll("-", "");
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(tools: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "jit-s14-sharing-")); roots.push(root);
  const path = join(root, "app.sqlite"), store = new S14Store(path); stores.add(store);
  const clock = { now: 1800000000000 };
  const options: S14Options = { policy: { routes: [{ id: "selected", provider: "codex", model: "fixture" }], tools, resources: ["share1", "share2"] },
    now: () => clock.now, chat: { async reply() { return { text: "Chat" }; } } };
  const app = new S14Application(store, options); await app.provisionOwner("fixture-sharing-owner-password");
  const token = await app.login("fixture-sharing-owner-password"), actor = app.authenticate(token).actor;
  const setup = app.execute(actor, { kind: "setup", requestId: rid(), expectedRevision: 0, payload: { ownerName: "Owner", language: "en", routeId: "selected", capabilities: { tools, resources: [] } } });
  const conversationId = setup.conversation!.id;
  store.transaction(tx => {
    const bot = record<Bot>(tx, "bots", "jit"); bot.id = "receiver"; bot.capabilities.resources = ["share1", "share2"];
    tx.run("INSERT INTO bots VALUES (?,?)", bot.id, canonical(bot));
    bot.id = "third"; tx.run("INSERT INTO bots VALUES (?,?)", bot.id, canonical(bot));
  });
  const source = store.transaction(tx => app.memory.source(tx, { id: rid(), botId: "jit", conversationId, attribution: "owner", text: "Pinned private evidence", derived: [] }));
  const target: SnapshotTarget = { kind: "source", id: source.id, revision: 1, generation: 1 };
  const command = (changes: Partial<CreateSnapshotShare["payload"]> = {}): CreateSnapshotShare => ({ kind: "snapshot.share", requestId: rid(), expectedRevision: 1,
    payload: { scopeId: "share1", target, receiverBotId: "receiver", workId: null, expiresAt: clock.now + 60000, ...changes } });
  const start = (scopes: ScopeRef[] = [], botId = "receiver", changes: Partial<StartPayload> = {}) => app.execute(actor, { kind: "work.start", requestId: rid(), expectedRevision: app.conversation(actor, conversationId).conversation.revision,
    payload: { conversationId, task: null, title: "Read", purpose: "Read snapshot", completionRule: "Review", bots: [{ id: botId, revision: 1 }], tools: [], scopes,
      limits: { attempts: 8, steps: 8, calls: 8, outputBytes: 131072, concurrency: 2, reads: 40, wallMs: 60000 }, expiresAt: clock.now + 60000, ...changes } });
  const admit = (workId: string, scopes: ScopeRef[] = [], botId = "receiver") => app.authority.admit(workId, rid(), { botId, scopes, tools, input: "Read exact snapshot", calls: 2, outputBytes: 16384 });
  const ref: ScopeRef = { kind: "share", id: "share1", revision: 1 };
  return { root, path, store, options, app, actor, token, clock, source, target, command, start, admit, ref, conversationId };
}

test("owner share exposes one pinned copy only to its exact receiver and explicit work grant", async () => {
  const f = await fixture(), c = f.command(), receipt = f.app.execute(f.actor, c);
  expect(f.app.execute(f.actor, c)).toEqual(receipt);
  expect(() => f.app.execute({ ownerId: "owner" }, c)).toThrow("authentication_required");
  expect(() => f.app.execute(f.actor, { ...c, payload: { ...c.payload, receiverBotId: "third" } })).toThrow("request_id_conflict");
  expect(() => f.app.execute(f.actor, { ...f.command(), expectedRevision: 2 })).toThrow("stale_revision");
  expect(() => f.start([f.ref], "third")).toThrow("scope_not_allowed");
  expect(() => f.start([{ ...f.ref, revision: 2 }])).toThrow("scope_revoked_or_stale");
  const ungranted = f.start(), absent = f.admit(ungranted.work!.id);
  expect(f.store.read(tx => f.app.sharing.context(tx, absent))).toEqual([]);
  f.app.authority.settle(absent.id);
  const work = f.start([f.ref]), attempt = f.admit(work.work!.id, [f.ref]);
  expect(f.store.read(tx => f.app.sharing.context(tx, attempt))[0]!.content).toBe("Pinned private evidence");
  const changed = f.store.transaction(tx => f.app.memory.source(tx, { ...f.source, id: rid(), text: "Later edits", derived: [] }));
  expect(changed.id).not.toBe(f.source.id);
  expect(f.store.read(tx => f.app.sharing.context(tx, attempt))[0]!.share.target).toEqual(f.target);
  expect(() => f.app.execute(f.actor, f.command({ target: { ...f.target, revision: 2 }, scopeId: "share2" }))).toThrow("snapshot_unavailable");
  expect(() => f.app.execute(f.actor, f.command({ target: { ...f.target, id: "../../profile/cookies" }, scopeId: "share2" }))).toThrow("invalid_identity");
});

test("work scope, expiry and receiver resource ceiling cannot be widened by sharing", async () => {
  const f = await fixture(), other = f.start();
  f.app.execute(f.actor, f.command({ workId: other.work!.id }));
  expect(() => f.start([f.ref])).toThrow("scope_not_allowed");
  expect(() => f.app.execute(f.actor, f.command({ scopeId: "unconfigured" }))).toThrow("snapshot_scope_denied");
  expect(() => f.app.execute(f.actor, f.command({ scopeId: "share2", receiverBotId: "jit" }))).toThrow("snapshot_scope_denied");
  f.clock.now += 60001;
  expect(f.app.sharing.list(f.actor)[0]!.state).toBe("expired");
  expect(() => f.start([f.ref])).toThrow("scope_revoked_or_stale");
});

test.each(["read", "context", "commit"])("revoke fences %s and late results, preserving honest disclosure metadata", async phase => {
  const f = await fixture(); f.app.execute(f.actor, f.command());
  const work = f.start([f.ref]), attempt = f.admit(work.work!.id, [f.ref]);
  const packet = f.store.read(tx => f.app.memory.attemptPacket(tx, attempt.id));
  if (phase !== "read") expect(f.store.read(tx => f.app.sharing.context(tx, attempt))).toHaveLength(1);
  f.app.execute(f.actor, { kind: "snapshot.revoke", requestId: rid(), expectedRevision: 1, payload: { shareId: "share1" } });
  expect(() => f.store.read(tx => f.app.sharing.context(tx, attempt))).toThrow();
  expect(f.app.memory.context(f.actor, packet.id).state).toBe("retired");
  expect(() => f.app.authority.commit(attempt.id, { state: "ready", text: "Late private result" })).toThrow();
  expect(f.app.sharing.list(f.actor)[0]).toMatchObject({ state: "revoked", disclosedKnowledge: "cannot_recall" });
});

test("derived shared output cannot be forwarded or enter an ungranted third-Bot handoff", async () => {
  const f = await fixture(); f.app.execute(f.actor, f.command());
  const work = f.start([f.ref]), attempt = f.admit(work.work!.id, [f.ref]);
  f.app.authority.commit(attempt.id, { state: "ready", text: "Derived snapshot" });
  const result = { id: `result_${attempt.id}`, revision: 1, generation: 1 };
  expect(() => f.app.execute(f.actor, f.command({ scopeId: "share2", receiverBotId: "third", target: { kind: "source", ...result } }))).toThrow("snapshot_forward_refused");
  const other = f.start([], "third"), receiver = f.admit(other.work!.id, [], "third");
  expect(f.store.read(tx => f.app.memory.handoff(tx, result, receiver))).toBe(false);
});

test("revocation survives stale application restore and withhold descendants", async () => {
  const f = await fixture(); f.app.execute(f.actor, f.command());
  const work = f.start([f.ref]), attempt = f.admit(work.work!.id, [f.ref]);
  f.app.authority.commit(attempt.id, { state: "ready", text: "Derived output" });
  const backup = join(f.root, "image.sqlite"); copyFileSync(f.path, backup);
  f.app.execute(f.actor, { kind: "snapshot.revoke", requestId: rid(), expectedRevision: 1, payload: { shareId: "share1" } });
  f.store.close(); stores.delete(f.store); copyFileSync(backup, f.path);
  const store = new S14Store(f.path); stores.add(store); const app = new S14Application(store, f.options), actor = app.authenticate(f.token).actor;
  expect(app.sharing.list(actor)[0]!.state).toBe("revoked");
  expect(app.authority.view(actor, work.work!.id).results).toEqual([]);
  expect(store.read(tx => tx.get<{ content: unknown }>("SELECT content FROM snapshot_shares")!.content)).toBeNull();
});

test("artifact sharing uses exact common gateway hash/type/size checks and never accepts a path or profile", async () => {
  const f = await fixture(), work = f.start([], "jit"), a = f.admit(work.work!.id, [], "jit");
  const bytes = new TextEncoder().encode("Only this file");
  const stage = f.store.transaction(tx => f.app.artifacts.stage(tx, a, { name: "file.txt", mediaType: "text/plain", size: bytes.length, sha256: artifactHash(bytes) }, bytes));
  f.app.authority.commit(a.id, { state: "ready", text: "Review", report: { title: "Report", claims: [{ id: "claim", text: "Unverified", kind: "inference", citations: [], covers: [], conflicts: [] }], missing: [], limitations: ["Unverified"], artifactIds: [stage.id] } });
  const target: SnapshotTarget = { kind: "artifact", id: stage.id, revision: 1, generation: 1 };
  const shared = f.app.execute(f.actor, f.command({ target }));
  expect(shared.share.sha256).toBe(artifactHash(bytes));
  expect(() => f.app.execute(f.actor, f.command({ scopeId: "share2", target: { ...target, kind: "profile" as "artifact" } }))).toThrow("snapshot_type_refused");
  f.store.transaction(tx => tx.run("UPDATE snapshot_shares SET content=? WHERE id='share1'", new TextEncoder().encode("Corrupt copy")));
  const next = f.start([f.ref]), receiver = f.admit(next.work!.id, [f.ref]);
  expect(() => f.store.read(tx => f.app.sharing.context(tx, receiver))).toThrow("artifact_integrity_mismatch");
});

test("share queries and commands retain the authenticated HTTP/CSRF boundary", async () => {
  const f = await fixture(), handler = createS14Handler(f.app, "http://localhost:3001");
  expect((await handler(new Request("http://localhost:3001/api/s14/shares"))).status).toBe(401);
  const headers = { cookie: `jit_s14=${f.token}`, origin: "http://localhost:3001", "content-type": "application/json" };
  expect((await handler(new Request("http://localhost:3001/api/s14/commands", { method: "POST", headers, body: JSON.stringify(f.command()) }))).status).toBe(403);
});

test("source withdrawal and deletion remove copied bytes and fence already-disclosed lineage", async () => {
  const f = await fixture();
  const remembered = f.app.execute(f.actor, { kind: "memory.remember", requestId: rid(), expectedRevision: f.app.conversation(f.actor, f.conversationId).conversation.revision,
    payload: { conversationId: f.conversationId, text: "Delete this source" } });
  const claim = f.app.memory.claim(f.actor, "jit", remembered.claim!).claim;
  if (claim.state !== "available") throw Error("fixture claim unavailable");
  f.app.execute(f.actor, f.command({ target: { kind: "source", ...claim.claim.source } }));
  const work = f.start([f.ref]), attempt = f.admit(work.work!.id, [f.ref]);
  const barrier = Promise.withResolvers<void>();
  const late = (async () => { await barrier.promise; return f.store.read(tx => f.app.sharing.context(tx, attempt)); })();
  f.app.execute(f.actor, { kind: "memory.delete", requestId: rid(), expectedRevision: 1, payload: { claim: remembered.claim! } });
  barrier.resolve(); await expect(late).rejects.toThrow();
  expect(f.app.sharing.list(f.actor)[0]!.state).toBe("unavailable");
  expect(f.store.read(tx => tx.get<{ content: unknown }>("SELECT content FROM snapshot_shares")!.content)).toBeNull();
});

test("shared bytes join the outbound privacy guard and never become permission to disclose another Bot's content", async () => {
  const f = await fixture(["web_search"]);
  const secret = "This confidential receiver snapshot contains private owner-only business planning details";
  const source = f.store.transaction(tx => f.app.memory.source(tx, { id: rid(), botId: "jit", conversationId: f.conversationId, attribution: "owner", text: secret, derived: [] }));
  f.app.execute(f.actor, f.command({ target: { kind: "source", id: source.id, revision: 1, generation: 1 } }));
  const work = f.start([f.ref], "receiver", { tools: ["web_search"] }), attempt = f.admit(work.work!.id, [f.ref]);
  let outbound = 0; f.app.parallel.options.transport = async () => { outbound++; throw Error("No live transport in fixture"); };
  const read = await f.app.parallel.read(attempt.id, "web_search", { query: secret });
  expect(read.outcome).toBe("private_context"); expect(read.dispatched).toBe(false); expect(outbound).toBe(0);
});


test("unknown snapshot command names cannot alias owner share creation", async () => {
  const f = await fixture();
  const command = { ...f.command(), kind: "snapshot.untrusted" } as unknown as CreateSnapshotShare;
  expect(() => f.app.execute(f.actor, command)).toThrow("unknown_command");
  expect(f.app.sharing.list(f.actor)).toEqual([]);
});
