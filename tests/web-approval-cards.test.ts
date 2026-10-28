import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { dictionaries } from "../src/i18n";
import { cardLifetimeMs } from "../src/exec/approval-cards";
import { effectToolNames } from "../src/exec/effect-tools";
import { createWebHandler } from "../src/web";
import { answer, cards, connection, decide, effectFixture, rid, send, setDeploy, setLevel, setRemote, setRule, settle, type EffectFixture, type EffectFixtureOptions } from "./fixtures/effects";

const fixtures: EffectFixture[] = [];
const origin = "http://localhost:3000";
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.close(); rmSync(f.root, { recursive: true, force: true }); rmSync(dirname(f.box.root), { recursive: true, force: true }); }
});
type Call = { name: string; input: unknown };
async function proposing(options: EffectFixtureOptions = {}) {
  const queue: Call[] = [];
  const f = await effectFixture({ ...options, script: async (request, _s, _o, tools) => {
    const results: Awaited<ReturnType<typeof tools.call>>[] = [];
    for (const call of queue.splice(0)) results.push(await tools.call(call.name, call.input));
    void results;
    return answer(request, JSON.stringify({ reply: "เสนอการ์ดแล้ว" }));
  } });
  fixtures.push(f);
  const web = createWebHandler(f.app);
  const propose = async (name: string, input: unknown) => {
    queue.push({ name, input });
    send(f, "ทำให้หน่อย");
    await settle(f);
    const list = cards(f);
    return list.at(-1)!;
  };
  return { f, web, propose };
}
const deployToken = () => `deploy-${rid()}-${rid()}`;
function get(f: EffectFixture, web: ReturnType<typeof createWebHandler>, path: string, token?: string) {
  return web(new Request(`${origin}${path}`, { headers: { cookie: `jit_session=${token ?? f.token}` } }));
}
function postForm(f: EffectFixture, web: ReturnType<typeof createWebHandler>, path: string, fields: Record<string, string>, token?: string) {
  return web(new Request(`${origin}${path}`, { method: "POST", body: new URLSearchParams(fields).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: `jit_session=${token ?? f.token}` } }));
}
const topicPath = (f: EffectFixture) => `/projects/${f.project.id}/topics/${f.topic.id}`;

test("(1) the topic with a pending fixture card shows approval.title text and two forms", async () => {
  const { f, web, propose } = await proposing();
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const card = await propose(effectToolNames["effect.deploy"], { target: "production" });
  const html = await (await get(f, web, topicPath(f))).text();
  expect(html).toContain(dictionaries.th["approval.title"]);
  const action = `${topicPath(f)}/approvals/${card.id}`;
  expect(html).toContain(`action="${action}"`);
  expect(html.match(new RegExp(`action="${action}"`, "g"))?.length).toBe(2);
});

test("(2) Approve POST → 303, card shows executing or succeeded", async () => {
  const { f, web, propose } = await proposing({ fetch: () => new Response("{}", { status: 202 }) });
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const card = await propose(effectToolNames["effect.deploy"], { target: "production" });
  const res = await postForm(f, web, `${topicPath(f)}/approvals/${card.id}`, {
    csrf: f.auth.csrf, requestId: rid(), expectedRevision: String(card.revision), expectedDigest: card.digest, cardId: card.id, decision: "approve",
  });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(`${topicPath(f)}#approval-${card.id}`);
  await settle(f);
  const done = f.app.approvalCard(f.auth.actor, f.project.id, card.id);
  expect(["executing", "succeeded"]).toContain(done.state);
  const html = await (await get(f, web, topicPath(f))).text();
  const states = [dictionaries.th["approval.state_executing"], dictionaries.th["approval.state_succeeded"]];
  expect(states.some(text => html.includes(text))).toBe(true);
});

