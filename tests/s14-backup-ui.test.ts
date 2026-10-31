import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { SNAPSHOT_NATIVE_FORMAT_VERSION, type HostSessionSnapshot } from "schway/host";
import { dictionaries } from "../src/i18n";
import { opsGuide, restorePrepareStep, stageSteps, type S14OpsStage } from "../src/s14/ops-guide";
import { S14Maintenance } from "../src/s14/ops";
import { opsHash } from "../src/s14/ops-image";
import { opsRoot, readS14Ops } from "../src/s14/ops-state";
import type { OnlineBackupControl, OpsCommand, OpsNativePort } from "../src/s14/ops-types";
import { lookupS14Asset, s14AssetUrl } from "../src/s14/web-assets";
import { createS14Handler } from "../src/s14/web";
import { renderS14 } from "../src/s14/web-pages";
import { S14Store } from "../src/s14/store";
import { createS14Product } from "../src/s14/web-product";
import { accessibilityProblems } from "./fixtures/a11y";
import { barrier } from "./fixtures/s14-computer";
import { domainFixture, retryId, workCommand, type DomainFixture } from "./fixtures/s14-domain";

setDefaultTimeout(30_000);

/**
 * OPS14-01 product surfaces over the real application and handler. Forms are posted the way a browser without script posts
 * them, and the restore journey runs the exact text the page and terminal hand over, through the real offline CLI.
 */
