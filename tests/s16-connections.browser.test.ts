import { afterAll, beforeAll, expect, test } from "bun:test";
import { connect as dial } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import { firstRunFixture } from "./fixtures/s15-first-run";
import { en } from "../src/i18n/en";
import { th } from "../src/i18n/th";

// CONN16-01 + MCP16-01 real React bundle: open a Bot's chat suggestion card, add an MCP source with a write-only secret,
// review its tools with one press and see it in the rules, in English (desktop) and Thai (mobile), keyboard-reachable.
const browserTest = process.env.JIT_S16_BROWSER_TESTS === "1" ? test : test.skip;
let browser: Browser;
beforeAll(async () => { if (process.env.JIT_S16_BROWSER_TESTS === "1") browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true }); });
afterAll(async () => { await browser?.close(); }, 30000);
const secret = "mcp_browser_secret_" + "K3j4H5g6".repeat(3);

function mcpServer() {
  let sessions = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request: Request): Promise<Response> {
    if (request.headers.get("authorization") !== `Bearer ${secret}`) return new Response(null, { status: 401 });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    const body = await request.json() as { id?: number; method: string };
    const rpc = (result: unknown, headers: Record<string, string> = {}) => Response.json({ jsonrpc: "2.0", id: body.id, result }, { headers });
    if (body.method === "initialize") return rpc({ protocolVersion: "2025-06-18", serverInfo: { name: "tracker", version: "1" }, capabilities: { tools: {} } }, { "Mcp-Session-Id": `s${++sessions}` });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") return rpc({ tools: [{ name: "search", title: "Search issues", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }, { name: "create_issue", title: "Create an issue", inputSchema: { type: "object" } }] });
    return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no" } });
  } });
  return { server, network: { allowHttp: true, resolve: async () => [{ address: "93.184.215.14", family: 4 }], connect: () => dial({ host: "127.0.0.1", port: server.port! }) } };
}

async function wire(page: Page, f: Awaited<ReturnType<typeof firstRunFixture>>, external: string[], language: string) {
  await page.context().route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()); if (url.origin !== "http://localhost:3098") { external.push(request.url()); await route.abort(); return; }
    const response = await f.request(url.pathname + url.search, request.method(), request.method() === "POST" ? request.postDataJSON() : undefined, { "accept-language": language });
    if (request.method() === "POST" && /\/messages$/.test(url.pathname)) await f.service.conversation.drain();
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
}

browserTest.each([1440, 390])("actual S16 Connections: chat card, add an MCP source and review its tools at width %i", async width => {
  const mcp = mcpServer();
  const f = await firstRunFixture(o => ({ ...o, connections: { vault: o.githubWeb!.vault, network: mcp.network } }));
  const copy = width === 1440 ? en : th, language = width === 1440 ? "en" : "th";
  const endpoint = `http://mcp.example.com:${mcp.server.port}/mcp`;
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: width === 1440 ? "en-US" : "th-TH", timezoneId: "Asia/Bangkok" });
  const errors: string[] = [], external: string[] = [];
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await wire(page, f, external, language);
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  try {
    // The default rules are installed once (as on first run); the Bot then suggests a connection in chat.
    const setup = await f.page("/setup", "en"), hash = (name: string) => new RegExp(`name="${name}" value="([a-f0-9]{64})"`).exec(setup.html)?.[1];
    await f.form("/s15/forms/rules/install", { proposalHash: hash("proposalHash")!, ...(hash("listHash") ? { listHash: hash("listHash")! } : {}), return: "setup" });
    f.interpretation = { intent: "execute", purposeId: "owner_requested_work", resourceIds: ["computer"], access: "reversible_write", subject: null };
    f.script = [{ type: "tool_call", id: "p1", name: "propose_connection", arguments: { kind: "mcp", endpoint, label: "Tracker" } }];
    await f.chat("Connect our issue tracker");
    await page.goto("http://localhost:3098/s16/chat/first");
    const card = page.getByRole("region", { name: copy["s16.connections.card.title"] });
    await card.waitFor();
    await card.getByText(copy["s16.connections.card.note"]).waitFor();
    expect(await noOverflow()).toBe(true);
    await card.getByRole("button", { name: copy["s16.connections.card.open"], exact: true }).click();
    await page.getByRole("heading", { name: copy["s16.connections.title"], level: 1 }).waitFor();
    await page.getByText(copy["s16.connections.fromChat"], { exact: false }).waitFor();
    // The card prefilled kind, name and address; the secret is typed here only.
    expect(await page.getByLabel(copy["s16.connections.endpoint"], { exact: true }).inputValue()).toBe(endpoint);
    expect(await page.getByLabel(copy["s16.connections.label"], { exact: true }).inputValue()).toBe("Tracker");
    await page.getByLabel(copy["s16.connections.auth"], { exact: true }).selectOption("bearer");
    await page.getByLabel(copy["s16.connections.secret"], { exact: true }).fill(secret);
    await page.getByRole("button", { name: copy["s16.connections.submit"], exact: true }).click();
    // Discovery opens the one-time review with the service's suggestions pre-selected.
    const review = page.getByRole("region", { name: copy["s16.connections.reviewTitle"].replace("{name}", "Tracker") });
    await review.waitFor();
    expect(await page.content()).not.toContain(secret);
    const create = review.getByLabel("Create an issue", { exact: true });
    expect(await create.inputValue()).toBe("approval");
    if (process.env.JIT_S16_SCREENSHOTS) await page.screenshot({ path: `${process.env.JIT_S16_SCREENSHOTS}/connections-review-${width}.png`, fullPage: true });
    await create.focus(); await create.selectOption("change");
    await review.getByRole("button", { name: copy["s16.connections.confirm"], exact: true }).click();
    await page.getByText(copy["s16.connections.reviewed"], { exact: true }).waitFor();
    await page.getByText(copy["s16.connections.policyInstalled"], { exact: true }).waitFor();
    await page.getByText(copy["s16.connections.state.active"], { exact: true }).waitFor();
    expect(await noOverflow()).toBe(true);
    const source = f.service.connections!.records()[0]!;
    expect(source.review?.decisions).toEqual({ search: "read", create_issue: "change" });
    expect(f.service.policy.owner.current(f.owner())!.resources.map(r => r.id)).toContain(source.id);
    // Back to the conversation that asked; the card is done and nothing in it was approved by connecting.
    await page.getByRole("button", { name: copy["s16.connections.back"], exact: true }).click();
    await page.getByLabel(copy["s16.chat.prompt"]).waitFor();
    expect(await page.getByRole("region", { name: copy["s16.connections.card.title"] }).count()).toBe(0);
    expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally { await context.close(); await f.close(); mcp.server.stop(true); }
}, 90000);