test("(3) Deny → denied", async () => {
  const { f, web, propose } = await proposing();
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const card = await propose(effectToolNames["effect.deploy"], { target: "production" });
  const res = await postForm(f, web, `${topicPath(f)}/approvals/${card.id}`, {
    csrf: f.auth.csrf, requestId: rid(), expectedRevision: String(card.revision), expectedDigest: card.digest, cardId: card.id, decision: "deny",
  });
  expect(res.status).toBe(303);
  expect(f.app.approvalCard(f.auth.actor, f.project.id, card.id)).toMatchObject({ state: "denied" });
});

test("(4) a stale digest → the translated EXE07 error", async () => {
  const { f, web, propose } = await proposing();
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const card = await propose(effectToolNames["effect.deploy"], { target: "production" });
  const res = await postForm(f, web, `${topicPath(f)}/approvals/${card.id}`, {
    csrf: f.auth.csrf, requestId: rid(), expectedRevision: String(card.revision), expectedDigest: "0".repeat(64), cardId: card.id, decision: "approve",
  });
  expect(res.status).toBe(409);
  expect(await res.text()).toContain(dictionaries.th["error.approval_digest_mismatch"]);
});

test("(5) an expired card (fake clock) shows no forms", async () => {
  const { f, web, propose } = await proposing();
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const card = await propose(effectToolNames["effect.deploy"], { target: "production" });
  f.clock.now += cardLifetimeMs;
  const html = await (await get(f, web, topicPath(f))).text();
  expect(html).not.toContain(`${topicPath(f)}/approvals/${card.id}`);
  expect(html).toContain(dictionaries.th["approval.state_expired"]);
});

test("(6) the <script> in the action JSON is escaped", async () => {
  const { f, web, propose } = await proposing();
  setLevel(f, "full");
  const remote = connection(f, "github_token", `ghp_${rid().replaceAll("-", "")}`);
  setRemote(f, remote);
  const card = await propose(effectToolNames["effect.github_comment"], { remote: "origin", issueNumber: 7, body: "<script>alert(1)</script> ดีครับ" });
  const html = await (await get(f, web, topicPath(f))).text();
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(card.id).toBeTruthy();
});

test("(7) /settings/approvals lists the pending card with a link to its topic", async () => {
  const { f, web, propose } = await proposing();
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const card = await propose(effectToolNames["effect.deploy"], { target: "production" });
  const html = await (await get(f, web, "/settings/approvals")).text();
  expect(html).toContain(`/projects/${f.project.id}/topics/${f.topic.id}#approval-${card.id}`);
});

test("(8) rule create without confirmation → 400; with it → listed", async () => {
  const { f, web } = await proposing();
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const bad = await postForm(f, web, "/settings/approvals/rules", {
    csrf: f.auth.csrf, requestId: rid(), expectedRevision: "0", projectId: f.project.id, effectKind: "effect.deploy", target: "production", remote: "", branches: "",
  });
  expect(bad.status).toBe(400);
  const good = await postForm(f, web, "/settings/approvals/rules", {
    csrf: f.auth.csrf, requestId: rid(), expectedRevision: "0", projectId: f.project.id, effectKind: "effect.deploy", target: "production", remote: "", branches: "", confirm: "on",
  });
  expect(good.status).toBe(303);
  const html = await (await get(f, web, "/settings/approvals")).text();
  expect(html).toContain("effect.deploy");
});

test("(9) CSRF missing → 403", async () => {
  const { f, web, propose } = await proposing();
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const card = await propose(effectToolNames["effect.deploy"], { target: "production" });
  const res = await web(new Request(`${origin}${topicPath(f)}/approvals/${card.id}`, { method: "POST",
    body: new URLSearchParams({ requestId: rid(), expectedRevision: String(card.revision), expectedDigest: card.digest, cardId: card.id, decision: "approve" }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: `jit_session=${f.token}` } }));
  expect(res.status).toBe(403);
});