const origin = "http://localhost:3001";
const hostile = '<img src=x onerror=alert(1)><button class="s-btn primary">Approve all</button></pre></div><form action="/s14/commands"><script>alert(1)</script>';
const fixtures: DomainFixture[] = [], offline: S14Maintenance[] = [];
afterEach(() => { for (const m of offline.splice(0)) m.close(); for (const f of fixtures.splice(0)) f.dispose(); });
const unescape = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const backupCommand = (html: string) => { const found = [...html.matchAll(/name="command" value="([^"]*)"/g)].map(m => JSON.parse(unescape(m[1]!)) as { kind: string }).find(item => item.kind === "backup.create"); return found ?? null; };
const strict = (html: string) => { expect(html).not.toMatch(/\sstyle="/); expect(html).not.toMatch(/\son[a-z]+="/); expect(html).not.toContain("javascript:"); expect([...html.matchAll(/<script\b[^>]*>/g)].every(m => m[0].includes('src="/assets/'))).toBe(true); };
const safe = (html: string, language: "th" | "en") => { strict(html); expect(accessibilityProblems(html, language)).toEqual([]); expect(html).not.toContain("<img src=x"); expect(html).not.toContain("<script>alert"); };
const nativePort: OpsNativePort = { supported: () => true, async open() { throw new Error("no native session in this fixture"); } };
const shown = (html: string, text: string) => expect(unescape(html)).toContain(text);
const preBlock = (html: string, id: string) => unescape(new RegExp(`<pre class="s-exact" id="${id}">([\\s\\S]*?)</pre>`).exec(html)![1]!);
const commandIn = (script: string) => JSON.parse(script.split("\n").find(line => line.startsWith('{"kind"'))!) as OpsCommand;

async function fixture(language: "th" | "en" = "en", options: Parameters<typeof domainFixture>[0] = {}) {
  const f = await domainFixture({ backups: nativePort, ...options }); fixtures.push(f);
  if (language === "th") f.app.execute(f.auth.actor, { kind: "owner.preferences.set", requestId: retryId(), expectedRevision: f.app.home(f.auth.actor).revision, payload: { language: "th", theme: "system" } });
  let token = f.token;
  const handler = () => createS14Handler(f.app, origin, renderS14, createS14Product(f.app));
  const cookie = () => `jit_s14=${token}`, words = dictionaries[language];
  const get = (route: string) => handler()(new Request(`${origin}${route}`, { headers: { cookie: cookie() } }));
  const page = async (route: string) => { const response = await get(route); expect(response.status).toBe(200); return response.text(); };
  const post = (route: string, fields: Record<string, string>) => handler()(new Request(`${origin}${route}`, { method: "POST", headers: { cookie: cookie(), origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }));
  const land = async (response: Response) => { let current = response, path = ""; for (let hop = 0; hop < 4 && current.status === 303; hop++) { path = current.headers.get("location")!; current = await get(path); } return { status: current.status, html: await current.text(), path }; };
  /** Presses the rendered Back up now form exactly as a browser without script would. */
  const press = async (html: string) => { const command = backupCommand(html)!, csrf = f.app.authenticate(token).csrf; return land(await post("/s14/commands", { csrf, command: JSON.stringify(command) })); };
  /** A backup through the real press, settled. */
  const backup = async () => { await press(await page("/settings/backup")); await f.app.backups.settle(); return f.app.backups.status(f.auth.actor).latest!.backupId; };
  return { f, language, words, page, get, post, land, press, backup, relogin: async () => { token = await f.app.login("domain-fixture-owner-password"); f.auth = f.app.authenticate(token); } };
}
const journalPath = (f: DomainFixture) => join(opsRoot(f.path), "online-backups.json");
/** Rewrites the journal the way a past outcome left it; the page must read whatever is durable. */
function patchLatest(f: DomainFixture, change: (result: OnlineBackupControl["requests"][number]["result"]) => void) {
  const control = JSON.parse(readFileSync(journalPath(f), "utf8")) as OnlineBackupControl;
  change(control.requests.at(-1)!.result);
  writeFileSync(journalPath(f), JSON.stringify(control));
}
function patchRegistry(f: DomainFixture, change: (control: ReturnType<typeof readS14Ops>) => void) {
  const control = readS14Ops(f.path); change(control); writeFileSync(join(opsRoot(f.path), "control.json"), JSON.stringify(control));
}
/** One retired session, so a capture has a native step that a test can hold open. */
function stalledNative(f: DomainFixture, snapshots: Map<string, HostSessionSnapshot>) {
  const packet = f.store.transaction(tx => f.app.memory.assemble(tx, { botId: "jit", conversationId: f.conversationId, purpose: "fixture", sources: [] }));
  const intent = f.app.recovery.intent(null, packet.id, f.options.policy.routes[0]!), reference = { id: crypto.randomUUID(), branchId: "main" }, bytes = Buffer.from("opaque native fixture");
  f.app.recovery.correlate(intent.id, reference); f.app.recovery.retired(intent.id);
  snapshots.set(intent.id, { snapshotContract: "schway.host.session-snapshot/v1", nativeFormatVersion: SNAPSHOT_NATIVE_FORMAT_VERSION, createdAt: "2026-10-31T00:00:00.000Z", sessions: [{ ...reference, workspaceRoot: "/fixture", headerCreatedAt: "2026-10-31T00:00:00.000Z", nativeFormatVersion: SNAPSHOT_NATIVE_FORMAT_VERSION, retired: true, artifacts: [{ kind: "conversation", size: bytes.length, sha256: opsHash(bytes), dataBase64: bytes.toString("base64") }] }] });
}
function heldPort(entered: ReturnType<typeof barrier>, snapshots: Map<string, HostSessionSnapshot>): OpsNativePort {
  return { supported: () => true, async open(intent) {
    await entered.wait();
    return { async snapshotSessions() { return structuredClone(snapshots.get(intent.id)!); }, validateSessionSnapshot: snapshot => ({ status: "valid", sessions: (snapshot as HostSessionSnapshot).sessions.map(s => ({ id: s.id, branchId: s.branchId })), nextAction: "none" }), async restoreSessionSnapshot() { return { status: "restored", sessions: [], nextAction: "none" }; }, async listSessions() { return { sessions: [] }; }, async retireSession() {}, async deleteSession(reference) { return { status: "deleted", session: reference, removed: [], nextAction: "none" }; }, async close() {} };
  } };
}

/** Extracts a real rendered region, including nested elements, for the enhancement script's small DOM fixture. */
function liveRegion(html: string, id: string) {
  const opening = new RegExp(`<([a-z]+)\\b[^>]* id="${id}"[^>]*>`).exec(html)!;
  expect(opening, id).not.toBeNull();
  const start = opening.index + opening[0].length, tags = new RegExp(`</?${opening[1]}\\b[^>]*>`, "g");
  tags.lastIndex = start;
  let depth = 1, end = start;
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    depth += tag[0].startsWith("</") ? -1 : 1;
    if (!depth) { end = tag.index; break; }
  }
  return { innerHTML: html.slice(start, end), className: /class="([^"]*)"/.exec(opening[0])?.[1] ?? "", dataset: {}, contains: () => false,
    querySelector(selector: string) { return selector === "details[open]" && /<details[^>]* open/.test(this.innerHTML) ? {} : null; } };
}

