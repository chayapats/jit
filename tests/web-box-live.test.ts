import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { dictionaries } from "../src/i18n";
import { createWebHandler } from "../src/web";
import { effectFixture, rid, setLevel, type EffectFixture } from "./fixtures/effects";
import { fakePng } from "./fixtures/fake-cdp";
import { markSetupComplete } from "./fixtures/setup";

const fixtures: EffectFixture[] = [];
const origin = "http://localhost:3000";
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.close(); rmSync(f.root, { recursive: true, force: true }); rmSync(dirname(f.box.root), { recursive: true, force: true }); }
});
const ok = () => ({ exitCode: 0, stdout: new TextEncoder().encode(JSON.stringify({ v: 1, ok: true, result: { stdout: "", stderr: "", exitCode: 0, timedOut: false } })), stderr: new Uint8Array() });

/** A browser-box installation whose virtual display records xdotool input instead of running it. */
async function liveWorld() {
  const desktop: string[] = [];
  const f = await effectFixture({
    browser: true,
    exec: local => async (handle, request) => {
      const parsed = JSON.parse(new TextDecoder().decode(request.input)) as { op?: string; command?: string };
      if (parsed.op === "spawn" && parsed.command?.includes("xdotool")) { desktop.push(parsed.command); return ok(); }
      // The virtual display: scrot captures a PNG into the box workspace for captureBoxScreen.
      if (parsed.op === "spawn" && parsed.command?.includes("scrot")) {
        mkdirSync(join(handle.workspaceRoot, ".jit"), { recursive: true });
        writeFileSync(join(handle.workspaceRoot, ".jit/screen.png"), fakePng);
        return ok();
      }
      return local(handle, request);
    },
  });
  fixtures.push(f);
  setLevel(f, "workspace");
  return { f, web: createWebHandler(f.app), desktop };
}
const livePath = (f: EffectFixture) => `/projects/${f.project.id}/box/live`;
const shotPath = (f: EffectFixture, id: string) => `/projects/${f.project.id}/box/screenshot/${id}`;
function get(f: EffectFixture, web: ReturnType<typeof createWebHandler>, path: string, token?: string) {
  return web(new Request(`${origin}${path}`, { headers: { cookie: `jit_session=${token ?? f.token}` } }));
}
function postForm(f: EffectFixture, web: ReturnType<typeof createWebHandler>, path: string, fields: Record<string, string>, token?: string) {
  return web(new Request(`${origin}${path}`, { method: "POST", body: new URLSearchParams(fields).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: `jit_session=${token ?? f.token}` } }));
}
function seed(f: EffectFixture) {
  return f.browser!.screenshots.put(f.project.id, fakePng, "agent", f.clock.now);
}
async function startTakeover(f: EffectFixture, web: ReturnType<typeof createWebHandler>) {
  const takeover = f.app.takeover(f.auth.actor, f.project.id);
  const res = await postForm(f, web, `${livePath(f).replace(/\/live$/, "/takeover/start")}`, {
    csrf: f.auth.csrf, requestId: rid(), expectedRevision: String(takeover.revision),
  });
  expect(res.status).toBe(303);
  return f.app.takeover(f.auth.actor, f.project.id);
}

test("(1) GET page with no screenshot → live.no_screenshot text", async () => {
  const { f, web } = await liveWorld();
  const res = await get(f, web, livePath(f));
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain(dictionaries.th["live.no_screenshot"]);
  expect(html).toContain(dictionaries.th["live.refresh"]);
});

test("(2) with a screenshot → <img with the screenshot URL", async () => {
  const { f, web } = await liveWorld();
  const meta = seed(f);
  const html = await (await get(f, web, livePath(f))).text();
  expect(html).toContain(`<img src="${shotPath(f, meta.id)}"`);
  expect(html).toContain('width="1280" height="800"');
  expect(html).toContain("data-live-refresh");
});

