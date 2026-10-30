import { runMaxTurns } from "../src/exec/run-tools";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HostCredentialStore, HostImageProbeRecord, Model, ModelRequest } from "schway/host";
import { Application } from "../src/application";
import { readImageProbes } from "../src/attachments/image-probes";
import { prepareModelImages } from "../src/attachments/model-images";
import { retireAttachments } from "../src/attachments/lifecycle";
import { SchwayRunPort, SCHWAY_PINNED_REVISION } from "../src/team/schway-port";
import { createWebHandler } from "../src/web";
import { runImageProbe } from "../src/evidence/image-probe";
import { uploadText, sendFiles } from "./fixtures/attachment-run";
import { answer, effectFixture, rid, settle, type EffectFixture } from "./fixtures/effects";
import type { RunScript } from "../src/team/scripted-port";

const worlds: EffectFixture[] = [];
afterEach(async () => { for (const f of worlds.splice(0)) { await f.close(); rmSync(f.root, { force: true, recursive: true }); rmSync(dirname(f.box.root), { force: true, recursive: true }); } });
async function world(script?: RunScript) {
  const f = await effectFixture({ ...(script ? { script } : {}), env: { JIT_JOB_CONTEXT_TOKENS: "256000" } }); worlds.push(f);
  f.app.execute(f.auth.actor, { kind: "web.settings.set", requestId: rid(), projectId: f.project.id, expectedRevision: 0, payload: { enabled: false } });
  return f;
}
function evidence(f: EffectFixture, patch: Partial<HostImageProbeRecord> = {}) {
  const record: HostImageProbeRecord = { contract: "schway.host.image-input/v1", route: "grok", model: "fixture-grok-exact", revision: SCHWAY_PINNED_REVISION,
    testedAt: new Date(f.clock.now).toISOString(), verdict: "pass", ...patch };
  const id = rid(); f.store.transaction(tx => {
    tx.run("INSERT INTO command_receipts VALUES ('owner', ?, 'fixture', ?, ?)", id, JSON.stringify({ imageProbe: { state: "complete", record } }), f.clock.now);
    tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', 'attachments.image_probe', ?, 'owner', ?)", id, f.clock.now);
  });
}
async function image(f: EffectFixture, format: "png" | "jpeg" = "png") {
  const original = await uploadText(f, "ORIGINAL_UNSANITIZED_IMAGE_SENTINEL_196", "original.txt");
  const bytes = readFileSync(new URL(`../src/evidence/fixtures/image-probe.${format}`, import.meta.url));
  const hash = createHash("sha256").update(bytes).digest("hex"), path = join(f.state, "attachments", f.project.id, hash.slice(0, 2), hash);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, bytes, { mode: 0o600 });
  f.store.transaction(tx => tx.run(`UPDATE attachments SET kind = 'image', media_type = 'image/webp', sanitized_by = 'container', clean_media_type = ?,
    model_sha256 = ?, model_bytes = ?, state = 'ready' WHERE id = ?`, `image/${format}`, hash, bytes.length, original.id));
  return { id: original.id, bytes, path, hash };
}
function model(captures: ModelRequest[], text = "seen"): Model {
  return { provider: "scripted", id: "fixture-grok-exact", async *stream(request) {
    captures.push(request);
    yield { type: "message_complete", message: { type: "assistant", id: rid(), content: [{ type: "text", text }] } };
  } };
}