test.each(["th", "en"] as const)("%s: the final live read refreshes the list, restore and workers while the first-page details stays open", async language => {
  const hold = barrier(), snapshots = new Map<string, HostSessionSnapshot>();
  const { f, page, press, words } = await fixture(language, { backups: heldPort(hold, snapshots) });
  stalledNative(f, snapshots);
  await press(await page("/settings/backup")); await hold.reached;
  const before = await page("/settings/backup");
  hold.release(); await f.app.backups.settle();
  const after = await page("/settings/backup"), id = f.app.backups.status(f.auth.actor).latest!.backupId;
  const ids = ["s14-live", "s14-backup-list", "s14-backup-restore", "s14-backup-version"];
  const current = new Map(ids.map(id => [id, liveRegion(before, id)])), fresh = new Map(ids.map(id => [id, liveRegion(after, id)]));
  const details = { open: true };
  expect(before).toContain('<details class="s-card s-more" open>');
  const document = (regions: typeof current, live: boolean) => ({ documentElement: { dataset: {} }, body: {}, activeElement: null,
    getElementById: (id: string) => regions.get(id) ?? null, querySelectorAll: () => [],
    querySelector: (selector: string) => selector === "[data-live]" && live ? {} : selector === "details[open]" ? details : null });
  const ticks: (() => Promise<void>)[] = [];
  runInNewContext(readFileSync(new URL("../src/s14/web-enhance.js", import.meta.url), "utf8"), {
    document: document(current, true), location: { href: `${origin}/settings/backup`, hash: "" },
    DOMParser: class { parseFromString() { return document(fresh, false); } },
    fetch: async () => ({ ok: true, text: async () => after }), setTimeout: (tick: () => Promise<void>) => ticks.push(tick),
  });
  expect(ticks).toHaveLength(1); await ticks.shift()!();
  for (const id of ids) expect(current.get(id)!.innerHTML, id).toBe(fresh.get(id)!.innerHTML);
  expect(current.get("s14-live")!.innerHTML).toContain(words["s14.backup.done_title"]);
  expect(current.get("s14-backup-list")!.innerHTML).toContain(`/settings/backup/${id}`);
  expect(current.get("s14-backup-restore")!.innerHTML).toContain(words["s14.backup.restore_pick"]);
  expect(current.get("s14-backup-version")!.innerHTML).toContain(words["s14.backup.workers.running"]);
  expect(details.open).toBe(true);
  expect(ticks).toHaveLength(0);
});

test.each(["th", "en"] as const)("%s: More reaches an honest first page with one press and the fixed lists", async language => {
  const { words, page } = await fixture(language);
  expect(await page("/more")).toContain('href="/settings/backup"');
  const html = await page("/settings/backup");
  safe(html, language);
  shown(html, words["s14.backup.first_title"]);
  shown(html, words["s14.backup.empty"]);
  shown(html, words["s14.backup.restore_none"]);
  shown(html, words["s14.backup.outside.accounts"]);
  shown(html, words["s14.backup.reconnect_note"]);
  shown(html, words["s14.backup.upgrades_detail"]);
  expect(html).not.toContain("data-live");
  expect(backupCommand(html)).toMatchObject({ kind: "backup.create", expectedRevision: 0, payload: {} });
});

test.each(["th", "en"] as const)("%s: a no-script press lands on the durable result, and the same form never captures twice", async language => {
  const { f, words, page, press, post, land } = await fixture(language);
  const html = await page("/settings/backup"), landed = await press(html);
  expect(landed.status).toBe(200);
  expect(landed.path).toMatch(/^\/settings\/backup\?request=[a-f0-9]{32}$/);
  await f.app.backups.settle();
  const done = await page(landed.path);
  safe(done, language);
  shown(done, words["s14.backup.done_title"]);
  shown(done, words["s14.backup.state.complete"]);
  expect(done).toMatch(/\d(\.\d)? (KiB|MiB)/);
  shown(done, words["s14.backup.origin.online"]);
  expect(done).not.toContain("data-live");
  const again = await land(await post("/s14/commands", { csrf: f.app.authenticate(f.token).csrf, command: /name="command" value="([^"]*)"/.exec(html)![1]!.replaceAll("&quot;", '"') }));
  expect(again.path).toBe(landed.path);
  expect(f.app.backups.status(f.auth.actor).retention.count).toBe(1);
});

test("the running service still answers JSON on its bare ingress, and a page press redirects", async () => {
  const { f, post } = await fixture();
  const body = { kind: "backup.create", requestId: retryId(), expectedRevision: 0, payload: {} };
  const bare = createS14Handler(f.app, origin);
  const receipt = await bare(new Request(`${origin}/s14/commands`, { method: "POST", headers: { cookie: `jit_s14=${f.token}`, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: f.auth.csrf, command: JSON.stringify(body) }).toString() }));
  expect(receipt.status).toBe(202);
  await f.app.backups.settle();
  const redirected = await post("/s14/commands", { csrf: f.auth.csrf, command: JSON.stringify(body) });
  expect(redirected.status).toBe(303);
  expect(redirected.headers.get("location")).toBe(`/settings/backup?request=${body.requestId}`);
});

