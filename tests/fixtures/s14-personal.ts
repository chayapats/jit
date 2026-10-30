import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixtures from "./google-personal.json";
import { ConnectionVault } from "../../src/exec/connections";
import { PersonalVault } from "../../src/s14/personal-vault";
import type { GoogleTransport, PersonalTimer } from "../../src/s14/personal-protocol";
import type { PersonalScope } from "../../src/s14/personal-types";
import { domainFixture, retryId, workCommand, type DomainFixture } from "./s14-domain";
import type { S14Options } from "../../src/s14/application";

/** Scripted pinned Google protocol; no fixture can fall through to a live network call. */
export class GoogleFixture {
  calls: { url: string; init: RequestInit }[] = [];
  scopes: PersonalScope[] = ["gmail.readonly"];
  hook?: GoogleTransport;
  response(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status }); }
  transport: GoogleTransport = async (url, init) => {
    this.calls.push({ url, init });
    if (this.hook) return this.hook(url, init);
    return this.normal(url, init);
  };
  normal(url: string, _init: RequestInit): Response {
    const u = new URL(url);
    if (u.pathname === "/token") return this.response({ access_token: "fixture-google-access-value-259", refresh_token: "fixture-google-refresh-value-259", token_type: "Bearer", expires_in: 3600, scope: this.scopes.map(s => `https://www.googleapis.com/auth/${s}`).join(" ") });
    if (u.pathname === "/revoke") return this.response({});
    if (u.pathname.endsWith("/profile")) return this.response(fixtures.profile);
    if (u.pathname.endsWith("/messages")) return this.response(fixtures.mailList);
    if (u.pathname.includes("/attachments/")) return this.response(fixtures.attachment);
    if (/\/messages\/mail[12]$/.test(u.pathname)) return this.response({ ...fixtures.message, id: u.pathname.endsWith("mail1") ? "mail1" : "mail2" });
    if (u.pathname.endsWith("/events")) return this.response(fixtures.events);
    if (u.pathname.includes("/calendars/")) return this.response(fixtures.calendar);
    throw new Error("Unscripted Google endpoint");
  }
}
/** Creates broker-only sealed secrets and deterministic owner/application/clock state. */
export async function personalFixture(options: Partial<S14Options> = {}, timer?: PersonalTimer) {
  const vaultRoot = realpathSync(mkdtempSync(join(tmpdir(), "jit-personal-vault-")));
  const google = new GoogleFixture();
  const vault = new PersonalVault(new ConnectionVault(join(vaultRoot, "secrets"), { forbidden: [] }));
  const f = await domainFixture({ policy: { routes: [{ id: "selected", provider: "codex", model: "fixture" }], tools: ["personal_read", "effect_send", "effect_calendar"], resources: ["mail", "calendar", "other"] }, personal: { vault, transport: google.transport, ...(timer ? { timer } : {}) }, ...options });
  f.app.execute(f.auth.actor, { kind: "personal.client.set", requestId: retryId(), expectedRevision: 0, payload: { clientId: "fixture-installation.apps.googleusercontent.com", clientSecret: "fixture-google-client-secret-259", redirectUri: "https://jit.example.test/s14/personal/oauth/callback" } });
  const dispose = f.dispose.bind(f);
  return Object.assign(f, { google, vault, vaultRoot, dispose() { dispose(); rmSync(vaultRoot, { recursive: true, force: true }); } });
}
/** Personal fixture includes protocol controls and vault probes for credential isolation assertions. */
export type PersonalFixture = Awaited<ReturnType<typeof personalFixture>>;
/** Completes explicit owner consent through a random-state callback and authenticated exchange. */
export async function connect(f: PersonalFixture, service: "gmail" | "calendar" = "gmail", scopes: PersonalScope[] = [service === "gmail" ? "gmail.readonly" : "calendar.readonly"]) {
  const connection = f.app.execute(f.auth.actor, { kind: "personal.connection.create", requestId: retryId(), expectedRevision: 0,
    payload: { label: `${service} fixture`, service, scopes, account: "owner@example.test", calendarId: service === "calendar" ? "cal@example.test" : null } }).connection!;
  const flow = f.app.execute(f.auth.actor, { kind: "personal.oauth.begin", requestId: retryId(), expectedRevision: connection.revision, payload: { connectionId: connection.id } }).flow!;
  const url = new URL(f.app.personal.authorization(f.auth.actor, flow.id).url);
  f.app.personal.callback(url.searchParams.get("state")!, "fixture-authorization-code-259");
  f.google.scopes = scopes;
  return f.app.personal.complete(f.auth.actor, flow.id);
}
/** Binds a resource slot to an account for one explicitly chosen Bot without starting work. */
export function grant(f: PersonalFixture, connectionId: string, scopeId = "mail", botId = "jit") {
  return f.app.execute(f.auth.actor, { kind: "personal.grant.set", requestId: retryId(), expectedRevision: 0, payload: { scopeId, connectionId, botId, active: true } }).grant!;
}
/** Admits a finite exact-account attempt for worker-level protocol tests. */
export function personalAttempt(f: DomainFixture, scopeId = "mail", tools = ["personal_read"]) {
  const scope = { kind: "resource" as const, id: scopeId, revision: 1 };
  const receipt = f.app.execute(f.auth.actor, workCommand(f, { tools, scopes: [scope], limits: { attempts: 4, steps: 4, calls: 64, outputBytes: 65536, wallMs: 60000, concurrency: 2, reads: 20 } }));
  return f.app.authority.admit(receipt.work!.id, retryId(), { botId: "jit", tools, scopes: [scope], input: "Prepare sourced personal brief", calls: 64, outputBytes: 32768 });
}
/** Supplies an explicit bounded read window without deriving any authority from mail/event content. */
export function readInput(f: DomainFixture, scopeId = "mail") {
  return { scope: { kind: "resource" as const, id: scopeId, revision: 1 }, from: f.clock.now - 86400000, to: f.clock.now + 86400000, timezone: "Asia/Bangkok" };
}