for (const format of ["png", "jpeg"] as const)
test(`only the live sanitized ${format} model derivative reaches the native model; persistence holds references`, async () => {
  const captures: ModelRequest[] = []; let outcome: unknown, snapshot: unknown, seenRequest: unknown;
  const f = await world(async request => {
    const port = new SchwayRunPort(f.store, f.config.team, f.config.jobs.outputBytes, { model: model(captures), now: () => f.clock.now });
    outcome = await port.invoke(request, new AbortController().signal, () => {});
    snapshot = await port.snapshot(request.context); seenRequest = port.requests;
    return answer(request, "done");
  });
  const file = await image(f, format); evidence(f); sendFiles(f, [file.id]); await settle(f);
  expect(outcome).toMatchObject({ state: "complete" }); expect(captures).toHaveLength(1);
  const part = captures[0]!.items.flatMap(item => item.type === "user" ? item.content : []).find(item => item.type === "image");
  expect(part).toMatchObject({ type: "image", mediaType: `image/${format}`, sha256: file.hash, byteLength: file.bytes.length });
  expect(part && "width" in part && part.width).toBeLessThanOrEqual(2048);
  expect(Buffer.from(captures[0]!.imageData!.get(file.hash)!)).toEqual(file.bytes);
  const audits = f.store.read(tx => tx.all<{ route: string; bytes: number; detail: string }>("SELECT route, bytes, detail_json AS detail FROM attachment_events WHERE kind = 'send_model' AND attachment_id = ?", file.id));
  expect(audits).toEqual([{ route: "grok/fixture-grok-exact", bytes: file.bytes.length, detail: '{"part":"image"}' }]);
  for (const value of [snapshot, seenRequest]) {
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain(file.bytes.toString("base64")); expect(serialized).not.toContain('"imageData"');
    expect(serialized).not.toContain(JSON.stringify([...file.bytes]));
  }
  const scan = (path: string) => { for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === "attachments") continue; const child = join(path, entry.name);
    if (entry.isDirectory()) scan(child); else if (entry.isFile()) {
      const persisted = readFileSync(child); expect(persisted.includes(file.bytes)).toBe(false);
      expect(persisted.includes(Buffer.from(file.bytes.toString("base64")))).toBe(false);
    }
  } }; scan(f.state);
});

for (const gate of ["none", "unsupported", "inconclusive", "route", "model", "revision", "malformed", "fallback", "webp"] as const)
test(`image bytes never enter the model with ${gate} evidence or derivative`, async () => {
  const captures: ModelRequest[] = []; let outcome: unknown;
  const f = await world(async request => {
    const port = new SchwayRunPort(f.store, f.config.team, f.config.jobs.outputBytes, { model: model(captures) });
    outcome = await port.invoke(request, new AbortController().signal, () => {}); return answer(request, "done");
  });
  const file = await image(f);
  if (gate !== "none") evidence(f, gate === "unsupported" || gate === "inconclusive" ? { verdict: gate } : gate === "route" ? { route: "codex" } : gate === "model" ? { model: "other-model" } : gate === "revision" ? { revision: "other-pin" } : gate === "malformed" ? { testedAt: "bad-date" } : {});
  if (gate === "fallback") f.store.transaction(tx => tx.run("UPDATE attachments SET sanitized_by = 'fallback' WHERE id = ?", file.id));
  if (gate === "webp") f.store.transaction(tx => tx.run("UPDATE attachments SET clean_media_type = 'image/webp' WHERE id = ?", file.id));
  // Unsupported routes must not even open the model blob.
  rmSync(file.path);
  sendFiles(f, [file.id]); await settle(f);
  expect(outcome).toMatchObject({ state: "complete" }); expect(captures).toHaveLength(1);
  expect(captures[0]!.imageData?.size ?? 0).toBe(0);
  expect(captures[0]!.items.flatMap(item => item.type === "user" ? item.content : []).some(part => part.type === "image")).toBe(false);
  expect(JSON.stringify(captures[0]!.context)).toContain("can't see images yet");
  expect(f.store.read(tx => tx.all("SELECT 1 FROM attachment_events WHERE kind = 'send_model' AND attachment_id = ?", file.id))).toHaveLength(0);
});

