import { expect, test } from "bun:test";
import type { BrowserContext } from "playwright-core";
import { desktopResponseBytes, desktopResponseTimeoutMs, guardDesktopContext } from "../src/s16/desktop/boundary";
import { connectionLimits } from "../src/s16/connections/types";

const origin = "https://jit.example.test";
/** Native route protocol fixture; actual cross-port browser and slow owning-MCP cases are separate opt-in proofs. */
async function fixture() {
  let handle!: (route: any) => Promise<void>, websocket!: (socket: any) => void;
  const context = { async route(_pattern: string, callback: typeof handle) { handle = callback; }, async routeWebSocket(_pattern: string, callback: typeof websocket) { websocket = callback; } };
  await guardDesktopContext(context as unknown as BrowserContext, origin);
  return {
    async request(input: { url?: string; source?: string; navigation?: boolean; status?: number; location?: string; bytes?: number; requiredMs?: number } = {}) {
      const fetched: Record<string, number>[] = [], aborted: string[] = []; let fulfilled = false, read = false, disposed = false;
      const page = {}, frame = { url: () => input.source ?? origin + "/s16/connections", page: () => page };
      const request = { url: () => input.url ?? origin + "/api/s16/client/connections/commands", isNavigationRequest: () => input.navigation ?? false, method: () => "POST", frame: () => frame, serviceWorker: () => null };
      await handle({ request: () => request, async abort(reason: string) { aborted.push(reason); }, async fulfill() { fulfilled = true; }, async fetch(options: Record<string, number>) {
        fetched.push(options); if (options.timeout! < (input.requiredMs ?? 0)) throw new Error("controlled_native_timeout");
        return { status: () => input.status ?? 200, headers: () => ({ ...(input.location ? { location: input.location } : {}), ...(input.bytes ? { "content-length": String(input.bytes) } : {}) }), async body() { read = true; return Buffer.from("{}"); }, async dispose() { disposed = true; } };
      } });
      return { fetched, aborted, fulfilled, read, disposed };
    },
    socket(url: string) { let connected = false, closed = false; websocket({ url: () => url, connectToServer() { connected = true; }, close() { closed = true; } }); return { connected, closed }; },
  };
}

test("the finite native budget covers the owning MCP command rather than one individual request", async () => {
  // Initialization, initialized notification, every allowed tools page, cleanup and OAuth discovery/exchange.
  expect(desktopResponseTimeoutMs).toBeGreaterThanOrEqual((connectionLimits.listPages + 2) * connectionLimits.requestMs + 5000 + 6 * 20000);
  const f = await fixture(), result = await f.request({ requiredMs: 40000 });
  expect(result.fulfilled).toBe(true); expect(result.aborted).toEqual([]); expect(result.disposed).toBe(true);
  expect(result.fetched[0]).toMatchObject({ maxRedirects: 0, maxRetries: 0, timeout: desktopResponseTimeoutMs });
  expect(Number.isFinite(desktopResponseTimeoutMs)).toBe(true);
});

test("foreign/cross-port and opaque initiators never reach the authenticated native transport", async () => {
  const f = await fixture();
  for (const input of [{ url: origin + ":444/api/s16/client/session" }, { url: "https://elsewhere.test/" }, { source: "about:srcdoc" }, { source: "blob:" + origin + "/untrusted" }]) {
    const result = await f.request(input); expect(result.fetched).toEqual([]); expect(result.fulfilled).toBe(false); expect(result.aborted).toEqual(["blockedbyclient"]);
  }
});

test("long responses retain zero redirect/retry, body limits and exact-service WebSockets", async () => {
  const f = await fixture(), redirected = await f.request({ status: 302, location: origin + ":444/collect" });
  expect(redirected.fulfilled).toBe(false); expect(redirected.aborted).toEqual(["blockedbyclient"]); expect(redirected.fetched[0]).toMatchObject({ maxRedirects: 0, maxRetries: 0 });
  const oversized = await f.request({ bytes: desktopResponseBytes + 1 }); expect(oversized.read).toBe(false); expect(oversized.fulfilled).toBe(false); expect(oversized.disposed).toBe(true);
  expect(f.socket("wss://jit.example.test/own")).toEqual({ connected: true, closed: false });
  expect(f.socket("wss://jit.example.test:444/other")).toEqual({ connected: false, closed: true });
});