test("(3) start takeover → 303; the page now has type=\"image\" name=\"shot\"", async () => {
  const { f, web } = await liveWorld();
  seed(f);
  const takeover = await startTakeover(f, web);
  expect(takeover.active).toBe(true);
  const html = await (await get(f, web, livePath(f))).text();
  expect(html).toContain('type="image" name="shot"');
  expect(html).toContain(dictionaries.th["live.takeover_active"]);
  expect(html).toContain(dictionaries.th["live.takeover_end"]);
});

test("(4) click POST with shot.x=10&shot.y=20 → the EXE14 click runs at {x:10,y:20}; type POST sends text; the stored image is fresh", async () => {
  const { f, web, desktop } = await liveWorld();
  seed(f);
  const takeover = await startTakeover(f, web);
  const shotId = (html: string) => /box\/screenshot\/([a-f0-9-]+)/.exec(html)?.[1];
  const before = shotId(await (await get(f, web, livePath(f))).text());
  expect(before).toBeTruthy();
  const click = await postForm(f, web, `/projects/${f.project.id}/box/takeover/click`, {
    csrf: f.auth.csrf, requestId: rid(), expectedRevision: String(takeover.revision), takeoverId: takeover.takeoverId!, "shot.x": "10", "shot.y": "20",
  });
  expect(click.status).toBe(303);
  expect(desktop.some(command => command.includes("mousemove --sync 10 20 click 1"))).toBe(true);
  const type = await postForm(f, web, `/projects/${f.project.id}/box/takeover/type`, {
    csrf: f.auth.csrf, requestId: rid(), expectedRevision: String(takeover.revision), takeoverId: takeover.takeoverId!, text: "hello",
  });
  expect(type.status).toBe(303);
  expect(desktop.some(command => command.includes("xdotool type") && command.includes("hello"))).toBe(true);
  // Every owner input captures a fresh screenshot, so the page no longer shows a stale image.
  const after = shotId(await (await get(f, web, livePath(f))).text());
  expect(after).toBeTruthy();
  expect(after).not.toBe(before);
});

test("(5) key POST Enter → the owner's word reaches EXE14 as Return", async () => {
  const { f, web, desktop } = await liveWorld();
  seed(f);
  const takeover = await startTakeover(f, web);
  const res = await postForm(f, web, `/projects/${f.project.id}/box/takeover/key`, {
    csrf: f.auth.csrf, requestId: rid(), expectedRevision: String(takeover.revision), takeoverId: takeover.takeoverId!, key: "Enter",
  });
  expect(res.status).toBe(303);
  expect(desktop.some(command => command.includes("xdotool key") && command.includes("Return"))).toBe(true);
  const end = await postForm(f, web, `/projects/${f.project.id}/box/takeover/end`, {
    csrf: f.auth.csrf, requestId: rid(), expectedRevision: String(takeover.revision), takeoverId: takeover.takeoverId!,
  });
  expect(end.status).toBe(303);
  expect(f.app.takeover(f.auth.actor, f.project.id).active).toBe(false);
});

test("(6) screenshot endpoint without a session → login; with one → image/png and no-store", async () => {
  const { f, web } = await liveWorld();
  const meta = seed(f);
  const bare = await web(new Request(`${origin}${shotPath(f, meta.id)}`));
  expect(bare.status).toBe(303);
  expect(bare.headers.get("location")).toBe("/login");
  const res = await get(f, web, shotPath(f, meta.id));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(fakePng);
});

test("(7) GET /box/latest returns {id}", async () => {
  const { f, web } = await liveWorld();
  expect(await (await get(f, web, `/projects/${f.project.id}/box/latest`)).json()).toEqual({ id: null });
  const meta = seed(f);
  expect(await (await get(f, web, `/projects/${f.project.id}/box/latest`)).json()).toEqual({ id: meta.id });
});

