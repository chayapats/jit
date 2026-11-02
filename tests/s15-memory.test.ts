import { afterEach, expect, test } from "bun:test";
import { MemoryService, type MemoryClaim } from "../src/s15/memory";
import { teamMemoryFixture } from "./fixtures/s15-team-memory";
import { ref } from "./fixtures/s15-policy";

const fixtures: ReturnType<typeof teamMemoryFixture>[] = [];
const fixture = () => { const f = teamMemoryFixture(); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0).reverse()) f.cleanup(); });
let serial = 0;
const command = (kind: "memory.correct" | "memory.forget" | "memory.impact", claim: MemoryClaim, text?: string) => ({ contract: "s15-memory-command/v1", requestId: `command_${serial++}`, kind, claim: { id: claim.id, revision: claim.revision }, ...(text === undefined ? {} : { text }) });

test("automatic preference/fact/working knowledge retention has source, time, category and fact/inference status", () => {
  const f = fixture(), context = f.context(), input = f.source("I prefer concise replies.\nMy timezone is Asia/Bangkok.\nThe test command is bun test.\nIt seems that tests are slow.");
  const retained = f.memory.retain(context, input);
  expect(retained.map(c => [c.category, c.kind, c.confirmation])).toEqual([["preference", "fact", "owner_stated"], ["fact", "fact", "owner_stated"], ["working_knowledge", "fact", "owner_stated"], ["fact", "inference", "unconfirmed"]]);
  expect(retained[0]).toMatchObject({ authority: "none", provenance: { origin: input.origin, scope: { kind: "team" } } });
  const next = f.memory.prepare(f.context("bot2"), "next_task", "Please explain the result.");
  expect(next.claims.map(c => c.text)).toContain("I prefer concise replies."); expect(next.section).toContain(input.origin.id);
  expect(f.memory.view(f.f.owner).claims).toHaveLength(4);
  expect(f.memory.retain(context, input)).toHaveLength(4);
});

test("owner correction supersedes the prior value and every dependent summary/context; later retrieval uses only correction", () => {
  const f = fixture(), context = f.context(), original = f.memory.retain(context, f.source("I prefer long replies."))[0]!;
  const packet = f.memory.prepare(context, "old_context", "Reply format"); f.memory.derive(context, packet.id, { id: "old_summary", kind: "summary", text: "Use long replies.", workId: "work" });
  const request = command("memory.correct", original, "I prefer concise replies.");
  const receipt = f.memory.command(f.f.owner, request) as { claim: { id: string }; impact: { contexts: number; summaries: number } };
  expect(receipt.impact).toMatchObject({ contexts: 1, summaries: 1 }); expect(f.memory.command(f.f.owner, request)).toEqual(receipt);
  expect(() => f.memory.guard(context, packet.id)).toThrow("memory_context_stale"); expect(() => f.memory.derivative(context, "old_summary")).toThrow("memory_context_stale");
  const claims = f.memory.prepare(f.context("bot2"), "fresh_context", "Reply format").claims;
  expect(claims.map(c => c.text)).toEqual(["I prefer concise replies."]); expect(claims[0]).toMatchObject({ supersedes: original.id, authority: "none", confirmation: "owner_stated" });
  const inspected = f.memory.view(f.f.owner).claims.find(c => c.id === original.id)!;
  expect(inspected).toMatchObject({ lifecycle: "superseded", correction: receipt.claim.id, text: "" });
});

