import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S14Application } from "../../src/s14/application";
import { S14Store } from "../../src/s14/store";
import { createS14Handler } from "../../src/s14/web";
import { composedFixture } from "./s15-composition";
import type { S15CompositionOptions } from "../../src/s15/composition";

/** Public synthetic password for this disposable fixture only; no real account, provider or installation is used. */
export const mobileFixturePassword = "fixture-only-mobile-owner-password";

/** Actual S14 password/session ingress plus protected S15/S16 composition. Model, VM and remote effects are fixtures. */
export async function mobileAppFixture(tune?: (options: S15CompositionOptions) => S15CompositionOptions) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jit-mobile-owner-"))), store = new S14Store(join(root, "owner.sqlite"));
  const app = new S14Application(store, { policy: { routes: [], tools: [], resources: [] }, chat: { async reply() { return { text: "Unused fixture legacy reply" }; } } });
  let f: Awaited<ReturnType<typeof composedFixture>> | undefined, login: ReturnType<typeof createS14Handler> | undefined;
  let intercept: ((request: Request) => Response | null | Promise<Response | null>) | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const intercepted = await intercept?.(request); if (intercepted) return intercepted;
    if (new URL(request.url).pathname === "/s14/login") return login ? login(request) : new Response(null, { status: 503 });
    return f ? f.service.fetch(request) : new Response(null, { status: 503 });
  } });
  const origin = "http://127.0.0.1:" + server.port, actors = new WeakSet<object>();
  const generation = () => store.read(tx => tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id='owner'")!.generation);
  try {
    await app.provisionOwner(mobileFixturePassword); login = createS14Handler(app, origin);
    f = await composedFixture("default", false, undefined, options => {
      const bootstrap = options.owner;
      options.proposedPolicy!.rules[0]!.adapters.push("s16_files"); options.proposedPolicy!.rules[0]!.operations.push("artifact_create");
      const configured: S15CompositionOptions = { ...options, origin, files: {}, owner: {
        authenticate(token) { const current = app.authenticate(token); actors.add(current.actor); return { proof: current.actor, csrf: current.csrf }; },
        verifyOwner(proof) {
          // Existing fixture setup owns a private in-process proof. It never authenticates an HTTP request.
          if (bootstrap.verifyOwner(proof)) return { id: "owner", generation: generation(), expiresAt: 900000 };
          if (!proof || typeof proof !== "object" || !actors.has(proof)) return null;
          try { store.read(tx => app.requireOwner(tx, proof as Parameters<typeof app.requireOwner>[1])); return { id: "owner", generation: generation(), expiresAt: Date.now() + 3600000 }; } catch { return null; }
        }, generation, verifyCsrf: (expected, supplied) => app.verifyCsrf(expected, supplied)
      } };
      return tune ? tune(configured) : configured;
    });
    return { f, app, store, root, origin, password: mobileFixturePassword,
      set intercept(value: typeof intercept) { intercept = value; },
      async close() { await server.stop(true); await f!.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
    };
  } catch (error) { await server.stop(true); await f?.close(); store.close(); rmSync(root, { recursive: true, force: true }); throw error; }
}
