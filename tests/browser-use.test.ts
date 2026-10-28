import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { OwnerActor } from "../src/application";
import { readConfig } from "../src/config";
import { AppError } from "../src/errors";
import { dictionaries } from "../src/i18n";
import { BrowserService, browserIdleMs, classifyBrowserAction, matchesVocabulary, renderSnapshot, snapshotBytes, type ElementInfo } from "../src/exec/browser";
import type { BoxStreamRequest, StreamTarget } from "../src/exec/box-runtime";
import { CdpClient, cdpRelayPath } from "../src/exec/cdp-stream";
import { PodmanBoxRuntime, type CommandRunner } from "../src/exec/podman-runtime";
import { ScreenshotStore, xdotoolCommand } from "../src/exec/takeover";
import { backupImageTables } from "../src/ops/backup";
import type { ScriptedTools } from "../src/team/scripted-port";
import { answer, decide, effectFixture, rid, send, setLevel, settle, type EffectFixture } from "./fixtures/effects";
import { FakeCdp, fakePng, type FixturePage } from "./fixtures/fake-cdp";

const fixtures: EffectFixture[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.close(); rmSync(f.root, { recursive: true, force: true }); rmSync(dirname(f.box.root), { recursive: true, force: true }); }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function rejects(action: () => unknown, code: string, status?: number): Promise<AppError> {
  try { await action(); } catch (error) {
    expect(error).toBeInstanceOf(AppError); expect((error as AppError).code).toBe(code);
    if (status !== undefined) expect((error as AppError).status).toBe(status);
    return error as AppError;
  }
  throw new Error(`expected ${code}`);
}

const cart: FixturePage = { url: "https://shop.example.test/cart", title: "Cart", elements: [
  { id: 1, role: "link", name: "Next page", tag: "a" },
  { id: 2, role: "button", name: "Pay now", tag: "button", type: "button" },
  { id: 3, role: "button", name: "ยืนยันการสั่งซื้อ", tag: "button", type: "button" },
  { id: 4, role: "textbox", name: "Email", tag: "input", type: "email", form: "login", field: "email" },
  { id: 5, role: "textbox", name: "Password", tag: "input", type: "password", form: "login", field: "password" },
  { id: 6, role: "button", name: "Continue", tag: "button", form: "login" },
  { id: 7, role: "combobox", name: "Size", tag: "select", options: ["s", "m", "l"] },
  { id: 8, role: "button", name: "Sender settings", tag: "button", type: "button" },
] };
const other: FixturePage = { url: "https://shop.example.test/other", title: "Other", elements: [{ id: 2, role: "button", name: "Pay now", tag: "button", type: "button" }] };

type Call = { name: string; input: unknown } | (() => void | Promise<void>);
/** An installation with a browser box whose Chromium is {@link FakeCdp}; `run` makes one Jit run call tools in order. */
async function browserWorld(pages: FixturePage[] = [cart, other]) {
  const cdp = new FakeCdp(pages);
  const desktop: string[] = [];
  let queued: Call[] = [], results: Awaited<ReturnType<ScriptedTools["call"]>>[] = [], names: string[] = [];
  const f = await effectFixture({
    browser: true,
    stream: (_target: StreamTarget, request: BoxStreamRequest) => {
      if (request.argv[0] !== cdpRelayPath) throw new Error(`unexpected stream ${request.argv[0]}`);
      return cdp.stream();
    },
    // The virtual display: xdotool input is recorded, scrot writes a PNG into the box workspace.
    exec: local => async (handle, request) => {
      const parsed = JSON.parse(new TextDecoder().decode(request.input)) as { op?: string; command?: string };
      const ok = () => ({ exitCode: 0, stdout: new TextEncoder().encode(JSON.stringify({ v: 1, ok: true, result: { stdout: "", stderr: "", exitCode: 0, timedOut: false } })), stderr: new Uint8Array() });
      if (parsed.op === "spawn" && parsed.command?.includes("xdotool")) { desktop.push(parsed.command); return ok(); }
      if (parsed.op === "spawn" && parsed.command?.includes("scrot")) {
        mkdirSync(join(handle.workspaceRoot, ".jit"), { recursive: true });
        writeFileSync(join(handle.workspaceRoot, ".jit/screen.png"), fakePng);
        return ok();
      }
      return local(handle, request);
    },
    script: async (request, _s, _o, tools) => {
      names = [...tools.names];
      for (const call of queued.splice(0)) {
        if (typeof call === "function") await call();
        else results.push(await tools.call(call.name, call.input));
      }
      return answer(request, JSON.stringify({ reply: "ทำแล้ว" }));
    },
  });
  fixtures.push(f);
  const run = async (calls: Call[]) => {
    queued = calls; results = [];
    send(f, "ใช้ browser หน่อย");
    await settle(f);
    return { results, names, json: (index: number) => JSON.parse(results[index]!.content) as Record<string, any> };
  };
  const takeover = (kind: "start" | "end", actor: OwnerActor = f.auth.actor, requestId = rid()) => {
    const state = f.app.takeover(f.auth.actor, f.project.id);
    return f.app.execute(actor, { kind: `takeover.${kind}`, requestId, projectId: f.project.id, expectedRevision: state.revision,
      payload: kind === "start" ? {} : { takeoverId: state.takeoverId ?? rid() } } as never) as unknown as { takeover: { active: boolean; takeoverId: string | null; revision: number } };
  };
  return { f, cdp, desktop, run, takeover };
}
const words = ["submit", "send", "pay", "buy", "confirm", "delete", "ส่ง", "ยืนยัน", "ชำระ", "ซื้อ", "ลบ"];
const element = (overrides: Partial<ElementInfo> = {}): ElementInfo => ({ tag: "button", type: "button", name: "", inForm: false, submits: false, password: false, fields: [], url: "https://x.test/", ...overrides });

