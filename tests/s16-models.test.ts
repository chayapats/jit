import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Model } from "schway/host";
import type { ApprovedModelRoute } from "../src/s15/model/types";
import type { ClientModelsView } from "../src/s16/client/contracts";
import { canonical } from "../src/s15/conversation/validation";
import { JitClient } from "../src/s16/client";
import { composedFixture } from "./fixtures/s15-composition";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const uid = () => crypto.randomUUID().replaceAll("-", "");
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

async function fixture() {
  let high!: ApprovedModelRoute, available = true, configured = true, fail = false, gate: Promise<void> | undefined;
  let entered = Promise.withResolvers<void>();
  const selected: string[] = [], prompts: string[] = [];
  const f = await composedFixture("default", false, undefined, o => {
    const base = o.model.registry.list()[0]!;
    high = { ...base, selection: { ...base.selection, model: { ...base.selection.model, id: "high_model" }, effort: "high" }, efforts: ["high"], rank: { ordinary: 1, difficult: 0 } };
    if (!o.proposedPolicy!.selections.some(selection => same(selection, high.selection))) {
      o.proposedPolicy!.selections.push(high.selection);
      o.proposedPolicy!.rules.forEach(rule => rule.selections.push(high.selection));
    }
    const routes = () => [base, ...(configured ? [{ ...high, availability: available ? "available" as const : "unavailable" as const }] : [])];
    return { ...o, bots: {}, catalogs: { ...o.catalogs, current: (kind, id) => kind === "model" && id === "high_model" ? { ref: high.selection.model, active: true } : o.catalogs.current(kind, id) },
      model: { ...o.model, registry: { ...o.model.registry, list: routes, current: selection => routes().find(row => same(row.selection, selection)) ?? null }, scripted(route): Model {
        return { provider: "codex-subscription", id: route.modelId, async *stream(request) {
          selected.push(route.selection.effort); prompts.push(JSON.stringify(request));
          entered.resolve();
          if (gate) await gate;
          if (fail) throw new Error("controlled model failure");
          const last = request.items.at(-1);
          yield { type: "message_complete", message: { type: "assistant", id: uid(), content: last?.type === "tool_result" ? [{ type: "text", text: "Completed from observed evidence." }] : [{ type: "tool_call", id: uid(), name: "bash", arguments: { command: "printf evidence" } }] } };
        } };
      } } };
  });
  cleanups.push(() => f.close());
  const client = new JitClient({ origin: "http://localhost:3099", fetch: async request => {
    const url = new URL(request.url); return f.request(url.pathname + url.search, request.method, request.method === "POST" ? await request.json() : undefined);
  } });
  await client.bootstrap();
  async function choose(selection: ApprovedModelRoute["selection"] | null) {
    const profile = f.service.bots!.profile("bot")!;
    const response = await f.request("/api/s16/client/bots/commands", "POST", { contract: "s16-bot-command/v1", requestId: uid(), kind: "bot.update", botId: "bot", expectedRevision: profile.revision, name: "Jit", responsibility: "Keep useful context.", selection, assignments: true });
    expect(response.status).toBe(200);
  }
  return { f, high, client, selected, prompts, choose, removeRoute() { configured = false; }, unavailable() { available = false; }, failing() { fail = true; }, get entered() { return entered.promise; }, gate(value: Promise<void> | undefined) { gate = value; if (value) entered = Promise.withResolvers<void>(); } };
}

test("MODEL16 catalog and snapshot reads report configured routes without provider work or reservations", async () => {
  const { f, client } = await fixture();
  const before = f.service.policy.control.reservations().length;
  const view = await client.models();
  expect(view.routes.map(route => [route.provider, route.modelId, route.selection.effort, route.approved])).toEqual([["codex", "fixture-model", "low", true], ["codex", "fixture-model", "high", true]]);
  expect(view.routes[0]).toMatchObject({ account: { id: "provider_account" }, billing: { id: "subscription" }, recipient: { id: "provider" } });
  expect((await client.snapshot("conversation")).modelUsage).toEqual({ records: [], truncated: false });
  expect(f.interpreterPrompts).toHaveLength(0); expect(f.modelPrompts).toHaveLength(0);
  expect(f.service.policy.control.reservations()).toHaveLength(before);
  expect((await f.request("/api/s16/client/models", "GET", undefined, { cookie: "" })).status).toBe(401);
  expect((await f.request("/api/s16/client/models?route=other")).status).toBe(405);
  expect((await f.request("/api/s16/client/models", "POST", {})).status).toBe(405);
});

