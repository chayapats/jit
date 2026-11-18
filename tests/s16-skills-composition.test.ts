import { afterEach, expect, test } from "bun:test";
import type { Model } from "schway/host";
import type { VmSshTransport } from "../src/s15/vm/transport";
import type { SkillDetail } from "../src/s16/skills/owner-view";
import type { SkillReceipt } from "../src/s16/skills/types";
import { firstRunFixture } from "./fixtures/s15-first-run";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const uid = () => crypto.randomUUID().replaceAll("-", "");
const file = (path: string, text: string) => ({ path, base64: Buffer.from(text).toString("base64") });
const fixtureFiles = [file("SKILL.md", "---\nname: emit\ndescription: Render the reviewed template.\n---\nThe test command is bun test.\nRead docs/template.txt and run scripts/emit.py to produce result.txt.\n"), file("docs/template.txt", "launch on friday\n"), file("scripts/emit.py", "from pathlib import Path\nPath('result.txt').write_text(Path('docs/template.txt').read_text().upper())\n"), file("LICENSE", "MIT License\nSelf-authored deterministic fixture.\n")];
type Fixture = Awaited<ReturnType<typeof firstRunFixture>>;
async function json<T>(response: Response, status = 200): Promise<T> { const text = await response.text(); expect({ status: response.status, text }).toMatchObject({ status }); return JSON.parse(text) as T; }
const command = (f: Fixture, value: object, requestId = uid()) => f.request("/api/s16/client/skills/commands", "POST", { contract: "s16-skill-command/v1", requestId, ...value });
async function fixture() {
  let f!: Fixture;
  const files = new Map<string, Uint8Array>(), calls: Record<string, unknown>[] = [];
  let gate: null | ((request: Record<string, unknown>) => Promise<void>) = null, lost = false;
  f = await firstRunFixture(options => { const base = options.vm.transport!; return { ...options, skills: {}, team: { ...options.team!, retention: () => ({ kind: "team" }) }, computers: { idleStopMs: 30 * 60_000, sweepMs: 0 }, vm: { ...options.vm, transport: registration => {
    const transport = base(registration), invoke = transport.invoke.bind(transport);
    transport.invoke = (async (request: Record<string, unknown>, input: Parameters<VmSshTransport["invoke"]>[1]) => {
      if (request.op !== "write" && request.op !== "read" && request.op !== "spawn") return invoke(request, input);
      await gate?.(request); input.beforeStart(); calls.push(structuredClone(request)); f.vmCalls.push(String(request.op));
      if (request.op === "write") { files.set(String(request.path), Buffer.from(String(request.data), "base64")); return {}; }
      if (request.op === "read") return { data: Buffer.from(files.get(String(request.path)) ?? []).toString("base64") };
      const success = (stdout = "") => ({ stdout: Buffer.from(stdout).toString("base64"), stderr: "", exitCode: 0, timedOut: false, truncated: false, totalBytes: Buffer.byteLength(stdout) });
      if (String(request.command).startsWith("set -eu\numask 077\n")) {
        // Controlled guest filesystem semantics: copies consume only bytes actually transferred through VM15.
        for (const match of String(request.command).matchAll(/^cp -- '([^']*)' '([^']*)'$/gm)) { const bytes = files.get(match[1]!); if (!bytes) throw Error("fixture_missing_transferred_file"); files.set(match[2]!, Uint8Array.from(bytes)); }
        return success();
      }
      if (String(request.command).startsWith("python3 '")) {
        const cwd = String(request.cwd); expect(new TextDecoder().decode(files.get(`${cwd}/scripts/emit.py`))).toBe(Buffer.from(fixtureFiles[2]!.base64, "base64").toString());
        const source = files.get(`${cwd}/docs/template.txt`); if (!source) throw Error("fixture_missing_template");
        files.set(`${cwd}/result.txt`, Buffer.from(new TextDecoder().decode(source).toUpperCase())); if (lost) throw Error("fixture_script_reply_lost"); return success("wrote result.txt\n");
      }
      return success("ordinary work\n");
    }) as VmSshTransport["invoke"]; return transport;
  } } }; });
  cleanup.push(() => f.close());
  const setup = await f.page("/setup", "en"), hash = (name: string) => new RegExp(`name="${name}" value="([a-f0-9]{64})"`).exec(setup.html)?.[1];
  expect((await f.form("/s15/forms/rules/install", { proposalHash: hash("proposalHash")!, ...(hash("listHash") ? { listHash: hash("listHash")! } : {}), return: "setup" })).status).toBeLessThan(400);
  const imported = await json<SkillReceipt>(await command(f, { kind: "skill.import", input: { kind: "folder", label: "Controlled package", files: fixtureFiles } }));
  const preview = await json<SkillDetail>(await f.request(`/api/s16/client/skills/${imported.skillId}`));
  const recipients = await json<{ hash: string }>(await f.request(`/api/s16/client/skills/${imported.skillId}/review-preview`, "POST", { pin: preview.candidate!.pin, dependencies: {} }));
  const reviewed = await json<SkillReceipt>(await command(f, { kind: "skill.review", skillId: imported.skillId, expectedRevision: preview.record.revision, pin: preview.candidate!.pin, availability: { kind: "team" }, executable: true, dependencies: {}, recipientsHash: recipients.hash }));
  expect(reviewed.policy).toBe("installed");
  const detail = await json<SkillDetail>(await f.request(`/api/s16/client/skills/${reviewed.skillId}`));
  f.interpretation = { intent: "execute", purposeId: "owner_requested_work", resourceIds: ["computer", detail.record.resource.id], access: "reversible_write", subject: null };
  return { f, files, calls, detail, set gate(value: typeof gate) { gate = value; }, set lost(value: boolean) { lost = value; } };
}
const script = (detail: SkillDetail) => [{ type: "tool_call" as const, id: "load", name: "skill_load", arguments: { skillId: detail.record.id, unitId: detail.active!.units[0]!.id, offset: 0 } }, { type: "tool_call" as const, id: "run", name: "skill_run", arguments: { skillId: detail.record.id, script: "scripts/emit.py", arguments: [] } }];

