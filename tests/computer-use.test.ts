import { uploadText, sendFiles } from "./fixtures/attachment-run";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError } from "../src/errors";
import { dictionaries } from "../src/i18n";
import type { BoxStreamRequest, StreamTarget } from "../src/exec/box-runtime";
import { cdpRelayPath } from "../src/exec/cdp-stream";
import { browserIdleMs } from "../src/exec/browser";
import { ComputerService, computerReasons, pressesEnter } from "../src/exec/computer";
import { backupImageTables } from "../src/ops/backup";
import type { ScriptedTools } from "../src/team/scripted-port";
import { answer, decide, effectFixture, rid, send, setLevel, settle, type EffectFixture } from "./fixtures/effects";
import { FakeCdp, fakePng } from "./fixtures/fake-cdp";

const fixtures: EffectFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.close(); rmSync(f.root, { recursive: true, force: true }); rmSync(dirname(f.box.root), { recursive: true, force: true }); }
});
function rejects(action: () => unknown, code: string, status?: number): AppError {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(AppError); expect((error as AppError).code).toBe(code);
    if (status !== undefined) expect((error as AppError).status).toBe(status);
    return error as AppError;
  }
  throw new Error(`expected ${code}`);
}

type Call = { name: string; input: unknown } | (() => void);
/** A browser-image box on the fake clock whose desktop input (xdotool through the runner) is recorded. */
async function desktopWorld() {
  const cdp = new FakeCdp();
  const desktop: string[] = [];
  let queued: Call[] = [], results: Awaited<ReturnType<ScriptedTools["call"]>>[] = [], names: string[] = [];
  const f = await effectFixture({
    browser: true,
    stream: (_target: StreamTarget, request: BoxStreamRequest) => {
      if (request.argv[0] !== cdpRelayPath) throw new Error("unexpected stream");
      return cdp.stream();
    },
    exec: local => async (handle, request) => {
      const parsed = JSON.parse(new TextDecoder().decode(request.input)) as { op?: string; command?: string };
      const ok = () => ({ exitCode: 0, stdout: new TextEncoder().encode(JSON.stringify({ v: 1, ok: true, result: { stdout: "", stderr: "", exitCode: 0, timedOut: false } })), stderr: new Uint8Array() });
      if (parsed.op === "spawn" && parsed.command?.includes("xdotool")) { desktop.push(parsed.command.replace("DISPLAY=:99 xdotool ", "")); return ok(); }
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
        if (typeof call === "function") call();
        else results.push(await tools.call(call.name, call.input));
      }
      return answer(request, JSON.stringify({ reply: "ทำแล้ว" }));
    },
  });
  fixtures.push(f);
  const run = async (calls: Call[]) => {
    queued = calls; results = [];
    send(f, "ใช้ desktop หน่อย");
    await settle(f);
    return { results, names, state: (index: number) => (JSON.parse(results[index]!.content) as { state?: string; done?: string }) };
  };
  const setConfirm = (confirmEveryAction: boolean, actor = f.auth.actor) =>
    f.app.execute(actor, { kind: "computer.settings.set", requestId: rid(), projectId: f.project.id,
      expectedRevision: f.app.computerSettings(f.auth.actor, f.project.id).revision, payload: { confirmEveryAction } });
  return { f, cdp, desktop, run, setConfirm };
}
const click = (x: number, y: number, intent: string) => ({ name: "computer_click", input: { x, y, intent } });
const type = (text: string, intent: string) => ({ name: "computer_type", input: { text, intent } });
const key = (keys: string[], intent: string) => ({ name: "computer_key", input: { keys, intent } });

