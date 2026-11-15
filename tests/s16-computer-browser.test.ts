import { afterEach, describe, expect, test } from "bun:test";
import { AppError } from "../src/errors";
import type { BoxStream } from "../src/exec/box-runtime";
import { CdpClient } from "../src/exec/cdp-stream";
import { ComputerBrowser, computerBrowserSnapshotBytes } from "../src/s16/computers/browser";
import { ScreenControl } from "../src/s16/computers/screen";
import { VmStore } from "../src/s15/vm/store";
import { vmDesktopCdpStream } from "../src/s15/vm/desktop-stream";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
const endpoint = { host: "127.0.0.1", port: 2222, user: "jit", identityFile: "/protected/key", knownHostsFile: "/protected/known" };
const pause = (ms = 1) => new Promise(resolve => setTimeout(resolve, ms));
function pipe() {
  let output!: ReadableStreamDefaultController<Uint8Array>, exit!: (code: number) => void, closed = false;
  const stdout = new ReadableStream<Uint8Array>({ start(c) { output = c; } });
  const exited = new Promise<number>(resolve => { exit = resolve; });
  const writes: Uint8Array[] = [];
  const stream: BoxStream = { stdout, exited, write(bytes) { if (closed) throw new AppError("cdp_closed"); writes.push(bytes); }, close() { if (closed) return; closed = true; output.close(); exit(-1); } };
  cleanups.push(stream.close);
  return { stream, writes, get closed() { return closed; }, emit: (s: string) => output.enqueue(Buffer.from(s)) };
}
function fixture(settings: { idleMs?: number; callMs?: number } = {}) {
  const store = new VmStore(":memory:"); cleanups.push(() => store.close());
  store.save({ id: "vm1", generation: 1, endpoint, managerId: "manager", state: "ready", networkCheckedAt: 1000, networkIsolated: true, maxSessions: 2, reason: null, machineIdentity: "machine", boot: "boot" });
  const owner = {};
  let browser!: ComputerBrowser, unavailable: string | null = null, hold = "", streams = 0;
  const tabs = [{ targetId: "target1", type: "page", url: "https://public.org/", title: "Public" }];
  const sent: { method: string; params: Record<string, any> }[] = [];
  const sessions = new Map<string, string>();
  let redirect: string | null = null, observedUrl: string | null = null, body = "hello\nneedle here";
  const screen = new ScreenControl({ store, requireOwner: actor => { if (actor !== owner) throw new Error("not owner"); }, scope: () => ({ kind: "shared" }),
    device: () => ({ async unavailable() { return unavailable; }, async capture() { return new Uint8Array(); }, async send() {} }), onTransition: vm => browser.invalidate(vm) });
  const pipes: ReturnType<typeof pipe>[] = [];
  browser = new ComputerBrowser({ agentInput: vm => screen.agentInput(vm), unavailable: async () => unavailable,
    tier: origin => origin === "https://sensitive.org" ? "sensitive" : origin === "https://trusted.org" ? "trusted" : undefined,
    stream: async () => {
      streams++; const p = pipe(); pipes.push(p);
      p.stream.write = bytes => {
        const m = JSON.parse(Buffer.from(bytes).subarray(0,-1).toString()); sent.push(m);
        if (m.method === hold) return;
        let result: Record<string, unknown> = {};
        const tab = () => tabs.find(t => t.targetId === (m.params.targetId ?? sessions.get(m.sessionId)))!;
        switch (m.method) {
          case "Target.getTargets": result = { targetInfos: tabs.map(t => ({ ...t })) }; break;
          case "Target.getTargetInfo": result = { targetInfo: { ...tab() } }; break;
          case "Target.createTarget": { const id = `new${tabs.length}`; tabs.push({ targetId: id, type: "page", url: m.params.url, title: "New" }); result = { targetId: id }; break; }
          case "Target.attachToTarget": sessions.set(`s_${m.params.targetId}`,m.params.targetId); result = { sessionId: `s_${m.params.targetId}` }; break;
          case "Page.navigate": tab().url = redirect ?? m.params.url; result = { loaderId: "loader" }; queueMicrotask(() => { if (!p.closed) p.emit(JSON.stringify({ method: "Page.loadEventFired", sessionId: m.sessionId, params: {} })+"\0"); }); break;
          case "Runtime.evaluate": result = { result: { value: { url: observedUrl ?? tab().url, text: body, truncated: false, elements: [{ tag: "button", name: "Next", type: "button" }] } } }; break;
        }
        p.emit(JSON.stringify({ id: m.id, result })+"\0");
      };
      return p.stream;
    }, ...settings });
  cleanups.push(() => browser.close());
  let n = 0;
  const command = (body: Record<string, unknown>) => screen.command(owner, { contract: "s16-screen-command/v1", requestId: `request_${++n}`, vmId: "vm1", ...body });
  const run = () => browser.open("vm1", () => {}, new AbortController().signal);
  return { browser, run, tabs, sent, pipes, command, screen, owner, get streams() { return streams; }, setHold: (s: string) => { hold = s; }, setUnavailable: (s: string) => { unavailable = s; }, setRedirect: (s: string) => { redirect = s; }, setObserved: (s: string) => { observedUrl = s; }, setBody: (s: string) => { body = s; } };
}

