import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "../src/errors";
import { dictionaries } from "../src/i18n";
import { actionDigest, approvalCommandIdentity, canonicalJson, cardLifetimeMs, readCard } from "../src/exec/approval-cards";
import { effectToolNames } from "../src/exec/effect-tools";
import { backupImageTables } from "../src/ops/backup";
import type { ScriptedTools } from "../src/team/scripted-port";
import { answer, cards, connection, decide, effectFixture, rid, send, setDeploy, setLevel, setRemote, setRule, settle, texts, type EffectFixture, type EffectFixtureOptions } from "./fixtures/effects";

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

type Call = { name: string; input: unknown };
/** A fixture whose Jit runs call the queued effect tools, so cards are proposed exactly as a model would. */
async function proposing(options: EffectFixtureOptions = {}) {
  const queue: Call[] = [], results: Awaited<ReturnType<ScriptedTools["call"]>>[] = [], names: string[][] = [];
  const f = await effectFixture({ ...options, script: async (request, _s, _o, tools) => {
    names.push([...tools.names]);
    for (const call of queue.splice(0)) results.push(await tools.call(call.name, call.input));
    return answer(request, JSON.stringify({ reply: "เสนอการ์ดแล้ว" }));
  } });
  fixtures.push(f);
  const propose = async (name: string, input: unknown) => {
    queue.push({ name, input });
    send(f, "ทำให้หน่อย");
    await settle(f);
    return results.at(-1)!;
  };
  return { f, propose, results, names };
}
const deployToken = () => `deploy-${rid()}-${rid()}`;

test("an effect tool only creates a pending card; without a decision no effect ever happens", async () => {
  const { f, propose } = await proposing();
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const result = await propose(effectToolNames["effect.deploy"], { target: "production", ref: "main" });
  const body = JSON.parse(result.content) as { state: string; cardId: string; digest: string };
  expect(result.isError).toBeUndefined();
  expect(body.state).toBe("pending_approval");
  const card = f.app.approvalCard(f.auth.actor, f.project.id, body.cardId);
  expect(card).toMatchObject({ state: "pending", revision: 1, kind: "effect.deploy", telegramEligible: true, decision: null, receipt: null,
    action: { kind: "effect.deploy", target: { name: "production", url: "https://deploy.example.test/hooks/jit", revision: 1 }, ref: "main" },
    roleId: f.jitId, topicId: f.topic.id, expiresAt: card.createdAt + cardLifetimeMs });
  expect(card.digest).toBe(actionDigest(card.action));
  expect(body.digest).toBe(card.digest);
  await settle(f);
  expect(f.fetches).toEqual([]);
  // The tool call itself is audited like any execution tool.
  expect(f.app.toolCalls(f.auth.actor, f.project.id).map(call => [call.tool, call.status, call.subject, call.level])).toEqual([["effect_deploy", "success", "production", "full"]]);
});

test("approval moves the card to executing with its receipt in one transaction, and causes exactly one effect", async () => {
  const token = deployToken();
  const { f, propose } = await proposing({ fetch: () => new Response("{}", { status: 202 }) });
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", token));
  const { cardId } = JSON.parse((await propose(effectToolNames["effect.deploy"], { target: "production" })).content) as { cardId: string };
  const card = f.app.approvalCard(f.auth.actor, f.project.id, cardId);
  const requestId = rid();
  const receipt = decide(f, card, "approve", f.auth.actor, requestId);
  expect(receipt.card).toMatchObject({ state: "executing", revision: 2, decision: { decision: "approve", channel: "web", ruleRevision: null } });
  expect(f.store.read(tx => tx.get<{ result_json: string }>("SELECT result_json FROM command_receipts WHERE request_id = ?", requestId))!.result_json).toContain('"executing"');
  await f.executor.idle();
  const done = f.app.approvalCard(f.auth.actor, f.project.id, cardId);
  expect(done).toMatchObject({ state: "succeeded", reason: null, receipt: { outcome: "succeeded", detail: { endpoint: "https://deploy.example.test/hooks/jit", status: 202 } } });
  expect(f.fetches).toHaveLength(1);
  expect(f.fetches[0]).toMatchObject({ url: "https://deploy.example.test/hooks/jit", method: "POST", body: { projectId: f.project.id, target: "production", ref: null, cardId } });
  expect(f.fetches[0]!.headers.authorization).toBe(`Bearer ${token}`);
  // The credential was released for this card only, and appears in no card, receipt, message or tool result.
  expect(f.store.read(tx => tx.all("SELECT action, purpose FROM connection_audit WHERE action = 'released'"))).toEqual([{ action: "released", purpose: `effect:${cardId}` }]);
  expect(JSON.stringify(f.app.approvalCards(f.auth.actor, f.project.id))).not.toContain(token);
  expect(texts(f).join("\n")).not.toContain(token);
  expect(texts(f).some(text => text.includes("effect.deploy") && text.includes(cardId.slice(0, 8)))).toBe(true);
  // A replay returns the first receipt and never runs the effect again; a used card cannot be decided again.
  expect(decide(f, card, "approve", f.auth.actor, requestId)).toEqual(receipt);
  await f.executor.idle();
  expect(f.fetches).toHaveLength(1);
  rejects(() => decide(f, card, "approve"), "approval_card_not_pending", 409);
  rejects(() => decide(f, { ...card, revision: done.revision }, "approve"), "approval_card_not_pending", 409);
  // Running the card again by hand does nothing either.
  await f.executor.run(f.project.id, cardId);
  expect(f.fetches).toHaveLength(1);
});

