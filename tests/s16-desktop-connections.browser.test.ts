import { expect, test } from "bun:test";
import { connect as dial } from "node:net";
import { dirname, join } from "node:path";
import { ConnectionVault } from "../src/exec/connections";
import { desktopSessionFixture } from "./fixtures/s16-desktop-session";
import { en } from "../src/i18n/en";

const browserTest = process.env.JIT_S16_DESKTOP_TESTS === "1" ? test : test.skip;
browserTest("actual native MCP discovery exceeds thirty seconds and still returns the one owning receipt", async () => {
  const methods: string[] = [], cookies: boolean[] = [];
  const mcp = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, async fetch(request): Promise<Response> {
    cookies.push(request.headers.has("cookie"));
    if (request.method === "DELETE") { methods.push("DELETE"); return new Response(null, { status: 204 }); }
    const body = await request.json() as { id?: unknown; method: string }; methods.push(body.method);
    const rpc = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result }, { headers: { "Mcp-Session-Id": "slow_fixture_session" } });
    if (body.method === "initialize") { await Bun.sleep(20000); return rpc({ protocolVersion: "2025-06-18", serverInfo: { name: "slow-fixture", version: "1" }, capabilities: { tools: {} } }); }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") { await Bun.sleep(20000); return rpc({ tools: [{ name: "lookup", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] }); }
    return new Response(null, { status: 400 });
  } });
  const native = await desktopSessionFixture("en", false, options => ({ ...options, connections: { vault: new ConnectionVault(join(dirname(options.directory), "desktop-connections-vault"), { forbidden: [options.directory] }), network: { allowHttp: true, resolve: async () => [{ address: "93.184.215.14", family: 4 }], connect: () => dial({ host: "127.0.0.1", port: mcp.port! }) } } }));
  const { app: page, f } = native, finished = Promise.withResolvers<void>(); let commands = 0;
  native.intercept = async request => {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/api/s16/client/connections/commands") return null;
    commands++; try { return await f.service.fetch(request); } finally { finished.resolve(); }
  };
  try {
    await page.goto(native.origin + "/s16/connections"); await page.getByRole("tab", { name: /Tool sources/ }).click();
    const form = page.locator("form.connection-form");
    await form.getByLabel(en["s16.connections.label"], { exact: true }).fill("Slow desktop source");
    await form.getByLabel(en["s16.connections.endpoint"], { exact: true }).fill(`http://slow-source.example.test:${mcp.port}/mcp`);
    await form.getByLabel(en["s16.connections.auth"], { exact: true }).selectOption("none");
    const began = performance.now(); await form.getByRole("button", { name: en["s16.connections.submit"], exact: true }).click();
    await page.getByRole("heading", { name: "Review the tools of Slow desktop source", exact: true }).waitFor({ timeout: 65000 });
    expect(performance.now() - began).toBeGreaterThan(30000); expect(commands).toBe(1);
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list", "DELETE"]); expect(cookies.every(value => !value)).toBe(true);
    const response = await native.session.context.request.get(native.origin + "/api/s16/client/connections");
    try { expect((await response.json()).sources).toMatchObject([{ label: "Slow desktop source", state: "needs_review", tools: [{ name: "lookup", decision: null }] }]); } finally { await response.dispose(); }
    expect(f.vmCalls).toEqual([]);
  } finally { if (commands) await finished.promise; await native.close(); await mcp.stop(true); }
}, 90000);
