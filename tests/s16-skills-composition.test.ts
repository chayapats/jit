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
async function fixture(connections = false, fileFeature = false, model?: Model) {
  let f!: Fixture;
  const files = new Map<string, Uint8Array>(), calls: Record<string, unknown>[] = [];
  let gate: null | ((request: Record<string, unknown>) => Promise<void>) = null, lost = false;
  f = await firstRunFixture(options => { const base = options.vm.transport!; return { ...options, skills: {}, ...(fileFeature ? { files: { memory: true } } : {}), ...(model ? { model: { ...options.model, scripted: () => model } } : {}), ...(connections ? { connections: { vault: options.githubWeb!.vault } } : {}), team: { ...options.team!, retention: () => ({ kind: "team" }) }, computers: { idleStopMs: 30 * 60_000, sweepMs: 0 }, vm: { ...options.vm, transport: registration => {
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


test("SKILL16-01: a mapped reviewed MCP tool runs with the package, while another private source still refuses outbound arguments", async () => {
  const h = await fixture(true), { f } = h, directory = f.service.connections!;
  const remote: { method: string; arguments: unknown }[] = []; let sessions = 0;
  directory.options.network.open = async url => {
    expect(url).toBe("https://docs.example.com/mcp");
    return { close() {}, async send(input) {
      if (input.method === "DELETE") return { status: 204, headers: new Headers(), text: "" };
      const rpc = JSON.parse(input.body ?? "{}") as { id?: unknown; method: string; params?: { arguments?: unknown } };
      remote.push({ method: rpc.method, arguments: rpc.params?.arguments ?? null });
      const headers = new Headers({ "content-type": "application/json" }); let result: unknown;
      if (rpc.method === "initialize") { headers.set("Mcp-Session-Id", "fixture_" + ++sessions); result = { protocolVersion: "2025-06-18", serverInfo: { name: "docs", version: "1" }, capabilities: { tools: {} } }; }
      else if (rpc.method === "notifications/initialized") return { status: 202, headers, text: "" };
      else if (rpc.method === "tools/list") result = { tools: [{ name: "read_notes", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false }, annotations: { readOnlyHint: true } }] };
      else if (rpc.method === "tools/call") result = { content: [{ type: "text", text: "The docs command is bun test." }] };
      else throw Error("unexpected_fixture_rpc");
      return { status: 200, headers, text: JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }) };
    } };
  };
  const connected = await json<import("../src/s16/connections/types").ConnectionReceipt>(await f.request("/api/s16/client/connections/commands", "POST", { contract: "s16-connection-command/v1", requestId: uid(), kind: "source.add", sourceKind: "mcp", label: "Docs", endpoint: "https://docs.example.com/mcp", auth: { kind: "none" }, document: null, origin: null }));
  await json(await f.request("/api/s16/client/connections/commands", "POST", { contract: "s16-connection-command/v1", requestId: uid(), kind: "source.review", sourceId: connected.source!.id, expectedRevision: connected.source!.revision, catalogHash: connected.source!.catalogHash, decisions: { read_notes: "read" } }));
  const source = directory.record(connected.source!.id)!, bindings = { docs: { sourceId: source.id, catalogHash: source.catalog!.hash, reviewRevision: source.review!.revision } };
  await json(await command(f, { kind: "skill.update", skillId: h.detail.record.id, expectedRevision: h.detail.record.revision, input: { kind: "folder", label: "Controlled package", files: [...fixtureFiles, file("mcp.json", JSON.stringify({ mcpServers: { docs: { type: "streamable-http", url: source.endpoint } } }))] } }));
  const candidate = await json<SkillDetail>(await f.request(`/api/s16/client/skills/${h.detail.record.id}`)), sharing = await json<{ hash: string }>(await f.request(`/api/s16/client/skills/${h.detail.record.id}/review-preview`, "POST", { pin: candidate.candidate!.pin, dependencies: bindings }));
  await json(await command(f, { kind: "skill.review", skillId: candidate.record.id, expectedRevision: candidate.record.revision, pin: candidate.candidate!.pin, availability: { kind: "team" }, executable: true, dependencies: bindings, recipientsHash: sharing.hash }));
  const active = f.service.skills!.record(candidate.record.id)!;
  f.interpretation = { intent: "execute", purposeId: "owner_requested_work", resourceIds: ["computer", active.resource.id, source.resource.id], access: "reversible_write", subject: null };
  f.script = [{ type: "tool_call", id: "load", name: "skill_load", arguments: { skillId: active.id, unitId: candidate.candidate!.units[0]!.id, offset: 0 } }, { type: "tool_call", id: "docs", name: `docs_${source.id.slice(4, 8)}__read_notes`, arguments: { q: "reviewed query" } }];
  const row = await f.chat("Use the selected docs playbook and its reviewed connection.", "mapped_dependency"); expect(row.state).toBe("completed"); expect(row.evidence[1]!.content).toContain("The docs command is bun test.");
  expect(remote.filter(call => call.method === "tools/call").map(call => call.arguments)).toEqual([{ q: "reviewed query" }]);
  // Existing owning DATA15 setup classifies another source and approves only the model, not this MCP service.
  const extra = { id: "unrelated_private", revision: 1, generation: 1 }, computer = f.config.vm.resource;
  f.config.disclosure!.sources.push({ ref: extra, resource: computer, classification: "private", active: true, ownerReleasable: true }); f.config.catalog.push({ kind: "lineage", ref: extra, active: true });
  for (const purpose of f.service.policy.owner.current(f.owner())!.purposes) f.config.disclosure!.approvals.push({ recipient: f.routes[0]!.recipient, purpose, resources: [computer], sources: [extra], dataClasses: ["private"], expiresAt: f.now + 60000 });
  const guarded = await f.chat("Use the docs connection again within the same permitted resources.", "separate_private_input");
  expect({ state: guarded.state, code: guarded.code, evidence: guarded.evidence }).toMatchObject({ evidence: expect.arrayContaining([expect.objectContaining({ isError: true, content: expect.stringContaining("read_operation_unavailable") })]) }); expect(remote.filter(call => call.method === "tools/call")).toHaveLength(1);
  const actual = f.service.conversation.options.policy.open(guarded.authority!);
  expect(() => f.service.disclosure!.guardRead(actual.authority, "s16_sources", { source: source.id, tool: "read_notes", arguments: { q: "reviewed query" } })).toThrow("recipient_unapproved");
});


test("SKILL16-01: Bot-only guest release refuses a shared placement and then uses the actual private member", async () => {
  const h = await fixture(), { f } = h, bot = f.config.conversation.bot.id, sharing = f.service.skills!.recipients(f.owner(), h.detail.record.id, h.detail.active!.pin, {});
  await json(await command(f, { kind: "skill.review", skillId: h.detail.record.id, expectedRevision: h.detail.record.revision, pin: h.detail.active!.pin, availability: { kind: "bots", botIds: [bot] }, executable: true, dependencies: {}, recipientsHash: sharing.hash }));
  const active = f.service.skills!.record(h.detail.record.id)!;
  f.interpretation = { intent: "execute", purposeId: "owner_requested_work", resourceIds: ["computer", active.resource.id], access: "reversible_write", subject: null }; f.script = script(h.detail);
  const shared = await f.chat("Use the Bot-private package.", "private_on_shared"); expect(shared.result).toBeNull(); expect(shared.code).toBe("skill_private_computer_required"); expect(h.files.size).toBe(0); expect(f.service.skills!.copies()).toHaveLength(0);
  // A separate protected fixture member, assigned before it has ever held work. This proves service placement and
  // copy custody, not physical guest-root isolation or real-device enrollment (their own conformance remains separate).
  const privateId = "private_skill", registration = f.service.vmStore.registration(f.config.vm.id);
  f.service.vmStore.save({ ...registration, id: privateId }); f.service.computerScopes!.assignPrivate(privateId, bot);
  const placed = await f.chat("Use the same package on the assigned private computer.", "private_computer_skill");
  expect(placed.state).toBe("completed"); expect(f.service.vmPool.holder(placed.authority!.id)).toBe(privateId);
  expect(f.service.skills!.copies()).toMatchObject([{ vmId: privateId, botIds: [bot], skillId: active.id, pin: active.activePin }]);
  expect([...h.files].some(([path, bytes]) => path.endsWith("/result.txt") && new TextDecoder().decode(bytes) === "LAUNCH ON FRIDAY\n")).toBe(true);
});


test("SKILL16-01: file work uses the same skill session and artifact-derived input cannot drop the package's DATA15 ancestry", async () => {
  let detail!: SkillDetail, input!: { id: string; sha256: string }, turn = 0;
  const model: Model = { provider: "codex-subscription", id: "gpt-6.1-sol", async *stream(request) {
    let parts: ({ type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> } | { type: "text"; text: string })[];
    if (turn++ === 0) parts = [{ type: "tool_call", id: "read_file", name: "file_read", arguments: { id: input.id, offset: 0 } }, { type: "tool_call", id: "script", name: "skill_run", arguments: { skillId: detail.record.id, script: "scripts/emit.py", arguments: [] } }];
    else if (turn === 2) { const result = request.items.findLast(item => item.type === "tool_result" && item.toolCallId === "script"); if (!result || result.type !== "tool_result") throw Error("missing_actual_skill_result"); const path = JSON.parse(result.content).path; parts = [{ type: "tool_call", id: "collect", name: "computer_file_collect", arguments: { path: path + "/result.txt", name: "result.txt" } }]; }
    else parts = [{ type: "text", text: "Collected the observed result file." }];
    yield { type: "message_complete", message: { type: "assistant", id: uid(), content: parts } };
  } };
  const h = await fixture(false, true, model), { f } = h; detail = h.detail;
  // Independent owning FILE/DATA15 setup consents selected computer files to the configured model only.
  // It does not approve the package resource or another service/recipient.
  for (const purpose of f.service.policy.owner.current(f.owner())!.purposes) f.config.disclosure!.approvals.push({ recipient: f.routes[0]!.recipient, purpose, resources: [f.config.vm.resource], sources: null, dataClasses: ["private"], expiresAt: f.now + 60000 });
  const bytes = Buffer.from("owner-selected source\n"), hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const pending = f.service.files!.create(f.owner(), { requestId: uid(), conversationId: "first", name: "source.txt", bytes: bytes.length, sha256: hash });
  const upload = await f.service.files!.write(f.owner(), pending.id, new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } })); input = upload.receipt!;
  const send = async (requestId: string, file: { id: string; sha256: string }) => { const response = await f.request("/api/s16/client/conversations/first/messages", "POST", { contract: "s16-conversation/v2", requestId, conversationId: "first", text: "Process the selected source with the reviewed package.", continuation: null, files: [{ id: file.id, sha256: file.sha256 }] }); expect({ status: response.status, text: response.status === 202 ? "" : await response.text() }).toMatchObject({ status: 202 }); await f.service.drain(); return f.service.conversation.view(f.owner(), requestId); };
  const row = await send("skill_file_work", input); expect({ state: row.state, code: row.code, evidence: row.evidence }).toMatchObject({ state: "completed" }); expect(row.artifacts).toHaveLength(1); expect(f.vmCalls.filter(op => op === "init")).toHaveLength(1);
  const artifact = row.artifacts![0]!; expect(new TextDecoder().decode(f.service.files!.artifact(f.owner(), artifact.id).bytes)).toBe("LAUNCH ON FRIDAY\n");
  const selected = await json<import("../src/s16/files/types").FileUpload>(await f.request(`/api/s16/client/artifacts/${artifact.id}/inputs`, "POST", { requestId: uid(), conversationId: "first", sha256: artifact.sha256 }), 201);
  f.interpretation = { intent: "inspect", purposeId: "owner_requested_work", resourceIds: ["computer"], access: "read", subject: null };
  const before = h.calls.length, denied = await send("derived_without_package", selected.receipt!); expect(denied.result).toBeNull(); expect(h.calls).toHaveLength(before);
  expect(f.service.skills!.record(detail.record.id)!.activePin).toBe(detail.active!.pin);
});