test("digest and revision mismatches, expiry, denial and replays do nothing", async () => {
  const { f, propose } = await proposing();
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const id = async () => (JSON.parse((await propose(effectToolNames["effect.deploy"], { target: "production" })).content) as { cardId: string }).cardId;
  const first = f.app.approvalCard(f.auth.actor, f.project.id, await id());
  rejects(() => decide(f, { ...first, digest: "0".repeat(64) }, "approve"), "approval_digest_mismatch", 409);
  rejects(() => decide(f, { ...first, revision: 7 }, "approve"), "stale_revision", 409);
  expect(f.app.approvalCard(f.auth.actor, f.project.id, first.id)).toMatchObject({ state: "pending", revision: 1 });
  // Denial is final.
  expect(decide(f, first, "deny").card).toMatchObject({ state: "denied", reason: "denied", decision: { decision: "deny", channel: "web" } });
  rejects(() => decide(f, { ...first, revision: 2 }, "approve"), "approval_card_not_pending", 409);
  // Expiry on the fake clock: the card reads expired, and a late approval is refused.
  const second = f.app.approvalCard(f.auth.actor, f.project.id, await id());
  f.clock.now += cardLifetimeMs;
  expect(f.app.approvalCard(f.auth.actor, f.project.id, second.id)).toMatchObject({ state: "expired", reason: "expired" });
  rejects(() => decide(f, second, "approve"), "approval_card_expired", 409);
  await settle(f);
  expect(f.fetches).toEqual([]);
  // The shape is exact: unknown fields or decisions are refused before anything is read.
  expect(() => approvalCommandIdentity({ kind: "approval.decide", requestId: rid(), projectId: f.project.id, expectedRevision: 1,
    payload: { cardId: second.id, digest: second.digest, decision: "approve", extra: true } } as never)).toThrow("invalid_approval_command");
  expect(() => approvalCommandIdentity({ kind: "approval.decide", requestId: rid(), projectId: f.project.id, expectedRevision: 1,
    payload: { cardId: second.id, digest: second.digest, decision: "maybe" } } as never)).toThrow("invalid_approval_command");
});

