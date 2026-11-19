import { connect as dial } from "node:net";
import { pkceChallenge } from "../../src/s16/connections/oauth";

/** Actual protected SourceNetwork transport to a controlled OAuth/MCP service; no external account or DNS is used. */
export function desktopOAuthFixture() {
  const usedCodes = new Set<string>(); let authorizations = 0;
  const state = { challenge: "", exchanged: 0, registered: 0, catalogReads: 0, providerCookies: [] as string[], code: "desktop_fixture_code", token: "desktop_fixture_access_token_0123456789" };
  const provider = "https://desktop-oauth.example.test";
  const rpc = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
  const server: ReturnType<typeof Bun.serve> = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    const url = new URL(request.url), at = (path: string) => `http://desktop-source.example.test:${server.port}${path}`;
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: at("/mcp"), authorization_servers: [at("")], scopes_supported: ["read"] });
    if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: at(""), authorization_endpoint: provider + "/authorize", token_endpoint: at("/token"), registration_endpoint: at("/register"), code_challenge_methods_supported: ["S256"] });
    if (url.pathname === "/register") { state.registered++; return Response.json({ client_id: "desktop-fixture" }, { status: 201 }); }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await request.text());
      if (form.get("code") !== state.code || pkceChallenge(form.get("code_verifier") ?? "") !== state.challenge || usedCodes.has(state.code)) return Response.json({ error: "invalid_grant" }, { status: 400 });
      usedCodes.add(state.code); state.exchanged++; return Response.json({ access_token: state.token, token_type: "Bearer", expires_in: 3600 });
    }
    if (url.pathname === "/mcp") {
      if (request.headers.get("authorization") !== `Bearer ${state.token}`) return new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${at("/.well-known/oauth-protected-resource/mcp")}"` } });
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      const body = await request.json() as { id?: unknown; method?: string };
      if (body.method === "initialize") return rpc(body.id, { protocolVersion: "2025-06-18", serverInfo: { name: "desktop-fixture", version: "1" }, capabilities: { tools: {} } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") { state.catalogReads++; return rpc(body.id, { tools: [{ name: "lookup", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] }); }
    }
    return new Response("Not found", { status: 404 });
  } });
  return {
    state, provider, endpoint: `http://desktop-source.example.test:${server.port}/mcp`,
    network: { allowHttp: true, resolve: async () => [{ address: "93.184.215.14", family: 4 }], connect: () => dial({ host: "127.0.0.1", port: server.port! }) },
    /** Fixture HTML only, served at the advertised HTTPS provider by a trusted native test transport. */
    authorize(requestUrl: string, cookie: string | undefined) {
      state.code = "desktop_fixture_code_" + ++authorizations;
      const url = new URL(requestUrl); state.providerCookies.push(cookie ?? ""); state.challenge = url.searchParams.get("code_challenge")!;
      const callback = new URL(url.searchParams.get("redirect_uri")!); callback.searchParams.set("state", url.searchParams.get("state")!); callback.searchParams.set("code", state.code);
      const escaped = callback.href.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
      callback.searchParams.delete("code"); callback.searchParams.set("error", "access_denied");
      const declined = callback.href.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
      return `<!doctype html><title>Controlled provider</title><h1>Fixture account consent</h1><a href="${escaped}">Continue as fixture owner</a><a href="${declined}">Decline fixture consent</a>`;
    },
    close: () => server.stop(true),
  };
}
