import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "schway/host";
import { ConnectionVault } from "../src/exec/connections";
import { dictionaries } from "../src/i18n";
import { S14Application } from "../src/s14/application";
import type { GitAction, GitRemotePort, GitRemoteProof } from "../src/s14/coding-git-types";
import { S14Store } from "../src/s14/store";
import { createS14Handler } from "../src/s14/web";
import { renderS14 } from "../src/s14/web-pages";
import { createS14Product } from "../src/s14/web-product";
import { commandWords, repositoryUrl } from "../src/s14/web-product-coding";
import { accessibilityProblems } from "./fixtures/a11y";
import { CodingRuntimeFixture, codingScript } from "./fixtures/s14-coding";

// Every case runs a real repository through the whole product; a loaded CI runner exceeds the default 5 s.
setDefaultTimeout(60_000);

/**
 * CODE14-01 and CODE14-02 product surfaces over the real application, scheduler, broker and handler. Forms are posted the way a browser
 * without script posts them: fields are read out of the rendered HTML. The repository is generated and GitHub is a scripted port.
 */
const origin = "http://localhost:3001", password = "fixture-s14-coding-owner-password", secret = "fixture-git-token-for-trusted-broker-only";
const hostile = '<img src=x onerror=alert(1)><button class="s-btn primary">Approve all</button></pre></div><form action="/s14/commands"><script>alert(1)</script>';
const rid = () => crypto.randomUUID().replaceAll("-", "");
const roots: string[] = [], stores: S14Store[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

class RemoteFixture implements GitRemotePort {
  head: string | null = null; base = ""; prs: GitRemoteProof["prs"] = []; pushes = 0; creates = 0; incomplete = false;
  pushOutcome: "succeeded" | "failed" | "unknown" = "succeeded"; prOutcome: "succeeded" | "failed" | "unknown" = "succeeded";
  async push(_mirror: string, action: GitAction, _token: string, allowed: () => void) { allowed(); this.pushes++; if (this.pushOutcome !== "failed") this.head = action.headCommit; return this.pushOutcome; }
  async createPr(action: GitAction, _token: string, allowed: () => void) {
    allowed(); this.creates++;
    if (this.prOutcome !== "failed") this.prs.push({ number: 17, headCommit: action.headCommit, baseCommit: action.pr!.baseCommit, head: action.update.ref.slice(11), base: action.pr!.base, title: action.pr!.title, body: action.pr!.body, draft: action.pr!.draft });
    return { outcome: this.prOutcome, number: this.prOutcome === "succeeded" ? 17 : null };
  }
  async readBack(_action: GitAction, _token: string, allowed: () => void) { allowed(); return { headCommit: this.head, baseCommit: this.base, prs: structuredClone(this.prs), complete: !this.incomplete }; }
}
/** Model edits through the real bash tool. `claim` is what it says at the end, and nothing on a page may treat that as a result. */
function scripted(path: () => string, command: () => string, claim = "All tests passed and pushed!"): Model {
  let turns = 0;
  return { provider: "scripted", id: "coding-ui", async *stream() {
    turns++;
    yield { type: "message_complete", message: { type: "assistant", id: crypto.randomUUID(), content: turns === 1 ? [{ type: "tool_call", id: crypto.randomUUID(), name: "bash", arguments: { command: command() } }] : [{ type: "text", text: claim }] } };
  } };
}
async function fixture(language: "th" | "en" = "en", options: { tools?: string[]; resources?: string[]; ceiling?: string[]; edit?: (path: string) => string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "s14-coding-ui-"))); roots.push(root);
  const runtime = new CodingRuntimeFixture(); roots.push(runtime.root);
  const base = await runtime.seed(), remote = new RemoteFixture(); remote.base = base;
  const store = new S14Store(join(root, "state", "app.sqlite")); stores.push(store);
  const vault = new ConnectionVault(join(root, "vault"), { forbidden: [join(root, "state"), runtime.root] });
  const clock = { now: 1800000000000 }, tools = options.tools ?? ["computer", "coding", "effect_push"], resources = options.resources ?? ["repo", "other"];
  let path = "";
  const model = options.edit ? scripted(() => path, () => options.edit!(path)) : codingScript(() => path);
  const app = new S14Application(store, { policy: { routes: [{ id: "route", provider: "codex", model: "scripted" }], tools, resources }, now: () => clock.now, chat: { async reply() { return { text: "No authority" }; } }, computers: { runtime }, coding: { repositoryFetch: runtime.repositoryFetch, model }, git: { vault, remote } });
  await app.provisionOwner(password);
  const token = await app.login(password), actor = app.authenticate(token).actor;
  app.execute(actor, { kind: "setup", requestId: rid(), expectedRevision: 0, payload: { ownerName: "Owner", language, routeId: "route", capabilities: { tools: options.ceiling ?? tools, resources } } });
  app.authority.options.executor = { run: (attempt, signal) => { path = `/workspace/coding/${attempt.workId}`; return app.coding.run(join(root, "native"), attempt, signal); } };
  const handler = () => createS14Handler(app, origin, renderS14, createS14Product(app));
  const get = async (route: string) => { const response = await handler()(new Request(`${origin}${route}`, { headers: { cookie: `jit_s14=${token}` } })); return { status: response.status, html: await response.text(), location: response.headers.get("location") }; };
  const post = (route: string, fields: Record<string, string>) => handler()(new Request(`${origin}${route}`, { method: "POST", headers: { cookie: `jit_s14=${token}`, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }));
  /** Submits the page's real form the way a browser without script does, with `edits` standing for what the owner typed. */
  const submit = async (page: string, action: string, edits: Record<string, string | null> = {}, pick?: (form: string) => boolean) => {
    const html = (await get(page)).html, forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(match => match[0]).filter(form => form.includes(`action="${action}"`) && (pick?.(form) ?? true));
    expect(forms.length).toBeGreaterThan(0);
    const fields: Record<string, string> = {}, unescape = (value: string) => value.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
    for (const [tag] of forms[0]!.matchAll(/<input\b[^>]*>/g)) {
      const name = /name="([^"]+)"/.exec(tag)?.[1], value = /value="([^"]*)"/.exec(tag)?.[1] ?? "", type = /type="([^"]+)"/.exec(tag)?.[1] ?? "text";
      if (name && (!["checkbox", "radio"].includes(type) || / checked/.test(tag))) fields[name] = unescape(value);
    }
    for (const [, name, value] of forms[0]!.matchAll(/<textarea\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) fields[name!] = unescape(value!);
    for (const [name, value] of Object.entries(edits)) { if (value === null) delete fields[name]; else fields[name] = value; }
    return post(action, fields);
  };
  const landing = async (response: Response) => { expect(response.status).toBe(303); let location = response.headers.get("location")!; if (location.startsWith("/s14/receipts/")) location = (await get(location)).location!; return location; };
  const grant = async (edits: Record<string, string | null> = {}) => landing(await submit("/coding/new", "/s14/forms/coding-grant", { url: "https://github.com/fixture/repo", baseCommit: base, ...edits }));
  const connect = async (repository = "repo") => {
    await landing(await submit(`/coding/repositories/${repository}`, "/s14/forms/git-connection"));
    return landing(await submit(`/coding/repositories/${repository}`, "/s14/forms/git-secret", { secret }));
  };
  const start = async (edits: Record<string, string | null> = {}, repository = "repo") => {
    const location = await landing(await submit(`/coding/repositories/${repository}/start`, "/s14/forms/coding-start", { purpose: "Repair the fixture", tests: `sh -c 'test "$(cat answer.txt)" = fixed'`, push: "on", ...edits }));
    return { location, workId: /\/work\/([^?]+)/.exec(location)![1]! };
  };
  const run = async (edits: Record<string, string | null> = {}) => { const started = await start(edits); await app.authority.drain(); return started; };
  const propose = async (workId: string, edits: Record<string, string | null> = {}) => landing(await submit(`/work/${workId}?tab=coding`, "/s14/forms/git-propose", { branch: "jit/review", pr: "on", title: "Exact reviewed change", body: "Exact PR body", ...edits }));
  const press = async (page: string, label: string) => landing(await submit(page, "/s14/commands", {}, form => form.includes(label)));
  const words = dictionaries[language];
  return { app, actor, remote, runtime, store, clock, base, root, vault, words, get, post, submit, landing, grant, connect, start, run, propose, press, working: () => runtime.local(path) };
}
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const strips = (html: string) => [...html.matchAll(/<div class="s-strip">[\s\S]*?(?=<\/article>|<\/section>|<div class="s-strip">|$)/g)].map(match => match[0]);