test.each(["th", "en"] as const)("%s: progress shows words and counts, offers no second press, and says so when it runs long", async language => {
  const entered = barrier(), snapshots = new Map<string, HostSessionSnapshot>();
  const { f, words, page, press } = await fixture(language, { backups: heldPort(entered, snapshots) });
  stalledNative(f, snapshots);
  const landed = await press(await page("/settings/backup"));
  await entered.reached;
  const html = await page("/settings/backup");
  safe(html, language);
  expect(html).toContain("data-live");
  shown(html, words["s14.backup.saving"]);
  expect(html).toContain(words["s14.backup.count_of"].replace("{done}", "0").replace("{total}", "1"));
  shown(html, words["s14.backup.paused_note"]);
  shown(html, words["s14.backup.workers.paused"]);
  expect(html).toContain(`data-phase="${words["s14.backup.state.capturing"]}"`);
  expect(html).toContain(`href="${landed.path}"`);
  expect(html).not.toContain("%");
  expect(backupCommand(html)).toBeNull();
  patchLatest(f, result => { result.progress.phase = "waiting_native_settlement"; });
  const slow = await page("/settings/backup");
  shown(slow, words["s14.backup.slow_title"]);
  expect(backupCommand(slow)).toBeNull();
  entered.release(); await f.app.backups.settle();
  expect(await page("/settings/backup")).toContain(words["s14.backup.done_title"]);
});

test("a capture in flight outranks an older landing link, and an old form is refused with words", async () => {
  const entered = barrier(), snapshots = new Map<string, HostSessionSnapshot>();
  const { f, words, page, press } = await fixture("en", { backups: heldPort(entered, snapshots) });
  const form = await page("/settings/backup"), first = await press(form);
  await f.app.backups.settle();
  stalledNative(f, snapshots);
  await press(await page("/settings/backup"));
  await entered.reached;
  const older = await page(first.path);
  expect(older).toContain(`data-phase="${words["s14.backup.state.capturing"]}"`);
  expect(backupCommand(older)).toBeNull();
  entered.release(); await f.app.backups.settle();
  const next = await press(form.replace(/&quot;requestId&quot;:&quot;[a-f0-9]{32}/, `&quot;requestId&quot;:&quot;${retryId()}`));
  expect(next.status).toBe(409);
  shown(next.html, words["s14.error.stale_revision"]);
  expect(next.html).toContain('href="/settings/backup"');
});

test.each(["th", "en"] as const)("%s: a failed capture stays on the page after a reload, with its cause and a way forward", async language => {
  const { f, words, page, press } = await fixture(language);
  await press(await page("/settings/backup")); await f.app.backups.settle();
  for (const reason of ["s14_backup_deadline_exceeded", "s14_backup_interrupted_no_auto_retry", "s14_ops_credential_excluded", "s14_backup_capture_failed"]) {
    patchLatest(f, result => { result.state = "blocked"; result.reason = reason; result.progress.phase = "blocked"; });
    const html = await page("/settings/backup");
    safe(html, language);
    shown(html, words[`s14.error.${reason}` as keyof typeof words]);
    shown(html, words[`s14.next.${reason}` as keyof typeof words]);
    shown(html, words["s14.backup.state.blocked"]);
    expect(html).toContain(reason);
    expect(backupCommand(html)).not.toBeNull();
  }
});

test("a hostile journal reason renders as inert text, with no invented cause", async () => {
  const { f, words, page, press } = await fixture();
  await press(await page("/settings/backup")); await f.app.backups.settle();
  patchLatest(f, result => { result.state = "blocked"; result.reason = hostile; });
  const html = await page("/settings/backup");
  safe(html, "en");
  shown(html, words["s14.backup.reason_generic"]);
  expect(html).toContain("&lt;img src=x");
});