test("(10) rule edit posts the rule revision; disabling then re-enabling works", async () => {
  const { f, web } = await proposing();
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const fields = { csrf: f.auth.csrf, projectId: f.project.id, effectKind: "effect.deploy", remote: "", branches: "" };
  const created = await postForm(f, web, "/settings/approvals/rules", { ...fields, requestId: rid(), expectedRevision: "0", target: "production", confirm: "on" });
  expect(created.status).toBe(303);
  let rule = f.app.effectSettings(f.auth.actor, f.project.id).rules.find(r => r.effectKind === "effect.deploy")!;
  expect(rule).toMatchObject({ enabled: true, revision: 1, scope: { target: "production" } });
  // The settings page renders per-rule edit/enable forms posting the rule revision.
  const listing = await (await get(f, web, "/settings/approvals")).text();
  expect(listing).toContain(`name="expectedRevision" value="${rule.revision}"`);
  // Editing with a stale revision fails; with the rule revision it updates the scope.
  const stale = await postForm(f, web, "/settings/approvals/rules", { ...fields, requestId: rid(), expectedRevision: "0", target: "staging", confirm: "on" });
  expect(stale.status).toBe(409);
  const edited = await postForm(f, web, "/settings/approvals/rules", { ...fields, requestId: rid(), expectedRevision: String(rule.revision), target: "staging", confirm: "on" });
  expect(edited.status).toBe(303);
  rule = f.app.effectSettings(f.auth.actor, f.project.id).rules.find(r => r.effectKind === "effect.deploy")!;
  expect(rule).toMatchObject({ enabled: true, revision: 2, scope: { target: "staging" } });
  // Disable, then re-enable through the edit/enable form that posts the rule revision.
  const disabled = await postForm(f, web, `/settings/approvals/rules/${f.project.id}%3Aeffect.deploy`,
    { csrf: f.auth.csrf, requestId: rid(), expectedRevision: String(rule.revision), projectId: f.project.id, effectKind: "effect.deploy" });
  expect(disabled.status).toBe(303);
  rule = f.app.effectSettings(f.auth.actor, f.project.id).rules.find(r => r.effectKind === "effect.deploy")!;
  expect(rule).toMatchObject({ enabled: false, revision: 3 });
  const reenabled = await postForm(f, web, "/settings/approvals/rules", { ...fields, requestId: rid(), expectedRevision: String(rule.revision), target: "staging", confirm: "on" });
  expect(reenabled.status).toBe(303);
  rule = f.app.effectSettings(f.auth.actor, f.project.id).rules.find(r => r.effectKind === "effect.deploy")!;
  expect(rule).toMatchObject({ enabled: true, revision: 4, scope: { target: "staging" } });
});

test("(11) a pending card shows even with 51 newer cards in another topic", async () => {
  const { f, web, propose } = await proposing();
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const card = await propose(effectToolNames["effect.deploy"], { target: "production" });
  const project = f.app.project(f.auth.actor, f.project.id);
  const other = f.app.execute(f.auth.actor, { kind: "topic.create", projectId: f.project.id, requestId: rid(), expectedRevision: project.revision, payload: { title: "หัวข้ออื่น" } }).topic;
  f.store.transaction(tx => {
    for (let i = 0; i < 51; i++) {
      const now = f.clock.now + i + 1;
      tx.run(`INSERT INTO approval_cards (id, project_id, topic_id, run_id, job_id, role_id, kind, action_json, digest, revision, state, telegram_eligible, created_at, expires_at, updated_at, started_at)
        VALUES (?, ?, ?, ?, ?, ?, 'effect.deploy', '{}', ?, 1, 'pending', 1, ?, ?, ?, NULL)`,
        rid(), f.project.id, other.id, rid(), rid(), f.jitId, "b".repeat(63) + (i % 16).toString(16), now, now + cardLifetimeMs, now);
    }
  });
  const html = await (await get(f, web, topicPath(f))).text();
  expect(html).toContain(`action="${topicPath(f)}/approvals/${card.id}"`);
});