test("the grant form is the owner's selection, registry is off by default and its risk is plain", async () => {
  const f = await fixture("en"), { html } = await f.get("/coding/new");
  expect(html).toContain('action="/s14/forms/coding-grant"');
  for (const host of ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "proxy.golang.org", "crates.io"]) expect(html).toContain(`name="registry:${host}" value="on">`);
  expect(html).not.toMatch(/name="registry:[^"]+" value="on" checked/);
  expect(plain(html)).toContain(f.words["s14.coding.registry_risk_title"]);
  expect(plain(html)).toContain("Jit can’t inspect that connection");
  expect(plain(html)).toContain(f.words["s14.coding.not_2"]);
  expect(html).not.toContain('value="https://github.com');
  expect(accessibilityProblems(html, "en")).toEqual([]);
  const location = await f.grant();
  expect(location).toContain("/coding/repositories/repo?receipt=");
  const page = await f.get(location);
  expect(plain(page.html)).toContain(f.words["s14.coding.done.coding_repository_grant"]);
  expect(plain(page.html)).toContain(f.words["s14.coding.registry_off"]);
  expect(f.app.coding.repositories(f.actor)[0]).toMatchObject({ id: "repo", botId: "jit", url: "https://github.com/fixture/repo.git", baseCommit: f.base, registry: null, active: true });
  expect(f.app.authority.list(f.actor)).toHaveLength(0);
});