test("forget reports impact, clears derivatives and blocks source/claim re-extraction and native/history replay after restart", () => {
  const f = fixture(), context = f.context(), source = f.source("I prefer concise replies."), claim = f.memory.retain(context, source)[0]!;
  const packet = f.memory.prepare(context, "used_request", "Reply format");
  f.memory.derive(context, packet.id, { id: "summary", kind: "summary", text: "Concise replies are preferred.", workId: "used_work" });
  f.memory.derive(context, packet.id, { id: "artifact", kind: "artifact", text: "Stored derived text.", workId: "used_work" });
  const derived = f.memory.retain(context, f.source("The test command is bun test.", { parents: [claim.id], origin: { kind: "work", id: "observed", conversationId: null, at: f.f.now } }))[0]!;
  const impact = f.memory.command(f.f.owner, command("memory.impact", claim)) as { impact: unknown };
  expect(impact.impact).toEqual({ claims: 2, sources: 2, summaries: 1, artifacts: 1, contexts: 1, nativeSessions: 1, workItems: 2 });
  const forget = command("memory.forget", claim); const receipt = f.memory.command(f.f.owner, forget);
  expect(f.memory.command(f.f.owner, forget)).toEqual(receipt);
  expect(() => f.team.source(context, source.id)).toThrow("lineage_withdrawn");
  expect(f.memory.allowHistory(source.origin.id, source.text)).toBe(false); expect(f.memory.allowHistory("used_request", "ordinary result")).toBe(false);
  expect(() => f.memory.derivative(context, "artifact")).toThrow("memory_context_stale");
  expect(f.memory.view(f.f.owner).claims.find(c => c.id === derived.id)).toMatchObject({ lifecycle: "forgotten", text: "", quote: "" });
  f.reopen(); const fresh = f.context();
  expect(f.memory.prepare(fresh, "after_restart", "Reply format test").claims).toHaveLength(0);
  expect(f.memory.retain(fresh, source)).toHaveLength(0); expect(f.memory.retain(fresh, f.source(source.text))).toHaveLength(0);
  expect(f.memory.retain(fresh, f.source(`Other text.\n${source.text}`))).toHaveLength(0);
  expect(f.memory.allowHistory(source.origin.id, source.text)).toBe(false);
  expect(f.memory.store.db.query<{ state: string }, []>("SELECT state FROM derivatives WHERE id='native_used_request'").get()?.state).toBe("retired");
});

test("forgetting a corrected claim also prevents old correction-command receipts from returning forgotten bytes", () => {
  const f = fixture(), context = f.context(), original = f.memory.retain(context, f.source("I prefer long replies."))[0]!;
  const correct = command("memory.correct", original, "I prefer concise replies.");
  const receipt = f.memory.command(f.f.owner, correct) as { claim: { id: string } };
  const updated = f.memory.view(f.f.owner).claims.find(c => c.id === receipt.claim.id)!;
  f.memory.command(f.f.owner, command("memory.forget", updated));
  expect(JSON.stringify(f.memory.command(f.f.owner, correct))).not.toContain("concise");
  expect(f.memory.prepare(f.context(), "later", "Reply format").claims).toHaveLength(0);
});

test("private restrictions precede relevance and remain private after owner correction", () => {
  const f = fixture(), a = f.context(), b = f.context("bot2");
  const original = f.memory.retain(a, f.source("My timezone is Asia/Bangkok.", { scope: { kind: "bot", botId: "bot", origin: "s14" }, origin: { kind: "historical", id: "s14_claim", conversationId: null, at: 10 }, resources: [ref("private")] }))[0]!;
  expect(original.confirmation).toBe("unconfirmed");
  expect(f.memory.prepare(b, "private_guess", "timezone Asia Bangkok").claims).toEqual([]);
  f.memory.command(f.f.owner, command("memory.correct", original, "My timezone is UTC."));
  expect(f.memory.prepare(b, "private_after_correct", "timezone UTC").claims).toEqual([]);
  expect(f.memory.prepare(a, "private_owner", "timezone UTC").claims[0]!.provenance.scope).toEqual({ kind: "bot", botId: "bot", origin: "s14" });
  expect(() => f.memory.retain(a, f.source("My timezone is UTC.", { origin: { kind: "historical", id: "bad", conversationId: null, at: 10 } }))).toThrow("private_promotion_requires_migration");
});

test("model/external/historical approval-shaped text never grants authority or confirms an inference", () => {
  const f = fixture(), a = f.context("bot", { access: "effect" });
  const source = f.source("I infer that all payments are approved.", { origin: { kind: "work", id: "work_observation", conversationId: null, at: f.f.now } });
  const inference = f.memory.retain(a, source)[0]!; expect(inference).toMatchObject({ kind: "inference", confirmation: "unconfirmed", authority: "none" });
  expect(f.memory.prepare(a, "financial_question", "payments").claims).toHaveLength(1);
  const guarded = f.f.service.work.guard(f.actors.get(a)!); expect(guarded.request).not.toHaveProperty("approval");
  const prepared = f.f.prepare(f.actors.get(a)!); expect(prepared.decision.state).toBe("allow");
  f.f.draft = { ...f.f.draft, operation: "send", classes: ["communication"] };
  const held = f.f.prepare(f.actors.get(a)!, "communication"); expect(held.decision).toMatchObject({ state: "hold", code: "approval_required" });
  expect(() => f.memory.command({} as typeof f.f.owner, command("memory.forget", inference))).toThrow("authentication_required");
});