test("channel rules: Telegram decides single-action cards only; the local API, rules and targets are refused outside Web", async () => {
  const { f, propose } = await proposing();
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const remoteConnection = connection(f, "github_token", `ghp_${rid().replaceAll("-", "")}`);
  setRemote(f, remoteConnection);
  // A deploy card is one action: Telegram may decide it.
  const deploy = f.app.approvalCard(f.auth.actor, f.project.id, (JSON.parse((await propose(effectToolNames["effect.deploy"], { target: "production" })).content) as { cardId: string }).cardId);
  expect(deploy.telegramEligible).toBe(true);
  expect(decide(f, deploy, "deny", f.telegram).card).toMatchObject({ state: "denied", decision: { channel: "telegram" } });
  // A comment card from the local API (a host script, not the owner in Web) is refused.
  f.app.execute(f.auth.actor, { kind: "local_api.set", requestId: rid(), projectId: null, expectedRevision: f.app.localApi(f.auth.actor).revision, payload: { enabled: true } });
  const local = f.app.issueLocalApiActor()!.actor;
  const comment = f.app.approvalCard(f.auth.actor, f.project.id, (JSON.parse((await propose(effectToolNames["effect.github_comment"], { remote: "origin", issueNumber: 7, body: "ขอบคุณครับ" })).content) as { cardId: string }).cardId);
  rejects(() => decide(f, comment, "approve", local), "approval_requires_web", 403);
  // A multi-ref push is not a single action: Telegram is refused.
  const multi = f.store.transaction(tx => {
    const now = f.clock.now;
    tx.run(`INSERT INTO approval_cards (id, project_id, topic_id, run_id, job_id, role_id, kind, action_json, digest, revision, state, telegram_eligible, created_at, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'effect.git_push', '{}', ?, 1, 'pending', 0, ?, ?, ?)`, rid(), f.project.id, f.topic.id, rid(), rid(), f.jitId, "a".repeat(64), now, now + cardLifetimeMs, now);
    return tx.get<{ id: string }>("SELECT id FROM approval_cards WHERE telegram_eligible = 0")!.id;
  });
  const card = f.store.read(tx => readCard(tx, f.project.id, multi));
  rejects(() => decide(f, card, "approve", f.telegram), "approval_requires_web", 403);
  // Rules and targets widen power: Telegram and the local API cannot write them.
  rejects(() => setRule(f, "effect.deploy", { target: "production" }, true, f.telegram), "approval_rule_requires_web", 403);
  rejects(() => setRule(f, "effect.deploy", { target: "production" }, true, local), "approval_rule_requires_web", 403);
  rejects(() => f.app.execute(f.telegram, { kind: "effect.target.set", requestId: rid(), projectId: f.project.id, expectedRevision: 1,
    payload: { target: "deploy", name: "production", url: "https://evil.example.test/", connectionId: remoteConnection } }), "approval_rule_requires_web", 403);
  // A git remote needs a GitHub token; a deploy target a deploy secret.
  rejects(() => setDeploy(f, remoteConnection, "staging"), "effect_connection_kind_mismatch", 409);
  expect(f.fetches).toEqual([]);
});

test("auto-approve rules decide matching cards only, are Web-only and record the rule revision", async () => {
  const { f, propose } = await proposing({ fetch: () => new Response("{}", { status: 200 }) });
  setLevel(f, "full");
  const secret = connection(f, "deploy_secret", deployToken());
  setDeploy(f, secret);
  setDeploy(f, secret, "staging", "https://deploy.example.test/hooks/staging");
  expect(setRule(f, "effect.deploy", { target: "staging" }).rule).toMatchObject({ revision: 1, enabled: true, channel: "web", scope: { target: "staging" } });
  const auto = JSON.parse((await propose(effectToolNames["effect.deploy"], { target: "staging" })).content) as { state: string; cardId: string };
  expect(auto.state).toBe("approved");
  await f.executor.idle();
  expect(f.app.approvalCard(f.auth.actor, f.project.id, auto.cardId)).toMatchObject({ state: "succeeded", decision: { decision: "approve", channel: "auto-rule", ruleRevision: 1 } });
  expect(f.fetches.map(call => call.url)).toEqual(["https://deploy.example.test/hooks/staging"]);
  // Another target is not in the rule's scope.
  const manual = JSON.parse((await propose(effectToolNames["effect.deploy"], { target: "production" })).content) as { state: string; cardId: string };
  expect(manual.state).toBe("pending_approval");
  // A disabled rule (revision 2) decides nothing.
  expect(setRule(f, "effect.deploy", { target: "staging" }, false).rule).toMatchObject({ revision: 2, enabled: false });
  const disabled = JSON.parse((await propose(effectToolNames["effect.deploy"], { target: "staging" })).content) as { state: string };
  expect(disabled.state).toBe("pending_approval");
  await settle(f);
  expect(f.fetches).toHaveLength(1);
  // A stale rule revision is refused.
  rejects(() => f.app.execute(f.auth.actor, { kind: "approval.rule.set", requestId: rid(), projectId: f.project.id, expectedRevision: 1,
    payload: { effectKind: "effect.deploy", scope: { target: "staging" }, enabled: true } }), "stale_revision", 409);
});

