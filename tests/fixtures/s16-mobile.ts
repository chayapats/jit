import { MobileTransport, mobileServiceId, type MobileSecureStore } from "../../src/s16/mobile/transport";
import { MobileSession } from "../../src/s16/mobile/session";
import { composedFixture } from "./s15-composition";
import type { S15CompositionOptions } from "../../src/s15/composition";

/** Actual protected HTTP composition/shared client. Only native keystore, model and VM are controlled fixture ports. */
export async function mobileFixture(configure?: (options: S15CompositionOptions) => S15CompositionOptions) {
  let f: Awaited<ReturnType<typeof composedFixture>> | undefined;
  let intercept: ((request: Request) => Promise<Response | null> | Response | null) | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { return await intercept?.(request) ?? (f ? f.service.fetch(request) : new Response(null, { status: 503 })); } });
  const origin = "http://127.0.0.1:" + server.port, records = new Map<string, string>();
  const store: MobileSecureStore = { async get(key) { return records.get(key) ?? null; }, async set(key, value) { records.set(key, value); }, async delete(key) { records.delete(key); } };
  try {
    f = await composedFixture("default", false, undefined, options => { const next = { ...options, origin }; return configure ? configure(next) : next; });
    const service = await mobileServiceId(origin), key = "jit.mobile.session.v1." + service;
    const seed = (token = f!.ownerCookie.slice("jit_s14=".length)) => records.set(key, JSON.stringify({ contract: "s16-mobile-session/v1", service, token, expiresAt: Date.now() + 3600000 }));
    seed(); const transport = new MobileTransport({ origin, store, fetch: (url, init) => fetch(url, init) }), session = new MobileSession(transport);
    return { f, origin, service, records, transport, session, seed,
      set intercept(value: typeof intercept) { intercept = value; },
      async close() { session.background(); await server.stop(true); await f!.close(); },
    };
  } catch (error) { await server.stop(true); await f?.close(); throw error; }
}