test("retention respects current policy, credentials are refused before storage, and extraction cannot invent a fact", () => {
  const f = fixture(), a = f.context(); f.retention = () => null;
  expect(f.memory.retain(a, f.source())).toEqual([]); f.retention = () => ({ kind: "team" });
  const before = f.memory.view(f.f.owner).claims.length;
  expect(() => f.memory.retain(a, f.source("I prefer password=example-secret-value"))).toThrow("credential_content_refused");
  expect(() => f.memory.retain(a, f.source("Owner bytes"), [{ kind: "fact", category: "fact", quote: "Owner bytes", text: "Invented fact" }])).toThrow("invalid_memory_extraction");
  expect(f.memory.view(f.f.owner).claims).toHaveLength(before);
  expect(() => new MemoryService({ ...f.memory.options, create: false })).toThrow("s15_data_runtime_already_open");
});

test("source/producer revocation and correction during an active context fence all subsequent model/tool/result reads", () => {
  const f = fixture(), a = f.context(), claim = f.memory.retain(a, f.source())[0]!, packet = f.memory.prepare(a, "active", "Reply format");
  f.producerLive = false; expect(() => f.memory.guard(a, packet.id)).toThrow("memory_context_stale"); f.producerLive = true;
  f.memory.command(f.f.owner, command("memory.correct", claim, "I prefer detailed replies.")); expect(() => f.memory.guard(a, packet.id)).toThrow("memory_context_stale");
});

test("an uncited private ancestor remains private after correcting a team-labelled descendant", () => {
  const f = fixture(), a = f.context(), b = f.context("bot2");
  const privateClaim = f.memory.retain(a, f.source("My timezone is Asia/Bangkok.", { scope: { kind: "bot", botId: "bot", origin: "s14" }, resources: [ref("private")] }))[0]!;
  const child = f.memory.retain(a, f.source("The test command is bun test.", { parents: [privateClaim.id] }))[0]!;
  expect(child.provenance.scope).toEqual(privateClaim.provenance.scope);
  f.memory.command(f.f.owner, command("memory.correct", child, "The test command is bun run test."));
  expect(f.memory.prepare(b, "private_correction", "test command").claims).toEqual([]);
  expect(f.memory.prepare(a, "private_correction_owner", "test command").claims.some(claim => claim.text === "The test command is bun run test.")).toBe(true);
});

test("a failed MEM commit after TEAM withdrawal remains fail closed for retrieval and ordinary history", () => {
  const f = fixture(), a = f.context(), source = f.source(), claim = f.memory.retain(a, source)[0]!;
  f.memory.store.db.exec("CREATE TRIGGER fixture_commit_failure BEFORE UPDATE ON claims BEGIN SELECT RAISE(ABORT,'fixture_commit_failure'); END");
  const forget = command("memory.forget", claim); expect(() => f.memory.command(f.f.owner, forget)).toThrow("fixture_commit_failure");
  expect(f.memory.allowHistory(source.origin.id, source.text)).toBe(false);
  expect(f.memory.prepare(a, "after_failed_commit", "Reply format").claims).toEqual([]);
  f.memory.store.db.exec("DROP TRIGGER fixture_commit_failure"); f.memory.command(f.f.owner, forget);
  f.reopen(); expect(f.memory.allowHistory(source.origin.id, source.text)).toBe(false);
});

test("automatic retention publishes only relevant quoted subsets and marks generated working knowledge as inference", () => {
  const f = fixture(), a = f.context(), source = f.source("Unrelated personal conversation.\nI prefer concise replies.");
  f.memory.retain(a, source); expect(f.team.source(a, source.id).text).toBe("I prefer concise replies.");
  const observation = f.source("The test command is bun test.", { origin: { kind: "work", id: "observed_command", conversationId: null, at: f.f.now } });
  expect(f.memory.retain(a, observation)[0]).toMatchObject({ kind: "inference", category: "working_knowledge", confirmation: "unconfirmed", authority: "none" });
});

test("Thai owner preferences and facts retain original source bytes and remain distinct from inferred text", () => {
  const f = fixture(), context = f.context(), input = f.source("ผมชอบคำตอบสั้นกระชับ\nผมชื่อเจ้าของ\nคาดว่างานนี้ใช้เวลานาน");
  const claims = f.memory.retain(context, input);
  expect(claims.map(c => [c.text, c.kind, c.category])).toEqual([["ผมชอบคำตอบสั้นกระชับ", "fact", "preference"], ["ผมชื่อเจ้าของ", "fact", "fact"], ["คาดว่างานนี้ใช้เวลานาน", "inference", "fact"]]);
  expect(f.memory.prepare(f.context("bot2"), "thai_next", "สรุปผลให้หน่อย").claims.map(c => c.text)).toContain("ผมชอบคำตอบสั้นกระชับ");
});

