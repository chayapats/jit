import { parseHTML } from "linkedom";
import { websiteHostSensitive } from "../src/s15/browser/sites";
import { disclosureFixture } from "./fixtures/s15-disclosure";
import { ref } from "./fixtures/s15-policy";
import { afterEach, describe, expect, test } from "bun:test";
import { AppError } from "../src/errors";
import type { BoxStream } from "../src/exec/box-runtime";
import { CdpClient } from "../src/exec/cdp-stream";
import { ComputerBrowser, computerBrowserObservation, computerBrowserSnapshotBytes } from "../src/s16/computers/browser";
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
  browser = new ComputerBrowser({ agentInput: vm => screen.agentInput(vm), generation: vm => screen.generation(vm), unavailable: async () => unavailable,
    tier: hostname => hostname === "sensitive.org" ? "sensitive" : hostname === "trusted.org" ? "trusted" : undefined,
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
  test("a new run uses the hand-back generation, while pre-yield observations and old frames remain stale", async () => {
    const f = fixture(), old = f.run();
    f.browser.options.observedGeneration = (vm, generation) => f.screen.observedBrowserGeneration(vm, generation);
    let observation = await old.execute({ kind: "read", generation: 1 });
    observation = await old.execute({ kind: "read", generation: observation.generation });
    observation = await old.execute({ kind: "read", generation: observation.generation });
    const yielded = f.screen.yieldToOwner("vm1", "fixture_card", Date.now() + 60_000);
    const taken = (await f.command({ kind: "takeover", generation: yielded.generation })).view;
    const back = (await f.command({ kind: "hand_back", generation: taken.generation, takeoverId: taken.takeoverId })).view;
    expect(back.generation).toBeGreaterThan(observation.generation as number);
    const run = f.run();
    const before = f.sent.length;
    await expect(run.execute({ kind: "read", generation: observation.generation })).rejects.toMatchObject({ code: "computer_browser_stale" });
    expect(f.sent.length).toBe(before);
    expect(await run.execute({ kind: "read", generation: back.generation })).toMatchObject({ state: "observed" });
    await expect(old.execute({ kind: "read", generation: observation.generation })).rejects.toMatchObject({ code: "computer_browser_stale" });
  });
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
  test("closed union rejects raw CDP, JS, selectors, secrets and inputs without opaque targets", async () => {
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


test.each(["http://sensitive.org/secret?token=abc", "https://sensitive.org:8443/secret?token=abc", "http://SENSITIVE.ORG./secret?token=abc"])("sensitive host refusal ignores scheme/port: %s", async url => {
  const f=fixture(), r=f.run(); f.tabs[0]!.url=url; f.tabs[0]!.title="SECRET TITLE"; f.setBody("LEAKED TEXT");
  const state=JSON.stringify(await r.execute({kind:"state"}));
  expect(state).toContain("website_protected");
  for(const secret of ["SECRET TITLE","/secret","token=abc","LEAKED TEXT"])expect(state).not.toContain(secret);
  for(const kind of ["read","find"]){await expect(r.execute({kind,generation:1,...(kind==="find"?{text:"secret"}:{})})).rejects.toMatchObject({code:"website_protected"});}
  await expect(r.execute({kind:"navigate",generation:1,url})).rejects.toMatchObject({code:"website_protected"});
  expect(f.sent.some(m=>["Runtime.evaluate","Page.navigate"].includes(m.method))).toBe(false);
});

test("destination tier is checked live immediately after awaited Page.enable",async()=>{
 const f=fixture(),r=f.run();f.setHold("Page.enable");
 const pending=r.execute({kind:"navigate",generation:1,url:"https://public.org/destination"});
 while(!f.sent.some(m=>m.method==="Page.enable"))await pause();
 f.browser.options.tier=host=>host==="public.org"?"sensitive":undefined;
 const m=f.sent.find(m=>m.method==="Page.enable")! as unknown as {id:number};
 f.pipes[0]!.emit(JSON.stringify({id:m.id,result:{}})+"\0");
 await expect(pending).rejects.toMatchObject({code:"website_protected"});
 expect(f.sent.some(m=>m.method==="Page.navigate"||m.method==="Runtime.evaluate")).toBe(false);
});

test("101 targets report truncation without expiring open opaque IDs beyond the projection",async()=>{
 const f=fixture(),r=f.run();
 for(let i=2;i<=101;i++)f.tabs.push({targetId:`target${i}`,type:"page",url:`https://public.org/${i}`,title:""});
 const state=await r.execute({kind:"state"});expect(state.truncated).toBe(true);expect((state.tabs as unknown[]).length).toBe(100);
 const id=(state.tabs as {id:string}[])[0]!.id;const first=f.tabs.shift()!;f.tabs.push(first);
 const reordered=await r.execute({kind:"state"});expect(reordered.truncated).toBe(true);
 expect((await r.execute({kind:"read",generation:1,tab:id})).url).toBe(first.url);
});

test("actual observation program never reads editable self/descendant text into names",async()=>{
 const {document}=parseHTML(`<html><body>
   <a contenteditable>SELF SECRET</a><button contenteditable aria-label="Pay">BUTTON SECRET</button>
   <a><span contenteditable>NESTED SECRET</span>Public link</a>
   <button>Public button<span contenteditable><b>DEEP SECRET</b><img alt="IMAGE SECRET"></span></button>
   <input value="INPUT SECRET"><textarea>TEXTAREA SECRET</textarea>
   <div contenteditable><a>ANCESTOR SECRET</a></div><button><span style="display:none">HIDDEN SECRET</span>Visible</button>
  </body></html>`);
 // Execute the unchanged production program over a real DOM tree; only the browser globals are supplied.
 const evaluate=new Function("document","NodeFilter","getComputedStyle","location",`return ${computerBrowserObservation}`);
  const result=evaluate(document,{SHOW_TEXT:4,SHOW_ELEMENT:1},(e:HTMLElement)=>e.style,{href:"https://public.org/"}) as {text:string;elements:{name:string}[]};
  const json=JSON.stringify(result);expect(json).not.toContain("SECRET");expect(result.elements.map(e=>e.name)).toContain("Pay");
  expect(result.elements.map(e=>e.name)).toContain("Public link");expect(result.elements.map(e=>e.name)).toContain("Public button");expect(result.elements.map(e=>e.name)).toContain("Visible");
});

test("takeover retains its ticket until positive guest drain acknowledgement",async()=>{
 const f=fixture(),r=f.run(),drain=Promise.withResolvers<void>();
 const stream=f.browser.options.stream;f.browser.options.stream=async(...args)=>({...await stream(...args),settled:drain.promise});
 f.setHold("Runtime.evaluate");const result=r.execute({kind:"read",generation:1}).catch(e=>e);
 while(!f.sent.some(m=>m.method==="Runtime.evaluate"))await pause();
 const transition=f.command({kind:"takeover",generation:0});await pause();
 expect((await f.screen.view(f.owner,"vm1")).state).toBe("settling");
 drain.resolve();expect(await result).toBeInstanceOf(AppError);await transition;
 expect((await f.screen.view(f.owner,"vm1")).state).toBe("owner");
});

test("needs_you deadline returns without yielding when an idle stream cannot prove settlement", async () => {
  const f = fixture({ callMs: 10 }), drain = Promise.withResolvers<void>();
  const stream = f.browser.options.stream; f.browser.options.stream = async (...args) => ({ ...await stream(...args), settled: drain.promise });
  f.browser.options.assertAgent = vm => f.screen.assertAgent(vm);
  let posted = 0; f.browser.options.needsYou = () => { posted++; throw Error("unexpected card"); };
  const run = f.browser.open("vm1", () => {}, new AbortController().signal, undefined, { requestId: "request", conversationId: "conversation", ownerGeneration: 1, vmGeneration: 1 });
  await run.execute({ kind: "state" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>(resolve => { timer = setTimeout(() => resolve("unbounded"), 100); });
  try {
    const result = await Promise.race([run.execute({ kind: "needs_you", reason: "sign_in", origin: "https://public.org" }).catch(error => error.code), timeout]);
    expect(result).toBe("computer_browser_timeout"); expect(posted).toBe(0); expect(f.screen.idleBlocked("vm1")).toBe(false);
  } finally { clearTimeout(timer); drain.resolve(); await run.settled(); }
});

test("unproven guest settlement fails closed, never granting owner input",async()=>{
 const f=fixture(),r=f.run(),drain=Promise.withResolvers<void>();void drain.promise.catch(()=>{});
 const stream=f.browser.options.stream;f.browser.options.stream=async(...args)=>({...await stream(...args),settled:drain.promise});
 f.setHold("Runtime.evaluate");const result=r.execute({kind:"read",generation:1}).catch(e=>e);
 while(!f.sent.some(m=>m.method==="Runtime.evaluate"))await pause();
 await f.command({kind:"takeover",generation:0});drain.reject(new AppError("computer_browser_unsettled",503));
 expect((await result).code).toBe("computer_browser_unsettled");
 expect((await f.screen.view(f.owner,"vm1")).state).toBe("settling");
});


test("any sensitive host record wins over a trusted alternate origin in either list order",()=>{
 const sites=[{origin:"https://sensitive.org:8443",tier:"trusted" as const},{origin:"https://sensitive.org",tier:"sensitive" as const}];
 for(const records of [sites,[...sites].reverse()]){
  expect(websiteHostSensitive(records,"SENSITIVE.ORG")).toBe(true);
  expect(websiteHostSensitive(records,"sensitive.org.")).toBe(true);
  expect(websiteHostSensitive(records,"www.sensitive.org")).toBe(false);
 }
});

test("each browser call stamps post-session private sources and imports persistent VM ancestry before publication",async()=>{
 const f=fixture(),x=disclosureFixture();cleanups.push(x.cleanup);
 let inputs=0,outputs=0;
 const hooks=(actor:object)=>({input(){inputs++;x.disclosure.vmInput(actor,"vm1");},output(){outputs++;x.disclosure.vmOutput(actor,"vm1");}});
 const r=f.browser.open("vm1",()=>{},new AbortController().signal,hooks(x.actor));
 await r.execute({kind:"state"}); // Session/run exists before the private read.
 x.disclosure.read(x.actor,ref("private"));f.setBody("private derived bytes in persistent tab");
 await r.execute({kind:"navigate",generation:1,url:"https://public.org/persisted"});
 await r.execute({kind:"find",generation:2,text:"private"});expect(inputs).toBe(3);expect(outputs).toBe(3);
 r.close();
 const sibling=x.f.admit({access:"effect"}).actor!;
 const later=f.browser.open("vm1",()=>{},new AbortController().signal,hooks(sibling));
 const read=await later.execute({kind:"read",generation:1});expect(read.text).toContain("private derived bytes");
 expect(inputs).toBe(4);expect(outputs).toBe(4);
 const work=x.f.service.work.guard(sibling);
 expect(()=>x.f.service.work.reserveModelCall(sibling,{requestId:"sibling_browser_model",selection:work.request.selection,upperBound:{attempts:1,steps:1,calls:1,reads:0,outputBytes:1,activeMs:1,spendMinor:"0"}})).toThrow("recipient_unapproved");
 x.sources.get("private")!.active=false;
 await expect(later.execute({kind:"read",generation:2})).rejects.toThrow("outside_scope");
});

test("disclosure denial before input dispatch sends no CDP; output denial publishes no observation",async()=>{
 const f=fixture();let denyInput=true;
 const r=f.browser.open("vm1",()=>{},new AbortController().signal,{input(){if(denyInput)throw new AppError("outside_scope");},output(){throw new AppError("recipient_unapproved");}});
 await expect(r.execute({kind:"state"})).rejects.toMatchObject({code:"outside_scope"});expect(f.sent).toHaveLength(0);
 denyInput=false;await expect(r.execute({kind:"read",generation:1})).rejects.toMatchObject({code:"recipient_unapproved"});
});


test("disclosure output is checked after awaited CDP cleanup, immediately before publication",async()=>{
 const f=fixture();let allowed=true;
 const r=f.browser.open("vm1",()=>{},new AbortController().signal,{input(){},output(){if(!allowed)throw new AppError("outside_scope");}});
 f.setHold("Target.detachFromTarget");const pending=r.execute({kind:"read",generation:1});
 while(!f.sent.some(m=>m.method==="Target.detachFromTarget"))await pause();
 allowed=false;const m=f.sent.find(m=>m.method==="Target.detachFromTarget")! as unknown as {id:number};
 f.pipes[0]!.emit(JSON.stringify({id:m.id,result:{}})+"\0");
 await expect(pending).rejects.toMatchObject({code:"outside_scope"});
});


test("closed desktop CDP stops publication but keeps draining SSH stdout until positive settlement",async()=>{
 const closed=Promise.withResolvers<void>(),exit=Promise.withResolvers<number>();let drained=0;
 const stdout=(async function*(){yield Buffer.from('{"jit":"attached"}\0');await closed.promise;for(let i=0;i<128;i++){drained++;yield Buffer.alloc(65536,32);}exit.resolve(0);})();
 const stream:BoxStream={stdout,exited:exit.promise,settled:exit.promise.then(()=>{}),write(){},close(){closed.resolve();}};
 const desktop=await vmDesktopCdpStream(endpoint,{spawn:()=>stream}),client=new CdpClient(desktop);
 client.close();await client.settled();expect(drained).toBe(128);
});