test("classification: submit controls, the Thai and English confirm vocabulary and line breaks are confirm actions", async () => {
  // Jit's own classifier: whole Latin words, Thai substrings, any line break in typed text.
  expect(classifyBrowserAction("click", element({ name: "Pay now" }), null, words)).toEqual(["confirm_word"]);
  expect(classifyBrowserAction("click", element({ name: "ชำระเงิน" }), null, words)).toEqual(["confirm_word"]);
  expect(classifyBrowserAction("click", element({ name: "Continue", submits: true, inForm: true }), null, words)).toEqual(["submit_control"]);
  expect(classifyBrowserAction("click", element({ name: "Send", submits: true }), null, words)).toEqual(["submit_control", "confirm_word"]);
  expect(classifyBrowserAction("click", element({ name: "Sender settings" }), null, words)).toEqual([]);
  expect(classifyBrowserAction("click", element({ name: "Display" }), null, words)).toEqual([]);
  for (const text of ["hello\n", "a\rb", "line\r\n"]) expect(classifyBrowserAction("type", element({ tag: "input" }), text, words)).toEqual(["line_break"]);
  expect(classifyBrowserAction("type", element({ tag: "input" }), "hello", words)).toEqual([]);
  expect(matchesVocabulary("DELETE ACCOUNT", words)).toBe(true);
  expect(matchesVocabulary("ลบรายการ", words)).toBe(true);
  expect(matchesVocabulary("Paypal login", ["pay"])).toBe(false);

  const w = await browserWorld();
  setLevel(w.f, "workspace");
  const out = await w.run([
    { name: "browser_open", input: { url: cart.url } },
    { name: "browser_click", input: { ref: "e1" } },
    { name: "browser_click", input: { ref: "e2" } },
    { name: "browser_click", input: { ref: "e3" } },
    { name: "browser_click", input: { ref: "e6" } },
    { name: "browser_click", input: { ref: "e8" } },
    { name: "browser_type", input: { ref: "e4", text: "owner@example.test" } },
    { name: "browser_type", input: { ref: "e4", text: "hello\n" } },
    { name: "browser_type", input: { ref: "e4", text: "a\rb" } },
    { name: "browser_type", input: { ref: "e5", text: "hunter2-secret\n" } },
    { name: "browser_select", input: { ref: "e7", value: "m" } },
  ]);
  expect(out.json(0)).toMatchObject({ url: cart.url, title: "Cart" });
  // Only the plain actions reached the page.
  expect(w.cdp.actions).toEqual(["click e1", "click e8", "type e4 owner@example.test", "select e7 m"]);
  for (const index of [2, 3, 4, 7, 8, 9]) expect(out.json(index).state).toBe("pending_approval");
  const all = w.f.app.approvalCards(w.f.auth.actor, w.f.project.id);
  const byKey = (operation: string, ref: string, text?: string) => all.find(card => (card.action as any).operation === operation && (card.action as any).element.ref === ref &&
    (text === undefined || (card.action as any).text === text))!;
  expect(all.map(card => card.kind)).toEqual(Array(6).fill("browser_confirm"));
  expect((byKey("click", "e2").action as any).reasons).toEqual(["confirm_word"]);
  expect((byKey("click", "e3").action as any).reasons).toEqual(["confirm_word"]);
  expect((byKey("click", "e6").action as any).reasons).toEqual(["submit_control"]);
  expect((byKey("type", "e4", "hello\n").action as any).reasons).toEqual(["line_break"]);
  expect((byKey("type", "e4", "a\rb").action as any).reasons).toEqual(["line_break"]);
  // The card shows the URL, the element text and the form's field names; a password value is never stored or shown.
  expect(byKey("click", "e6").action).toMatchObject({ url: cart.url, element: { tag: "button", name: "Continue" }, formFields: ["email", "password"], text: null, textDigest: null });
  const secret = byKey("type", "e5");
  expect(secret.action).toMatchObject({ text: null, element: { name: "Password" }, reasons: ["line_break"] });
  expect((secret.action as any).textDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(w.f.app.approvalCards(w.f.auth.actor, w.f.project.id))).not.toContain("hunter2");
  // Confirm cards are never auto-approved, and no rule can be written for them.
  await rejects(() => w.f.app.execute(w.f.auth.actor, { kind: "approval.rule.set", requestId: rid(), projectId: w.f.project.id, expectedRevision: 0,
    payload: { effectKind: "browser_confirm", scope: { remote: "x" }, enabled: true } } as never), "invalid_approval_command");
});