for (const fault of ["deleted", "job", "owner", "context", "halt", "corrupt", "missing", "replacement", "signal", "probe"] as const)
test(`resolver rechecks ${fault} at send time and emits no late bytes`, async () => {
  let first: Uint8Array | null | undefined, second: Uint8Array | null | undefined, sends = 0;
  const f = await world(async request => {
    const prepared = prepareModelImages(f.store, request, SCHWAY_PINNED_REVISION, () => f.clock.now);
    first = await prepared.options.resolve(prepared.images[0]!);
    if (fault === "deleted") f.store.transaction(tx => retireAttachments(tx, request.projectId, [request.attachments![0]!.attachmentId], "delete", f.clock.now));
    if (fault === "job") f.store.transaction(tx => tx.run("UPDATE job_authority SET generation = generation + 1 WHERE job_id = ?", request.fence.jobId));
    if (fault === "owner") f.store.transaction(tx => tx.run("UPDATE owner SET generation = generation + 1"));
    if (fault === "context") f.store.transaction(tx => tx.run("UPDATE team_contexts SET state = 'retired' WHERE id = ?", request.context.id));
    if (fault === "halt") f.store.transaction(tx => tx.run("INSERT INTO execution_halts (project_id, revision, halted, channel, reason, created_at) VALUES (?, 1, 1, 'web', 'fixture', ?)", f.project.id, f.clock.now));
    if (fault === "corrupt") writeFileSync(file.path, Buffer.alloc(file.bytes.length), { mode: 0o600 });
    if (fault === "missing") rmSync(file.path);
    if (fault === "probe") evidence(f, { verdict: "unsupported" });
    if (fault === "replacement") f.store.transaction(tx => tx.run("UPDATE attachments SET model_sha256 = ? WHERE id = ?", "a".repeat(64), file.id));
    second = await prepared.options.resolve(prepared.images[0]!, fault === "signal" ? AbortSignal.abort() : undefined);
    if (!["signal", "corrupt", "missing"].includes(fault)) {
      try { await prepared.guardSend(async () => { sends++; return new Response(); }); } catch { /* Expected live fence refusal. */ }
    }
    return answer(request, "done");
  });
  const file = await image(f); evidence(f); sendFiles(f, [file.id]); await settle(f);
  expect(first && Buffer.from(first)).toEqual(file.bytes); expect(second).toBeNull(); expect(sends).toBe(0);
  expect(f.store.read(tx => tx.all("SELECT 1 FROM attachment_events WHERE kind = 'send_model' AND attachment_id = ?", file.id))).toHaveLength(1);
});

for (const fault of ["hash", "size", "dimensions"] as const)
test(`invalid ${fault} model derivative fails closed before model invocation`, async () => {
  const captures: ModelRequest[] = []; let outcome: unknown;
  const f = await world(async request => {
    const port = new SchwayRunPort(f.store, f.config.team, f.config.jobs.outputBytes, { model: model(captures) });
    outcome = await port.invoke(request, new AbortController().signal, () => {}); return answer(request, "done");
  });
  const file = await image(f); evidence(f);
  if (fault === "hash") writeFileSync(file.path, Buffer.alloc(file.bytes.length));
  if (fault === "size") f.store.transaction(tx => tx.run("UPDATE attachments SET model_bytes = 10485761 WHERE id = ?", file.id));
  if (fault === "dimensions") { const bytes = Buffer.from(file.bytes); bytes.writeUInt32BE(2049, 16); writeFileSync(file.path, bytes); }
  sendFiles(f, [file.id]); await settle(f); expect(outcome).toMatchObject({ reason: "images_unavailable" }); expect(captures).toHaveLength(0);
});

for (const correct of [true, false])
test(`explicit public-host probe checks both formats and replay (${correct})`, async () => {
  const f = await world(), captures: ModelRequest[] = [];
  const fixture: Model = { provider: "scripted", id: "fixture-grok-exact", async *stream(request) {
    captures.push(request); yield { type: "message_complete", message: { type: "assistant", id: rid(), content: [{ type: "text", text: correct ? captures.length === 1 ? "582731" : "914026" : "wrong" }] } };
  } };
  const { record } = await runImageProbe({ route: "grok", model: "fixture-grok-exact", revision: SCHWAY_PINNED_REVISION, databasePath: f.store.path,
    signal: new AbortController().signal, assertCurrent: () => {}, now: () => f.clock.now }, { model: fixture });
  expect(record.verdict).toBe(correct ? "pass" : "inconclusive");
  expect(captures).toHaveLength(correct ? 2 : 1);
  if (correct) expect(captures[1]!.items.flatMap(item => item.type === "user" ? item.content : []).filter(part => part.type === "image")).toHaveLength(2);
  expect(JSON.stringify(record)).not.toContain("582731");
});