describe("desktop stream handshake", () => {
  test("consumes handshake first, preserves coalesced CDP bytes and uses fixed pinned SSH argv", async () => {
    const p = pipe(); let argv: string[] = [];
    const opening = vmDesktopCdpStream(endpoint, { spawn: args => { argv = args; return p.stream; } });
    p.emit('{"jit":"atta'); p.emit('ched"}\0{"id":1,"result":{"ok":true}}\0');
    const stream = await opening;
    expect(argv).toContain("-T"); expect(argv).toContain("StrictHostKeyChecking=yes"); expect(argv.at(-1)).toBe("'sudo' '-n' '-u' 'jit-desktop' '/usr/local/lib/jit-desktop/cdp-attach'");
    const cdp = new CdpClient(stream); const answer = cdp.send("Browser.getVersion");
    expect(await answer).toEqual({ ok: true }); cdp.close();
  });
  test.each(['{"jit":"busy"}\0', 'garbage\0', '{"jit":"attached","extra":true}\0'])('refuses %s and closes', async (frame) => {
    const p = pipe(), opening = vmDesktopCdpStream(endpoint, { spawn: () => p.stream }); p.emit(frame);
    await expect(opening).rejects.toMatchObject({ code: frame.includes("busy") ? "computer_browser_busy" : "computer_browser_unavailable" }); expect(p.closed).toBe(true);
  });
  test("abort closes an opening attach immediately rather than waiting the 10 second handshake", async () => {
    const p=pipe(),abort=new AbortController();
    const opening=vmDesktopCdpStream(endpoint,{spawn:()=>p.stream,signal:abort.signal});abort.abort();
    await expect(opening).rejects.toMatchObject({code:"cancelled"});expect(p.closed).toBe(true);
  });
  test("CDP event wait settles on channel close rather than holding an agent ticket for 15 seconds",async()=>{
    const p=pipe(),client=new CdpClient(p.stream),wait=client.waitFor(e=>e.method==="Page.loadEventFired");
    client.close();await expect(wait).rejects.toMatchObject({code:"cdp_closed"});
  });
  test("missing handshake, EOF and hanging attach close without any one-shot transport", async () => {
    const p = pipe(); await expect(vmDesktopCdpStream(endpoint, { spawn: () => p.stream, handshakeMs: 5 })).rejects.toMatchObject({ code: "computer_browser_unavailable" }); expect(p.closed).toBe(true);
    const q = pipe(); const opening = vmDesktopCdpStream(endpoint, { spawn: () => q.stream }); q.stream.close(); await expect(opening).rejects.toMatchObject({ code: "computer_browser_unavailable" });
  });
});

