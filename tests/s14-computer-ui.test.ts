import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dictionaries } from "../src/i18n";
import { S14Application, type S14Options } from "../src/s14/application";
import { S14Store } from "../src/s14/store";
import { createS14Handler } from "../src/s14/web";
import { renderFailure, renderS14 } from "../src/s14/web-pages";
import { createS14Product } from "../src/s14/web-product";
import type { BotComputer } from "../src/s14/computer-types";
import { accessibilityProblems } from "./fixtures/a11y";
import { barrier, FakeComputerRuntime, fixturePng } from "./fixtures/s14-computer";

/**
 * Bot computer Web surface (#248 BOX14-01): each state rendered through the real handler, and every control submitted
 * the way a browser without script submits it, reading the fields out of the HTML.
 */
const origin = "http://localhost:3001", password = "fixture-s14-computer-ui-owner";
const rid = () => crypto.randomUUID().replaceAll("-", "");
const roots: string[] = [], stores: S14Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(options: { language?: "th" | "en"; runtime?: FakeComputerRuntime | null; capable?: boolean; authority?: S14Options["authority"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jit-s14-computer-ui-")); roots.push(root);
  const store = new S14Store(join(root, "s14.sqlite")); stores.push(store);
  const clock = { now: 1800000000000 }, runtime = options.runtime === undefined ? new FakeComputerRuntime() : options.runtime, tools = ["computer", "effect_send"];
  const app = new S14Application(store, { policy: { routes: [{ id: "selected", provider: "codex", model: "scripted" }], tools, resources: [] }, chat: { async reply() { return { text: "ok" }; } }, now: () => clock.now, computers: runtime ? { runtime } : {}, authority: options.authority ?? {} } as S14Options);
  await app.provisionOwner(password);
  const token = await app.login(password), auth = app.authenticate(token), handler = createS14Handler(app, origin, renderS14, createS14Product(app));
  const conversationId = app.execute(auth.actor, { kind: "setup", requestId: rid(), expectedRevision: 0, payload: { ownerName: "Owner", language: options.language ?? "en", routeId: "selected", capabilities: { tools: options.capable === false ? [] : tools, resources: [] } } }).conversation!.id;
  const get = (path: string) => handler(new Request(`${origin}${path}`, { headers: { cookie: `jit_s14=${token}` } }));
  const page = async (path = "/team/jit?tab=computer") => { const response = await get(path); expect(response.status).toBe(200); return response.text(); };
  const post = (path: string, fields: Record<string, string>) => handler(new Request(`${origin}${path}`, { method: "POST", headers: { cookie: `jit_s14=${token}`, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }));
  const startWork = (title = "Local report", tools_ = ["computer", "effect_send"]) => app.execute(auth.actor, { kind: "work.start", requestId: rid(), expectedRevision: app.conversation(auth.actor, conversationId).conversation.revision, payload: { conversationId, task: null, title, purpose: "Write it", completionRule: "Owner review", bots: [{ id: "jit", revision: 1 }], tools: tools_, scopes: [], limits: { attempts: 4, steps: 4, calls: 64, outputBytes: 8192, wallMs: 3600000, concurrency: 2, reads: 40 }, expiresAt: clock.now + 3600000 } }).work!;
  const computer = () => app.computers.view(auth.actor, "jit");
  const open = async (work = startWork()) => { app.execute(auth.actor, { kind: "computer.open", requestId: rid(), expectedRevision: computer().computer?.revision ?? 0, payload: { botId: "jit", workId: work.id } }); await app.computers.drain(); return work; };
  const lease = (kind: "takeover.start" | "takeover.end") => { const { computer: c, lease: l } = computer(); return app.execute(auth.actor, { kind, requestId: rid(), expectedRevision: c!.revision, payload: { botId: "jit", computerId: c!.id, generation: c!.generation, leaseRevision: l!.revision } }); };
  const life = (kind: "computer.stop" | "computer.reset" | "computer.delete") => { const c = computer().computer!; return app.execute(auth.actor, { kind, requestId: rid(), expectedRevision: c.revision, payload: { botId: "jit", computerId: c.id, generation: c.generation } }); };
  const forceState = (patch: Partial<BotComputer>) => { const c = { ...computer().computer!, ...patch }; store.transaction(tx => tx.run("UPDATE bot_computers SET record_json=? WHERE id=?", JSON.stringify(c), c.id)); };
  return { app, store, clock, runtime, auth, token, get, page, post, startWork, computer, open, lease, life, forceState, conversationId };
}
type F = Awaited<ReturnType<typeof fixture>>;
const unescape = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const formsFor = (html: string, action: string) => [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(m => m[0]).filter(f => f.includes(`action="${action}"`));
/** Successful controls of one form: hidden and named inputs, without the image button, which adds its own coordinates. */
function fields(form: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const input of form.matchAll(/<input\b[^>]*>/g)) {
    const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(input[0])?.[1], key = attr("name");
    if (!key || /type="image"/.test(input[0])) continue;
    out[unescape(key)] = unescape(attr("value") ?? "");
  }
  return out;
}
const commandOf = (html: string, kind: string) => { const form = formsFor(html, "/s14/commands").map(fields).find(item => JSON.parse(item.command!).kind === kind); if (!form) throw new Error(`no ${kind} form`); return form; };
const hasCommand = (html: string, kind: string) => formsFor(html, "/s14/commands").some(form => JSON.parse(fields(form).command!).kind === kind);
const inputForm = (html: string, kind: string) => { const found = formsFor(html, "/s14/bots/jit/computer/input").map(fields).find(item => item.kind === kind); if (!found) throw new Error(`no ${kind} form`); return found; };
const follow = async (f: F, response: Response) => { expect(response.status).toBe(303); const location = response.headers.get("location")!; return location.startsWith("/s14/receipts/") ? f.get(location) : response; };
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(m => m[1]!.replace(/<[^>]+>/g, "")).filter(label => label !== dictionaries.th["s14.chat.new"] && label !== dictionaries.en["s14.chat.new"]);
const strict = (html: string, locale: "th" | "en" = "en") => { expect(html).not.toMatch(/\sstyle="/); expect(html).not.toMatch(/\son[a-z]+="/); expect(html).not.toContain("javascript:"); expect(accessibilityProblems(html, locale)).toEqual([]); };

test("absent names why: lazy default, no ceiling and missing runtime; none offers a control that cannot work", async () => {
  const lazy = await fixture(), html = await lazy.page();
  expect(html).toContain("No computer yet"); expect(html).toContain("nothing to set up"); expect(html).toContain("No work can open this computer right now"); expect(html).not.toContain("computer.open"); strict(html);
  expect(lazy.runtime!.starts).toHaveLength(0);
  const ceiling = await fixture({ capable: false }); expect(await ceiling.page()).toContain("may not have a computer");
  const none = await fixture({ runtime: null }), missing = await none.page();
  expect(missing).toContain("no isolated runtime"); expect(missing).toContain("will not fall back to the host shell"); expect(missing).toContain("computer_runtime_not_configured"); expect(missing).toContain("s14-probe.ts --diagnostics");
  none.startWork(); const refused = await none.page(); expect(refused).not.toContain("Open the computer for this work");
});

test("a live grant offers one exact open form, and the command reaches the fake runtime without any second confirmation", async () => {
  const f = await fixture(), work = f.startWork("<img src=x onerror=alert(1)>"), html = await f.page();
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;"); expect(html).not.toContain("<img src=x"); strict(html);
  expect(buttons(html).some(label => label.includes("img"))).toBe(false);
  const form = commandOf(html, "computer.open");
  expect(JSON.parse(form.command!)).toMatchObject({ expectedRevision: 0, payload: { botId: "jit", workId: work.id } });
  await follow(f, await f.post("/s14/commands", form)); await f.app.computers.drain();
  expect(f.runtime!.starts).toHaveLength(1); expect(f.computer().computer!.state).toBe("running");
});

test("a work without the computer tool offers no open form", async () => {
  const f = await fixture(); f.startWork("No computer", []);
  expect(await f.page()).not.toContain("Open the computer for this work");
});

test("computer open forms refresh their signature for new work, work state, grant revocation and expiry without a computer revision", async () => {
  const f = await fixture();
  const signature = (html: string) => unescape(/id="s14-computer-more" data-sig="([^"]+)"/.exec(html)![1]!);
  const absent = signature(await f.page()), work = f.startWork("First report");
  const queued = await f.page(), queuedKey = signature(queued);
  expect(queuedKey).not.toBe(absent);
  expect(queuedKey).toContain(work.id);
  expect(signature(await f.page())).toBe(queuedKey);
  expect(hasCommand(queued, "computer.open")).toBe(true);
  const a = f.app.authority.admit(work.id, rid(), { botId: "jit", tools: ["computer"], scopes: [], input: "Report", calls: 6, outputBytes: 1024 });
  const working = signature(await f.page());
  expect(working).not.toBe(queuedKey);
  f.app.authority.commit(a.id, { state: "waiting", text: "Waiting for evidence" });
  const waiting = signature(await f.page());
  expect(waiting).not.toBe(working);
  f.app.execute(f.auth.actor, { kind: "work.stop", requestId: rid(), expectedRevision: f.app.authority.view(f.auth.actor, work.id).work.revision, payload: { workId: work.id } });
  const revoked = await f.page();
  expect(signature(revoked)).toBe(absent); expect(hasCommand(revoked, "computer.open")).toBe(false);
  const next = f.startWork("Next report"), live = await f.page();
  expect(signature(live)).toContain(next.id); expect(hasCommand(live, "computer.open")).toBe(true);
  f.clock.now += 3600000;
  const expired = await f.page();
  expect(signature(expired)).toBe(absent); expect(hasCommand(expired, "computer.open")).toBe(false);
  expect(f.computer().computer).toBeNull();
});

test("running with nobody driving is view-only: a picture, a typed lease and take over, and no input form", async () => {
  const f = await fixture(); await f.open(); const html = await f.page();
  expect(html).toContain("Nobody is driving"); expect(html).toContain("Running"); expect(html).toContain('<img src="/api/s14/bots/jit/computer/image"'); expect(html).toContain("cannot read these pixels"); strict(html);
  expect(html).not.toContain('type="image"'); expect(formsFor(html, "/s14/bots/jit/computer/input")).toHaveLength(0); expect(hasCommand(html, "takeover.start")).toBe(true);
  expect(html).toContain("None. No internet or website sign-in in this build. Nothing on this computer is shared with another Bot");
  const response = await f.get("/api/s14/bots/jit/computer/image"); expect(response.headers.get("content-type")).toBe("image/png"); expect(response.headers.get("cache-control")).toContain("no-store");
});

test("agent lease reads as the Bot driving; an expired agent lease does not", async () => {
  const f = await fixture(); await f.open();
  const { computer: c, lease } = f.computer();
  f.store.transaction(tx => tx.run("UPDATE input_leases SET record_json=? WHERE computer_id=?", JSON.stringify({ ...lease!, actor: "agent", attemptId: "a", expiresAt: f.clock.now + 60000 }), c!.id));
  const driving = await f.page(); expect(driving).toContain("Jit is driving"); expect(driving).toContain("View only until you take over"); expect(hasCommand(driving, "takeover.start")).toBe(true);
  f.clock.now += 60000;
  expect(await f.page()).toContain("Nobody is driving");
});

test("no-script takeover: start, coordinate, text and key forms post exact fields and land on a readable outcome", async () => {
  const f = await fixture(); await f.open();
  await follow(f, await f.post("/s14/commands", commandOf(await f.page(), "takeover.start")));
  let html = await f.page();
  expect(html).toContain("You are driving"); expect(html).toContain('data-driver="owner"'); strict(html);
  const image = /<input type="image"[^>]*>/.exec(html)![0];
  expect(image).toContain('name="point"'); expect(image).toContain('width="1280"'); expect(image).toContain('height="800"'); expect(image).toContain('tabindex="-1"');
  const click = await f.post("/s14/bots/jit/computer/input", { ...inputForm(html, "click"), "point.x": "1279", "point.y": "799" });
  expect(click.status).toBe(303); const location = click.headers.get("location")!; expect(location).toMatch(/^\/team\/jit\?tab=computer&input=[a-f0-9]+#screen$/);
  html = await f.page(location.replace("#screen", "")); expect(html).toContain("Sent"); expect(html).toContain("Check the picture");
  const typed = await f.post("/s14/bots/jit/computer/input", { ...inputForm(html, "text"), text: "ข้อความ secret-owner-text" }); expect(typed.status).toBe(303);
  html = await f.page(); const keyForm = inputForm(html, "key");
  expect(html.match(/name="key" value="[A-Za-z]+"/g)).toHaveLength(8);
  expect((await f.post("/s14/bots/jit/computer/input", { ...keyForm, key: "Enter" })).status).toBe(303);
  expect(f.runtime!.inputs.map(item => item.input)).toEqual([{ kind: "click", x: 1279, y: 799 }, { kind: "text", text: "ข้อความ secret-owner-text" }, { kind: "key", key: "Enter" }]);
  expect(await f.page()).not.toContain("secret-owner-text");
  const dump = f.store.read(tx => JSON.stringify(tx.all("SELECT * FROM audit")) + JSON.stringify(tx.all("SELECT * FROM command_receipts")) + JSON.stringify(tx.all("SELECT * FROM computer_inputs")));
  expect(dump).not.toContain("secret-owner-text");
});

test("the keyboard coordinate form posts the same exact fields as the image, bounded to the surface", async () => {
  const f = await fixture(); await f.open(); f.lease("takeover.start");
  const html = await f.page(), forms = formsFor(html, "/s14/bots/jit/computer/input").filter(form => form.includes('name="point.x"'));
  expect(forms).toHaveLength(1); expect(forms[0]).toContain('max="1279"'); expect(forms[0]).toContain('max="799"');
  expect((await f.post("/s14/bots/jit/computer/input", { ...fields(forms[0]!), "point.x": "12", "point.y": "34" })).status).toBe(303);
  expect(f.runtime!.inputs.at(-1)!.input).toEqual({ kind: "click", x: 12, y: 34 });
  const refused = await f.post("/s14/bots/jit/computer/input", { ...inputForm(await f.page(), "click"), "point.x": "1280", "point.y": "0" });
  expect(refused.status).toBeGreaterThanOrEqual(400); expect(await refused.text()).toContain('href="/team/jit?tab=computer"');
});

test("an unknown outcome is shown as unknown, offers no resend, and a repeated post never reaches the runtime twice", async () => {
  const f = await fixture(); await f.open(); f.lease("takeover.start");
  f.runtime!.beforeInput = barrier();
  const form = { ...inputForm(await f.page(), "text"), text: "once" };
  const pending = f.post("/s14/bots/jit/computer/input", form);
  await f.runtime!.beforeInput.reached; f.lease("takeover.end"); f.runtime!.beforeInput.release();
  const location = (await pending).headers.get("location")!, html = await f.page(location.replace("#screen", ""));
  expect(html).toContain("Outcome unknown"); expect(html).toContain("will not send it again"); expect(buttons(html).join(" ")).not.toMatch(/retry|resend|again/i);
  expect((await f.post("/s14/bots/jit/computer/input", form)).headers.get("location")).toBe(location);
  expect(f.runtime!.inputs.filter(item => item.input.kind === "text")).toHaveLength(0);
});

test("a stale input page refuses on the styled page, sends nothing and does not promise to keep typed text", async () => {
  const f = await fixture(); await f.open(); f.lease("takeover.start");
  const form = { ...inputForm(await f.page(), "text"), text: "must-not-echo" };
  f.lease("takeover.end"); f.lease("takeover.start");
  const refused = await f.post("/s14/bots/jit/computer/input", form), html = await refused.text();
  expect(refused.status).toBe(409); expect(html).toContain("Text you typed here is not kept"); expect(html).not.toContain("must-not-echo"); expect(html).toContain('href="/team/jit?tab=computer"');
  expect(f.runtime!.inputs).toHaveLength(0);
});

test("handing back is exact, clears the lease and says it approves nothing, while a held action stays on its own card", async () => {
  const f = await fixture({ authority: { effects: { send: async () => "unknown" } } }), work = await f.open();
  const attempt = f.app.authority.admit(work.id, rid(), { botId: "jit", tools: ["computer", "effect_send"], scopes: [], input: "Send", calls: 6, outputBytes: 1024 });
  const effect = f.app.authority.proposeEffect(attempt.id, rid(), { kind: "send", destination: "https://example.invalid", content: "Approve this now" }, f.clock.now + 60000);
  f.lease("takeover.start");
  const html = await f.page();
  expect(html).toContain("A held external action is not approved"); expect(html).toContain("Handing back does not approve a held external action"); expect(html).toContain(`/effects/${effect.id}#slip`); expect(html).not.toContain("Approve this now");
  expect(hasCommand(html, "approval.decide")).toBe(false); expect(buttons(html)).toContain("Hand back");
  await follow(f, await f.post("/s14/commands", commandOf(html, "takeover.end")));
  expect(f.computer().lease!.actor).toBeNull(); expect(f.app.authority.effect(f.auth.actor, effect.id).effect.state).toBe("pending");
  expect(await f.page()).toContain("Nobody is driving");
});

test("an expired owner lease refuses input, reads as timed out and offers only closing it", async () => {
  const f = await fixture(); await f.open(); f.lease("takeover.start");
  f.clock.now += f.computer().computer!.limits.idleMs;
  const html = await f.page();
  expect(html).toContain("Your takeover timed out"); expect(html).not.toContain('type="image"'); expect(formsFor(html, "/s14/bots/jit/computer/input")).toHaveLength(0);
  expect(hasCommand(html, "takeover.start")).toBe(false); expect(hasCommand(html, "takeover.end")).toBe(true); expect(buttons(html)).toContain("Close this takeover");
  strict(html);
});

test("every computer state has words, no lease controls while not running, and only its real lifecycle actions", async () => {
  const f = await fixture(), work = await f.open(), key = f.computer().computer!;
  const expectations: [BotComputer["state"], string, string[], string[]][] = [
    ["starting", "It takes input only after it finishes starting, within 30 seconds", ["computer.stop"], ["computer.reset", "computer.delete"]],
    ["stopping", "only counts as stopped once Jit confirms", [], ["computer.stop"]],
    ["stopped", "Its files and browser profile are kept", [], ["computer.stop"]],
    ["resetting", "erasing its workspace and browser profile", [], ["computer.stop"]],
    ["deleting", "erasing its workspace and browser profile", [], ["computer.stop"]],
    ["deleted", "Its data cannot be recovered", [], ["computer.stop"]],
    ["unavailable", "will not fall back to the host shell", ["computer.stop"], []],
  ];
  for (const [state, words, present, absent] of expectations) {
    f.forceState({ ...key, state, reason: state === "unavailable" ? "computer_isolation_unverified" : null });
    const html = await f.page();
    expect(html).toContain(`<span id="s14-computer-status" class="s-pill ${state === "unavailable" ? "danger" : state === "resetting" || state === "deleting" ? "warn" : ""}">`);
    expect(html).toContain(dictionaries.en[`s14.computer_state.${state}`]); expect(html).toContain(words); expect(html).toContain("Nobody can send input"); strict(html);
    expect(html).not.toContain("data-screen"); expect(html).toContain("No picture while the computer is not running");
    for (const kind of ["takeover.start", "takeover.end"]) expect(hasCommand(html, kind)).toBe(false);
    for (const kind of present) expect(hasCommand(html, kind)).toBe(true);
    for (const kind of absent) expect(hasCommand(html, kind)).toBe(false);
  }
  expect(work.id).toBeTruthy();
});

test("unavailable fails closed with a safe repair; an unmapped or hostile reason renders as inert generic text", async () => {
  const f = await fixture(); await f.open();
  f.forceState({ state: "unavailable", reason: "computer_isolation_unverified" });
  let html = await f.page();
  expect(html).toContain("could not prove the isolation of this computer"); expect(html).toContain("computer_isolation_unverified"); expect(html).toContain("keeps its place"); expect(html).toContain("s14-probe.ts --diagnostics"); expect(hasCommand(html, "computer.stop")).toBe(true);
  f.forceState({ reason: '<form action="/x"><button>Approve</button></form>' });
  html = await f.page();
  expect(html).toContain("could not run this computer safely"); expect(html).not.toContain('<form action="/x">'); expect(buttons(html)).not.toContain("Approve"); strict(html);
});

test("idle stop keeps data and says so; a restart and an ended grant say why without claiming a resume", async () => {
  const f = await fixture(); await f.open();
  f.clock.now += f.computer().computer!.limits.idleMs; f.app.computers.sweep(); await f.app.computers.drain();
  let html = await f.page();
  expect(f.computer().computer!.state).toBe("stopped"); expect(html).toContain("Stopped by itself after no use"); expect(html).toContain("kept");
  f.forceState({ reason: "restart_fenced_no_replay" }); expect(await f.page()).toContain("does not repeat startup, input or erasing");
  f.forceState({ reason: "computer_authority_revoked" }); html = await f.page(); expect(html).toContain("the work that opened it ended");
});

for (const [mode, kind, title, confirm, after] of [["reset", "computer.reset", "Reset the computer of Jit?", "Erase both and reset", "stays as stopped and empty"], ["delete", "computer.delete", "Delete the computer of Jit?", "Erase both and delete", "starts a new, empty computer"]] as const) {
  test(`${mode} goes through a consequence card naming both exact scopes before its one typed command`, async () => {
    const f = await fixture(); await f.open(); const c = f.computer().computer!, panel = await f.page();
    expect(hasCommand(panel, kind)).toBe(false); expect(panel).toContain(`/team/jit?tab=computer&amp;confirm=${mode}#slip`);
    const html = await f.page(`/team/jit?tab=computer&confirm=${mode}`);
    expect(html).toContain(title); expect(html).toContain("cannot be undone"); expect(html).toContain("Jit keeps no backup"); expect(html).toContain(c.workspaceId); expect(html).toContain(c.profileId); expect(html).toContain("What stays"); expect(html).toContain(after); expect(html).toContain("data-focus-on-load"); strict(html);
    expect(buttons(html)).toEqual([confirm]); expect(html).toContain("Keep the computer");
    const form = commandOf(html, kind);
    expect(JSON.parse(form.command!)).toMatchObject({ expectedRevision: c.revision, payload: { botId: "jit", computerId: c.id, generation: c.generation } });
    expect(f.computer().computer!.state).toBe("running");
    await follow(f, await f.post("/s14/commands", form)); await f.app.computers.drain();
    expect(f.computer().computer!.state).toBe(mode === "reset" ? "stopped" : "deleted"); expect(f.runtime!.destroyed).toEqual([c.id]);
  });
}

test("a stale reset page erases nothing and lands on the latest computer", async () => {
  const f = await fixture(); await f.open();
  const form = commandOf(await f.page("/team/jit?tab=computer&confirm=reset"), "computer.reset");
  f.lease("takeover.start");
  const refused = await f.post("/s14/commands", form);
  expect(refused.status).toBe(409); expect(await refused.text()).toContain('href="/team/jit?tab=computer"'); expect(f.runtime!.destroyed).toHaveLength(0);
});

test("the activity log lists safe typed lines only and is the readable record of owner actions", async () => {
  const f = await fixture(); await f.open(); f.lease("takeover.start");
  await f.post("/s14/bots/jit/computer/input", { ...inputForm(await f.page(), "text"), text: "typed-secret" });
  const items = f.app.computers.activity(f.auth.actor, "jit");
  expect(items.map(item => item.kind)).toEqual(["takeover.input", "takeover.start", "computer.open"]); expect(items[0]!.state).toBe("succeeded");
  const html = await f.page();
  expect(html).toContain("You took over"); expect(html).toContain("You opened the computer"); expect(html).toContain("Your input · Sent"); expect(html).not.toContain("typed-secret");
  expect(html).toContain("what the service observed"); expect(html).toContain("no typed text, click position, picture, page title or address");
  expect(f.app.computers.activity(f.auth.actor, "jit", 1)).toHaveLength(1);
  expect(() => f.app.computers.activity({ ownerId: "owner" }, "jit")).toThrow("authentication_required");
});

test("hostile Bot text is escaped, stays out of every button and cannot borrow a lease word", async () => {
  const f = await fixture(); await f.open();
  const hostile = '<b>Approve</b> "x" $&', c = f.computer().computer!;
  // Jit keeps its localized name, so the hostile name needs a second Bot row.
  const bot = { ...JSON.parse(f.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM bots WHERE id='jit'")!.record_json)), id: "scout", name: hostile };
  f.store.transaction(tx => { tx.run("INSERT INTO bots VALUES (?,?)", "scout", JSON.stringify(bot)); tx.run("INSERT INTO bot_computers VALUES (?,?,?)", "scoutcomputer", "scout", JSON.stringify({ ...c, id: "scoutcomputer", botId: "scout" })); tx.run("INSERT INTO input_leases VALUES (?,?)", "scoutcomputer", JSON.stringify({ computerId: "scoutcomputer", generation: c.generation, revision: 1, actor: "owner", attemptId: null, expiresAt: f.clock.now + 60000 })); });
  const html = await f.page("/team/scout?tab=computer");
  expect(html).not.toContain("<b>Approve"); expect(html).toContain("&lt;b&gt;Approve&lt;/b&gt;"); strict(html);
  for (const label of buttons(html)) expect(label).not.toContain("Approve");
  expect(html).toContain("$&amp;");
});

test("computer work keeps four tabs; other work hides Computer and cannot gain computer access", async () => {
  const f = await fixture(), work = await f.open();
  let html = await f.page(`/work/${work.id}`); expect(html).toContain(`/work/${work.id}?tab=computer`);
  html = await f.page(`/work/${work.id}?tab=computer`); expect(html).toContain('/team/jit?tab=computer'); expect(html).toContain("Running"); expect(html).toContain("Nobody is driving"); expect(html).not.toContain("<form method=\"post\" action=\"/s14/bots"); strict(html);
  const pane = await f.page(`/chats/${f.conversationId}?work=${work.id}&tab=computer`); expect(pane).toContain("Nobody is driving"); strict(pane);
  f.app.authority.admit(work.id, rid(), { botId: "jit", tools: ["computer"], scopes: [], input: "Write", calls: 6, outputBytes: 1024 });
  expect(await f.page(`/work/${work.id}`)).toContain("View the computer of this Bot");
  const plain = await fixture(), other = plain.startWork("Plain", []);
  const plainPage = await plain.page(`/work/${other.id}`);
  for (const tab of ["progress", "grant", "evidence"]) expect(plainPage).toContain(`/work/${other.id}?tab=${tab}`);
  expect(plainPage).not.toContain(`/work/${other.id}?tab=computer`);
  expect(await plain.page(`/work/${other.id}?tab=computer`)).not.toContain("Viewing and takeover");
  expect(() => plain.app.execute(plain.auth.actor, { kind: "computer.open", requestId: rid(), expectedRevision: 0, payload: { botId: "jit", workId: other.id } })).toThrow("computer_outside_grant");
});

test("Bot overview, Team and More read the computer honestly", async () => {
  const f = await fixture(); expect(await f.page("/team/jit")).toContain("No computer yet");
  await f.open();
  const overview = await f.page("/team/jit"); expect(overview).toContain("Running"); expect(overview).toContain('href="/team/jit?tab=computer"'); strict(overview);
  expect(await f.page("/team")).toContain("Computer · Running");
  expect(await f.page("/more")).not.toContain("Bot computers");
  const more = await f.page("/more");
  for (const path of ["/memory", "/team/jit?tab=computer", "/settings/web"]) expect(more).toContain(`href="${path}"`);
});

test("Thai renders every state with no raw keys, and both dictionaries define the same computer keys", async () => {
  const f = await fixture({ language: "th" }); await f.open();
  const views = [await f.page()]; f.lease("takeover.start"); views.push(await f.page()); views.push(await f.page("/team/jit?tab=computer&confirm=reset")); views.push(await f.page("/team/jit?tab=computer&confirm=delete"));
  expect(views[0]).toContain("ไม่มีใครคุม"); expect(views[1]).toContain("คุณคุมอยู่"); expect(views[1]).toContain("การคืนเครื่องไม่ได้อนุมัติ"); expect(views[1]).toContain('lang="th"');
  expect(views[2]).toContain("โปรไฟล์เบราว์เซอร์"); expect(views[3]).toContain("ลบเครื่องของจิตไหม");
  for (const html of views) { expect(html).not.toMatch(/s14\.[a-z_]+\.[a-z_]+/); strict(html, "th"); }
  const pick = (locale: "th" | "en") => Object.keys(dictionaries[locale]).filter(key => /^s14\.(computer|lease|screen|input|activity|destroy)/.test(key)).sort();
  expect(pick("th")).toEqual(pick("en"));
  expect(renderFailure("th", "stale_revision", "/team/jit?tab=computer")).toContain("ไม่ถูกเก็บไว้");
  expect(renderFailure("en", "stale_revision", "/work/x")).toContain("Anything you typed is kept");
  expect(fixturePng.length).toBeGreaterThan(0);
});

test("enhancement stays on the page's own forms, the one-event state stream and same-origin reads", () => {
  const script = readFileSync(join(import.meta.dir, "../src/s14/web-enhance.js"), "utf8");
  expect(script).toContain("/events"); expect(script).toContain("form.requestSubmit()"); expect(script).not.toMatch(/WebSocket|RTCPeerConnection|method:\s*"POST"/);
});
