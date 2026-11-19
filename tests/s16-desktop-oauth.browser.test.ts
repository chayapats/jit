import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { firstRunFixture } from "./fixtures/s15-first-run";
import { desktopOAuthFixture } from "./fixtures/s16-desktop-oauth";
import { openDesktopSession } from "../src/s16/desktop/launcher";
import { openDesktopOwnerWindow } from "../src/s16/desktop/owner-window";
import { activeNativeDesktop, installNativeDesktop } from "../src/s16/desktop/installation";
import { en } from "../src/i18n/en";
import { desktopGithubHelp } from "../src/s16/desktop/owner-links";

const browserTest = process.env.JIT_S16_DESKTOP_TESTS === "1" ? test : test.skip;
browserTest.each(["allow", "decline"] as const)("native OAuth %s uses the owning receipt and a session-free provider before actual service finalization", async consent => {
  const source = desktopOAuthFixture(), root = mkdtempSync(join(tmpdir(), "jit-desktop-oauth-"));
  let f: Awaited<ReturnType<typeof firstRunFixture>> | undefined;
  const commands: string[] = [], callbacks: string[] = [], callbackStatuses: number[] = []; let returns = 0, resumed = 0;
  const freshRead = Promise.withResolvers<void>(), releaseRead = Promise.withResolvers<void>(); let holdConnections = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/s16/client/connections/commands") commands.push((await request.clone().json() as { kind: string }).kind);
    if (url.pathname === "/s16/connections/oauth/callback") callbacks.push(request.headers.get("cookie") ?? "");
    const response = f ? await f.service.fetch(request) : new Response(null, { status: 503 });
    if (holdConnections && request.method === "GET" && url.pathname === "/api/s16/client/connections") { freshRead.resolve(); await releaseRead.promise; }
    if (url.pathname === "/s16/connections/oauth/callback") callbackStatuses.push(response.status);
    return response;
  } });
  const origin = `http://127.0.0.1:${server.port}`, browser = process.env.JIT_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  let session: Awaited<ReturnType<typeof openDesktopSession>> | undefined;
  try {
    f = await firstRunFixture((options, config) => { config.origin = origin; return { ...options, origin, connections: { vault: options.githubWeb!.vault, network: source.network } }; });
    const setup = await f.page("/setup", "en"), hash = (name: string) => new RegExp(`name="${name}" value="([a-f0-9]{64})"`).exec(setup.html)?.[1];
    expect((await f.form("/s15/forms/rules/install", { proposalHash: hash("proposalHash")!, ...(hash("listHash") ? { listHash: hash("listHash")! } : {}), return: "setup" })).status).toBeLessThan(400);
    let host = { openDesktopSession, openDesktopOwnerWindow };
    if (process.env.JIT_S16_DESKTOP_ARTIFACT) {
      installNativeDesktop({ artifact: process.env.JIT_S16_DESKTOP_ARTIFACT, root, runtime: { bun: process.execPath, browser, locale: "en", service: origin } });
      host = await import(pathToFileURL(join(activeNativeDesktop(root).directory, "main.js")).href);
    }
    const opened = Promise.withResolvers<Awaited<ReturnType<typeof openDesktopOwnerWindow>>>(), help = Promise.withResolvers<Awaited<ReturnType<typeof openDesktopOwnerWindow>>>(), reconnected = Promise.withResolvers<Awaited<ReturnType<typeof openDesktopOwnerWindow>>>(); let openedCount = 0, oauthWindows = 0;
    session = await host.openDesktopSession({ root, service: origin, browser, locale: "en", headless: true, async ownerWindow(request) {
      openedCount++;
      const window = await host.openDesktopOwnerWindow({ ...request, async returned(target) { returns++; await request.returned(target); resumed++; } }, { browser, headless: true, async beforeNavigate(context) {
        // Only the advertised fixture HTTPS provider is transported in-process. Native Jit/callback guards stay active.
        if (request.callback) await context.route(source.provider + "/authorize?*", route => route.fulfill({ status: 200, contentType: "text/html", body: source.authorize(route.request().url(), route.request().headers().cookie) }));
        else await context.route(desktopGithubHelp, route => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Controlled public help</title><h1>Public help fixture</h1>" }));
      } });
      if (!request.callback) help.resolve(window); else (oauthWindows++ === 0 ? opened : reconnected).resolve(window);
      return window;
    } });
    await session.context.addCookies([{ name: "jit_s14", value: f.ownerCookie.slice("jit_s14=".length), url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = session.context.pages()[0]!; page.setDefaultTimeout(10000);
    await page.goto(origin + "/s16/connections");
    const cdp = await session.context.newCDPSession(page);
    try {
      const inactive = await cdp.send("Runtime.evaluate", { expression: `jitDesktopOwnerLink(${JSON.stringify(desktopGithubHelp)})`, awaitPromise: true, returnByValue: true, userGesture: false });
      expect(inactive.result.value).toEqual({ opened: false }); expect(openedCount).toBe(0);
    } finally { await cdp.detach(); }
    expect(await page.evaluate(async () => (Reflect.get(window, "jitDesktopOwnerLink") as (url: string) => Promise<unknown>)("https://desktop-oauth.example.test/invented"))).toEqual({ opened: false });
    await page.getByRole("link", { name: en["s16.connections.github.create"], exact: true }).click();
    const publicWindow = await help.promise; await publicWindow.page.getByRole("heading", { name: "Public help fixture" }).waitFor();
    expect(await publicWindow.context.cookies()).toEqual([]); await publicWindow.close();
    await page.getByRole("tab", { name: /Tool sources/ }).click();
    const form = page.locator("form.connection-form");
    await form.getByLabel(en["s16.connections.label"], { exact: true }).fill("Desktop fixture source");
    await form.getByLabel(en["s16.connections.endpoint"], { exact: true }).fill(source.endpoint);
    await form.getByLabel(en["s16.connections.auth"], { exact: true }).selectOption("oauth");
    await form.getByRole("button", { name: en["s16.connections.submit"], exact: true }).click();
    const provider = await opened.promise;
    await provider.page.getByRole("link", { name: "Continue as fixture owner" }).waitFor();
    expect(await provider.context.cookies()).toEqual([]);
    expect(await provider.page.evaluate(() => [typeof Reflect.get(window, "jitDesktopOwnerLink"), typeof Reflect.get(window, "jitDesktopConnect"), typeof Reflect.get(window, "require")])).toEqual(["undefined", "undefined", "undefined"]);
    const authorize = provider.page.url();
    expect(await page.evaluate(async url => (Reflect.get(window, "jitDesktopOwnerLink") as (url: string) => Promise<unknown>)(url), authorize)).toEqual({ opened: false });
    expect(new URL(page.url()).origin).toBe(origin); expect(source.state.exchanged).toBe(0); expect(openedCount).toBe(2);
    await provider.page.getByRole("link", { name: consent === "allow" ? "Continue as fixture owner" : "Decline fixture consent" }).click({ noWaitAfter: true });
    await provider.closed;
    try {
      if (consent === "allow") await page.getByRole("heading", { name: "Review the tools of Desktop fixture source", exact: true }).waitFor();
      else await page.getByText(en["s16.connections.state.reconnect_required"], { exact: true }).waitFor();
    }
    catch (error) {
      console.error("desktop OAuth fixture result", { commands, callbackStatuses, returns, resumed, exchanged: source.state.exchanged, path: new URL(page.url()).pathname, hash: new URL(page.url()).hash, alerts: await page.getByRole("alert").allTextContents(), statuses: await page.getByRole("status").allTextContents() });
      throw error;
    }
    const view = await (await f.request("/api/s16/client/connections")).json() as { sources: { id: string; revision: number; state: string; tools: unknown[] }[] };
    expect(view.sources).toHaveLength(1);
    expect(view.sources[0]).toMatchObject(consent === "allow" ? { state: "needs_review", tools: [{ name: "lookup", decision: null }] } : { state: "reconnect_required", code: "source_login_declined", tools: [] });
    expect(source.state.registered).toBe(1); expect(source.state.exchanged).toBe(consent === "allow" ? 1 : 0); expect(source.state.catalogReads).toBe(consent === "allow" ? 1 : 0);
    expect(source.state.providerCookies).toEqual([""]); expect(callbacks).toEqual([""]); expect(commands).toEqual(consent === "allow" ? ["source.add", "source.oauth_complete"] : ["source.add"]);
    expect(f.vmCalls).toEqual([]); expect(new URL(page.url()).origin).toBe(origin);
    if (consent === "allow") {
      const card = page.locator("li.connection-card").filter({ has: page.getByRole("heading", { name: "Desktop fixture source", exact: true }) });
      await card.getByRole("button", { name: en["s16.connections.reconnect"], exact: true }).click();
      const reconnect = card.locator("form.connection-form"); await reconnect.getByLabel(en["s16.connections.auth"], { exact: true }).selectOption("oauth");
      await reconnect.getByRole("button", { name: en["s16.connections.reconnectSave"], exact: true }).click();
      const second = await reconnected.promise; await second.page.getByRole("link", { name: "Continue as fixture owner" }).waitFor();
      expect(await second.context.cookies()).toEqual([]); await second.page.getByRole("link", { name: "Continue as fixture owner" }).click({ noWaitAfter: true }); await second.closed;
      await page.getByRole("heading", { name: "Review the tools of Desktop fixture source", exact: true }).waitFor();
      expect(source.state.exchanged).toBe(2); expect(openedCount).toBe(3);
      expect(commands).toEqual(["source.add", "source.oauth_complete", "source.reconnect", "source.oauth_complete"]);
      // Disconnect unmounts the already loaded private view. A different owner device removes this source before
      // revalidation; hold all new reads to prove neither the old card nor its old OAuth hash can resurrect it.
      await session.context.setOffline(true);
      await page.waitForFunction(() => !document.body.textContent?.includes("Desktop fixture source"));
      const latest = await (await f.request("/api/s16/client/connections")).json() as typeof view;
      expect((await f.request("/api/s16/client/connections/commands", "POST", { contract: "s16-connection-command/v1", requestId: crypto.randomUUID(), kind: "source.remove", sourceId: latest.sources[0]!.id, expectedRevision: latest.sources[0]!.revision })).status).toBe(200);
      holdConnections = true; await session.context.setOffline(false); await freshRead.promise;
      expect(await page.evaluate(() => document.body.textContent?.includes("Desktop fixture source"))).toBe(false);
      holdConnections = false; releaseRead.resolve();
      await page.getByRole("tab", { name: /Tool sources/ }).click(); await page.getByText(en["s16.connections.sources.empty"], { exact: true }).waitFor();
      expect(commands).toEqual(["source.add", "source.oauth_complete", "source.reconnect", "source.oauth_complete"]);
      // The removal above used the authenticated in-process owner seam; no stale native page submitted a command.
      expect(callbacks).toEqual(["", ""]); expect(source.state.catalogReads).toBe(2);
    }
  } finally { releaseRead.resolve(); await session?.close(); await server.stop(true); await source.close(); await f?.close(); rmSync(root, { recursive: true, force: true }); }
// Several signed-browser launches include platform keychain startup/teardown and a second actual OAuth exchange.
}, 90000);
