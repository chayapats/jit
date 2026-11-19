import { expect, test } from "bun:test";
import type { BrowserContext, Request as BrowserRequest } from "playwright-core";
import { desktopGithubHelp, installDesktopOwnerLinks } from "../src/s16/desktop/owner-links";
import type { DesktopOwnerWindowRequest } from "../src/s16/desktop/owner-window";

const origin = "https://jit.example.test";
async function fixture(openGate?: Promise<void>) {
  let callback!: (source: any, value: unknown) => Promise<{ opened: boolean }>, time = 1000, revision = 7, authorized = true, activation = false;
  let address = origin + "/s16/connections", reads = 0, closes = 0;
  const navigations: string[] = [], opened: DesktopOwnerWindowRequest[] = [], gestures: unknown[] = [];
  const frame = {}, page = { mainFrame: () => frame, isClosed: () => false, url: () => address, async goto(target: string) { navigations.push(target); address = target; }, async reload() {} };
  const context = {
    async exposeBinding(_name: string, fn: typeof callback) { callback = fn; },
    request: { async get(url: string, options: Record<string, unknown>) { expect(url).toBe(origin + "/api/s16/client/connections"); expect(options).toMatchObject({ maxRedirects: 0, maxRetries: 0 }); reads++; return { ok: () => authorized, body: async () => Buffer.from(JSON.stringify({ contract: "s16-client-connections/v1", sources: [{ id: "src_1", revision, state: "authorizing", auth: { kind: "oauth" } }] })), async dispose() {} }; } },
    async newCDPSession() { return { async send(_method: string, options: Record<string, unknown>) { gestures.push(options.userGesture); return { result: { value: activation } }; }, async detach() {} }; },
  };
  const links = await installDesktopOwnerLinks(context as unknown as BrowserContext, { origin, now: () => time, async open(request) { opened.push(request); await openGate; const closed = Promise.withResolvers<void>(); return { closed: closed.promise, async close() { closes++; closed.resolve(); } }; } });
  const capture = (requestId = "command_1", mutate?: (command: any, receipt: any) => void, status = 200) => {
    const url = new URL("https://provider.example.test/authorize"); for (const [key, value] of Object.entries({ state: requestId, redirect_uri: origin + "/s16/connections/oauth/callback", code_challenge_method: "S256", code_challenge: "a".repeat(43), response_type: "code" })) url.searchParams.set(key, value);
    const command = { contract: "s16-connection-command/v1", requestId, kind: "source.oauth_begin", sourceId: "src_1", expectedRevision: 7 };
    const receipt = { contract: "s16-connection-receipt/v1", requestId, kind: "source.oauth_begin", source: { id: "src_1", revision: 7, state: "authorizing", auth: { kind: "oauth" } }, authorize: url.href };
    mutate?.(command, receipt);
    const request = { method: () => "POST", url: () => origin + "/api/s16/client/connections/commands", frame: () => ({ ...frame, page: () => page }), postDataJSON: () => command };
    // Preserve the real main-frame identity while supplying the browser's page lookup.
    Object.assign(frame, { page: () => page }); request.frame = () => frame as any;
    links.capture(request as unknown as BrowserRequest, status, Buffer.from(JSON.stringify(receipt))); return receipt.authorize;
  };
  return { links, opened, navigations, gestures, capture, call: (url: unknown, child = false) => callback({ page, frame: child ? {} : frame }, url), get reads() { return reads; }, get closes() { return closes; }, set time(value: number) { time = value; }, set revision(value: number) { revision = value; }, set authorized(value: boolean) { authorized = value; }, set address(value: string) { address = value; }, set activation(value: boolean) { activation = value; } };
}