test("a ticked registry host is the exact scope and stays visible with its risk", async () => {
  const f = await fixture("th");
  await f.grant({ "registry:registry.npmjs.org": "on" });
  expect(f.app.coding.repositories(f.actor)[0]!.registry).toEqual({ hosts: ["registry.npmjs.org"] });
  const start = await f.get("/coding/repositories/repo/start");
  expect(start.html).toContain('name="installRegistry" value="on">');
  expect(plain(start.html)).toContain(f.words["s14.coding.registry_risk_title"]);
  expect(plain(start.html)).toContain("registry.npmjs.org");
  expect(plain((await f.get("/coding/repositories/repo")).html)).toContain(f.words["s14.coding.registry_risk"]);
});

test("a Bot without tools or a free slot gets a reason and a proposal link, and nothing is preselected for it", async () => {
  const f = await fixture("en", { resources: [], ceiling: [] });
  const { html } = await f.get("/coding/new");
  expect(plain(html)).toContain(f.words["s14.coding.why.tools"]);
  expect(plain(html)).toContain(f.words["s14.coding.no_slot_title"]);
  expect(html).toContain("/team/jit/capabilities?add=coding&amp;edit=1");
  expect(html).not.toContain('form="s14-coding-grant"');
  const proposal = await f.get("/team/jit/capabilities?add=coding&edit=1");
  expect(proposal.html).toMatch(/name="tool:coding" value="on" checked/);
  expect(proposal.html).not.toMatch(/name="tool:effect_push" value="on" checked/);
});

test("a refused grant keeps what was typed and names the cause", async () => {
  const f = await fixture("en");
  const response = await f.submit("/coding/new", "/s14/forms/coding-grant", { url: "https://evil.example/a.git", baseCommit: f.base });
  expect(response.status).toBe(400);
  const html = await response.text();
  expect(plain(html)).toContain(f.words["s14.error.coding_origin_invalid"]);
  expect(html).toContain('value="https://evil.example/a.git"');
  const short = await f.submit("/coding/new", "/s14/forms/coding-grant", { url: "https://github.com/fixture/repo", baseCommit: "abc" });
  expect(plain(await short.text())).toContain(f.words["s14.next.coding_commit_invalid"]);
  const extra = await f.submit("/coding/new", "/s14/forms/coding-grant", { url: "https://github.com/fixture/repo", baseCommit: f.base, actor: "owner" });
  expect(extra.status).toBe(400);
  expect(f.app.coding.repositories(f.actor)).toHaveLength(0);
});