test("a landing link cannot fake a result, and hostile request text is not echoed", async () => {
  const { page, words } = await fixture();
  for (const route of [`/settings/backup?request=${retryId()}`, `/settings/backup?request=${encodeURIComponent(hostile)}`]) {
    const html = await page(route);
    safe(html, "en");
    shown(html, words["s14.backup.first_title"]);
    expect(html).not.toContain(words["s14.backup.done_title"]);
  }
});

test("an unresolved native close keeps work paused and points at a restart, with no press", async () => {
  const { f, words, page, press } = await fixture();
  await press(await page("/settings/backup")); await f.app.backups.settle();
  patchLatest(f, result => { result.state = "blocked"; result.reason = "s14_ops_native_close_unresolved"; result.workers = "paused"; result.progress.phase = "blocked"; });
  writeFileSync(join(opsRoot(f.path), "capture.json"), JSON.stringify({ contract: "app.managed-backup/v1", requestId: f.app.backups.status(f.auth.actor).latest!.requestId, backupId: f.app.backups.status(f.auth.actor).latest!.backupId }));
  const html = await page("/settings/backup");
  safe(html, "en");
  shown(html, words["s14.next.s14_ops_native_close_unresolved"]);
  expect(backupCommand(html)).toBeNull();
  shown(html, words["s14.backup.workers.paused"]);
});