test("every confirm action waits for its card: denial performs nothing, approval resumes once, a moved page is stale", async () => {
  const w = await browserWorld();
  setLevel(w.f, "workspace");
  await w.run([{ name: "browser_open", input: { url: cart.url } }, { name: "browser_click", input: { ref: "e2" } }, { name: "browser_click", input: { ref: "e6" } },
    { name: "browser_type", input: { ref: "e5", text: "hunter2-secret\n" } }]);
  const pending = w.f.app.approvalCards(w.f.auth.actor, w.f.project.id);
  const ref = (value: string) => pending.find(card => (card.action as any).element.ref === value)!;
  const [pay, submit, password] = [ref("e2"), ref("e6"), ref("e5")];
  // The run ended but its page waits for the owner (a pending card keeps the session).
  expect(w.cdp.open()).toBe(1);
  decide(w.f, pay!, "deny");
  await settle(w.f);
  expect(w.cdp.actions).toEqual([]);
  decide(w.f, submit!, "approve");
  await settle(w.f);
  expect(w.cdp.actions).toEqual(["click e6"]);
  expect(w.f.app.approvalCard(w.f.auth.actor, w.f.project.id, submit!.id)).toMatchObject({ state: "succeeded", receipt: { outcome: "succeeded" } });
  // The password card types the held value (and its Enter) without the value ever being on the card.
  decide(w.f, password!, "approve");
  await settle(w.f);
  expect(w.cdp.actions).toEqual(["click e6", "type e5 hunter2-secret", "key e5 Enter"]);
  // A used card cannot run again.
  await w.f.executor.run(w.f.project.id, submit!.id);
  expect(w.cdp.actions).toHaveLength(3);

  // A card whose page moved is stale: nothing is clicked.
  await w.run([{ name: "browser_open", input: { url: cart.url } }, { name: "browser_click", input: { ref: "e2" } }, () => {}, { name: "browser_open", input: { url: other.url } }]);
  const moved = w.f.app.approvalCards(w.f.auth.actor, w.f.project.id, { state: "pending" }).find(card => card.id !== pay!.id)!;
  decide(w.f, moved, "approve");
  await settle(w.f);
  expect(w.f.app.approvalCard(w.f.auth.actor, w.f.project.id, moved.id)).toMatchObject({ state: "failed", reason: "stale" });
  expect(w.cdp.actions).toHaveLength(3);
});

