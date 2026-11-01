import { expect, test } from "bun:test";
import { lookupS14Asset } from "../src/s14/web-assets";
import { canonical } from "../src/s14/validation";
import { claim, report, rid, teamFixture } from "./fixtures/s14-team";

/**
 * Opt-in real Firefox layout regression over local scripted application pages, never installed-service acceptance.
 * Set JIT_FIREFOX_LAYOUT_DRIVER and JIT_FIREFOX_LAYOUT_BINARY to local executables. WebDriver creates an empty profile
 * in a separate process; page JavaScript is disabled. No live account, model, provider or external effect is used.
 */
const driverPath = process.env.JIT_FIREFOX_LAYOUT_DRIVER, binary = process.env.JIT_FIREFOX_LAYOUT_BINARY;
test.skipIf(!driverPath || !binary)("Firefox native Tab and Shift+Tab reveal whole controls and rings in S14 scrollers (fixture)", async () => {
  const f = await teamFixture();
  let driver: ReturnType<typeof Bun.spawn> | undefined, session = "", endpoint = "";
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    // Match a routine with a longer Bot list without changing any real installation.
    f.store.transaction(tx => {
      const original = f.app.home(f.auth.actor).bots[0]!;
      for (let i = 0; i < 4; i++) {
        const bot = { ...original, id: `fixture_bot_${i}`, name: `Fixture Bot ${i}` };
        tx.run("INSERT INTO bots VALUES (?,?)", bot.id, canonical(bot));
      }
    });
    f.scripts.lanes.jit = async a => ({ state: "ready", text: "Fixture report", report: report([claim(a, await f.read(a))]) });
    const work = f.start({ bots: [{ id: "jit", revision: 1 }] });
    await f.app.authority.drain();
    const pages = new Map<string, string>();
    for (const language of ["en", "th"] as const) for (const theme of ["dark", "light"] as const) {
      f.app.execute(f.auth.actor, { kind: "owner.preferences.set", requestId: rid(), expectedRevision: f.app.home(f.auth.actor).revision, payload: { language, theme } });
      for (const [name, path] of [["routine", "/routines/new"], ["report", `/work/${work.id}?tab=report`], ["pane", `/chats/${f.conversationId}?work=${work.id}&tab=report`]]) {
        pages.set(`/${language}/${theme}/${name}`, await f.page(path!));
      }
    }
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (request.method !== "GET") return new Response("Fixture is read-only", { status: 405 });
      const path = new URL(request.url).pathname, asset = lookupS14Asset(path);
      if (asset) return new Response(asset.body, { headers: { "content-type": asset.contentType } });
      const page = pages.get(path);
      return new Response(page ?? "Not found", { status: page ? 200 : 404, headers: { "content-type": "text/html", "content-security-policy": "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; script-src 'none'; connect-src 'none'; form-action 'none'" } });
    } });
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }), port = reservation.port!;
    reservation.stop(true);
    endpoint = `http://127.0.0.1:${port}`;
    driver = Bun.spawn([driverPath!, "--host", "127.0.0.1", "--port", String(port)], { stdout: "ignore", stderr: "ignore" });
    async function command<T = unknown>(path: string, body?: unknown): Promise<T> {
      const response = await fetch(`${endpoint}${session ? `/session/${session}` : ""}${path}`, {
        method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(20_000),
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      const result = await response.json() as { value: T };
      if (!response.ok) throw new Error(`WebDriver ${path}: ${JSON.stringify(result.value)}`);
      return result.value;
    }
    for (let i = 0; ; i++) {
      try { await command("/status"); break; } catch (error) { if (i === 99) throw error; await Bun.sleep(50); }
    }
    const created = await command<{ sessionId: string; capabilities: { browserVersion: string; "moz:headless": boolean } }>("/session", { capabilities: { alwaysMatch: { browserName: "firefox", "moz:firefoxOptions": {
      binary, args: ["-no-remote"], prefs: { "javascript.enabled": false, "accessibility.tabfocus": 7, "network.captive-portal-service.enabled": false, "network.connectivity-service.enabled": false },
    } } } });
    session = created.sessionId;
    const evaluate = <T>(script: string, args: unknown[] = []) => command<T>("/execute/sync", { script, args });
    const tab = (reverse: boolean) => command("/actions", { actions: [{ type: "key", id: "keyboard", actions: [
      ...(reverse ? [{ type: "keyDown", value: "\uE008" }] : []), { type: "keyDown", value: "\uE004" }, { type: "keyUp", value: "\uE004" }, ...(reverse ? [{ type: "keyUp", value: "\uE008" }] : []), { type: "pause", duration: 50 },
    ] }] });
    let observations = 0;
    // Pin and verify the actual acceptance viewport; unhonoured window sizes must never count as device evidence.
    for (const [width, height] of [[1280, 1234]]) {
      await command("/window/rect", { width, height });
      const chrome = await evaluate<{ width: number; height: number }>("return {width: outerWidth-innerWidth, height: outerHeight-innerHeight}");
      await command("/window/rect", { width: width! + chrome.width, height: height! + chrome.height });
      expect(await evaluate("return [innerWidth, innerHeight]")).toEqual([width, height]);
      for (const language of ["en", "th"]) for (const theme of ["dark", "light"]) for (const name of ["routine", "report", "pane"]) {
        await command("/url", { url: `http://127.0.0.1:${server.port}/${language}/${theme}/${name}` });
        const selector = name === "routine" ? 'form[action="/s14/forms/routine-preview"] button.s-btn.primary' : 'a[download$=".md"]';
        for (const reverse of [false, true]) for (const edge of ["partial", "ring"]) {
          // Fixture setup leaves the target partly clipped at either edge. Only native Tab may reveal it.
          const before = await evaluate<{ focused: boolean; top: number; bottom: number; clipTop: number; clipBottom: number }>(`
            const target = document.querySelector(arguments[0]);
            if (!target) throw Error('Fixture target missing');
            const scroller = target.closest('.s-scroll, .s-pane-body');
            const column = scroller.classList.contains('s-pane-body') ? scroller : scroller.firstElementChild;
            const spacer = document.createElement('div');
            spacer.style.cssText = 'height:1600px;flex:none';
            column.prepend(spacer);
            const tail = spacer.cloneNode(); column.append(tail);
            // A fixture sentinel avoids browser-internal Tab stops in native date/time/number inputs.
            const adjacent = document.createElement('button'); adjacent.type='button'; adjacent.textContent='Fixture focus start';
            if (arguments[1]) target.after(adjacent); else target.before(adjacent);
            adjacent.focus({preventScroll:true});
            const box = scroller.getBoundingClientRect(), rect = target.getBoundingClientRect();
            const desired = arguments[3] === 'ring'
              ? (arguments[1] ? box.top + 2 : box.bottom - rect.height - 2)
              : arguments[1] ? box.top - rect.height / 2 : box.bottom - (arguments[2] === 'routine' ? 19.5 : 27.7);
            scroller.scrollTop += rect.top - desired;
            const initial = target.getBoundingClientRect(), clip = scroller.getBoundingClientRect();
            return {focused:document.activeElement===target, top:initial.top, bottom:initial.bottom,
              clipTop:clip.top, clipBottom:clip.bottom};
          `, [selector, reverse, name, edge]);
          const initialContext = `${language}/${theme}/${name} ${reverse ? "Shift+Tab" : "Tab"} ${edge} before Tab ${JSON.stringify(before)}`;
          expect(before.focused, initialContext).toBe(false);
          if (edge === "partial") {
            if (reverse) {
              expect(before.top, initialContext).toBeLessThan(before.clipTop);
              expect(before.bottom, initialContext).toBeGreaterThan(before.clipTop);
            } else {
              expect(before.top, initialContext).toBeLessThan(before.clipBottom);
              expect(before.bottom, initialContext).toBeGreaterThan(before.clipBottom);
            }
          } else {
            expect(before.top, initialContext).toBeGreaterThanOrEqual(before.clipTop);
            expect(before.bottom, initialContext).toBeLessThanOrEqual(before.clipBottom);
          }
          await tab(reverse);
          const result = await evaluate<{ focused: boolean; ring: number; top: number; bottom: number; left: number; right: number; clipTop: number; clipBottom: number; clipLeft: number; clipRight: number; outline: string }>(`
            const target=document.querySelector(arguments[0]), scroller=target.closest('.s-scroll, .s-pane-body');
            const rect=target.getBoundingClientRect(), clip=scroller.getBoundingClientRect(), css=getComputedStyle(target);
            const ring=parseFloat(css.outlineWidth)+Math.max(0,parseFloat(css.outlineOffset));
            return {focused:document.activeElement===target, ring, top:rect.top, bottom:rect.bottom, left:rect.left, right:rect.right,
              clipTop:clip.top,clipBottom:clip.bottom,clipLeft:clip.left,clipRight:clip.right,outline:css.outlineStyle};
          `, [selector]);
          const context = `${language}/${theme}/${name} ${width}x${height} ${reverse ? "Shift+Tab" : "Tab"} ${edge} ${JSON.stringify(result)}`;
          expect(result.focused, context).toBe(true);
          expect(result.outline, context).toBe("solid"); expect(result.ring, context).toBeGreaterThan(0);
          if (edge === "ring") {
            // Use the actual focused outline extent to prove that only its ring started clipped.
            if (reverse) expect(before.top - result.ring, initialContext).toBeLessThan(before.clipTop);
            else expect(before.bottom + result.ring, initialContext).toBeGreaterThan(before.clipBottom);
          }
          expect(result.top - result.ring, context).toBeGreaterThanOrEqual(result.clipTop - 0.1);
          expect(result.bottom + result.ring, context).toBeLessThanOrEqual(result.clipBottom + 0.1);
          expect(result.left - result.ring, context).toBeGreaterThanOrEqual(result.clipLeft - 0.1);
          expect(result.right + result.ring, context).toBeLessThanOrEqual(result.clipRight + 0.1);
          observations++;
        }
      }
    }
    console.info(`Firefox ${created.capabilities.browserVersion} fixture (headless=${created.capabilities["moz:headless"]}): ${observations} whole-control/ring observations; TH/EN, dark/light, verified 1280x1234 viewport, Tab/Shift+Tab, page JavaScript disabled.`);
  } finally {
    if (session) await fetch(`${endpoint}/session/${session}`, { method: "DELETE", signal: AbortSignal.timeout(10_000) }).catch(() => {});
    if (driver) { driver.kill(); await driver.exited; }
    server?.stop(true); f.close();
  }
}, 120_000);
