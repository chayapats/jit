import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { Application } from "../src/application";
import { dictionaries } from "../src/i18n";
import { cardLifetimeMs } from "../src/exec/approval-cards";
import { effectToolNames } from "../src/exec/effect-tools";
import { TelegramChannel } from "../src/telegram/channel";
import { TelegramProjectCommands } from "../src/telegram/project-commands";
import { notifyApprovalCard } from "../src/telegram/approval-notify";
import { renderApprovalMessage } from "../src/telegram/approval-messages";
import { readCallbackRef } from "../src/telegram/callbacks";
import { answer, cards, connection, effectFixture, rid, send, setDeploy, setLevel, setRemote, settle, type EffectFixture } from "./fixtures/effects";

const fixtures: EffectFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.close(); rmSync(f.root, { recursive: true, force: true }); rmSync(dirname(f.box.root), { recursive: true, force: true }); }
});
type Call = { name: string; input: unknown };
async function proposing() {
  const queue: Call[] = [];
  const f = await effectFixture({ script: async (request, _s, _o, tools) => {
    for (const call of queue.splice(0)) await tools.call(call.name, call.input);
    return answer(request, JSON.stringify({ reply: "เสนอการ์ดแล้ว" }));
  } });
  fixtures.push(f);
  f.store.transaction(tx => {
    tx.run("UPDATE telegram_binding SET revision = 2, state = 'bound', telegram_user_id = 99, telegram_chat_id = 99, bound_at = ?, proof_json = '{\"confirmedBy\":\"owner_web\",\"confirmedAt\":1,\"requestId\":\"x\"}' WHERE id = 1", f.clock.now);
  });
  const telegram = new TelegramChannel(f.store, f.config, { now: () => f.clock.now });
  const commands = new TelegramProjectCommands(f.store, { app: f.app, sessionToken: f.token, config: f.config, now: () => f.clock.now });
  const propose = async (name: string, input: unknown) => {
    queue.push({ name, input });
    send(f, "ทำให้หน่อย");
    await settle(f);
    return cards(f).at(-1)!;
  };
  return { f, telegram, commands, propose };
}
const deployToken = () => `deploy-${rid()}-${rid()}`;
function callback(updateId: number, data: string, userId = 99, chatId = 99) {
  return { update_id: updateId, callback_query: { id: `cb-${updateId}`, from: { id: userId }, data, message: { message_id: 9000 + updateId, chat: { id: chatId, type: "private" } } } };
}
const intents = (f: EffectFixture) => f.store.read(tx => tx.all<{ record_json: string }>("SELECT record_json FROM delivery_intents ORDER BY sequence"));
const lastIntentText = (f: EffectFixture) => {
  const row = f.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents ORDER BY sequence DESC LIMIT 1"));
  return row ? (JSON.parse(row.record_json) as { payload: { text: string } }).payload.text : "";
};

for (const saved of [false, true]) test(`(1) needs-me approval notifies once with two buttons (saved=${saved})`, async () => {
  const { f, propose } = await proposing();
  if (saved) f.app.execute(f.auth.actor, { kind: "attention.set", requestId: rid(), projectId: null, expectedRevision: 0, payload: { channel: "telegram", level: "needs-me" } });
  expect(f.app.attentionLevels(f.auth.actor).telegram).toMatchObject({ level: "needs-me", revision: saved ? 1 : 0 });
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const card = await propose(effectToolNames["effect.deploy"], { target: "production" });
  expect(card.telegramEligible).toBe(true);
  const notified = notifyApprovalCard(f.store, card, f.clock.now);
  expect(notified).not.toBeNull();
  const intent = intents(f).find(i => i.record_json.includes(`approval/${card.id}`));
  expect(intent).toBeTruthy();
  const datas = [...intent!.record_json.matchAll(/tg\/1\/[a-f0-9]{32}/g)].map(m => m[0]);
  expect(datas).toHaveLength(2);
  expect(intents(f).filter(i => i.record_json.includes(`approval/${card.id}`))).toHaveLength(1);
  expect(notifyApprovalCard(f.store, card, f.clock.now)).toBeNull();
});