test("effect tools are absent below full, and a card cannot be approved once the level falls below full", async () => {
  const { f, propose, names, results } = await proposing();
  setLevel(f, "workspace");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const refused = await propose(effectToolNames["effect.deploy"], { target: "production" });
  expect(refused).toEqual({ content: "Unknown tool: effect_deploy", isError: true });
  expect(names.at(-1)).toEqual(["read", "write", "edit", "bash", "grep", "find", "ls"]);
  expect(cards(f)).toEqual([]);
  setLevel(f, "full");
  const pending = JSON.parse((await propose(effectToolNames["effect.deploy"], { target: "production" })).content) as { cardId: string };
  expect(names.at(-1)).toEqual(["read", "write", "edit", "bash", "grep", "find", "ls", ...Object.values(effectToolNames)]);
  setLevel(f, "workspace");
  const card = f.app.approvalCard(f.auth.actor, f.project.id, pending.cardId);
  rejects(() => decide(f, card, "approve"), "access_level_insufficient", 409);
  expect(f.app.approvalCard(f.auth.actor, f.project.id, pending.cardId).state).toBe("pending");
  expect(results).toHaveLength(2);
  // Without an executor there is no effect tool at all, and approval is refused while denial still works.
  const bare = await effectFixture({ effects: false, script: (request, _s, _o, tools) => answer(request, JSON.stringify({ reply: tools.names.join(",") })) });
  fixtures.push(bare);
  setLevel(bare, "full");
  send(bare, "มีเครื่องมืออะไรบ้าง");
  await settle(bare);
  expect(texts(bare)).toContain("read,write,edit,bash,grep,find,ls");
});

test("a halt refuses approval and fails an approved card before it starts", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { f, propose } = await proposing({ executor: { afterClaim: () => gate } });
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const id = async () => (JSON.parse((await propose(effectToolNames["effect.deploy"], { target: "production" })).content) as { cardId: string }).cardId;
  const first = f.app.approvalCard(f.auth.actor, f.project.id, await id());
  const second = f.app.approvalCard(f.auth.actor, f.project.id, await id());
  f.app.execute(f.auth.actor, { kind: "execution.halt", requestId: rid(), projectId: f.project.id, expectedRevision: 0, payload: {} });
  rejects(() => decide(f, first, "approve"), "execution_halted", 409);
  // An approved card whose run had not started yet fails at its claim, with nothing attempted.
  f.store.transaction(tx => tx.run("UPDATE approval_cards SET state = 'executing', revision = revision + 1 WHERE id = ?", second.id));
  release();
  expect(await f.executor.run(f.project.id, second.id)).toMatchObject({ state: "failed", reason: "access_changed" });
  expect(f.fetches).toEqual([]);
});

test("a crash during executing yields unknown and owner attention, never an automatic retry", async () => {
  // The claimed run never reaches its effect: it stands for a process that died after the claim committed.
  let die!: (error: Error) => void;
  const hang = new Promise<void>((_, reject) => { die = reject; });
  const { f, propose } = await proposing({ executor: { afterClaim: () => hang } });
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const { cardId } = JSON.parse((await propose(effectToolNames["effect.deploy"], { target: "production" })).content) as { cardId: string };
  const card = f.app.approvalCard(f.auth.actor, f.project.id, cardId);
  decide(f, card, "approve");
  // The executor claimed the card (the effect may be under way) and the process "dies" here.
  await Bun.sleep(20);
  expect(f.app.approvalCard(f.auth.actor, f.project.id, cardId)).toMatchObject({ state: "executing" });
  expect(f.app.approvalCard(f.auth.actor, f.project.id, cardId).startedAt).not.toBeNull();
  // The next boot reconciles it to unknown; running it again does nothing.
  expect(f.executor.reconcile()).toEqual([cardId]);
  expect(f.app.approvalCard(f.auth.actor, f.project.id, cardId)).toMatchObject({ state: "unknown", reason: "interrupted", receipt: { outcome: "unknown" } });
  const again = await f.executor.run(f.project.id, cardId);
  expect(again.state).toBe("unknown");
  // The dead run's late settlement changes nothing: the card stays unknown and no effect was attempted.
  die(new Error("process died"));
  await f.executor.idle();
  expect(f.app.approvalCard(f.auth.actor, f.project.id, cardId).state).toBe("unknown");
  expect(f.fetches).toEqual([]);
  // An approved card that never started fails as interrupted_before_start: nothing was attempted.
  const other = f.app.approvalCard(f.auth.actor, f.project.id, (JSON.parse((await propose(effectToolNames["effect.deploy"], { target: "production" })).content) as { cardId: string }).cardId);
  f.store.transaction(tx => tx.run("UPDATE approval_cards SET state = 'executing', revision = revision + 1 WHERE id = ?", other.id));
  expect(f.executor.reconcile()).toEqual([other.id]);
  expect(f.app.approvalCard(f.auth.actor, f.project.id, other.id)).toMatchObject({ state: "failed", reason: "interrupted_before_start" });
});