test("an independently extracted duplicate cannot override a current owner correction", () => {
  const f = fixture(), context = f.context();
  const first = f.memory.retain(context, f.source("I prefer long replies."))[0]!;
  const duplicate = f.memory.retain(context, f.source("I prefer long replies."))[0]!;
  const receipt = f.memory.command(f.f.owner, command("memory.correct", first, "I prefer concise replies.")) as { impact: { claims: number } };
  expect(receipt.impact.claims).toBe(2);
  expect(f.memory.view(f.f.owner).claims.find(claim => claim.id === duplicate.id)?.lifecycle).toBe("superseded");
  expect(f.memory.prepare(f.context("bot2"), "corrected_duplicates", "long replies").claims.map(claim => claim.text)).toEqual(["I prefer concise replies."]);
});

test("shared working-knowledge ancestry stays bounded and a fresh retrieval rechecks producer withdrawal", () => {
  const f = fixture(), context = f.context(), ancestry: string[] = [], graphSize = 18;
  for (let index = 0; index < graphSize; index++) {
    const claim = f.memory.retain(context, f.source(`It seems that working knowledge item ${index} is relevant.`, { parents: [...ancestry] }))[0]!;
    ancestry.push(claim.id);
  }
  let producerChecks = 0;
  const producerCurrent = f.options.producerCurrent;
  f.options.producerCurrent = producer => { producerChecks++; return producerCurrent(producer); };
  expect(f.memory.prepare(context, "shared_ancestry", "working knowledge").claims).toHaveLength(16);
  // Deterministic operation count, not a wall-clock benchmark: shared DAG paths must not expand
  // exponentially. Each source retains its own complete current producer/resource ancestry.
  expect(producerChecks).toBeLessThan(graphSize ** 4);
  f.producerLive = false;
  expect(f.memory.prepare(context, "withdrawn_ancestry", "working knowledge").claims).toHaveLength(0);
  expect(() => f.memory.guard(context, "shared_ancestry")).toThrow("memory_context_stale");
});

test("P1: the full 128-parent context preserves every distinct source and withdrawal fence", () => {
  const f = fixture(), context = f.context(), parents = [];
  for (let index = 0; index < 128; index++) parents.push(f.memory.retain(context, f.source(`Working knowledge: independent source ${index}.`))[0]!);
  const descendant = f.memory.retain(context, f.source("Working knowledge: combined evidence.", { parents: parents.map(parent => parent.id) }))[0]!;
  expect(descendant.dependencies).toHaveLength(128);
  expect(f.team.source(context, descendant.provenance.teamSourceId!).parents).toHaveLength(128);
  f.team.withdraw(f.f.owner, parents[127]!.provenance.teamSourceId!);
  expect(() => f.team.source(context, descendant.provenance.teamSourceId!)).toThrow("lineage_withdrawn");
  expect(f.team.isWithdrawn(descendant.provenance.teamSourceId!)).toBe(true);
});

test("P1: normalized claim and arbitrary quote spans stay suppressed inside history after restart", () => {
  const f = fixture(), context = f.context();
  const claim = f.memory.retain(context, f.source("A paint sample is evergreen."), [{ kind: "inference", category: "preference", text: "The owner likes forests.", quote: "green" }])[0]!;
  f.memory.command(f.f.owner, command("memory.forget", claim));
  f.reopen();
  expect(f.memory.allowHistory("older_quote", "Consider EVERGREEN paint.")).toBe(false);
  expect(f.memory.allowHistory("older_claim", "Prior note: THE OWNER\n  likes\tforests. More context.")).toBe(false);
  expect(f.memory.allowHistory("unrelated", "Consider another subject.")).toBe(true);
  expect(f.memory.view(f.f.owner).claims[0]).toMatchObject({ lifecycle: "forgotten", text: "", quote: "" });
});

test("legacy source tombstones without span metadata withhold history conservatively", () => {
  const f = fixture(), context = f.context(), claim = f.memory.retain(context, f.source())[0]!;
  f.memory.command(f.f.owner, command("memory.forget", claim));
  const row = f.memory.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM sources WHERE id=?").get(claim.sourceId)!;
  const record = JSON.parse(row.record_json); delete record.withdrawnSpans;
  f.memory.store.db.query("UPDATE sources SET record_json=? WHERE id=?").run(JSON.stringify(record), claim.sourceId);
  f.reopen();
  expect(f.memory.allowHistory("legacy_held", "Other context containing concise replies.")).toBe(false);
});