test("(2) a non-eligible card → no intent", async () => {
  const { f } = await proposing();
  setLevel(f, "full");
  const card = f.store.transaction(tx => {
    tx.run(`INSERT INTO approval_cards (id, project_id, topic_id, run_id, job_id, role_id, kind, action_json, digest, revision, state, telegram_eligible, created_at, expires_at, updated_at, started_at)
      VALUES (?, ?, ?, ?, ?, ?, 'effect.git_push', '{}', ?, 1, 'pending', 0, ?, ?, ?, NULL)`, rid(), f.project.id, f.topic.id, rid(), rid(), f.jitId, "a".repeat(64), f.clock.now, f.clock.now + cardLifetimeMs, f.clock.now);
    return tx.get<{ id: string }>("SELECT id FROM approval_cards WHERE telegram_eligible = 0")!;
  });
  const full = f.app.approvalCard(f.auth.actor, f.project.id, card.id);
  expect(full.telegramEligible).toBe(false);
  expect(notifyApprovalCard(f.store, full, f.clock.now)).toBeNull();
  expect(intents(f).some(i => i.record_json.includes(`approval/${card.id}`))).toBe(false);
});

test("(3) approve callback from the bound chat decides the card once with channel telegram", async () => {
  const { f, telegram, commands, propose } = await proposing();
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const card = await propose(effectToolNames["effect.deploy"], { target: "production" });
  const notified = notifyApprovalCard(f.store, card, f.clock.now)!;
  telegram.ingest([callback(701, notified.approveData)]);
  telegram.processProjectCommands(commands);
  await settle(f);
  const decided = f.app.approvalCard(f.auth.actor, f.project.id, card.id);
  expect(decided.decision).toMatchObject({ decision: "approve", channel: "telegram" });
  expect(["executing", "succeeded"]).toContain(decided.state);
  expect(lastIntentText(f)).toContain(dictionaries.th["approval.state_executing"] ?? dictionaries.th["approval.state_succeeded"] ?? "");
});

test("(4) same callback again → approval.used and no second decide", async () => {
  const { f, telegram, commands, propose } = await proposing();
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const card = await propose(effectToolNames["effect.deploy"], { target: "production" });
  const notified = notifyApprovalCard(f.store, card, f.clock.now)!;
  telegram.ingest([callback(711, notified.approveData)]);
  telegram.processProjectCommands(commands);
  await settle(f);
  const once = f.app.approvalCard(f.auth.actor, f.project.id, card.id);
  telegram.ingest([callback(712, notified.approveData)]);
  telegram.processProjectCommands(commands);
  const twice = f.app.approvalCard(f.auth.actor, f.project.id, card.id);
  expect(twice.revision).toBe(once.revision);
  expect(lastIntentText(f)).toContain(dictionaries.th["telegram.approval_used"]);
});

test("(5) callback from another chat → rejected", async () => {
  const { f, telegram, commands, propose } = await proposing();
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const card = await propose(effectToolNames["effect.deploy"], { target: "production" });
  const notified = notifyApprovalCard(f.store, card, f.clock.now)!;
  telegram.ingest([callback(721, notified.approveData, 100, 100)]);
  telegram.processProjectCommands(commands);
  expect(f.app.approvalCard(f.auth.actor, f.project.id, card.id).state).toBe("pending");
});

test("(6) callback after the card expiry → expired notice", async () => {
  const { f, telegram, commands, propose } = await proposing();
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const card = await propose(effectToolNames["effect.deploy"], { target: "production" });
  const notified = notifyApprovalCard(f.store, card, f.clock.now)!;
  f.clock.now += cardLifetimeMs + 1;
  telegram.ingest([callback(731, notified.approveData)]);
  telegram.processProjectCommands(commands);
  expect(lastIntentText(f)).toContain(dictionaries.th["telegram.approval_expired"]);
  expect(f.app.approvalCard(f.auth.actor, f.project.id, card.id).state).toBe("expired");
});