test("computer tools exist only at full, and only in the browser image", async () => {
  const w = await desktopWorld();
  const computer = (names: string[]) => names.filter(name => name.startsWith("computer_")).sort();
  expect(computer((await w.run([])).names)).toEqual([]);
  setLevel(w.f, "workspace");
  const workspace = await w.run([]);
  expect(computer(workspace.names)).toEqual([]);
  expect(workspace.names).toContain("browser_click");
  setLevel(w.f, "full");
  expect(computer((await w.run([])).names)).toEqual(["computer_click", "computer_key", "computer_screenshot", "computer_type"]);
  // Not in a box without the browser image, and not for a run granted less than full.
  const service = new ComputerService(w.f.store, w.f.browser!);
  const request = w.f.seen.at(-1)!;
  const plain = await w.f.runtime.ensure(w.f.project.id, "full", { profile: false });
  expect(service.openRun({ request, handle: plain, current: () => true }).definitions).toEqual([]);
  const browserBox = await w.f.runtime.ensure(w.f.project.id, "full", { profile: true });
  expect(service.openRun({ request: { ...request, execution: { level: "workspace", boxProjectId: w.f.project.id } }, handle: browserBox, current: () => true }).definitions).toEqual([]);
  expect(service.openRun({ request, handle: browserBox, current: () => true }).definitions).toHaveLength(4);
});

test("confirmEveryAction defaults on and is a Web-only toggle", async () => {
  const w = await desktopWorld();
  expect(w.f.app.computerSettings(w.f.auth.actor, w.f.project.id)).toEqual({ projectId: w.f.project.id, revision: 0, confirmEveryAction: true, updatedAt: null });
  rejects(() => w.setConfirm(false, w.f.telegram), "computer_setting_requires_web", 403);
  // Even turning it back on is Web only.
  rejects(() => w.setConfirm(true, w.f.telegram), "computer_setting_requires_web", 403);
  w.f.app.execute(w.f.auth.actor, { kind: "local_api.set", requestId: rid(), projectId: null, expectedRevision: w.f.app.localApi(w.f.auth.actor).revision, payload: { enabled: true } });
  rejects(() => w.setConfirm(false, w.f.app.issueLocalApiActor()!.actor), "computer_setting_requires_web", 403);
  expect(w.setConfirm(false).computer).toMatchObject({ revision: 1, confirmEveryAction: false });
  rejects(() => w.f.app.execute(w.f.auth.actor, { kind: "computer.settings.set", requestId: rid(), projectId: w.f.project.id, expectedRevision: 0, payload: { confirmEveryAction: true } }), "stale_revision", 409);
  rejects(() => w.f.app.execute(w.f.auth.actor, { kind: "computer.settings.set", requestId: rid(), projectId: w.f.project.id, expectedRevision: 1, payload: { confirmEveryAction: "no" } } as never), "invalid_computer_command");
  expect(w.setConfirm(true).computer).toMatchObject({ revision: 2, confirmEveryAction: true });
});

test("with the default setting every click and key waits for a card; plain typing does not", async () => {
  const w = await desktopWorld();
  setLevel(w.f, "full");
  const out = await w.run([click(10, 20, "input"), click(30, 40, "navigate"), key(["Tab"], "input"), type("hello", "input")]);
  expect([0, 1, 2].map(index => out.state(index).state)).toEqual(["pending_approval", "pending_approval", "pending_approval"]);
  expect(out.state(3)).toMatchObject({ done: "type" });
  expect(w.desktop).toEqual(["type --delay 12 -- 'hello'"]);
  const cards = w.f.app.approvalCards(w.f.auth.actor, w.f.project.id);
  expect(cards.every(card => card.kind === "computer_confirm" && card.state === "pending")).toBe(true);
  const tab = cards.find(card => (card.action as any).operation === "key")!;
  expect(tab.action).toEqual({ kind: "computer_confirm", operation: "key", x: null, y: null, text: null, keys: ["Tab"], intent: "input", reasons: ["confirm_every_action"] });
  // A denied card sends nothing; an approved one sends exactly its input, once.
  const first = cards.find(card => (card.action as any).x === 10)!;
  decide(w.f, tab, "deny");
  decide(w.f, first, "approve");
  await settle(w.f);
  expect(w.desktop).toEqual(["type --delay 12 -- 'hello'", "mousemove --sync 10 20 click 1"]);
  expect(w.f.app.approvalCard(w.f.auth.actor, w.f.project.id, first.id)).toMatchObject({ state: "succeeded" });
  await w.f.executor.run(w.f.project.id, first.id);
  expect(w.desktop).toHaveLength(2);
});