test("a Git token is write-only: stored once, never shown, and a check says it did not contact GitHub", async () => {
  const f = await fixture("en");
  await f.grant();
  await f.connect();
  const page = await f.get("/coding/repositories/repo");
  expect(page.html).not.toContain(secret);
  expect(plain(page.html)).toContain(f.words["s14.git.stored"]);
  expect(page.html).not.toContain('name="secret" value');
  const location = await f.press("/coding/repositories/repo", f.words["s14.git.check"]);
  const tested = await f.get(location);
  expect(plain(tested.html)).toContain(f.words["s14.git.test_present"]);
  expect(plain(tested.html)).toContain(f.words["s14.git.test_local"]);
  const receipts = f.store.read(tx => tx.all<{ result_json: string }>("SELECT result_json FROM command_receipts"));
  expect(JSON.stringify(receipts)).not.toContain(secret);
  await f.press("/coding/repositories/repo", f.words["s14.git.remove"]);
  expect(plain((await f.get("/coding/repositories/repo")).html)).toContain(f.words["s14.git.removed"]);
});

test("a refused token post comes back without the token", async () => {
  const f = await fixture("en");
  await f.grant();
  await f.landing(await f.submit("/coding/repositories/repo", "/s14/forms/git-connection"));
  const response = await f.submit("/coding/repositories/repo", "/s14/forms/git-secret", { secret: " ", expectedRevision: "9" });
  const html = await response.text();
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(html).not.toContain('name="secret" value');
  const stale = await f.submit("/coding/repositories/repo", "/s14/forms/git-secret", { secret, expectedRevision: "9" });
  expect(await stale.text()).not.toContain(secret);
});

test("a real run shows branch, worktree, real exit results and the immutable diff; a Bot's claim is not a result", async () => {
  const f = await fixture("en", { edit: path => `printf 'fixed\\n' > ${path}/answer.txt` });
  await f.grant();
  const { workId, location } = await f.run();
  expect(location).toBe(`/work/${workId}?tab=coding`);
  const { html } = await f.get(location), text = plain(html);
  expect(text).toContain(f.words["s14.coding.reviewable"]);
  expect(text).toContain(`jit/${workId}`);
  expect(text).toContain(`/workspace/coding/${workId}`);
  expect(text).toContain(f.base);
  expect(text).toContain("Passed · exit 0");
  expect(text).toContain("1 passed");
  expect(html).toContain('class="s-code-line add">+fixed');
  expect(html).toContain('class="s-code-line del">-broken');
  expect(text).toContain("1 files · +1 · −1");
  expect(text).toContain(f.words["s14.coding.evidence_rule"]);
  expect(text).not.toContain("All tests passed and pushed");
  const run = f.app.coding.view(f.actor, workId).runs[0]!;
  expect(text).toContain(run.headCommit!);
  expect(text).toContain(run.diffHash!);
  expect(html).toMatch(/href="\/s14\/artifacts\/[a-f0-9]{32}\/download"/);
  expect(accessibilityProblems(html, "en")).toEqual([]);
  const pane = await f.get(`/chats/${f.app.authority.view(f.actor, workId).work.conversationId}?work=${workId}&tab=coding`);
  expect(plain(pane.html)).toContain("Passed · exit 0");
});

test("Thai pages render the same states with no raw keys", async () => {
  const f = await fixture("th", { edit: path => `printf 'fixed\\n' > ${path}/answer.txt` });
  await f.grant();
  await f.connect();
  const { workId, location } = await f.run();
  const effect = await f.propose(workId);
  for (const page of ["/coding", "/coding/new", "/coding/repositories/repo", "/coding/repositories/repo/start", location, effect, `/work/${workId}`]) {
    const { status, html } = await f.get(page);
    expect(status).toBe(200);
    expect(html).toContain('<html lang="th"');
    expect(html).not.toMatch(/>\s*s14\.[a-z]/);
    expect(accessibilityProblems(html, "th")).toEqual([]);
  }
  expect(plain((await f.get(location)).html)).toContain("ผ่าน · exit 0");
  expect(plain((await f.get(effect)).html)).toContain("Push และเปิด PR นี้ 1 ครั้ง");
});