test("(7) the ref expiry equals the card expiry when sooner than 24h", async () => {
  const { f, propose } = await proposing();
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const card = await propose(effectToolNames["effect.deploy"], { target: "production" });
  const notified = notifyApprovalCard(f.store, card, f.clock.now)!;
  const id = notified.approveData.slice("tg/1/".length);
  const ref = f.store.read(tx => readCallbackRef(tx, id, f.clock.now));
  expect(ref.expiresAt).toBe(card.expiresAt);
  expect(ref.expectedDigest).toBe(card.digest);
});

test("(8) the rendered text contains no { and no JSON details", async () => {
  const { f, propose } = await proposing();
  setLevel(f, "full");
  const remote = connection(f, "github_token", `ghp_${rid().replaceAll("-", "")}`);
  setRemote(f, remote);
  const card = await propose(effectToolNames["effect.github_comment"], { remote: "origin", issueNumber: 7, body: "ขอบคุณครับ" });
  const rendered = renderApprovalMessage(card, "th", { projectName: "โครงการ", topicTitle: "หัวข้อ" });
  expect(rendered.text).not.toContain("{");
  expect(rendered.text).not.toContain('"kind"');
  expect(rendered.buttons).toHaveLength(2);
});

test("a push card with 20 long commit summaries still notifies within the byte budget", async () => {
  const { f } = await proposing();
  setLevel(f, "full");
  setRemote(f, connection(f, "github_token", `ghp_${rid().replaceAll("-", "")}`));
  const { actionDigest, canonicalJson } = await import("../src/exec/approval-cards");
  const sha = (n: number) => n.toString(16).padStart(40, "0");
  const action = {
    kind: "effect.git_push" as const,
    remote: { name: "origin", url: "https://github.com/owner/repo.git", revision: 1 },
    repository: ".",
    updates: [{ ref: "refs/heads/main", oldSha: "a".repeat(40), newSha: "b".repeat(40) }],
    commits: Array.from({ length: 20 }, (_, i) => ({ sha: sha(i + 1), summary: `งาน ${i} ` + "ก".repeat(300) })),
  };
  const cardId = rid(), now = f.clock.now;
  f.store.transaction(tx => {
    tx.run(`INSERT INTO approval_cards (id, project_id, topic_id, run_id, job_id, role_id, kind, action_json, digest, revision, state, telegram_eligible, created_at, expires_at, updated_at, started_at)
      VALUES (?, ?, ?, ?, ?, ?, 'effect.git_push', ?, ?, 1, 'pending', 1, ?, ?, ?, NULL)`,
      cardId, f.project.id, f.topic.id, rid(), rid(), f.jitId, canonicalJson(action), actionDigest(action as never), now, now + cardLifetimeMs, now);
  });
  const full = f.app.approvalCard(f.auth.actor, f.project.id, cardId);
  expect(full.telegramEligible).toBe(true);
  const notified = notifyApprovalCard(f.store, full, now);
  expect(notified).not.toBeNull();
  const text = lastIntentText(f);
  expect(Buffer.byteLength(text) <= 4000).toBe(true);
  expect(text).toContain(notified!.approveData);
  expect(text).toContain(notified!.denyData);
  expect(text).toMatch(/และอีก \d+ รายการ|and \d+ more/);
});

test("tapping an expired card after a newer callback still answers expired", async () => {
  const { f, telegram, commands, propose } = await proposing();
  setLevel(f, "full");
  setDeploy(f, connection(f, "deploy_secret", deployToken()));
  const card = await propose(effectToolNames["effect.deploy"], { target: "production" });
  const notified = notifyApprovalCard(f.store, card, f.clock.now)!;
  f.clock.now += cardLifetimeMs + 1;
  // A newer callback prunes through the tombstone window but keeps the old refs readable.
  await propose(effectToolNames["effect.deploy"], { target: "production" });
  const next = cards(f)[0]!;
  expect(next.id).not.toBe(card.id);
  notifyApprovalCard(f.store, next, f.clock.now);
  telegram.ingest([callback(741, notified.approveData)]);
  telegram.processProjectCommands(commands);
  expect(lastIntentText(f)).toContain(dictionaries.th["telegram.approval_expired"]);
  expect(f.app.approvalCard(f.auth.actor, f.project.id, card.id).state).toBe("expired");
});