test("intent only adds cards: Enter and line breaks always wait, even with the setting off", async () => {
  const w = await desktopWorld();
  setLevel(w.f, "full");
  w.setConfirm(false);
  const out = await w.run([
    key(["Return"], "input"),          // 0: always a card
    type("hello\n", "input"),          // 1: always a card
    type("hello", "input"),            // 2: no card
    click(1, 1, "navigate"),           // 3: no card with the setting off
    click(2, 2, "submit"),             // 4: declared submit adds a card
    key(["Tab"], "confirm"),           // 5: declared confirm adds a card
    key(["ctrl+Return"], "navigate"),  // 6: Enter with a modifier
    key(["KP_Enter"], "input"),        // 7
    key(["shift+ISO_Enter"], "input"), // 8
    key(["ctrl+m"], "input"),          // 9: a terminal Enter chord
    type("a\rb", "navigate"),          // 10
    key(["Tab"], "input"),             // 11: no card with the setting off
  ]);
  const gated = [0, 1, 4, 5, 6, 7, 8, 9, 10], direct = [2, 3, 11];
  for (const index of gated) expect(out.state(index).state).toBe("pending_approval");
  for (const index of direct) expect(out.state(index).done).toBeTruthy();
  expect(w.desktop).toEqual(["type --delay 12 -- 'hello'", "mousemove --sync 1 1 click 1", "key --delay 12 -- Tab"]);
  const reasons = w.f.app.approvalCards(w.f.auth.actor, w.f.project.id).map(card => (card.action as any).reasons as string[]);
  expect(reasons.filter(list => list.includes("confirm_every_action"))).toEqual([]);
  // The classifier itself: the declared intent can never remove a reason.
  expect(computerReasons({ operation: "key", keys: ["Return"] }, "input", false)).toEqual(["enter_key"]);
  expect(computerReasons({ operation: "type", text: "hello\n" }, "input", false)).toEqual(["line_break"]);
  expect(computerReasons({ operation: "type", text: "hello" }, "input", false)).toEqual([]);
  expect(computerReasons({ operation: "type", text: "hello" }, "input", true)).toEqual([]);
  expect(computerReasons({ operation: "key", keys: ["Tab"] }, "input", true)).toEqual(["confirm_every_action"]);
  expect(computerReasons({ operation: "click", x: 1, y: 1 }, "confirm", true)).toEqual(["declared_confirm", "confirm_every_action"]);
  for (const name of ["Return", "return", "KP_Enter", "ISO_Enter", "Linefeed", "alt+Return", "ctrl+j", "Control_L+m"]) expect(pressesEnter(name)).toBe(true);
  for (const name of ["Tab", "ctrl+l", "Escape", "m"]) expect(pressesEnter(name)).toBe(false);
  // Invalid intents and inputs act on nothing.
  const invalid = await w.run([click(1, 1, "trusted"), click(1280, 0, "input"), type("x".repeat(2001), "input"), key(Array(17).fill("Tab"), "input"), key(["0xff0d"], "input"), key(["Return; reboot"], "input")]);
  for (const result of invalid.results) expect(result.isError).toBe(true);
  expect(w.desktop).toHaveLength(3);
  // Computer confirm cards are never auto-approved.
  rejects(() => w.f.app.execute(w.f.auth.actor, { kind: "approval.rule.set", requestId: rid(), projectId: w.f.project.id, expectedRevision: 0,
    payload: { effectKind: "computer_confirm", scope: { target: "x" }, enabled: true } } as never), "invalid_approval_command");
});