test("SKILL16-01: exact client review → CHAT instruction read → same placed VM script effect → retained pin/lineage and restart", async () => {
  const { f, detail, files, calls } = await fixture(); f.script = script(detail);
  const row = await f.chat("Use the reviewed playbook to render its template.", "run_skill");
  expect(row.state).toBe("completed"); expect(row.evidence.map(e => e.tool)).toEqual(["skill_load", "skill_run"]);
  expect(row.evidence[0]!.content).toContain("The test command is bun test."); const output = JSON.parse(row.evidence[1]!.content); expect(output).toMatchObject({ pin: detail.active!.pin, exitCode: 0, stdout: "wrote result.txt\n", basis: "guest_reported" });
  const result = [...files].find(([path]) => path.endsWith("/result.txt")); expect(new TextDecoder().decode(result![1])).toBe("LAUNCH ON FRIDAY\n");
  const root = `/var/lib/jit-work/${row.authority!.id}/chat_${row.authority!.id}`; expect(result![0].startsWith(root + "/inputs/")).toBe(true);
  expect(calls.filter(call => call.op === "spawn").every(call => String(call.cwd).startsWith(root))).toBe(true); expect(f.vmCalls.filter(op => op === "init")).toHaveLength(1);
  expect(f.prompts.some(prompt => prompt.includes("The test command is bun test."))).toBe(true);
  expect(f.service.conversation.store.request("run_skill").skillUses).toHaveLength(2); expect(f.service.skills!.copies()).toHaveLength(1);
  const work = f.service.conversation.options.policy.open(row.authority!), packet = f.service.memory.derivative(f.service.team.bind(work.actor), "run_skill"); expect(packet.dataRefs?.length).toBeGreaterThan(0);
  const before = calls.length; await f.reopen(); await f.service.drain(); expect(calls).toHaveLength(before); expect(f.service.conversation.view(f.owner(), "run_skill").result).not.toBeNull();
  f.interpretation = { intent: "execute", purposeId: "owner_requested_work", resourceIds: ["computer"], access: "reversible_write", subject: null }; f.script = [{ type: "tool_call", id: "ordinary", name: "bash", arguments: { command: "printf ordinary" } }];
  expect((await f.chat("Continue ordinary work on the same computer.", "ordinary_work")).state).toBe("completed");
});