test("model output and tool text cannot decide a card, add a rule or reach a credential", async () => {
  const secret = deployToken();
  const { f, propose } = await proposing();
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", secret));
  const result = await propose(effectToolNames["effect.deploy"], { target: "production", ref: "main", approve: true, decision: "approve" });
  // Extra fields are not part of the pinned action; the card stays pending.
  const { cardId } = JSON.parse(result.content) as { cardId: string };
  expect(f.app.approvalCard(f.auth.actor, f.project.id, cardId)).toMatchObject({ state: "pending", action: { kind: "effect.deploy", target: { name: "production" }, ref: "main" } });
  expect(canonicalJson(f.app.approvalCard(f.auth.actor, f.project.id, cardId).action)).not.toContain("approve");
  // The reply's text is untrusted and changes nothing.
  expect(f.app.effectSettings(f.auth.actor, f.project.id).rules).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(secret);
  // Unknown targets are refused without a card.
  const unknown = await propose(effectToolNames["effect.deploy"], { target: "nowhere" });
  expect(unknown.isError).toBe(true);
  expect(cards(f)).toHaveLength(1);
});

test("schema 37 classifies every new table for backups and every new owner-visible string exists in Thai and English", () => {
  for (const table of ["approval_cards", "auto_approve_rules", "git_remotes", "deploy_targets"]) expect(backupImageTables[table]).toBe("include");
  const keys = Object.keys(dictionaries.th).filter(key => /^(error\.(approval_|invalid_approval_|invalid_effect_|effect_|effects_)|effects\.)/.test(key));
  expect(keys.length).toBeGreaterThanOrEqual(15);
  for (const key of keys) expect(dictionaries.en[key as keyof typeof dictionaries.en]).toBeTruthy();
  for (const key of Object.keys(dictionaries.en).filter(key => key.startsWith("effects."))) expect(dictionaries.th[key as keyof typeof dictionaries.th]).toBeTruthy();
});


test("card lists filter by the state the owner sees, and a late decision records the expiry", async () => {
  const { f, propose } = await proposing();
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const { cardId } = JSON.parse((await propose(effectToolNames["effect.deploy"], { target: "production" })).content) as { cardId: string };
  expect(f.app.approvalCards(f.auth.actor, f.project.id, { state: "pending" }).map(card => card.id)).toEqual([cardId]);
  f.clock.now += cardLifetimeMs;
  // Not written yet, but read as expired: a pending query no longer lists it and an expired query does.
  expect(f.app.approvalCards(f.auth.actor, f.project.id, { state: "pending" })).toEqual([]);
  expect(f.app.approvalCards(f.auth.actor, f.project.id, { state: "expired" }).map(card => [card.id, card.state])).toEqual([[cardId, "expired"]]);
  // A decision after the deadline is refused, and the expiry it found is recorded durably.
  rejects(() => decide(f, f.store.read(tx => readCard(tx, f.project.id, cardId)), "approve"), "approval_card_expired", 409);
  expect(f.store.read(tx => tx.get<{ state: string; reason: string }>("SELECT state, reason FROM approval_cards WHERE id = ?", cardId))).toEqual({ state: "expired", reason: "expired" });
  expect(f.app.approvalCards(f.auth.actor, f.project.id, { state: "expired" }).map(card => card.id)).toEqual([cardId]);
  expect(f.fetches).toEqual([]);
});