test("(8) CSRF missing on POST → 403", async () => {
  const { f, web } = await liveWorld();
  const res = await web(new Request(`${origin}/projects/${f.project.id}/box/takeover/start`, { method: "POST",
    body: new URLSearchParams({ requestId: rid(), expectedRevision: "0" }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: `jit_session=${f.token}` } }));
  expect(res.status).toBe(403);
});

test("(8b) the Refresh screen form captures a fresh screenshot before the page re-renders", async () => {
  const { f, web } = await liveWorld();
  seed(f);
  const html = await (await get(f, web, livePath(f))).text();
  expect(html).toContain(dictionaries.th["live.refresh_screen"]);
  const first = await (await get(f, web, `/projects/${f.project.id}/box/latest`)).json() as { id: string | null };
  expect(first.id).toBeTruthy();
  const res = await postForm(f, web, `/projects/${f.project.id}/box/refresh`, {
    csrf: f.auth.csrf, requestId: rid(), expectedRevision: "0",
  });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(livePath(f));
  const second = await (await get(f, web, `/projects/${f.project.id}/box/latest`)).json() as { id: string | null };
  expect(second.id).toBeTruthy();
  expect(second.id).not.toBe(first.id);
});

test("(9) the live-view enhancement never intercepts a form submit", async () => {
  const source = readFileSync(join(import.meta.dir, "../src/web-assets/app.js"), "utf8");
  // The setup ceremony predates the live view and still submits its own form; the live view itself only polls.
  const live = source.slice(source.indexOf("// Live view"), source.indexOf("// ⌘K"));
  expect(live).toContain("data-live-refresh");
  expect(live).toContain('input[type="image"][data-live-refresh]');
  expect(live).not.toContain("submit");
});

/** A minimal installation whose config either names a browser image or not, for the topic header link. */
async function plainWorld(images: boolean) {
  const root = mkdtempSync(join(tmpdir(), "jit-box-live-"));
  const path = join(root, "state.sqlite");
  const digest = "a".repeat(64);
  const config = readConfig({ JIT_DATABASE: path, ...(images ? { JIT_BOX_IMAGE_BASE: `localhost/jit-box@sha256:${digest}`, JIT_BOX_IMAGE_BROWSER: `localhost/jit-browser@sha256:${digest}` } : {}) });
  const { TransactionStore } = await import("../src/store");
  const store = new TransactionStore(config.databasePath);
  const app = new Application(store, config, { now: () => 1_800_000_000_000 });
  const password = "fixture-box-live-password";
  await app.setupOwner(password);
  markSetupComplete(store);
  const token = await app.login(password), auth = app.authenticate(token);
  const project = app.execute(auth.actor, { kind: "project.create", requestId: rid(), projectId: null, expectedRevision: 0, payload: { name: "กล่อง" } }).project;
  const topic = app.execute(auth.actor, { kind: "topic.create", requestId: rid(), projectId: project.id, expectedRevision: project.revision, payload: { title: "ดูจอ" } }).topic;
  const web = createWebHandler(app);
  return { app, store, root, token, auth, project, topic, web, close: () => store.close() };
}

test("(10) the topic header links the live view only when the box is browser-capable", async () => {
  const plain = await plainWorld(false);
  const browser = await plainWorld(true);
  try {
    const without = await (await plain.web(new Request(`${origin}/projects/${plain.project.id}/topics/${plain.topic.id}`, { headers: { cookie: `jit_session=${plain.token}` } }))).text();
    expect(without).not.toContain(`/projects/${plain.project.id}/box/live`);
    const html = await (await browser.web(new Request(`${origin}/projects/${browser.project.id}/topics/${browser.topic.id}`, { headers: { cookie: `jit_session=${browser.token}` } }))).text();
    expect(html).toContain(`href="/projects/${browser.project.id}/box/live"`);
    expect(html).toContain(dictionaries.th["live.open"]);
  } finally {
    plain.close(); browser.close();
    rmSync(plain.root, { recursive: true, force: true }); rmSync(browser.root, { recursive: true, force: true });
  }
});
