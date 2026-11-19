import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { composedFixture } from "./s15-composition";
import { connectDesktopWindow, openDesktopSession } from "../../src/s16/desktop/launcher";
import { activeNativeDesktop, installNativeDesktop } from "../../src/s16/desktop/installation";
import { desktopProfile, prepareDesktopStartup, privateDesktopDirectory, writeDesktopRecord } from "../../src/s16/desktop/storage";
import type { Locale } from "../../src/i18n";
import type { S15CompositionOptions } from "../../src/s15/composition";

/** Real loopback owning composition, HTTP and native profile. Only models/effect providers/VMs are scripted. */
export async function desktopSessionFixture(locale: Locale, views = false, configure?: (options: S15CompositionOptions) => S15CompositionOptions) {
  const root = mkdtempSync(join(tmpdir(), "jit-desktop-workflow-")); let f: Awaited<ReturnType<typeof composedFixture>> | undefined;
  let intercept: ((request: Request) => Response | null | Promise<Response | null>) | undefined;
  const messages: string[] = [], decisions: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const controlled = await intercept?.(request); if (controlled) return controlled;
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && /\/(messages|decisions)$/.test(path)) {
      const command = await request.clone().json() as { requestId: string };
      (path.endsWith("/messages") ? messages : decisions).push(command.requestId);
    }
    return f ? f.service.fetch(request) : new Response(null, { status: 503 });
  } });
  const origin = `http://127.0.0.1:${server.port}`, browser = process.env.JIT_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  let session: Awaited<ReturnType<typeof openDesktopSession>> | undefined, installed = false;
  try {
    f = await composedFixture("default", false, undefined, options => {
      options.proposedPolicy!.rules[0]!.adapters.push("s16_files"); options.proposedPolicy!.rules[0]!.operations.push("artifact_create");
      const next: S15CompositionOptions = { ...options, origin, files: {}, notifications: { fetch: async () => { throw new Error("fixture_push_unexpected"); } }, ...(views ? { bots: {}, computers: { idleStopMs: 1800000, sweepMs: 0 } } : {}) };
      return configure ? configure(next) : next;
    });
    let host = { openDesktopSession, connectDesktopWindow };
    if (process.env.JIT_S16_DESKTOP_ARTIFACT) {
      installNativeDesktop({ artifact: process.env.JIT_S16_DESKTOP_ARTIFACT, root, runtime: { bun: process.execPath, browser, locale, service: origin } });
      host = await import(pathToFileURL(join(activeNativeDesktop(root).directory, "main.js")).href);
    }
    const downloads = privateDesktopDirectory(join(root, "downloads")), profile = desktopProfile(root, origin), chrome = prepareDesktopStartup(profile.directory);
    // A controlled owner's browser preference selects only this fixture destination. Product launch still restores
    // Chrome's default native download behavior, rather than Playwright's temporary download interception.
    writeDesktopRecord(join(chrome, "Default", "Preferences"), { download: { default_directory: downloads, prompt_for_download: false } });
    const open = async () => {
      session = await host.openDesktopSession({ root, service: origin, browser, locale, headless: true });
      session.context.setDefaultTimeout(10000); return session;
    };
    await open();
    await session!.context.addCookies([{ name: "jit_s14", value: f.ownerCookie.slice("jit_s14=".length), url: origin, httpOnly: true, sameSite: "Strict", expires: Math.floor(Date.now() / 1000) + 3600 }]);
    const app = await (await host.connectDesktopWindow(session!)).ready; installed = true;
    return { f, root, origin, downloads, messages, decisions, app, get session() { return session!; },
      set intercept(value: typeof intercept) { intercept = value; },
      async reopen() { await session!.close(); await open(); return (await host.connectDesktopWindow(session!)).ready; },
      async close() { if (installed) await session!.cdp.send("PWA.uninstall", { manifestId: origin + "/s16/" }).catch(() => {}); await session?.close(); await server.stop(true); await f!.close(); rmSync(root, { recursive: true, force: true }); },
    };
  } catch (error) { await session?.close(); await server.stop(true); await f?.close(); rmSync(root, { recursive: true, force: true }); throw error; }
}