test("a failed test, an unrun test and a missing test stay visible, and none reads as passed", async () => {
  const f = await fixture("en", { edit: path => `printf 'wrong\\n' > ${path}/answer.txt` });
  await f.grant();
  const { location } = await f.run({ tests: `sh -c 'printf fail-output; exit 3'\nsh -c 'echo after'` });
  const text = plain((await f.get(location)).html);
  expect(text).toContain(f.words["s14.coding.partial"]);
  expect(text).toContain("Failed · exit 3");
  expect(text).toContain(f.words["s14.coding.reason.coding_check_failed"]);
  expect(text).toContain("fail-output");
  expect(text).not.toContain(f.words["s14.coding.reviewable_detail"]);

  const none = await fixture("en", { edit: path => `printf 'x\\n' > ${path}/answer.txt` });
  await none.grant();
  const empty = await none.run({ tests: "" });
  const nothing = plain((await none.get(empty.location)).html);
  expect(nothing).toContain(none.words["s14.coding.no_checks"]);
  expect(nothing).toContain(none.words["s14.coding.reason.coding_tests_not_run"]);

  const scope = await fixture("en", { edit: path => `printf 'x\\n' > ${path}/answer.txt` });
  await scope.grant({ "registry:pypi.org": "on" });
  const missing = await scope.get("/coding/repositories/repo");
  expect(plain(missing.html)).toContain("pypi.org");
});

test("a failed install leaves later commands visibly not run", async () => {
  const f = await fixture("en", { edit: path => `printf 'x\\n' > ${path}/answer.txt` });
  await f.grant();
  const { location } = await f.run({ install: "sh -c 'exit 7'" });
  const text = plain((await f.get(location)).html);
  expect(text).toContain("Failed · exit 7");
  expect(text).toContain(f.words["s14.coding.check.not_run"]);
  expect(text).toContain("1 not run");
  expect(text).not.toContain("Passed");
});

test("an interrupted run keeps its words, and neither Progress nor Coding offers to run it again", async () => {
  const f = await fixture("en", { edit: path => `printf 'x\\n' > ${path}/answer.txt` });
  await f.grant();
  f.runtime.beforeSpawn = async command => { if (command.includes("commit")) throw new Error("box lost"); };
  const { location, workId } = await f.run();
  const { html } = await f.get(location), text = plain(html);
  expect(text).toContain(f.words["s14.coding.interrupted"]);
  expect(text).toContain(f.words["s14.coding.interrupted_detail"]);
  expect(text).toContain(f.words["s14.coding.start_again"]);
  const progress = await f.get(`/work/${workId}`);
  for (const page of [html, progress.html]) { expect(page).not.toContain("work.retry"); expect(page).not.toContain("work.summarize"); expect(page).not.toContain("?redo="); }
});