test("invented URLs, iframe calls and stale owner/source facts cannot consume a native privilege", async () => {
  const f = await fixture(); try {
    expect(await f.call("https://evil.test/")).toEqual({ opened: false }); expect(f.reads).toBe(0);
    const valid = f.capture(); expect(await f.call(valid, true)).toEqual({ opened: false }); expect(f.reads).toBe(0);
    f.revision = 8; expect(await f.call(valid)).toEqual({ opened: false }); expect(f.opened).toEqual([]);
    const next = f.capture("command_2"); f.authorized = false; expect(await f.call(next)).toEqual({ opened: false }); expect(f.opened).toEqual([]);
    f.address = "https://other.example.test/s16/connections"; expect(await f.call(desktopGithubHelp)).toEqual({ opened: false });
  } finally { await f.links.close(); }
});

test("a matching actual receipt opens once, concurrent/replayed calls refuse, and only the verified return resumes", async () => {
  const f = await fixture(); try {
    const url = f.capture(); const results = await Promise.all([f.call(url), f.call(url)]);
    expect(results.filter(result => result.opened)).toHaveLength(1); expect(f.opened).toHaveLength(1);
    expect(f.opened[0]).toMatchObject({ url, origin, callback: { state: "command_1", sourceId: "src_1" } });
    f.capture(); expect(await f.call(url)).toEqual({ opened: false });
    await f.opened[0]!.returned("/s16/connections#oauth=wrong_source"); expect(f.navigations).toEqual([]);
    await f.opened[0]!.returned("/s16/connections#oauth=src_1"); expect(f.navigations).toEqual([origin + "/s16/connections#oauth=src_1"]);
  } finally { await f.links.close(); }
  expect(f.closes).toBe(1);
});

test.each(["identity", "kind", "source", "state", "revision", "redirect", "pkce", "credentials"] as const)("an unprovable %s receipt creates no capability", async reason => {
  const f = await fixture(); try {
    const url = f.capture("command_1", (_command, receipt) => {
      if (reason === "identity") receipt.requestId = "other";
      if (reason === "kind") receipt.kind = "source.remove";
      if (reason === "source") receipt.source.id = "different";
      if (reason === "state") receipt.source.state = "active";
      if (reason === "revision") receipt.source.revision = 0;
      if (reason === "redirect" || reason === "pkce") { const url = new URL(receipt.authorize); url.searchParams.set(reason === "redirect" ? "redirect_uri" : "code_challenge_method", reason === "redirect" ? "https://other.test/callback" : "plain"); receipt.authorize = url.href; }
      if (reason === "credentials") { const url = new URL(receipt.authorize); url.username = "user"; url.password = "password"; receipt.authorize = url.href; }
    });
    expect(await f.call(url)).toEqual({ opened: false }); expect(f.opened).toEqual([]); expect(f.reads).toBe(0);
  } finally { await f.links.close(); }
});

test("expiry, capacity and genuine public-link activation remain finite and never manufacture approval", async () => {
  const f = await fixture(); try {
    const url = f.capture(); f.time = 602000; expect(await f.call(url)).toEqual({ opened: false });
    expect(await f.call(desktopGithubHelp)).toEqual({ opened: false }); expect(f.gestures).toEqual([false]);
    f.activation = true; expect(await f.call(desktopGithubHelp)).toEqual({ opened: true });
    expect(f.opened[0]!.callback).toBeNull();
    for (let at = 0; at < 3; at++) expect(await f.call(f.capture("command_" + (at + 2)))).toEqual({ opened: true });
    expect(await f.call(f.capture("command_extra"))).toEqual({ opened: false }); expect(f.opened).toHaveLength(4);
  } finally { await f.links.close(); }
});

test("closing a session also settles an in-flight native window without leaving or opening an orphan", async () => {
  const gate = Promise.withResolvers<void>(), f = await fixture(gate.promise);
  const opening = f.call(f.capture());
  // The actual current-owner read is asynchronous, so wait for the host factory barrier.
  for (let at = 0; at < 10 && !f.opened.length; at++) await Promise.resolve();
  expect(f.opened).toHaveLength(1);
  let done = false; const closing = f.links.close().then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false);
  gate.resolve(); expect(await opening).toEqual({ opened: false }); await closing;
  expect(f.closes).toBe(1); expect(await f.call(f.capture("later"))).toEqual({ opened: false });
});