test("takeover is Web only; while it is active agent browser calls and approved cards fail takeover_active", async () => {
  const w = await browserWorld();
  setLevel(w.f, "workspace");
  await rejects(() => w.takeover("start", w.f.telegram), "takeover_requires_web", 403);
  w.f.app.execute(w.f.auth.actor, { kind: "local_api.set", requestId: rid(), projectId: null, expectedRevision: w.f.app.localApi(w.f.auth.actor).revision, payload: { enabled: true } });
  await rejects(() => w.takeover("start", w.f.app.issueLocalApiActor()!.actor), "takeover_requires_web", 403);
  await w.run([{ name: "browser_open", input: { url: cart.url } }, { name: "browser_click", input: { ref: "e2" } }]);
  const card = w.f.app.approvalCards(w.f.auth.actor, w.f.project.id)[0]!;
  const started = w.takeover("start");
  expect(started.takeover).toMatchObject({ active: true, revision: 1 });
  await rejects(() => w.takeover("start"), "takeover_active", 409);
  const blocked = await w.run([{ name: "browser_snapshot", input: {} }, { name: "browser_click", input: { ref: "e1" } }]);
  for (const result of blocked.results) { expect(result.isError).toBe(true); expect(result.content).toContain("takeover_active"); }
  // An approved card does not act during a takeover.
  decide(w.f, card, "approve");
  await settle(w.f);
  expect(w.f.app.approvalCard(w.f.auth.actor, w.f.project.id, card.id)).toMatchObject({ state: "failed", reason: "takeover_active" });
  expect(w.cdp.actions).toEqual([]);
  // Owner input reaches the virtual display with xdotool; it is Web only, for the active takeover, and never replayed.
  const takeoverId = started.takeover.takeoverId!;
  const input = (kind: string, payload: Record<string, unknown>, actor: OwnerActor = w.f.auth.actor, requestId = rid()) =>
    w.f.app.execute(actor, { kind, requestId, projectId: w.f.project.id, expectedRevision: 1, payload: { takeoverId, ...payload } } as never) as unknown as Promise<unknown>;
  const requestId = rid();
  await input("takeover.click", { x: 10, y: 20 }, w.f.auth.actor, requestId);
  await input("takeover.click", { x: 10, y: 20 }, w.f.auth.actor, requestId);
  await input("takeover.type", { text: "สวัสดี it's me" });
  await input("takeover.key", { key: "ctrl+l" });
  expect(w.desktop).toEqual(["DISPLAY=:99 xdotool mousemove --sync 10 20 click 1", "DISPLAY=:99 xdotool type --delay 12 -- 'สวัสดี it'\\''s me'", "DISPLAY=:99 xdotool key --delay 12 -- ctrl+l"]);
  await rejects(() => input("takeover.click", { x: 1, y: 1 }, w.f.telegram), "takeover_requires_web", 403);
  await rejects(() => w.f.app.execute(w.f.auth.actor, { kind: "takeover.click", requestId: rid(), projectId: w.f.project.id, expectedRevision: 1, payload: { takeoverId: rid(), x: 1, y: 1 } } as never), "takeover_not_active", 409);
  await rejects(() => input("takeover.click", { x: 5000, y: 1 }), "invalid_takeover_command");
  expect(() => xdotoolCommand({ kind: "key", keys: ["Return; rm -rf /"] })).toThrow("invalid_desktop_input");
  // The owner ends the takeover; the agent works again.
  await rejects(() => w.takeover("end", w.f.telegram), "takeover_requires_web", 403);
  expect(w.takeover("end").takeover).toMatchObject({ active: false, revision: 2 });
  const after = await w.run([{ name: "browser_snapshot", input: {} }]);
  expect(after.results[0]!.isError).toBeUndefined();
});