test.each(["th", "en"] as const)("%s: running work is named before a press, with its title escaped, and the press returns once it settles", async language => {
  const hold = barrier();
  const { f, words, page, post, land, backup } = await fixture(language, { authority: { executor: { async run() { await hold.wait(); return { state: "ready", text: "Done" }; } } } });
  const id = await backup(), work = workCommand(f, { title: hostile }), form = await page("/settings/backup");
  f.app.execute(f.auth.actor, work);
  const running = f.app.authority.drain();
  await hold.reached;
  const html = await page("/settings/backup");
  safe(html, language);
  shown(html, words["s14.backup.hold_title"]);
  expect(html).toContain("&lt;img src=x");
  expect(html).toContain("data-live");
  const restore = await page(`/settings/backup/${id}/restore`);
  safe(restore, language);
  shown(restore, words["s14.restore.settle_title"]);
  expect(backupCommand(html)).toBeNull();
  const refused = await land(await post("/s14/commands", { csrf: f.auth.csrf, command: /name="command" value="([^"]*)"/.exec(form)![1]!.replaceAll("&quot;", '"') }));
  expect(refused.status).toBe(409);
  shown(refused.html, words["s14.error.s14_ops_quiesce_required"]);
  expect(refused.html).toContain('href="/settings/backup"');
  hold.release(); await running;
  expect(backupCommand(await page("/settings/backup"))).not.toBeNull();
});

test("a sign-in or missing native support explains itself and offers no press", async () => {
  const unsupported = await fixture("en", { backups: { ...nativePort, supported: () => false } });
  const html = await unsupported.page("/settings/backup");
  shown(html, unsupported.words["s14.error.s14_ops_native_unsupported"]);
  expect(backupCommand(html)).toBeNull();
  const absent = await fixture("en");
  delete (absent.f.options as { backups?: unknown }).backups;
  (absent.f.app.backups as unknown as { native: undefined }).native = undefined;
  expect(backupCommand(await absent.page("/settings/backup"))).toBeNull();
});

test.each(["th", "en"] as const)("%s: one backup says what is inside, where it is, and that there is no download", async language => {
  const { f, words, page, backup } = await fixture(language), id = await backup();
  const html = await page(`/settings/backup/${id}`);
  safe(html, language);
  shown(html, words["s14.backup.health.intact_detail"]);
  shown(html, words["s14.backup.inside.work"]);
  shown(html, words["s14.backup.outside.password"]);
  shown(html, words["s14.backup.where_copy"]);
  expect(html).toContain(`.ops/backups/${id}/`);
  expect(html).not.toContain(dirname(f.path));
  expect(html).toContain(`href="/settings/backup/${id}/restore"`);
  expect(html).not.toContain('action="/s14/commands"');
});

test("damage and an unknown format are named on the list and close the restore steps", async () => {
  const { f, words, page, backup } = await fixture(), damaged = await backup(), unsupported = await backup(), unreadable = await backup();
  const folder = (id: string) => join(opsRoot(f.path), "backups", id);
  unlinkSync(join(folder(damaged), "application.sqlite"));
  const manifest = JSON.parse(readFileSync(join(folder(unsupported), "manifest.json"), "utf8")); manifest.schema = 99;
  writeFileSync(join(folder(unsupported), "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(folder(unreadable), "manifest.json"), "{not json");
  const list = await page("/settings/backup");
  safe(list, "en");
  shown(list, words["s14.backup.health.damaged"]);
  shown(list, words["s14.backup.health.unsupported"]);
  for (const id of [damaged, unsupported, unreadable]) {
    const item = await page(`/settings/backup/${id}`), steps = await page(`/settings/backup/${id}/restore`);
    expect(item).not.toContain(`/settings/backup/${id}/restore`);
    expect(steps).not.toContain("restore.prepare");
    safe(steps, "en");
  }
  expect(await page(`/settings/backup/${unreadable}`)).toContain(words["s14.unknown"]);
});

test("an unknown backup is a plain missing page, and a foreign address never reads a path", async () => {
  const { get, words } = await fixture();
  const missing = await get(`/settings/backup/${retryId()}`);
  expect(missing.status).toBe(404);
  shown(await missing.text(), words["s14.error.generic"]);
  expect((await get("/settings/backup/..%2f..%2fetc")).status).toBe(404);
});

test("retention is stated, a full protected list refuses before the press, and a tenth slot closes restore", async () => {
  const { f, words, page, backup } = await fixture(), id = await backup();
  const others = Array.from({ length: 8 }, () => retryId());
  patchRegistry(f, control => { control.backups = [...others, id]; });
  const html = await page("/settings/backup");
  shown(html, words["s14.backup.create_note_full"]);
  shown(html, words["s14.backup.retention_protected"]);
  expect(backupCommand(html)).not.toBeNull();
  patchRegistry(f, control => { control.backups = [...others, retryId()]; });
  const full = await page("/settings/backup");
  shown(full, words["s14.error.s14_ops_retention_full"]);
  expect(backupCommand(full)).toBeNull();
  patchRegistry(f, control => { control.backups = [...others, retryId(), id]; });
  const restore = await page(`/settings/backup/${id}/restore`);
  shown(restore, words["s14.restore.no_room"]);
  expect(restore).not.toContain("restore.prepare");
});

test("a full retry journal says so and offers no press", async () => {
  const { f, words, page, press } = await fixture();
  await press(await page("/settings/backup")); await f.app.backups.settle();
  const control = JSON.parse(readFileSync(journalPath(f), "utf8")) as OnlineBackupControl;
  control.revision = 100; writeFileSync(journalPath(f), JSON.stringify(control));
  const html = await page("/settings/backup");
  shown(html, words["s14.error.s14_ops_receipt_bound"]);
  expect(backupCommand(html)).toBeNull();
});

test.each(["th", "en"] as const)("%s: restore explains itself and hands over one exact command, with no control on the page", async language => {
  const { f, words, page, backup, post } = await fixture(language), id = await backup();
  const html = await page(`/settings/backup/${id}/restore`);
  safe(html, language);
  for (const key of ["s14.restore.terminal_title", "s14.restore.terminal_detail", "s14.restore.plan.stop", "s14.restore.plan.recovery", "s14.restore.after.deleted_detail", "s14.restore.after.newer_detail", "s14.restore.after.accounts_detail", "s14.restore.after.password_detail", "s14.restore.after.work_detail", "s14.restore.keep_open", "s14.restore.halfway_detail"] as const) shown(html, words[key]);
  const script = preBlock(html, "s14-restore-prepare"), command = commandIn(script), revision = readS14Ops(f.path).revision;
  expect(command).toMatchObject({ kind: "restore.prepare", expectedRevision: revision, payload: { backupId: id } });
  expect(script).toContain("bun src/main.ts ops --s14 --command .local/s14-restore-prepare.json");
  expect(script).not.toMatch(/password/i);
  expect(preBlock(await page(`/settings/backup/${id}/restore`), "s14-restore-prepare")).toBe(script);
  expect(html).toContain('data-copy="s14-restore-prepare"');
  expect(html).not.toContain("<form method=\"post\" action=\"/s14/commands\"");
  const refused = await post("/s14/commands", { csrf: f.auth.csrf, command: JSON.stringify(command) });
  expect(refused.status).toBe(409);
  shown(await refused.text(), words["s14.error.s14_ops_offline_required"]);
});

test("a new backup moves the revision the restore command binds", async () => {
  const { page, backup } = await fixture(), id = await backup();
  const before = commandIn(preBlock(await page(`/settings/backup/${id}/restore`), "s14-restore-prepare"));
  await backup();
  expect(commandIn(preBlock(await page(`/settings/backup/${id}/restore`), "s14-restore-prepare")).expectedRevision).toBe(before.expectedRevision + 1);
});

async function openStage(f: DomainFixture, id: string, run: (m: S14Maintenance, actor: ReturnType<S14Maintenance["app"]["authenticate"]>["actor"]) => Promise<void>) {
  f.store.close();
  const m = new S14Maintenance(f.path, f.options, nativePort); offline.push(m);
  const actor = m.app.authenticate(f.token).actor;
  await run(m, actor);
  m.close(); offline.pop();
  f.reopen();
  return id;
}
const maintenanceCommand = (m: S14Maintenance, kind: OpsCommand["kind"], payload: object) => ({ kind, requestId: retryId(), expectedRevision: m.control.revision, payload }) as OpsCommand;

test.each(["th", "en"] as const)("%s: a finished restore or discard stays as a calm record with the honest limit", async language => {
  const { f, words, page, backup } = await fixture(language), id = await backup();
  await openStage(f, id, async (m, actor) => {
    const staged = await m.execute(actor, maintenanceCommand(m, "restore.prepare", { backupId: id }));
    await m.execute(actor, maintenanceCommand(m, "restore.discard", { stageId: staged.stage!.id }));
  });
  const discarded = await page("/settings/backup");
  safe(discarded, language);
  shown(discarded, words["s14.backup.last.discarded_restore"]);
  shown(discarded, words["s14.backup.stage.discarded"]);
  patchRegistry(f, control => { control.stage!.state = "complete"; });
  const complete = await page("/settings/backup");
  safe(complete, language);
  shown(complete, words["s14.backup.last.complete_restore"]);
  shown(complete, words["s14.backup.last.complete_detail"]);
  expect(complete).toContain(readS14Ops(f.path).stage!.recoveryBackupId);
  expect(complete).toContain('href="/recovery"');
  expect(complete).not.toContain("restore.activate");
});

test("the full restore runs from the exact text the page and terminal print, through the real offline CLI", async () => {
  const { f, page, backup, words } = await fixture(), id = await backup();
  const script = preBlock(await page(`/settings/backup/${id}/restore`), "s14-restore-prepare");
  f.store.close();
  const env = { ...process.env, JIT_S14_DATABASE: f.path, JIT_S14_ROUTES: JSON.stringify(f.options.policy.routes), JIT_S14_RESOURCES: JSON.stringify(f.options.policy.resources) };
  const work = join(f.root, "operator"); mkdirSync(join(work, ".local"), { recursive: true, mode: 0o700 });
  const run = async (block: string) => {
    const json = block.split("\n").find(line => line.startsWith('{"kind"'))!, file = join(work, ".local", "command.json");
    rmSync(file, { force: true }); writeFileSync(file, json, { mode: 0o600 });
    const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../src/main.ts"), "ops", "--s14", "--password-stdin", "--command", file], { cwd: join(import.meta.dir, ".."), env, stdin: new Blob(["domain-fixture-owner-password"]), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited).toBe(0);
    return { receipt: JSON.parse(stdout) as { state: string; stage: S14OpsStage; revision: number }, stderr };
  };
  const prepared = await run(script);
  expect(prepared.receipt.state).toBe("validated");
  // The Web cannot show this stage: the store refuses to open, so the terminal is the only place its details appear.
  expect(() => new S14Store(f.path)).toThrow("s14_ops_reconciliation_required");
  const status = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../src/main.ts"), "ops", "--s14", "--password-stdin"], { cwd: join(import.meta.dir, ".."), env, stdin: new Blob(["domain-fixture-owner-password"]), stdout: "pipe", stderr: "pipe" });
  const reprinted = await new Response(status.stderr).text();
  expect(await status.exited).toBe(0);
  expect(reprinted).toBe(prepared.stderr);
  expect(prepared.stderr).toContain(prepared.receipt.stage.actionHash!);
  expect(prepared.stderr).toContain(words["s14.backup.guide.validated_restore"]);
  expect(prepared.stderr).toContain('"kind":"restore.discard"');
  const activate = prepared.stderr.split("\n").filter(line => line.startsWith('{"kind":"restore.activate"'));
  expect(activate).toHaveLength(1);
  const done = await run(activate[0]!);
  expect(done.receipt.state).toBe("complete");
  expect(done.stderr).toContain(words["s14.backup.guide.finished_restore"]);
  expect(done.stderr).toContain("bun src/main.ts serve --s14");
});

test("guide text covers every stage state in both languages with nothing left unfilled", () => {
  const base: S14OpsStage = { id: "a".repeat(32), mode: "restore", backupId: "b".repeat(32), state: "validated", reason: null, actionHash: "c".repeat(64), recoveryBackupId: "d".repeat(32) };
  for (const locale of ["th", "en"] as const) for (const mode of ["restore", "upgrade"] as const) for (const state of ["preparing", "validated", "activating", "complete", "partial", "blocked", "discarded"] as const) {
    const stage = { ...base, mode, state, reason: state === "blocked" ? "s14_ops_integrity_failed" : null };
    const text = opsGuide({ revision: 4, state, stage }, locale);
    expect(text).not.toMatch(/\{[a-z]+\}/);
    expect(text.length).toBeGreaterThan(0);
    if (state === "partial" || state === "blocked") expect(text).not.toContain("restore.activate");
    if (state === "blocked") expect(text).toContain(dictionaries[locale]["s14.next.s14_ops_integrity_failed"]);
  }
  expect(stageSteps({ ...base, mode: "upgrade" }, 1).map(step => step.command.kind)).toEqual(["restore.activate", "upgrade.rollback"]);
  expect(stageSteps({ ...base, actionHash: "not-a-hash" }, 1).map(step => step.command.kind)).toEqual(["restore.discard"]);
  expect(opsGuide({ revision: 1, stage: null })).toBe("");
  expect(opsGuide({ revision: 1, stage: { ...base, state: "complete" } })).toBe("");
  expect(opsGuide({ revision: 1, stage: null, pendingBackupId: base.id }, "en")).toContain('"kind":"restore.discard"');
  const once = restorePrepareStep(3, base.id), reprinted = restorePrepareStep(3, base.id);
  expect(once.command.requestId).toBe(reprinted.command.requestId);
  expect(once.command.requestId).not.toBe(restorePrepareStep(4, base.id).command.requestId);
  expect(once.command.requestId).toMatch(/^[a-f0-9]{32}$/);
});

test("every published safe reason has a word in both languages", () => {
  const contract = readFileSync(join(import.meta.dir, "../docs/contracts/s14-foundation-http.md"), "utf8");
  const codes = [...new Set([...contract.slice(contract.indexOf("## OPS14-01 managed installation seam"), contract.indexOf("## PR #275")).matchAll(/`(s14_(?:ops|backup|lifecycle)_[a-z_]+)`/g)].map(m => m[1]!))];
  expect(codes.length).toBeGreaterThan(20);
  for (const locale of ["th", "en"] as const) for (const code of codes) expect(dictionaries[locale][`s14.error.${code}` as keyof typeof dictionaries.th]).toBeTruthy();
});

test("the stylesheet is served, and Copy targets its own block while the sign-in code keeps working", () => {
  expect(new TextDecoder().decode(lookupS14Asset(s14AssetUrl("s14.css"))!.body)).toContain(".s-backup-run");
  const source = readFileSync(new URL("../src/s14/web-enhance.js", import.meta.url), "utf8");
  const writes: string[] = [];
  const buttons = [{ hidden: true, textContent: "Copy", dataset: { copy: "s14-block", copied: "Copied" }, listener: null as null | (() => Promise<void>), addEventListener(_: string, run: () => Promise<void>) { this.listener = run; } },
    { hidden: true, textContent: "Copy code", dataset: { copy: "", copied: "Copied" }, listener: null as null | (() => Promise<void>), addEventListener(_: string, run: () => Promise<void>) { this.listener = run; } }];
  const page = { documentElement: { dataset: {} }, activeElement: null, getElementById: (id: string) => id === "s14-block" ? { textContent: "exact command" } : null, querySelectorAll: (selector: string) => selector === "[data-copy]" ? buttons : [], querySelector: (selector: string) => selector === "[data-copy-source]" ? { textContent: "CODE" } : null };
  runInNewContext(source, { document: page, location: { href: `${origin}/`, hash: "" }, navigator: { clipboard: { writeText: async (value: string) => { writes.push(value); } } }, matchMedia: () => ({ matches: false }), setTimeout: () => {} });
  expect(buttons.every(button => !button.hidden)).toBe(true);
  return Promise.all(buttons.map(button => button.listener!())).then(() => expect(writes).toEqual(["exact command", "CODE"]));
});
