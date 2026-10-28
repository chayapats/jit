import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "../src/errors";
import { writeServerTools } from "../src/exec/mcp";
import { dictionaries } from "../src/i18n";
import { createWebHandler } from "../src/web";
import { answer, connection, effectFixture, rid, send, setLevel, settle, type EffectFixture } from "./fixtures/effects";

const fixtures: EffectFixture[] = [];
const origin = "http://localhost:3000";
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.close(); rmSync(f.root, { recursive: true, force: true }); rmSync(dirname(f.box.root), { recursive: true, force: true }); }
});

/** Installation without an MCP gateway: an accepted server stays `installing`, so the card round-trip is deterministic. */
async function fixture() {
  let nextReply = JSON.stringify({ reply: "ok" });
  const f = await effectFixture({ script: async request => answer(request, nextReply) });
  fixtures.push(f);
  const web = createWebHandler(f.app);
  const propose = async (items: Record<string, unknown>[]) => {
    setLevel(f, "workspace");
    nextReply = JSON.stringify({ reply: "เสนอให้ติดตั้ง MCP", proposals: items });
    send(f, "ติดตั้ง MCP ให้หน่อย");
    await settle(f);
    return f.app.mcpProposals(f.auth.actor, f.project.id);
  };
  return { f, web, propose };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const spec = (overrides: Record<string, unknown> = {}) => ({ kind: "mcp_install", name: "notes", source: "npm", package: "@fixture/notes-mcp", version: "1.4.2",
  command: "notes-mcp", args: ["--stdio"], env: [], ...overrides });
function get(f: EffectFixture, web: ReturnType<typeof createWebHandler>, path: string, token?: string) {
  return web(new Request(`${origin}${path}`, { headers: { cookie: `jit_session=${token ?? f.token}` } }));
}
function postForm(f: EffectFixture, web: ReturnType<typeof createWebHandler>, path: string, fields: Record<string, string>, token?: string) {
  return web(new Request(`${origin}${path}`, { method: "POST", body: new URLSearchParams(fields).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: `jit_session=${token ?? f.token}` } }));
}
const topicPath = (f: EffectFixture) => `/projects/${f.project.id}/topics/${f.topic.id}`;
const proposalPath = (f: EffectFixture, id: string) => `${topicPath(f)}/mcp-proposals/${id}`;
function tools(f: EffectFixture, serverId: string) {
  f.store.transaction(tx => writeServerTools(tx, { projectId: f.project.id, id: serverId, revision: 1 },
    [{ name: "read_note", exposed: "mcp_notes_read_note", description: "read", readOnly: true, inputSchema: { type: "object" }, refused: null },
      { name: "write_note", exposed: "mcp_notes_write_note", description: "write", readOnly: false, inputSchema: { type: "object" }, refused: null }], f.clock.now));
}

test("(1) the topic with a proposal fixture shows the exact version string and command inside <code>", async () => {
  const { f, web, propose } = await fixture();
  const [proposal] = await propose([spec()]);
  expect(proposal!.state).toBe("proposed");
  const html = await (await get(f, web, topicPath(f))).text();
  expect(html).toContain("<code>1.4.2</code>");
  expect(html).toContain("<code>notes-mcp</code>");
  expect(html).toContain(`action="${proposalPath(f, proposal!.id)}"`);
  expect(html).toContain(dictionaries.th["mcp.proposal_title"]);
});

test("(2) hostile proposal text renders escaped (args share the card's <code> path; EXE12 validation keeps markup out of every other verbatim field)", async () => {
  const { f, web, propose } = await fixture();
  // EXE12's pinned-version/name/package/command patterns refuse `<` and `>`, so no stored verbatim field but
  // args can hold markup — it must still render escaped inside `<code>`.
  await propose([spec({ args: ["<img src=x>"] })]);
  const html = await (await get(f, web, topicPath(f))).text();
  expect(html).toContain("&lt;img src=x&gt;");
  expect(html).not.toContain("<img src=x>");
});

test("(3) Accept POST → 303; the server is installing (no installer is wired, so it stays there)", async () => {
  const { f, web, propose } = await fixture();
  const [proposal] = await propose([spec({ env: ["NOTES_TOKEN"] })]);
  const token = connection(f, "mcp_env", "notes-token-value-1");
  const res = await postForm(f, web, proposalPath(f, proposal!.id), {
    csrf: f.auth.csrf, requestId: rid(), expectedRevision: "1", decision: "accept", env_NOTES_TOKEN: token,
  });
  // The env binding selects carry connection ids and labels only — never a value.
  expect(await res.text()).not.toContain("notes-token-value-1");
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(`${topicPath(f)}#proposal-${proposal!.id}`);
  expect(f.app.mcpServers(f.auth.actor, f.project.id)).toMatchObject([{ name: "notes", state: "installing" }]);
  // Telegram may narrow (reject) but never accept: EXE12 refuses with `mcp_install_requires_web`.
  try {
    f.app.execute(f.telegram, { kind: "mcp.install.accept", requestId: rid(), projectId: f.project.id, expectedRevision: 2, payload: { proposalId: proposal!.id, env: {} } });
    throw new Error("expected mcp_install_requires_web");
  } catch (error) { expect(error).toBeInstanceOf(AppError); expect((error as AppError).code).toBe("mcp_install_requires_web"); }
});