test("the CDP stream closes at run end, after five idle minutes, on box stop and on the kill switch", async () => {
  const w = await browserWorld();
  setLevel(w.f, "workspace");
  // Run end with nothing pending closes it.
  await w.run([{ name: "browser_open", input: { url: cart.url } }]);
  expect(w.cdp.streams).toHaveLength(1);
  expect(w.cdp.open()).toBe(0);
  // A pending card keeps the page past the run, until five idle minutes pass.
  await w.run([{ name: "browser_open", input: { url: cart.url } }, { name: "browser_click", input: { ref: "e2" } }]);
  expect(w.cdp.open()).toBe(1);
  expect(w.f.browser!.sweep(w.f.clock.now + browserIdleMs - 1)).toEqual([]);
  expect(w.f.browser!.sweep(w.f.clock.now + browserIdleMs)).toEqual([w.f.project.id]);
  expect(w.cdp.open()).toBe(0);
  const parked = w.f.app.approvalCards(w.f.auth.actor, w.f.project.id, { state: "pending" })[0]!;
  decide(w.f, parked, "approve");
  await settle(w.f);
  expect(w.f.app.approvalCard(w.f.auth.actor, w.f.project.id, parked.id)).toMatchObject({ state: "failed", reason: "browser_session_closed" });
  // Box stop.
  await w.run([{ name: "browser_open", input: { url: cart.url } }, { name: "browser_click", input: { ref: "e2" } }]);
  expect(w.cdp.open()).toBe(1);
  await w.f.boxes.stop(w.f.project.id);
  expect(w.cdp.open()).toBe(0);
  // The kill switch, mid-run: the stream is closed and later calls are refused.
  let during = -1;
  const halted = await w.run([{ name: "browser_open", input: { url: cart.url } }, () => {
    const access = w.f.app.projectAccess(w.f.auth.actor, w.f.project.id);
    w.f.app.execute(w.f.auth.actor, { kind: "execution.halt", requestId: rid(), projectId: w.f.project.id, expectedRevision: access.haltRevision, payload: {} });
    during = w.cdp.open();
  }, { name: "browser_snapshot", input: {} }]);
  expect(during).toBe(0);
  expect(halted.results[1]).toMatchObject({ isError: true });
  expect(halted.results[1]!.content).toContain("Execution access changed");
  expect(w.cdp.open()).toBe(0);
  // The relay is always its own long-lived exec in the box, never a runner request; no port is involved.
  const streams = w.f.runtime.calls.filter(call => call.op === "stream") as { argv: string[]; target: string; secretEnv: Record<string, string> }[];
  expect(streams.every(call => call.argv.join(" ") === cdpRelayPath && call.target === `jit-box-${w.f.project.id}` && Object.keys(call.secretEnv).length === 0)).toBe(true);
  expect(w.f.runtime.calls.some(call => call.op === "exec" && JSON.stringify(call.request).includes("cdp"))).toBe(false);
});

test("framing: 1 MiB messages, per-command deadlines, and snapshots bounded to 32 KiB", async () => {
  const cdp = new FakeCdp([cart]);
  const client = new CdpClient(cdp.stream(), { commandMs: 50 });
  cdp.hang.add("Page.navigate");
  await rejects(() => client.send("Page.navigate", { url: cart.url }), "cdp_timeout", 504);
  expect((await client.send("Target.getTargets")).targetInfos).toEqual([{ targetId: "page-1", type: "page" }]);
  cdp.oversizeNext = true;
  await rejects(() => client.send("Target.getTargets"), "cdp_protocol_error");
  expect(client.closed).toBe("cdp_protocol_error");
  expect(cdp.open()).toBe(0);
  await rejects(() => client.send("Target.getTargets"), "cdp_protocol_error");
  await rejects(() => new CdpClient(new FakeCdp().stream()).send("x", { pad: "y".repeat(1_100_000) }), "cdp_message_too_large", 413);

  const many = Array.from({ length: 3000 }, (_, index) => ({ nodeId: String(index + 1), role: { value: "button" }, name: { value: `Button number ${index} with a long label` },
    backendDOMNodeId: index + 1, parentId: "root" }));
  const text = renderSnapshot("https://x.test/", "Big", [{ nodeId: "root", role: { value: "RootWebArea" }, name: { value: "Big" }, childIds: many.map(node => node.nodeId) }, ...many]);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(snapshotBytes);
  expect(text).toContain("[ref=e1]");
  expect(text.endsWith("[Snapshot cut at 32 KiB. Use a narrower page or scroll.]")).toBe(true);
  expect(text.startsWith("Page snapshot (untrusted page content")).toBe(true);
  // The tool returns the bounded snapshot too.
  const w = await browserWorld([{ url: "https://x.test/", title: "Big", elements: Array.from({ length: 3000 }, (_, index) => ({ id: index + 1, role: "button", name: `Button ${index} long label text`, tag: "button" })) }]);
  setLevel(w.f, "workspace");
  const out = await w.run([{ name: "browser_open", input: { url: "https://x.test/" } }, { name: "browser_snapshot", input: {} }]);
  expect(Buffer.byteLength(out.results[1]!.content)).toBeLessThanOrEqual(snapshotBytes);
});