test("a withdrawn explicit pin holds without default inference; only an explicit default choice releases it", async () => {
  const { f, high, choose, selected } = await fixture(); await choose(high.selection);
  const old = f.service.policy.owner.current(f.owner)!;
  const input = structuredClone(f.policyInput); input.selections = [f.choice]; input.rules.forEach(rule => { rule.selections = [f.choice]; });
  f.service.policy.owner.install(f.owner, uid(), old.revision, input);
  const catalog = await (await f.request("/api/s16/client/models")).json() as ClientModelsView;
  expect(catalog.routes.find(route => route.selection.effort === "high")).toMatchObject({ approved: false, holdCode: "selection_pinned" });
  const profile = f.service.bots!.profile("bot")!;
  expect((await f.request("/api/s16/client/bots/commands", "POST", { contract: "s16-bot-command/v1", requestId: uid(), kind: "bot.update", botId: "bot", expectedRevision: profile.revision, name: "Jit", responsibility: "Keep context", selection: high.selection, assignments: true })).status).toBe(409);
  const calls = f.service.policy.control.reservations().length;
  const row = await f.chat("Update notes under my selected model.");
  expect(row.state).toBe("held"); expect(row.code).toBe("selection_pinned"); expect(selected).toHaveLength(0);
  expect(f.service.policy.control.reservations()).toHaveLength(calls);
  expect(f.service.bots!.profile("bot")!.selection).toEqual(high.selection);
  await choose(null);
  expect((await f.chat("Update notes with the explicit default.")).state).toBe("completed");
  expect(new Set(selected)).toEqual(new Set(["low"]));
});

test("removing a configured route holds an explicit pin before interpretation even while policy retains it", async () => {
  const { f, high, choose, removeRoute, selected, client } = await fixture();
  await choose(high.selection); removeRoute();
  expect(f.service.policy.owner.current(f.owner)!.selections).toContainEqual(high.selection);
  expect((await client.models()).routes.some(route => same(route.selection, high.selection))).toBe(false);
  const profile = (await client.bots()).bots.find(bot => bot.id === "bot")!;
  expect(profile.selectionUnavailable).toBe(true); expect(profile.selection).toEqual(high.selection);
  const reservations = f.service.policy.control.reservations().length;
  const row = await f.chat("Use my pinned route after its configuration was removed.");
  expect(row.state).toBe("held"); expect(row.code).toBe("selection_pinned");
  expect(f.interpreterPrompts).toHaveLength(0); expect(selected).toHaveLength(0);
  expect(f.service.policy.control.reservations()).toHaveLength(reservations);
  await choose(null);
  expect((await f.chat("Use the explicitly selected installation default.")).state).toBe("completed");
  expect(new Set(selected)).toEqual(new Set(["low"]));
});

test("live unavailability keeps the exact pin and produces an honest hold without fallback", async () => {
  const { f, high, choose, unavailable, selected, client } = await fixture(); await choose(high.selection); unavailable();
  const view = await client.models(); expect(view.routes.find(route => route.selection.effort === "high")!.holdCode).toBe("route_unavailable");
  const row = await f.chat("Use the pinned high route.");
  expect(row.state).toBe("held"); expect(selected).toHaveLength(0); expect(f.service.bots!.profile("bot")!.selection).toEqual(high.selection);
});