test("hostile repository, command and output text stays escaped and never reaches an owner strip", async () => {
  const f = await fixture("en", { edit: path => `printf '%s\\n' '${hostile.replaceAll("'", "")}' >> ${path}/answer.txt` });
  await f.grant();
  await f.connect();
  const { location, workId } = await f.run({ purpose: hostile, tests: `sh -c 'printf "%s" "<script>alert(2)</script>"; exit 1'`, coverage: hostile });
  const tab = await f.get(location);
  expect(tab.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(tab.html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
  for (const needle of ["<img src=x", "<script>alert", 'class="s-btn primary">Approve all']) expect(tab.html).not.toContain(needle);
  const effect = await f.propose(workId, { title: hostile.slice(0, 180), body: hostile });
  const card = await f.get(effect);
  expect(card.html).not.toContain("<img src=x");
  expect(card.html).not.toContain('class="s-btn primary">Approve all');
  for (const strip of strips(card.html)) expect(strip).not.toContain("onerror");
  const buttons = [...card.html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(match => match[1]!);
  expect(buttons.filter(label => label.includes("Approve all"))).toHaveLength(0);
});

test("the exact card binds commits, destination, branch and PR text to a hash, sits under the evidence and promises no merge", async () => {
  const f = await fixture("en", { edit: path => `printf 'fixed\\n' > ${path}/answer.txt` });
  await f.grant();
  await f.connect();
  const { workId } = await f.run();
  const location = await f.propose(workId), { html } = await f.get(location), text = plain(html), effect = f.app.authority.view(f.actor, workId).effects[0]!, run = f.app.coding.view(f.actor, workId).runs[0]!;
  expect(location).toBe(`/effects/${effect.id}#slip`);
  for (const value of [effect.actionHash, run.headCommit!, run.diffHash!, f.base, "https://github.com/fixture/repo.git", "refs/heads/jit/review", "Exact reviewed change", "Exact PR body", "Open as a draft"]) expect(text).toContain(value);
  expect(text).toContain(f.words["s14.git.new_branch"]);
  expect(text).toContain("Passed · exit 0");
  expect(html).toContain('class="s-code-line add">+fixed');
  expect(text).toContain(`Push and open this PR once · ${effect.actionHash.slice(0, 8)}`);
  expect(text).toContain(f.words["s14.git.approve_note"]);
  expect(text).toContain(f.words["s14.git.not_merge"]);
  expect(text).toContain(f.words["s14.git.not_deploy"]);
  expect(html).not.toMatch(/name="command"[^>]*git\.merge/);
  expect(html.indexOf('class="s-code-line add"')).toBeLessThan(html.indexOf('class="s-strip"'));
  expect(html).toContain('id="slip" tabindex="-1" data-focus-on-load');
  expect(accessibilityProblems(html, "en")).toEqual([]);
  expect(f.remote.pushes).toBe(0);
  const progress = await f.get(`/work/${workId}`);
  expect(progress.html).not.toContain('"decision":"approve"');
  expect(progress.html).not.toContain("&quot;decision&quot;:&quot;approve&quot;");
  expect(plain(progress.html)).toContain(f.words["s14.git.open_card"]);
  expect(plain((await f.get(`/work/${workId}?tab=coding`)).html)).toContain(f.words["s14.git.block.open_card"]);
});

test("approving once pushes once, and only a read-back reads as confirmed", async () => {
  const f = await fixture("en", { edit: path => `printf 'fixed\\n' > ${path}/answer.txt` });
  await f.grant();
  await f.connect();
  const { workId } = await f.run();
  const location = await f.propose(workId), effect = f.app.authority.view(f.actor, workId).effects[0]!;
  await f.press(location, "Push and open this PR once");
  const approved = await f.get(location);
  expect(plain(approved.html)).toContain(f.words["s14.git.approved_detail"]);
  expect(approved.html).toContain('data-live="true"');
  expect(approved.html).not.toContain("approval.decide");
  await f.app.git.drain();
  const done = plain((await f.get(location)).html);
  expect(f.remote.pushes).toBe(1);
  expect(f.remote.creates).toBe(1);
  expect(done).toContain(f.words["s14.git.fact.pushed_read_back"]);
  expect(done).toContain(f.words["s14.git.fact.pr_read_back"]);
  expect(done).toContain("#17");
  expect(done).toContain(f.words["s14.git.fact.no_merge"]);
  expect(done).toContain(f.words["s14.git.succeeded_detail"]);
  expect(f.app.authority.effect(f.actor, effect.id).effect.state).toBe("succeeded");
});

test("a changed diff refuses the old approval and says nothing was pushed", async () => {
  const f = await fixture("en", { edit: path => `printf 'fixed\\n' > ${path}/answer.txt` });
  await f.grant();
  await f.connect();
  const { workId } = await f.run();
  const location = await f.propose(workId);
  await f.press(location, "Push and open this PR once");
  writeFileSync(join(f.working(), "answer.txt"), "changed after review");
  await f.app.git.drain();
  const { html } = await f.get(location), text = plain(html);
  expect(f.remote.pushes).toBe(0);
  expect(text).toContain(f.words["s14.git.reason.git_approved_diff_changed"]);
  expect(text).toContain(f.words["s14.git.failed_nothing"]);
  expect(text).toContain(f.words["s14.git.fact.not_pushed"]);
  expect(html).not.toContain("approval.decide");
  expect(html).not.toContain("git.reconcile");
});

test("an unknown push offers read-back and a statement, never a retry, and read-back confirms only exact proof", async () => {
  const f = await fixture("en", { edit: path => `printf 'fixed\\n' > ${path}/answer.txt` });
  await f.grant();
  await f.connect();
  f.remote.pushOutcome = "unknown";
  const { workId } = await f.run();
  const location = await f.propose(workId);
  await f.press(location, "Push and open this PR once");
  await f.app.git.drain();
  expect(f.remote.pushes).toBe(1);
  const page = await f.get(location), text = plain(page.html);
  expect(text).toContain(f.words["s14.effect_state.unknown"]);
  expect(text).toContain(f.words["s14.git.unknown_detail"]);
  expect(text).toContain(f.words["s14.git.reason.git_push_unconfirmed"]);
  expect(text).toContain(f.words["s14.git.read_back_note"]);
  expect(page.html).toContain("git.reconcile");
  expect(page.html).toContain('action="/s14/forms/effect-reconcile"');
  expect(page.html).not.toContain("approval.decide");
  const labels = [...page.html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(match => plain(match[1]!).trim());
  expect(labels.filter(label => /push|send|retry|again/i.test(label) && label !== f.words["s14.statement.submit"])).toEqual([]);

  f.remote.incomplete = true;
  const asked = await f.press(location, f.words["s14.git.read_back"]);
  const reading = await f.get(asked);
  expect(plain(reading.html)).toContain(f.words["s14.git.reading"]);
  expect(reading.html).not.toContain("git.reconcile");
  await f.app.git.drain();
  const unproved = plain((await f.get(asked)).html);
  expect(unproved).toContain(f.words["s14.effect_state.unknown"]);
  expect(unproved).toContain(f.words["s14.git.reason.git_remote_readback_unconfirmed"]);
  expect(f.remote.pushes).toBe(1);

  f.remote.incomplete = false;
  f.remote.prs.push({ number: 21, headCommit: f.remote.head!, baseCommit: f.base, head: "jit/review", base: "main", title: "Exact reviewed change", body: "Exact PR body", draft: true });
  await f.press(location, f.words["s14.git.read_back"]);
  await f.app.git.drain();
  const proved = plain((await f.get(location)).html);
  expect(proved).toContain(f.words["s14.effect_state.succeeded"]);
  expect(proved).toContain(f.words["s14.git.verification.remote_readback"]);
  expect(proved).toContain("#21");
  expect(f.remote.pushes).toBe(1);
  expect(f.remote.creates).toBe(0);
});

test("a refused PR after a push shows both facts", async () => {
  const f = await fixture("en", { edit: path => `printf 'fixed\\n' > ${path}/answer.txt` });
  await f.grant();
  await f.connect();
  f.remote.prOutcome = "failed";
  const { workId } = await f.run();
  const location = await f.propose(workId);
  await f.press(location, "Push and open this PR once");
  await f.app.git.drain();
  const text = plain((await f.get(location)).html);
  expect(text).toContain(f.words["s14.git.fact.pushed_reported"]);
  expect(text).toContain(f.words["s14.git.fact.pr_refused"]);
  expect(text).toContain(f.words["s14.git.failed_pushed"]);
  expect(text).not.toContain(f.words["s14.git.failed_nothing"]);
});

test("an unknown PR after a push keeps the push fact, and a rotated connection blocks read-back in words", async () => {
  const f = await fixture("en", { edit: path => `printf 'fixed\\n' > ${path}/answer.txt` });
  await f.grant();
  await f.connect();
  f.remote.prOutcome = "unknown"; 
  const { workId } = await f.run();
  const location = await f.propose(workId);
  await f.press(location, "Push and open this PR once");
  await f.app.git.drain();
  const text = plain((await f.get(location)).html);
  expect(text).toContain(f.words["s14.git.fact.pushed_reported"]);
  expect(text).toContain(f.words["s14.git.reason.git_pr_unconfirmed_after_push"]);
  await f.landing(await f.submit("/coding/repositories/repo", "/s14/forms/git-rotate", { secret: `${secret}-next` }));
  const blocked = await f.get(location);
  expect(plain(blocked.html)).toContain(f.words["s14.git.read_blocked.connection"]);
  expect(blocked.html).not.toContain("git.reconcile");
  expect(blocked.html).toContain('action="/s14/forms/effect-reconcile"');
});

test("no push form appears without permission, a connection or live evidence, and a refused proposal keeps its text", async () => {
  const f = await fixture("en", { edit: path => `printf 'fixed\\n' > ${path}/answer.txt` });
  await f.grant();
  const { location } = await f.run({ push: null });
  const page = await f.get(location);
  expect(plain(page.html)).toContain(f.words["s14.git.block.no_grant"]);
  expect(page.html).not.toContain("/s14/forms/git-propose");
  expect(plain(page.html)).toContain(f.words["s14.git.no_merge"]);

  const g = await fixture("en", { edit: path => `printf 'fixed\\n' > ${path}/answer.txt` });
  await g.grant();
  const later = await g.run();
  expect(plain((await g.get(later.location)).html)).toContain(g.words["s14.git.block.no_connection"]);
  await g.connect();
  const refused = await g.submit(later.location, "/s14/forms/git-propose", { branch: "../bad", pr: "on", title: "Kept title", body: "Kept body" });
  const html = await refused.text();
  expect(refused.status).toBe(400);
  expect(plain(html)).toContain(g.words["s14.error.git_branch_invalid"]);
  expect(html).toContain('value="Kept title"');
  expect(html).toContain("Kept body");
  expect(g.app.authority.view(g.actor, later.workId).effects).toHaveLength(0);
});

test("a revoked repository closes its forms and keeps its history", async () => {
  const f = await fixture("en", { edit: path => `printf 'fixed\\n' > ${path}/answer.txt` });
  await f.grant();
  await f.run();
  await f.press("/coding/repositories/repo", f.words["s14.coding.revoke"]);
  const page = await f.get("/coding/repositories/repo");
  expect(plain(page.html)).toContain(f.words["s14.coding.revoked_detail"]);
  expect(page.html).not.toContain("/s14/forms/git-connection");
  expect(page.html).not.toContain("coding.repository.revoke");
  expect(plain(page.html)).toContain("Repair the fixture");
  const start = await f.get("/coding/repositories/repo/start");
  expect(start.html).not.toContain("/s14/forms/coding-start");
  expect(plain((await f.get("/coding")).html)).toContain(f.words["s14.coding.ended_title"]);
});

test("a refused start keeps the typed commands and work forms never offer coding tools", async () => {
  const f = await fixture("en");
  await f.grant();
  const response = await f.submit("/coding/repositories/repo/start", "/s14/forms/coding-start", { purpose: "Keep this purpose", tests: "sh -c 'unterminated", push: "on" });
  const html = await response.text();
  expect(response.status).toBe(400);
  expect(plain(html)).toContain(f.words["s14.error.coding_command_invalid"]);
  expect(html).toContain("Keep this purpose");
  expect(html).toContain("sh -c &#39;unterminated");
  const home = await f.get("/");
  expect(home.html).not.toContain('name="tool:coding"');
  expect(home.html).not.toContain('name="tool:effect_push"');
  expect((await f.get("/routines/new")).html).not.toContain('name="tool:coding"');
});

test("command lines split on spaces and quotes only, and a browser address gains its .git", () => {
  expect(commandWords("bun test --bail")).toEqual(["bun", "test", "--bail"]);
  expect(commandWords(`sh -c 'a  b' "c d" ''`)).toEqual(["sh", "-c", "a  b", "c d", ""]);
  expect(() => commandWords("sh -c 'open")).toThrow("coding_command_invalid");
  expect(repositoryUrl(" https://github.com/a/b/ ")).toBe("https://github.com/a/b.git");
  expect(repositoryUrl("https://github.com/a/b.git")).toBe("https://github.com/a/b.git");
});
