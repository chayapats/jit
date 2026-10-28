// Opt-in live evidence for jit.box.cdp-stream/v1 with a real Chromium (EXE14). Skipped unless JIT_LIVE_BROWSER=1.
//
//   JIT_LIVE_BROWSER=1 [JIT_LIVE_CHROMIUM=/path/to/chromium] bun test tests/browser-use.live.test.ts
//
// It runs the shipped relay (`ops/box/cdp-relay --headless`) on the host with a throwaway profile, drives Chromium over
// the NUL-framed pipe only (no debugging port), reads a page as a bounded snapshot and classifies its submit button.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyBrowserAction, describeElementFunction, renderSnapshot } from "../src/exec/browser";
import { CdpClient } from "../src/exec/cdp-stream";
import { defaultConfirmWords } from "../src/config";
import { processStream } from "../src/exec/podman-runtime";

const live = process.env.JIT_LIVE_BROWSER === "1";
const profile = mkdtempSync(join(tmpdir(), "jit-live-browser-"));
afterAll(() => rmSync(profile, { recursive: true, force: true }));

test.skipIf(!live)("a real Chromium behind the relay: navigate, snapshot and classify a submit", async () => {
  const relay = join(import.meta.dir, "../ops/box/cdp-relay");
  const stream = processStream(Bun.spawn(["python3", relay, "--headless", "--profile", profile, "--chromium", process.env.JIT_LIVE_CHROMIUM ?? "chromium"],
    { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: profile }, stdin: "pipe", stdout: "pipe", stderr: "ignore" }));
  const client = new CdpClient(stream, { commandMs: 20_000 });
  try {
    const targets = await client.send("Target.getTargets");
    const page = (targets.targetInfos as { targetId: string; type: string }[]).find(target => target.type === "page")!;
    const { sessionId } = await client.send("Target.attachToTarget", { targetId: page.targetId, flatten: true }) as { sessionId: string };
    await client.send("Page.enable", {}, { sessionId });
    const html = "<title>Live</title><form><label>Email <input name=email></label><button>Send</button></form>";
    const loaded = client.waitFor(event => event.method === "Page.loadEventFired", 20_000);
    await client.send("Page.navigate", { url: `data:text/html,${encodeURIComponent(html)}` }, { sessionId });
    await loaded;
    const tree = await client.send("Accessibility.getFullAXTree", {}, { sessionId });
    const snapshot = renderSnapshot("data:", "Live", tree.nodes as never);
    expect(snapshot).toContain('button "Send"');
    const button = (tree.nodes as { role?: { value?: string }; backendDOMNodeId?: number }[]).find(node => node.role?.value === "button")!;
    const { object } = await client.send("DOM.resolveNode", { backendNodeId: button.backendDOMNodeId }, { sessionId }) as { object: { objectId: string } };
    const described = await client.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: describeElementFunction, returnByValue: true }, { sessionId });
    const info = (described.result as { value: Parameters<typeof classifyBrowserAction>[1] }).value;
    expect(info).toMatchObject({ tag: "button", submits: true, inForm: true, fields: ["email"] });
    expect(classifyBrowserAction("click", info, null, defaultConfirmWords)).toEqual(["submit_control", "confirm_word"]);
  } finally {
    client.close();
  }
}, 60_000);