test("changing a Bot model preserves active-work pins and applies to subsequent work with the same conversation and memory", async () => {
  const a = await fixture(), { f, client, choose, high } = a;
  const first = await f.chat("I prefer concise notes. Update the notes."); expect(first.state).toBe("completed");
  let release!: () => void; a.gate(new Promise<void>(resolve => { release = resolve; }));
  const command = client.prepareMessage("conversation", "Update one task while I change the next model."); await client.send(command);
  const draining = f.service.conversation.drain();
  await a.entered;
  const active = f.service.conversation.store.request(command.requestId); expect(active.state).toBe("running"); expect(active.authority).not.toBeNull();
  try { await choose(high.selection); } finally { a.gate(undefined); release(); }
  await draining;
  const oldWork = f.service.policy.work.guard(f.service.policy.control.bindWork(active.authority!.id)); expect(oldWork.request.selectionPin).toEqual(f.choice);
  const next = await f.chat("Update the next task and keep my preference."); expect(next.state).toBe("completed");
  expect(f.service.policy.work.guard(f.service.policy.control.bindWork(next.authority!.id)).request.selectionPin).toEqual(high.selection);
  const previousNative = f.service.models.project(f.owner, active.authority!.id).selections[0]!.session;
  const nextNative = f.service.models.project(f.owner, next.authority!.id).selections[0]!.session;
  expect(previousNative).not.toBeNull(); expect(nextNative).not.toBeNull(); expect(nextNative!.id).not.toBe(previousNative!.id);
  const snapshot = await client.snapshot("conversation");
  expect(snapshot.botId).toBe("bot"); expect(snapshot.conversation.rows.map(row => row.requestId)).toContain(first.receipt.requestId);
  expect(snapshot.modelUsage!.records.find(row => row.requestId === command.requestId)!.selection.effort).toBe("low");
  expect(snapshot.modelUsage!.records.find(row => row.requestId === next.receipt.requestId)!.selection.effort).toBe("high");
  expect(a.prompts.at(-1)).toContain("concise notes");
  await f.reopen(); expect((await client.snapshot("conversation")).modelUsage).toEqual(snapshot.modelUsage);
});

test("failed work retains unknown usage and charged reservations across reads and restart", async () => {
  const a = await fixture(); a.failing();
  const row = await a.f.chat("Attempt the controlled failing task."); expect(row.state).not.toBe("completed");
  const before = a.f.service.policy.control.reservations();
  const snapshot = await a.client.snapshot("conversation"), observed = snapshot.modelUsage!.records[0]!;
  expect(observed.state).not.toBe("completed"); expect(observed.reservedCalls).toBeGreaterThan(0);
  expect(observed.tokens?.inputTokens ?? null).toBeNull(); expect(observed.tokens?.outputTokens ?? null).toBeNull(); expect(observed.physicalSends).toBeNull(); expect(observed.usage.spendMinor).toBeNull();
  expect(observed.partial).toBe(true);
  expect(JSON.stringify(snapshot.modelUsage)).not.toContain("controlled failing task");
  expect(a.f.service.policy.control.reservations()).toEqual(before);
  await a.f.reopen(); const after = await a.client.snapshot("conversation");
  expect(after.modelUsage!.records[0]!.reservedCalls).toBe(observed.reservedCalls); expect(a.f.service.policy.control.reservations()).toEqual(before);
});

test("work observations are bounded in SQL and exclude output/native session handles", async () => {
  const { f } = await fixture(); const row = await f.chat("Update the fixture notes."); expect(row.state).toBe("completed");
  const workId = row.authority!.id;
  const db = new Database(join(f.directory, "model.sqlite"));
  try {
    const original = JSON.parse(db.query<{ json: string }, []>("SELECT json FROM records LIMIT 1").get()!.json);
    for (let i = 0; i < 140; i++) db.query("INSERT INTO records VALUES (?,?)").run(`history_${i}`, JSON.stringify({ ...original, id: `history_${i}`, output: "PRIVATE_OUTPUT", session: { id: "PRIVATE_SESSION", branchId: "PRIVATE_BRANCH" } }));
    const records = f.service.models.observations(f.owner, [workId]);
    expect(records.records).toHaveLength(128); expect(records.truncated).toBe(true);
    expect(JSON.stringify(records)).not.toContain("PRIVATE_");
    expect(f.service.models.observations(f.owner, ["unrelated"])).toEqual({ records: [], truncated: false });
    expect(() => f.service.models.observations(f.owner, Array.from({ length: 33 }, (_, i) => `work_${i}`))).toThrow();
    const plan = db.query("EXPLAIN QUERY PLAN SELECT json FROM records WHERE json_extract(json,'$.workId')=? ORDER BY rowid DESC LIMIT 129").all(workId);
    expect(JSON.stringify(plan)).toContain("model_records_work");
  } finally { db.close(); }
});

test("client rejects model telemetry attached to a foreign request", async () => {
  const { f, client } = await fixture(); await f.chat("Update a note.");
  const snapshot = await client.snapshot("conversation"); snapshot.modelUsage!.records[0]!.requestId = "foreign";
  const forged = new JitClient({ origin: "https://jit.test", fetch: async () => Response.json(snapshot) });
  await expect(forged.snapshot("conversation")).rejects.toMatchObject({ code: "client_protocol_invalid" });
});