test("Web probe requires session, Origin, CSRF and quota confirmation; receipt replay spends nothing", async () => {
  const f = await world(); let calls = 0;
  const app = new Application(f.store, f.config, { now: () => f.clock.now, imageProbe: { model: { provider: "scripted", id: "fixture-grok-exact", async *stream() {
    calls++; yield { type: "message_complete", message: { type: "assistant", id: rid(), content: [{ type: "text", text: calls === 1 ? "582731" : "914026" }] } };
  } } } });
  const token = await app.login("fixture-exe07-owner-password"), auth = app.authenticate(token), web = createWebHandler(app);
  const command = { requestId: rid(), projectId: null, expectedRevision: app.team(auth.actor).ownerRevision, provider: "grok" as const, model: "fixture-grok-exact", confirmed: true };
  const telegram = app.issueAdapterActor(token, "telegram");
  await expect(app.probeImages(telegram, command)).rejects.toMatchObject({ code: "channel_not_authorized" });
  const post = (body: unknown, headers: Record<string, string> = {}) => web(new Request(`${f.config.origin}/api/team/image-probe`, {
    method: "POST", headers: { host: new URL(f.config.origin).host, origin: f.config.origin, cookie: `jit_session=${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }));
  const body = { ...command, projectId: undefined, csrf: auth.csrf };
  expect((await post(body, { cookie: "" })).status).toBe(401);
  expect((await post(body, { origin: "https://other.invalid" })).status).toBe(403);
  expect((await post({ ...body, csrf: "bad" })).status).toBe(403);
  expect((await post({ ...body, confirmed: false })).status).toBe(400); expect(calls).toBe(0);
  const result = await post(body); expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ imageProbe: { state: "complete", record: { verdict: "pass", route: "grok", model: "fixture-grok-exact" } } });
  expect(calls).toBe(2); expect((await post(body)).status).toBe(200); expect(calls).toBe(2);
  expect(f.store.read(tx => readImageProbes(tx, SCHWAY_PINNED_REVISION))).toHaveLength(1);
  expect(app.imageProbeState(auth.actor).routes[0]!.passed).toBe(true);
  const page = await web(new Request(`${f.config.origin}/settings/team`, { headers: { host: new URL(f.config.origin).host, cookie: `jit_session=${token}` } }));
  const html = await page.text(); expect(html).toContain('name="confirmed"'); expect(html).toContain("fixture-grok-exact"); expect(calls).toBe(2);
  app.execute(auth.actor, { kind: "route.save", requestId: rid(), projectId: null, expectedRevision: app.team(auth.actor).ownerRevision, payload: { roleId: null, route: { provider: "codex", model: "other-model", authRoute: "codex" } } });
  expect(app.imageProbeState(auth.actor).routes.find(item => item.route.model === "other-model")!.passed).toBe(false);
  await app.closeDeviceSignIns();
});

function sse(text: string): Response {
  const message = { id: "fixture-message", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
  return new Response([
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: text })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: message })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "fixture-response", object: "response", status: "completed", output: [message], usage: { input_tokens: 10, output_tokens: 5 } } })}\n\n`,
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}
for (const route of ["grok", "codex"] as const)
test(`${route} public subscription adapter emits input_image derivatives and probes both formats without live calls`, async () => {
  const wire: any[] = []; let outcome: unknown;
  const store = { get: async () => JSON.stringify({ accessToken: "fixture-image-access", expiresAt: Date.now() + 3600000, obtainedAt: Date.now() }), set: async () => {}, delete: async () => true };
  const f = await world(async request => {
    const port = new SchwayRunPort(f.store, f.config.team, f.config.jobs.outputBytes, { authStore: store,
      authFetch: async (_target, init) => { wire.push(JSON.parse(String(init?.body))); return sse("seen"); } });
    outcome = await port.invoke(request, new AbortController().signal, () => {}); return answer(request, "done");
  });
  if (route === "codex") f.app.execute(f.auth.actor, { kind: "route.save", requestId: rid(), projectId: f.project.id, expectedRevision: f.app.team(f.auth.actor, f.project.id).projectRevision,
    payload: { roleId: null, route: { provider: route, model: "fixture-grok-exact", authRoute: "owner-codex" } } });
  const file = await image(f); evidence(f, { route }); sendFiles(f, [file.id]); await settle(f);
  expect(outcome).toMatchObject({ state: "complete" }); expect(wire).toHaveLength(1);
  expect(JSON.stringify(wire[0])).toContain(`data:image/png;base64,${file.bytes.toString("base64")}`);
  expect(JSON.stringify(wire[0])).toContain('"type":"input_image"'); expect(wire[0].store).toBe(false);
  expect(JSON.stringify(wire[0])).not.toContain("ORIGINAL_UNSANITIZED_IMAGE_SENTINEL_196");
  wire.length = 0;
  const { record } = await runImageProbe({ route, model: "fixture-grok-exact", revision: SCHWAY_PINNED_REVISION, databasePath: f.store.path, signal: new AbortController().signal, assertCurrent: () => {}, now: () => f.clock.now },
    { store, fetch: async (_target, init) => { wire.push(JSON.parse(String(init?.body))); return sse(wire.length === 1 ? "582731" : "914026"); } });
  expect(record.verdict).toBe("pass"); expect(wire).toHaveLength(2);
  expect(JSON.stringify(wire[1])).toContain("data:image/png;base64,"); expect(JSON.stringify(wire[1])).toContain("data:image/jpeg;base64,");
});

test("latest failed/running/corrupt evidence never revives an older passing record", async () => {
  const f = await world(); evidence(f); evidence(f, { verdict: "unsupported" });
  expect(f.app.imageProbeState(f.auth.actor).routes[0]!.passed).toBe(false);
  evidence(f); const latest = f.store.read(tx => tx.get<{ request_id: string }>("SELECT request_id FROM audit WHERE command_kind = 'attachments.image_probe' ORDER BY id DESC LIMIT 1")!);
  for (const state of ["running", "failed", "unknown"]) {
    f.store.transaction(tx => tx.run("UPDATE command_receipts SET result_json = json_set(result_json, '$.imageProbe.state', ?) WHERE request_id = ?", state, latest.request_id));
    expect(f.app.imageProbeState(f.auth.actor).routes[0]!.passed).toBe(false);
  }
  f.store.transaction(tx => tx.run("UPDATE command_receipts SET result_json = '{}' WHERE request_id = ?", latest.request_id));
  expect(f.store.read(tx => readImageProbes(tx, SCHWAY_PINNED_REVISION))).toEqual([]);
});

for (const change of ["route", "abort", "shutdown"] as const)
test(`probe ${change} during inference cannot commit a pass or send a second request`, async () => {
  const f = await world(), controller = new AbortController(); let calls = 0;
  const app = new Application(f.store, f.config, { now: () => f.clock.now, imageProbe: { model: { provider: "scripted", id: "fixture-grok-exact", async *stream() {
    calls++;
    if (change === "abort") controller.abort();
    if (change === "shutdown") void app.closeDeviceSignIns();
    if (change === "route") app.execute(auth.actor, { kind: "route.save", requestId: rid(), projectId: null, expectedRevision: app.team(auth.actor).ownerRevision,
      payload: { roleId: null, route: { provider: "codex", model: "new-model", authRoute: "codex" } } });
    yield { type: "message_complete", message: { type: "assistant", id: rid(), content: [{ type: "text", text: "582731" }] } };
  } } } });
  const token = await app.login("fixture-exe07-owner-password"), auth = app.authenticate(token);
  const result = await app.probeImages(auth.actor, { requestId: rid(), projectId: null, expectedRevision: app.team(auth.actor).ownerRevision, provider: "grok", model: "fixture-grok-exact", confirmed: true }, controller.signal);
  expect(result.imageProbe.record.verdict).toBe("inconclusive"); expect(calls).toBe(1);
  expect(app.imageProbeState(auth.actor).routes.every(row => !row.passed)).toBe(true);
  await app.closeDeviceSignIns();
});

test("image refusal reasons reach the owner reply card and stream in both languages", async () => {
  const { replyLabels } = await import("../src/web-layout"), { withLocale, dictionaries } = await import("../src/i18n");
  for (const locale of ["th", "en"] as const) for (const reason of ["images_unsupported", "images_unavailable"] as const) {
    expect(withLocale(locale, () => replyLabels({ state: "failed", nextAction: "send_again", reason })).next).toBe(dictionaries[locale][`team_card.reason.${reason}`]);
  }
});

for (const count of [5, 6])
test(`${count} inline images respect Schway's five-image bound without silent omission`, async () => {
  let turns = 0;
  const captures: ModelRequest[] = []; let outcome: unknown;
  const f = await world(async request => {
    turns = runMaxTurns(request);
    const port = new SchwayRunPort(f.store, f.config.team, f.config.jobs.outputBytes, { model: model(captures) });
    outcome = await port.invoke(request, new AbortController().signal, () => {}); return answer(request, "done");
  });
  f.config.attachments.messageFiles = 6;
  const files = []; for (let n = 0; n < count; n++) files.push(await image(f));
  evidence(f); sendFiles(f, files.map(file => file.id)); await settle(f);
  expect(outcome).toMatchObject({ reason: count === 5 ? "complete" : "images_unavailable" });
  expect(captures).toHaveLength(count === 5 ? 1 : 0);
  if (count === 5) expect(turns).toBe(1);
  if (count === 5) expect(captures[0]!.items.flatMap(item => item.type === "user" ? item.content : []).filter(part => part.type === "image")).toHaveLength(5);
  expect(f.store.read(tx => tx.all("SELECT 1 FROM attachment_events WHERE kind = 'send_model'"))).toHaveLength(count === 5 ? 5 : 0);
});

/** Probe-owned deadline only: native timers never need to elapse in these fixtures. */
class ProbeClock {
  now = 0;
  pending = new Map<unknown, { at: number; callback: () => void }>();
  timers = {
    set: (callback: () => void, ms: number) => { const id = {}; this.pending.set(id, { at: this.now + ms, callback }); return id; },
    clear: (id: unknown) => { this.pending.delete(id); },
  };
  advance(ms: number) {
    this.now += ms;
    for (const [id, timer] of this.pending) if (timer.at <= this.now) { this.pending.delete(id); timer.callback(); }
  }
}
const probeDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};

for (const route of ["grok", "codex"] as const)
for (const scenario of ["never-ending", "oversized", "cumulative", "retry", "refresh-rejected", "mid-probe-refresh", ...(route === "grok" ? ["refresh-pressure" as const] : [])] as const)
test(`${route} probe bounds: ${scenario} stops without durable passing evidence`, async () => {
  const f = await world(), clock = new ProbeClock(), reading = probeDeferred();
  let inference = 0, tokens = 0, writes = 0, cancelled = 0, pulls = 0, responseBytes = 0;
  let transportSignal: AbortSignal | undefined;
  const inferenceBodies: string[] = [];
  let credential = JSON.stringify({ accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: 4_000_000_000_000, obtainedAt: 0 });
  const store: HostCredentialStore = { get: async () => credential, set: async (_key, value) => { writes++; credential = value; }, delete: async () => true };
  const app = new Application(f.store, f.config, { now: () => f.clock.now + clock.now, imageProbe: { store, timers: clock.timers,
    fetch: async (target, init) => {
      transportSignal = init?.signal ?? undefined;
      if (String(target).toLowerCase().includes("token")) {
        tokens++;
        if (scenario === "refresh-rejected") return new Response('{}', { status: 401 });
        return Response.json({ access_token: "fixture-renewed", refresh_token: "fixture-refresh", expires_in: scenario === "refresh-pressure" ? -1 : 3600 });
      }
      inference++; inferenceBodies.push(String(init?.body));
      if (scenario === "refresh-pressure") return new Response('{}', { status: 401 });
      if (scenario === "retry") return new Response('{}', { status: 503 });
      if (scenario === "refresh-rejected") return new Response('{}', { status: 401 });
      if (scenario === "never-ending") return new Response(new ReadableStream<Uint8Array>({
        pull() { pulls++; reading.resolve(); return new Promise<void>(() => {}); },
        cancel() { cancelled++; },
      }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
      if (scenario === "oversized") return new Response(new ReadableStream<Uint8Array>({
        pull(controller) { pulls++; const chunk = new TextEncoder().encode(`: ${"x".repeat(65530)}\n\n`); responseBytes += chunk.length; controller.enqueue(chunk); },
        cancel() { cancelled++; },
      }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
      if (scenario === "mid-probe-refresh" && inference === 1) {
        // The first successful image expires the credential before native replay.
        credential = JSON.stringify({ accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: 1, obtainedAt: 0 });
        return sse("582731");
      }
      if (scenario === "mid-probe-refresh") return new Response('{}', { status: 503 });
      const response = sse(inference === 1 ? "582731" : "914026");
      const bytes = new TextEncoder().encode(`: ${"x".repeat(140 * 1024)}\n\n${await response.text()}`);
      responseBytes += bytes.length;
      return new Response(bytes, { headers: { "content-type": "text/event-stream" } });
    },
  } });
  try {
    const token = await app.login("fixture-exe07-owner-password"), auth = app.authenticate(token);
    if (route === "codex") app.execute(auth.actor, { kind: "route.save", requestId: rid(), projectId: null,
      expectedRevision: app.team(auth.actor).ownerRevision, payload: { roleId: null, route: { provider: route, model: "fixture-grok-exact", authRoute: "owner-codex" } } });
    if (scenario === "refresh-rejected" || scenario === "refresh-pressure") credential = JSON.stringify({ accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: 1, obtainedAt: 0 });
    const command = { requestId: rid(), projectId: null, expectedRevision: app.team(auth.actor).ownerRevision, provider: route, model: "fixture-grok-exact", confirmed: true as const };
    let settled = false;
    const pending = app.probeImages(auth.actor, command).then(result => { settled = true; return result; });
    if (scenario === "never-ending") {
      await reading.promise;
      clock.advance(119_999); await Promise.resolve();
      expect(settled).toBe(false); expect(transportSignal?.aborted).toBe(false);
      clock.advance(1);
    }
    const result = await pending;
    expect(result.imageProbe).toMatchObject({ state: "failed", record: { verdict: "inconclusive" } });
    expect(inference).toBeLessThanOrEqual(4); expect(tokens).toBeLessThanOrEqual(4);
    // One initial PNG submission and one JPEG submission with PNG replay; retries reuse each body.
    expect(new Set(inferenceBodies).size).toBeLessThanOrEqual(2);
    expect(inferenceBodies.filter(body => body.includes("data:image/jpeg;base64,")).length).toBeLessThanOrEqual(2);
    expect(app.imageProbeState(auth.actor).routes.every(row => !row.passed)).toBe(true);
    const records = f.store.read(tx => tx.all<{ result_json: string }>("SELECT result_json FROM command_receipts WHERE request_id = ?", command.requestId));
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0]!.result_json).imageProbe).toEqual(result.imageProbe);
    expect(f.store.read(tx => readImageProbes(tx, SCHWAY_PINNED_REVISION)).every(record => record.verdict !== "pass")).toBe(true);
    // Replaying the confirmed command cannot spend quota again.
    const counts = [inference, tokens];
    expect(await app.probeImages(auth.actor, command)).toEqual(result);
    expect([inference, tokens]).toEqual(counts);
    expect(clock.pending.size).toBe(0);
    if (scenario === "never-ending") { expect(clock.now).toBe(120_000); expect(inference).toBe(1); expect(cancelled).toBe(1); expect(transportSignal?.aborted).toBe(true); }
    if (scenario === "oversized") { expect(inference).toBe(1); expect(pulls).toBe(5); expect(cancelled).toBe(1); expect(responseBytes).toBeGreaterThan(256 * 1024); }
    if (scenario === "cumulative") { expect(inference).toBe(2); expect(responseBytes).toBeGreaterThan(256 * 1024); }
    if (scenario === "retry") expect(inference).toBe(1);
    if (scenario === "refresh-pressure") { expect(inference).toBe(1); expect(tokens).toBe(1); expect(writes).toBe(1); expect(result.imageProbe.reason).toBe("sign_in"); }
    if (scenario === "refresh-rejected") { expect(tokens).toBe(1); expect(inference).toBe(0); expect(writes).toBe(0); }
    if (scenario === "mid-probe-refresh") { expect(inference).toBe(2); expect(tokens).toBe(1); expect(writes).toBe(1); }
  } finally { await app.closeDeviceSignIns(); }
});

for (const route of ["grok", "codex"] as const)
for (const [endpoint, status, reason] of [
  ["inference", 403, "plan_or_credits"], ["inference", 401, "sign_in"], ["inference", 429, "quota"],
  ["inference", 400, null], ["inference", 404, null], ["inference", 415, null], ["inference", 422, null],
  ["token", 400, "sign_in"], ["token", 401, "sign_in"],
] as const)
test(`${route} ${endpoint} ${status} stores only a closed refusal reason and stops sends`, async () => {
  const f = await world(); let inference = 0, tokens = 0;
  const providerText = "personal-team-blocked:spending-limit PROVIDER_PRIVATE_ERROR_SENTINEL";
  const store: HostCredentialStore = { get: async () => JSON.stringify({ accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: endpoint === "token" ? 1 : 4_000_000_000_000, obtainedAt: 0 }), set: async () => {}, delete: async () => true };
  const app = new Application(f.store, f.config, { now: () => f.clock.now, imageProbe: { store, fetch: async target => {
    if (String(target).toLowerCase().includes("token")) tokens++; else inference++;
    return Response.json({ code: providerText, error: providerText }, { status });
  } } });
  try {
    const token = await app.login("fixture-exe07-owner-password"), auth = app.authenticate(token);
    if (route === "codex") app.execute(auth.actor, { kind: "route.save", requestId: rid(), projectId: null,
      expectedRevision: app.team(auth.actor).ownerRevision, payload: { roleId: null, route: { provider: route, model: "fixture-grok-exact", authRoute: "owner-codex" } } });
    const command = { requestId: rid(), projectId: null, expectedRevision: app.team(auth.actor).ownerRevision, provider: route, model: "fixture-grok-exact", confirmed: true as const };
    const result = await app.probeImages(auth.actor, command);
    expect(result.imageProbe).toMatchObject({ state: "failed", reason, record: { verdict: reason ? "inconclusive" : "unsupported" } });
    expect([inference, tokens]).toEqual(endpoint === "token" ? [0, 1] : [1, 0]);
    expect(result.imageProbe.record).not.toHaveProperty("reason");
    const { imageProbeCards } = await import("../src/web-image-probes"), { withLocale, dictionaries } = await import("../src/i18n");
    for (const locale of ["en", "th"] as const) {
      const state = app.imageProbeState(auth.actor), html = withLocale(locale, () => imageProbeCards({ ...state, routes: state.routes.filter(row => row.route.provider === route) }, auth.csrf, null));
      expect(state.routes.find(row => row.route.provider === route)!.reason).toBe(reason);
      expect(html).not.toContain(providerText);
      if (reason) {
        expect(html).toContain(`role="status"`);
        expect(html).toContain(dictionaries[locale][`attachments.image_probe_reason_${reason}`]);
        expect(html).toContain(dictionaries[locale][`attachments.image_probe_next_${reason}`]);
        expect(html).not.toContain(dictionaries[locale]["attachments.route_cannot_see_images"]);
        if (reason === "sign_in") expect(html).toContain(`/settings/team#sign-in-${route}`);
      }
    }
    const persisted = f.store.read(tx => JSON.stringify({ receipts: tx.all("SELECT result_json FROM command_receipts"), audit: tx.all("SELECT * FROM audit") }));
    expect(persisted).not.toContain(providerText);
    expect(await app.probeImages(auth.actor, command)).toEqual(result);
    expect([inference, tokens]).toEqual(endpoint === "token" ? [0, 1] : [1, 0]);
  } finally { await app.closeDeviceSignIns(); }
});