test("(4) a project at the read level → mcp.error_level text", async () => {
  const { f, web, propose } = await fixture();
  const [proposal] = await propose([spec()]);
  setLevel(f, "read");
  const res = await postForm(f, web, proposalPath(f, proposal!.id), {
    csrf: f.auth.csrf, requestId: rid(), expectedRevision: "1", decision: "accept",
  });
  expect(res.status).toBe(409);
  expect(await res.text()).toContain(dictionaries.th["mcp.error_level"]);
});

test("(5) /settings/mcp lists the servers and tools, with mcp.tool_read_only on a read-only tool", async () => {
  const { f, web, propose } = await fixture();
  const [proposal] = await propose([spec({ env: ["NOTES_TOKEN"] })]);
  const token = connection(f, "mcp_env", "notes-token-value-1");
  const created = await postForm(f, web, proposalPath(f, proposal!.id), {
    csrf: f.auth.csrf, requestId: rid(), expectedRevision: "1", decision: "accept", env_NOTES_TOKEN: token,
  });
  expect(created.status).toBe(303);
  const server = f.app.mcpServers(f.auth.actor, f.project.id)[0]!;
  tools(f, server.id);
  const html = await (await get(f, web, "/settings/mcp")).text();
  expect(html).toContain("notes");
  expect(html).toContain("read_note");
  expect(html).toContain("write_note");
  expect(html).toContain(dictionaries.th["mcp.tool_read_only"]);
  expect(html).toContain(dictionaries.th["mcp.tool_needs_approval"]);
  expect(html).toContain(`action="/settings/mcp/${server.id}/tools/write_note/auto"`);
  expect(html).toContain(`action="/settings/mcp/${server.id}/remove"`);
});

test("(6) toggling auto on a non-read-only tool creates an EXE07 rule; toggling again disables it", async () => {
  const { f, web, propose } = await fixture();
  const [proposal] = await propose([spec({ env: ["NOTES_TOKEN"] })]);
  const token = connection(f, "mcp_env", "notes-token-value-1");
  await postForm(f, web, proposalPath(f, proposal!.id), {
    csrf: f.auth.csrf, requestId: rid(), expectedRevision: "1", decision: "accept", env_NOTES_TOKEN: token,
  });
  const server = f.app.mcpServers(f.auth.actor, f.project.id)[0]!;
  tools(f, server.id);
  const auto = `/settings/mcp/${server.id}/tools/write_note/auto`;
  const on = await postForm(f, web, auto, { csrf: f.auth.csrf, requestId: rid(), expectedRevision: "0" });
  expect(on.status).toBe(303);
  let rule = f.app.effectSettings(f.auth.actor, f.project.id).rules.find(item => item.effectKind === "mcp_tool")!;
  expect(rule).toMatchObject({ enabled: true, scope: { tools: [{ server: "notes", tool: "write_note" }] } });
  const listed = await (await get(f, web, "/settings/mcp")).text();
  expect(listed).toContain(`name="expectedRevision" value="${rule.revision}"`);
  const off = await postForm(f, web, auto, { csrf: f.auth.csrf, requestId: rid(), expectedRevision: String(rule.revision) });
  expect(off.status).toBe(303);
  rule = f.app.effectSettings(f.auth.actor, f.project.id).rules.find(item => item.effectKind === "mcp_tool")!;
  expect(rule.enabled).toBe(false);
});

test("(7) Remove → the server is gone", async () => {
  const { f, web, propose } = await fixture();
  const [proposal] = await propose([spec({ env: ["NOTES_TOKEN"] })]);
  const token = connection(f, "mcp_env", "notes-token-value-1");
  await postForm(f, web, proposalPath(f, proposal!.id), {
    csrf: f.auth.csrf, requestId: rid(), expectedRevision: "1", decision: "accept", env_NOTES_TOKEN: token,
  });
  const server = f.app.mcpServers(f.auth.actor, f.project.id)[0]!;
  const res = await postForm(f, web, `/settings/mcp/${server.id}/remove`, {
    csrf: f.auth.csrf, requestId: rid(), expectedRevision: String(server.revision),
  });
  expect(res.status).toBe(303);
  expect(f.app.mcpServers(f.auth.actor, f.project.id)).toHaveLength(0);
});

test("(8) CSRF missing → 403", async () => {
  const { f, web, propose } = await fixture();
  const [proposal] = await propose([spec()]);
  const res = await web(new Request(`${origin}${proposalPath(f, proposal!.id)}`, { method: "POST",
    body: new URLSearchParams({ requestId: rid(), expectedRevision: "1", decision: "reject" }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: `jit_session=${f.token}` } }));
  expect(res.status).toBe(403);
});