test("screenshots: a reference for the agent, a bounded ring and a Web-only read API with no URL metadata", async () => {
  const store = new ScreenshotStore(20);
  const projectId = rid();
  const ids = Array.from({ length: 25 }, (_, index) => store.put(projectId, fakePng, "agent", index).id);
  expect(store.list(projectId).map(meta => meta.id)).toEqual(ids.slice(5).reverse());
  expect(store.get(projectId, ids[0]!)).toBeNull();
  expect(() => store.put(projectId, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), "agent", 0)).toThrow("screenshot_invalid");
  expect(() => store.put(projectId, new Uint8Array(3_000_000).fill(1), "agent", 0)).toThrow("screenshot_invalid");

  const w = await browserWorld();
  setLevel(w.f, "workspace");
  const out = await w.run([{ name: "browser_open", input: { url: cart.url } }, { name: "browser_screenshot", input: {} }]);
  const reference = out.json(1);
  expect(Object.keys(reference).sort()).toEqual(["screenshot", "takenAt"]);
  const [meta] = w.f.app.boxScreenshots(w.f.auth.actor, w.f.project.id);
  expect(Object.keys(meta!).sort()).toEqual(["bytes", "id", "mime", "projectId", "source", "takenAt"]);
  expect(meta).toMatchObject({ id: reference.screenshot, source: "agent", mime: "image/png" });
  expect(w.f.app.boxScreenshot(w.f.auth.actor, w.f.project.id, meta!.id).data).toEqual(fakePng);
  await rejects(() => w.f.app.boxScreenshots(w.f.telegram, w.f.project.id), "channel_not_authorized", 403);
  await rejects(() => w.f.app.boxScreenshot(w.f.auth.actor, w.f.project.id, rid()), "screenshot_not_found", 404);
  // The owner's live view captures the whole display.
  const desktop = await w.f.app.captureBoxScreen(w.f.auth.actor, w.f.project.id);
  expect(desktop).toMatchObject({ source: "owner", bytes: fakePng.length });
});

test("browser tools exist only at workspace or above and only in the browser image; the profile persists until a wiping reset", async () => {
  const w = await browserWorld();
  const atRead = await w.run([]);
  expect(atRead.names.filter(name => name.startsWith("browser_"))).toEqual([]);
  setLevel(w.f, "workspace");
  const atWorkspace = await w.run([]);
  expect(atWorkspace.names.filter(name => name.startsWith("browser_")).sort()).toEqual(["browser_click", "browser_open", "browser_screenshot", "browser_select", "browser_snapshot", "browser_type"]);
  // The box carries the project profile mount.
  expect(w.f.runtime.boxes.get(w.f.project.id)).toMatchObject({ profile: true });
  expect(w.f.runtime.boxes.get(w.f.project.id)!.mounts.map(mount => mount.destination).sort()).toEqual(["/profile", "/workspace"]);
  // A box without the browser image gets no browser tools.
  const service = new BrowserService(w.f.store, { boxes: w.f.boxes, runtime: w.f.runtime });
  const handle = await w.f.runtime.ensure(w.f.project.id, "workspace", { profile: false });
  expect(service.openRun({ request: w.f.seen.at(-1)!, handle, current: () => true }).definitions).toEqual([]);

  // Podman: a plain reset keeps the profile; a reset with wipeWorkspace removes it with the workspace.
  const root = mkdtempSync(join(tmpdir(), "jit-exe14-podman-")); dirs.push(root);
  const projectId = rid();
  const run: CommandRunner = async argv => ({ exitCode: argv[0] === "container" && argv[1] === "exists" ? 1 : 0, stdout: new Uint8Array(), stderr: new Uint8Array() });
  const config = readConfig({ JIT_EXECUTION_DIR: root, JIT_BOX_IMAGE_BASE: `localhost/jit-box@sha256:${"a".repeat(64)}`, JIT_BOX_IMAGE_BROWSER: `localhost/jit-browser@sha256:${"b".repeat(64)}` });
  const podman = new PodmanBoxRuntime({ config: config.execution, run });
  for (const dir of ["workspace", "profile"]) mkdirSync(join(root, projectId, dir), { recursive: true });
  await podman.reset({ projectId }, { wipeWorkspace: false });
  expect(existsSync(join(root, projectId, "profile"))).toBe(true);
  await podman.reset({ projectId }, { wipeWorkspace: true });
  expect(existsSync(join(root, projectId, "profile"))).toBe(false);
  expect(existsSync(join(root, projectId, "workspace"))).toBe(false);
});

test("schema, backup policy and dictionaries cover exec.browser/v1 and app.takeover/v1", () => {
  expect(backupImageTables.takeover_sessions).toBe("include");
  for (const key of Object.keys(dictionaries.en).filter(key => /^error\.(takeover_|invalid_takeover_|invalid_desktop_|browser_|screen_|screenshot_)/.test(key))) expect(dictionaries.th[key as keyof typeof dictionaries.th]).toBeTruthy();
});