test("SKILL16-01: revoke during staging fences the actual write and later script/publication while retaining the claimed pin", async () => {
  const h = await fixture(), entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>(); h.f.script = script(h.detail);
  h.gate = async request => { if (request.op === "write") { h.gate = null; entered.resolve(); await resume.promise; } };
  const running = h.f.chat("Run the reviewed script.", "revoke_during_stage"); await entered.promise;
  await json(await command(h.f, { kind: "skill.revoke", skillId: h.detail.record.id, expectedRevision: h.detail.record.revision })); resume.resolve();
  const row = await running; expect(row.state).not.toBe("completed"); expect(row.result).toBeNull(); expect(h.files.size).toBe(0); expect(h.calls.filter(call => call.op === "spawn")).toHaveLength(0);
  expect(h.f.service.conversation.store.request("revoke_during_stage").skillUses?.length).toBeGreaterThan(0);
});

test("SKILL16-01: a lost script response preserves actual VM bytes and unknown evidence, without replay on restart", async () => {
  const h = await fixture(); h.lost = true; h.f.script = script(h.detail); const row = await h.f.chat("Run the reviewed script once.", "lost_script");
  expect(row.state).not.toBe("completed"); expect(row.result).toBeNull(); expect([...h.files].some(([path, bytes]) => path.endsWith("/result.txt") && new TextDecoder().decode(bytes) === "LAUNCH ON FRIDAY\n")).toBe(true);
  const before = h.calls.length; await h.f.reopen(); await h.f.service.drain(); expect(h.calls).toHaveLength(before);
  expect(h.f.service.conversation.store.request("lost_script").state).not.toBe("completed"); expect(h.f.service.vmStore.db.query<{ id: string }, [string]>("SELECT id FROM vm_sessions WHERE work_id=?").all(row.authority!.id).flatMap(session => h.f.service.vmStore.evidence(session.id)).some(e => e.outcome === "unknown")).toBe(true);
});


test("SKILL16-01: the public CHAT fallback uses the same guarded package pin and actual placed VM, with no controller execution", async () => {
  const h = await fixture(), sent: string[] = []; let turn = 0;
  const model: Model = { provider: "codex-subscription", id: "gpt-6.1-sol", async *stream(request) {
    sent.push(JSON.stringify(request)); yield { type: "message_complete", message: { type: "assistant", id: uid(), content: turn++ === 0 ? script(h.detail) : [{ type: "text", text: "Observed the script result." }] } };
  } };
  delete h.f.service.conversation.options.runWork; h.f.service.conversation.options.model = model;
  const row = await h.f.chat("Use the reviewed package through the public fallback.", "fallback_skill");
  expect(row.state).toBe("completed"); expect(row.evidence.map(e => e.tool)).toEqual(["skill_load", "skill_run"]); expect(sent.some(text => text.includes("wrote result.txt"))).toBe(true);
  expect([...h.files].some(([path, bytes]) => path.endsWith("/result.txt") && new TextDecoder().decode(bytes) === "LAUNCH ON FRIDAY\n")).toBe(true);
  expect(h.f.service.conversation.store.request("fallback_skill").skillUses).toHaveLength(2);
});