describe("computer_browser read operations", () => {
  test("closed union rejects raw CDP, JS, selectors, secrets and input operations", async () => {
    const f = fixture(), r = f.run();
    for (const op of [{ kind: "read", generation: 1, selector: "#x" }, { kind: "evaluate", value: "document.cookie" }, { kind: "click", target: "x", generation: 1 }, { kind: "state", vmId: "other" }]) await expect(r.execute(op)).rejects.toMatchObject({ code: "computer_browser_operation_invalid" });
    expect(f.streams).toBe(0); expect(r.tools()[0]!.name).toBe("computer_browser");
  });
  test("read/find return bounded untrusted observations and fresh opaque IDs on the same shared stream", async () => {
    const f = fixture(), r = f.run();
    const state = await r.execute({ kind: "state" }); expect(state.generation).toBe(1);
    const read = await r.execute({ kind: "read", generation: 1 }); expect(read).toMatchObject({ state: "observed", generation: 2, text: "hello\nneedle here" });
    expect(JSON.stringify(read)).not.toContain("target1");
    const found = await r.execute({ kind: "find", text: "NEEDLE", generation: 2 }); expect(found.text).toBe("needle here"); expect(f.streams).toBe(1);
    await expect(r.execute({ kind: "read", generation: 1 })).rejects.toMatchObject({ code: "computer_browser_stale" });
    f.setBody("泰".repeat(20000)); const bounded = await r.execute({ kind: "read", generation: 3 }); expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(computerBrowserSnapshotBytes); expect(bounded.truncated).toBe(true);
  });
  test.each(["https://accounts.google.com/secret", "https://sensitive.org/account"])("refuses owner-opened %s without reading or disclosing title/path", async url => {
    const f = fixture(), r = f.run(); f.tabs[0]!.url = url; f.tabs[0]!.title = "PRIVATE";
    const state = await r.execute({ kind: "state" }); expect(JSON.stringify(state)).not.toMatch(/PRIVATE|secret|account\"/);
    const code = url.includes("google") ? "website_sensitive_only" : "website_protected";
    await expect(r.execute({ kind: "read", generation: 1 })).rejects.toMatchObject({ code });
    await expect(r.execute({ kind: "find", generation: 1, text: "x" })).rejects.toMatchObject({ code });
    expect(f.sent.some(m => m.method === "Runtime.evaluate" || m.method === "Target.attachToTarget")).toBe(false);
  });
  test("leaves refused tab intact and navigates in exactly one new tab; target refused before opening", async () => {
    const f = fixture(), r = f.run(); f.tabs[0]!.url = "https://sensitive.org/form";
    await expect(r.execute({ kind: "navigate", generation: 1, url: "https://sensitive.org/" })).rejects.toMatchObject({ code: "website_protected" }); expect(f.streams).toBe(0);
    const result = await r.execute({ kind: "navigate", generation: 1, url: "https://trusted.org/" }); expect(result.url).toBe("https://trusted.org/"); expect(f.tabs[0]!.url).toBe("https://sensitive.org/form"); expect(f.sent.filter(m => m.method === "Target.createTarget")).toHaveLength(1);
  });
  test("navigation redirects and observation races onto a refused origin never publish text", async () => {
    const f = fixture(), r = f.run(); f.setRedirect("https://sensitive.org/private");
    await expect(r.execute({ kind: "navigate", generation: 1, url: "https://public.org/new" })).rejects.toMatchObject({ code: "website_protected" });
    expect(f.sent.some(m => m.method === "Runtime.evaluate")).toBe(false);
    f.tabs[0]!.url = "https://public.org/"; f.setObserved("https://sensitive.org/private");
    await expect(r.execute({ kind: "read", generation: 1 })).rejects.toMatchObject({ code: "website_protected" });
  });
  test("one controller stream per VM; idle disconnect, browser restart and run end allow reopening", async () => {
    const f = fixture({ idleMs: 15 }), a = f.run(), b = f.run(); await a.execute({ kind: "state" });
    await expect(b.execute({ kind: "state" })).rejects.toMatchObject({ code: "computer_browser_busy" });
    f.pipes[0]!.stream.close(); await pause(); await a.execute({ kind: "state" }); expect(f.streams).toBe(2);
    await pause(30); expect(f.pipes[1]!.closed).toBe(true); await a.execute({ kind: "state" }); expect(f.streams).toBe(3);
    a.close(); expect(f.pipes[2]!.closed).toBe(true); await b.execute({ kind: "state" }); expect(f.streams).toBe(4);
  });
  test("takeover closes channel, refuses new calls and settles the outstanding ticket before owner input", async () => {
    const f = fixture(), r = f.run(); f.setHold("Runtime.evaluate");
    const pending = r.execute({ kind: "read", generation: 1 }); const checked = pending.then(() => null, error => error);
    while (!f.sent.some(m => m.method === "Runtime.evaluate")) await pause();
    const transition = f.command({ kind: "takeover", generation: 0 });
    expect(await checked).toBeInstanceOf(AppError); await transition;
    expect((await f.screen.view(f.owner, "vm1")).state).toBe("owner"); expect(f.pipes[0]!.closed).toBe(true);
    await expect(r.execute({ kind: "state" })).rejects.toMatchObject({ code: "takeover_active" });
    const view = await f.screen.view(f.owner,"vm1"); await f.command({ kind: "hand_back", generation: view.generation, takeoverId: view.takeoverId });
    await expect(r.execute({ kind: "read", generation: 1 })).rejects.toMatchObject({ code: "computer_browser_stale" });
    expect((await r.execute({ kind: "state" })).state).toBe("ready"); expect(f.streams).toBe(2);
  });
  test("own call deadline closes a hanging CDP call and releases its ticket", async () => {
    const f = fixture({ callMs: 10 }), r = f.run(); f.setHold("Runtime.evaluate");
    await expect(r.execute({ kind: "read", generation: 1 })).rejects.toMatchObject({ code: "computer_browser_timeout" }); expect(f.pipes[0]!.closed).toBe(true);
    await f.command({ kind: "takeover", generation: 0 }); expect((await f.screen.view(f.owner,"vm1")).state).toBe("owner");
  });
  test("the 60s call bound covers a hanging availability check and stream open too",async()=>{
    const f=fixture({callMs:10}),r=f.run();
    const original=f.browser.options.unavailable;
    f.browser.options.unavailable=()=>new Promise(()=>{});
    await expect(r.execute({kind:"state"})).rejects.toMatchObject({code:"computer_browser_timeout"});expect(f.streams).toBe(0);
    f.browser.options.unavailable=original;
    f.browser.options.stream=()=>new Promise(()=>{});
    await expect(r.execute({kind:"state"})).rejects.toMatchObject({code:"computer_browser_timeout"});
    await f.command({kind:"takeover",generation:0});expect((await f.screen.view(f.owner,"vm1")).state).toBe("owner");
  });
  test("run cancellation and VM invalidation close streams and stale old observations",async()=>{
    const f=fixture(),abort=new AbortController(),r=f.browser.open("vm1",()=>{},abort.signal);
    await r.execute({kind:"state"});abort.abort();expect(f.pipes[0]!.closed).toBe(true);
    await expect(r.execute({kind:"state"})).rejects.toMatchObject({code:"cancelled"});
    const next=f.run();await next.execute({kind:"state"});f.browser.invalidate("vm1");expect(f.pipes[1]!.closed).toBe(true);
    await expect(next.execute({kind:"read",generation:1})).rejects.toMatchObject({code:"computer_browser_stale"});
    await next.execute({kind:"state"});expect(f.streams).toBe(3);
  });
  test("missing desktop and stopped VM refuse without opening a stream", async () => {
    const f = fixture(), r = f.run(); f.setUnavailable("vm_desktop_unavailable");
    await expect(r.execute({ kind: "state" })).rejects.toMatchObject({ code: "vm_desktop_unavailable" }); expect(f.streams).toBe(0);
  });
});