test("during a takeover the computer tools and approved computer cards fail takeover_active; screenshots return a reference", async () => {
  const w = await desktopWorld();
  setLevel(w.f, "full");
  const shot = await w.run([{ name: "computer_screenshot", input: {} }, click(5, 5, "input")]);
  expect(Object.keys(JSON.parse(shot.results[0]!.content)).sort()).toEqual(["screenshot", "takenAt"]);
  expect(w.f.app.boxScreenshots(w.f.auth.actor, w.f.project.id)[0]).toMatchObject({ source: "agent", mime: "image/png" });
  const card = w.f.app.approvalCards(w.f.auth.actor, w.f.project.id)[0]!;
  const started = w.f.app.execute(w.f.auth.actor, { kind: "takeover.start", requestId: rid(), projectId: w.f.project.id, expectedRevision: 0, payload: {} });
  const blocked = await w.run([click(1, 1, "input"), type("hello", "input"), key(["Tab"], "input"), { name: "computer_screenshot", input: {} }]);
  for (const result of blocked.results) { expect(result.isError).toBe(true); expect(result.content).toContain("takeover_active"); }
  decide(w.f, card, "approve");
  await settle(w.f);
  expect(w.f.app.approvalCard(w.f.auth.actor, w.f.project.id, card.id)).toMatchObject({ state: "failed", reason: "takeover_active" });
  expect(w.desktop).toEqual([]);
  w.f.app.execute(w.f.auth.actor, { kind: "takeover.end", requestId: rid(), projectId: w.f.project.id, expectedRevision: 1, payload: { takeoverId: started.takeover.takeoverId! } });
  const after = await w.run([type("again", "input")]);
  expect(after.state(0)).toMatchObject({ done: "type" });
  // Narrowing below full removes the tools and fails approved cards before anything is sent.
  await w.run([click(7, 7, "input")]);
  const pending = w.f.app.approvalCards(w.f.auth.actor, w.f.project.id, { state: "pending" })[0]!;
  setLevel(w.f, "workspace");
  rejects(() => decide(w.f, pending, "approve"), "access_level_insufficient", 409);
  expect(w.desktop).toEqual(["type --delay 12 -- 'again'"]);
});

test("schema, backup policy and dictionaries cover exec.computer/v1", () => {
  expect(backupImageTables.computer_settings).toBe("include");
  for (const key of ["error.computer_setting_requires_web", "error.invalid_computer_command"]) {
    expect(dictionaries.th[key as keyof typeof dictionaries.th]).toBeTruthy();
    expect(dictionaries.en[key as keyof typeof dictionaries.en]).toBeTruthy();
  }
});

test("review fix: a computer card holds its desktop session; once that session closes, approval sends nothing", async () => {
  const w = await desktopWorld();
  setLevel(w.f, "full");
  await w.run([click(3, 4, "input"), click(5, 6, "input")]);
  // The run ended but the pending cards keep the session (and the screen they were made on).
  expect(w.cdp.open()).toBe(1);
  const [first, second] = w.f.app.approvalCards(w.f.auth.actor, w.f.project.id);
  decide(w.f, first!, "approve");
  await settle(w.f);
  expect(w.desktop).toHaveLength(1);
  // The session closes (idle): the other card can no longer act on another page or a new run's screen.
  w.f.browser!.sweep(w.f.clock.now + browserIdleMs);
  expect(w.cdp.open()).toBe(0);
  decide(w.f, second!, "approve");
  await settle(w.f);
  expect(w.f.app.approvalCard(w.f.auth.actor, w.f.project.id, second!.id)).toMatchObject({ state: "failed", reason: "stale" });
  expect(w.desktop).toHaveLength(1);
});


for (const confirmed of [false, true]) test(`ATT04 computer_type guards full text; existing confirm card marker=${confirmed}`, async () => {
  const w = await desktopWorld(); setLevel(w.f, "full");
  const marker = "PRIVATE_ATTACHMENT_COMPUTER_193_never_send";
  const file = await uploadText(w.f, "prefix ".repeat(6000) + marker); sendFiles(w.f, [file.id]);
  await w.run([{ name: "computer_type", input: { text: marker + (confirmed ? "\n" : ""), intent: "input" } }]);
  expect(w.desktop).toHaveLength(0);
  const cards = w.f.app.approvalCards(w.f.auth.actor, w.f.project.id);
  expect(cards).toHaveLength(1); expect(cards[0]!.kind).toBe(confirmed ? "computer_confirm" : "outbound_release");
  expect(cards[0]!.action.outbound?.attachmentId).toBe(file.id);
  decide(w.f, cards[0]!, "approve"); await w.f.executor.idle(); expect(w.desktop).toHaveLength(1);
});
