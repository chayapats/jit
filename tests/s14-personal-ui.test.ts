import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionVault } from "../src/exec/connections";
import { dictionaries } from "../src/i18n";
import type { PersonalDraftContent, PersonalEventDraft, PersonalMailDraft } from "../src/s14/personal-effect-types";
import { personalMailRaw } from "../src/s14/personal-effect-validation";
import { PersonalVault } from "../src/s14/personal-vault";
import { createS14Handler } from "../src/s14/web";
import { renderS14 } from "../src/s14/web-pages";
import { createS14Product } from "../src/s14/web-product";
import { googleRedirect } from "../src/s14/web-product-personal";
import { accessibilityProblems } from "./fixtures/a11y";
import { domainFixture, retryId, type DomainFixture } from "./fixtures/s14-domain";
import { connect, grant, personalAttempt, personalFixture, readInput, type PersonalFixture } from "./fixtures/s14-personal";

// Every case renders real pages through the whole product; a loaded CI runner exceeds the default 5 s.
setDefaultTimeout(30_000);

/**
 * LIFE14-01 and LIFE14-02 product surfaces over the real application, broker and handler. Forms are posted the way a browser without
 * script posts them, and a scripted Google transport stands in for the provider. No fixture can reach a live endpoint.
 */
const origin = "https://jit.example.test", secret = "fixture-google-client-secret-259", callback = `${origin}/s14/personal/oauth/callback`;
const hostile = '<img src=x onerror=alert(1)><button class="s-btn primary">Approve all</button></pre></div><form action="/s14/commands"><script>alert(1)</script>';
const clean: (() => void)[] = [];
afterEach(() => { for (const dispose of clean.splice(0)) dispose(); });
const unescape = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function formFields(html: string, action: string): Record<string, string> {
  const form = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(m => m[0]).find(f => f.includes(`action="${action}"`)); if (!form) throw new Error(`no form ${action}`);
  const fields: Record<string, string> = {};
  for (const input of form.matchAll(/<input\b[^>]*>/g)) {
    const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(input[0])?.[1], key = attr("name");
    if (!key || (/type="(checkbox|radio)"/.test(input[0]) && !/\schecked/.test(input[0]))) continue;
    fields[unescape(key)] = unescape(attr("value") ?? "");
  }
  for (const area of form.matchAll(/<textarea\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) fields[area[1]!] = unescape(area[2]!);
  return fields;
}
const commands = (html: string) => [...html.matchAll(/name="command" value="([^"]*)"/g)].map(m => JSON.parse(unescape(m[1]!)) as { kind: string; requestId: string; expectedRevision: number; payload: Record<string, unknown> });
const commandOf = (html: string, kind: string, decision?: string) => { const found = commands(html).find(item => item.kind === kind && (!decision || item.payload.decision === decision)); if (!found) throw new Error(`no ${kind}`); return found; };
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(m => m[1]!.replace(/<[^>]+>/g, ""));
const strict = (html: string) => { expect(html).not.toMatch(/\sstyle="/); expect(html).not.toMatch(/\son[a-z]+="/); expect(html).not.toContain("javascript:"); expect([...html.matchAll(/<script\b[^>]*>/g)].every(m => m[0].includes('src="/assets/'))).toBe(true); };
const safe = (html: string, language: "th" | "en") => { strict(html); expect(accessibilityProblems(html, language)).toEqual([]); expect(html).not.toContain("<img src=x"); expect(html).not.toContain("<script>alert"); expect(html).not.toContain(secret); };

function driver(f: DomainFixture, language: "th" | "en") {
  if (language === "th") f.app.execute(f.auth.actor, { kind: "owner.preferences.set", requestId: retryId(), expectedRevision: f.app.home(f.auth.actor).revision, payload: { language: "th", theme: "system" } });
  const handler = () => createS14Handler(f.app, origin, renderS14, createS14Product(f.app)), cookie = `__Host-jit_s14=${f.token}`, words = dictionaries[language];
  const get = (route: string, session = true) => handler()(new Request(`${origin}${route}`, { headers: session ? { cookie } : {} }));
  const page = async (route: string) => { const response = await get(route); expect(response.status).toBe(200); return response.text(); };
  const post = (route: string, fields: Record<string, string>) => handler()(new Request(`${origin}${route}`, { method: "POST", headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }));
  const land = async (response: Response): Promise<{ status: number; html: string; path: string }> => {
    let current = response, path = "";
    for (let hop = 0; hop < 4 && current.status === 303; hop++) { path = current.headers.get("location")!; current = await get(path.split("#")[0]!); }
    return { status: current.status, html: await current.text(), path };
  };
  const press = async (html: string, kind: string, decision?: string) => land(await post("/s14/commands", { csrf: f.app.authenticate(f.token).csrf, command: JSON.stringify(commandOf(html, kind, decision)) }));
  return { words, get, page, post, land, press };
}
/** Installation with no client yet, for the guide. */
async function fresh(language: "th" | "en" = "en") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jit-personal-ui-")));
  const f = await domainFixture({ policy: { routes: [{ id: "selected", provider: "codex", model: "fixture" }], tools: ["personal_read", "effect_send", "effect_calendar"], resources: ["mail", "calendar"] }, personal: { vault: new PersonalVault(new ConnectionVault(join(root, "secrets"), { forbidden: [] })) } });
  clean.push(() => { f.dispose(); rmSync(root, { recursive: true, force: true }); });
  return { f, ...driver(f, language) };
}
async function broker(language: "th" | "en" = "en", options: Parameters<typeof personalFixture>[0] = {}) {
  const f = await personalFixture(options); clean.push(() => f.dispose());
  return { f, ...driver(f, language) };
}
const mail = (changes: Partial<PersonalMailDraft> = {}): PersonalMailDraft => ({ kind: "mail", to: ["ada@example.test"], cc: ["ben@example.test"], bcc: ["cho@example.test"], subject: "Quarterly numbers", body: "Hello Ada,\n\n  indented line stays\nภาษาไทย", ...changes });
const event = (operation: PersonalEventDraft["operation"] = "create"): PersonalEventDraft => ({ kind: "event", operation, eventId: operation === "create" ? null : "event1", etag: operation === "create" ? null : '"etag1"', timezone: "America/New_York", sendUpdates: "all", event: operation === "delete" ? null : { summary: "Planning", description: "Bring notes", location: "Room 4", start: "2026-11-01T01:30:00-04:00", end: "2026-11-01T02:30:00-05:00", recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"], attendees: ["ada@example.test"] } });
/** One held draft under a connection with exactly the given consent. */
async function held(b: Awaited<ReturnType<typeof broker>>, content: PersonalDraftContent, scopes?: Parameters<typeof connect>[2]) {
  const isMail = content.kind === "mail", service = isMail ? "gmail" as const : "calendar" as const, slot = isMail ? "mail" : "calendar";
  const connection = await connect(b.f, service, scopes ?? (isMail ? ["gmail.readonly", "gmail.send"] : ["calendar.readonly", "calendar.events"]));
  grant(b.f, connection.id, slot);
  const readEvent = !isMail && content.operation !== "create";
  const attempt = personalAttempt(b.f, slot, [isMail ? "effect_send" : "effect_calendar", ...(readEvent ? ["personal_read"] : [])]);
  if (readEvent) await b.f.app.personal.reads.read(attempt.id, readInput(b.f, slot));
  const view = b.f.app.personal.effects.propose(attempt.id, retryId(), readInput(b.f, slot).scope, content, b.f.clock.now + 50000);
  return { connection, attempt, view };
}

test.each(["th", "en"] as const)("the guide is one numbered step per page with copyable public values and a write-only secret (%s)", async language => {
  const { get, page, words } = await fresh(language);
  const home = await page("/settings/google");
  expect(home).toContain(words["s14.google.home.start"]); expect(home).toContain(words["s14.google.honest.why"]);
  safe(home, language);
  expect(await page("/more")).toContain('href="/settings/google"');
  for (let step = 1; step <= 6; step++) {
    const html = await page(`/settings/google/guide?step=${step}`);
    safe(html, language);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain(`${words["s14.google.guide.step"]} ${step} / 6`);
    // One forward action per step, and the last one is the form.
    expect(html.match(/class="s-btn primary"/g)).toHaveLength(1);
  }
  const client = await page("/settings/google/guide?step=5"), consent = await page("/settings/google/guide?step=4"), paste = await page("/settings/google/guide?step=6");
  expect(client).toContain(`>${callback}</code>`); expect(client).toContain('data-copy-target="s14-copy-redirect"'); expect(client).toContain("hidden data-copy");
  for (const scope of ["gmail.readonly", "gmail.send", "calendar.readonly", "calendar.events"]) expect(consent).toContain(`https://www.googleapis.com/auth/${scope}<`);
  expect(consent).toContain(words["s14.google.warning.why"]); expect(consent).toContain(words["s14.google.guide.consent.c_why"]);
  expect(consent).toContain('rel="noopener noreferrer"');
  expect(paste).toContain('type="password" name="clientSecret"'); expect(paste).toContain('autocomplete="new-password"'); expect(paste).toMatch(/name="clientSecret"(?![^>]*value=)/);
  expect(formFields(paste, "/s14/forms/google-client").redirectUri).toBe(callback);
  expect((await get("/settings/google/guide?step=99")).status).toBe(200);
});

test("the address note follows what Google can accept", () => {
  expect(googleRedirect("https://jit.example.com")).toEqual({ uri: "https://jit.example.com/s14/personal/oauth/callback", address: "https" });
  expect(googleRedirect("https://jit.local").address).toBe("private");
  expect(googleRedirect("https://192.168.1.5").address).toBe("private");
  expect(googleRedirect("http://localhost:3001").address).toBe("loopback");
});

test("saving the client lands on honest words, and a refused form keeps the ID and never the secret", async () => {
  const { f, page, post, land, words } = await fresh();
  const html = await page("/settings/google/guide?step=6"), form = formFields(html, "/s14/forms/google-client");
  const refused = await post("/s14/forms/google-client", { ...form, clientId: "not-a-client", clientSecret: "typed-secret-that-must-vanish" }), body = await refused.text();
  expect(refused.status).toBe(400); expect(body).toContain(words["s14.error.personal_invalid_client"]); expect(body).toContain('value="not-a-client"'); expect(body).not.toContain("typed-secret-that-must-vanish");
  const done = await land(await post("/s14/forms/google-client", { ...form, clientId: "installation.apps.googleusercontent.com", clientSecret: secret }));
  expect(done.status).toBe(200); expect(done.path).toContain("/settings/google?receipt=");
  expect(done.html).toContain(words["s14.google.done.client_set"]); expect(done.html).toContain(words["s14.google.client.unverified"]); expect(done.html).toContain(words["s14.google.client.secret_stored"]);
  expect(done.html).not.toContain(secret); expect(done.html).toContain(words["s14.google.add_gmail"]);
  expect(JSON.stringify(f.app.personal.settings(f.auth.actor))).not.toContain(secret);
  expect((await page("/settings/google/guide?step=6"))).toContain(words["s14.google.guide.paste.replace"]);
});

test.each(["th", "en"] as const)("read and write are chosen separately, and a read connection says it cannot write (%s)", async language => {
  const { f, page, post, land, words } = await broker(language);
  const html = await page("/settings/google/new?service=gmail"), form = formFields(html, "/s14/forms/google-connection");
  safe(html, language);
  expect(html).toContain(words["s14.google.new.separate_detail"]);
  expect(form.consent_read).toBe("on"); expect(form.consent_write).toBeUndefined();
  const none = await post("/s14/forms/google-connection", { csrf: form.csrf!, requestId: form.requestId!, expectedRevision: "0", service: "gmail", account: "owner@example.test" }), refused = await none.text();
  expect(none.status).toBe(400); expect(refused).toContain(words["s14.error.personal_invalid_consent"]); expect(refused).toContain('value="owner@example.test"');
  const done = await land(await post("/s14/forms/google-connection", { ...form, account: "owner@example.test" }));
  expect(done.path).toContain("/settings/google/connections/");
  const connection = f.app.personal.settings(f.auth.actor).connections[0]!;
  expect(connection).toMatchObject({ scopes: ["gmail.readonly"], service: "gmail", calendarId: null, state: "configured", accountVerification: "owner_label" });
  safe(done.html, language);
  expect(done.html).toContain(words["s14.google.no_write.gmail"]); expect(done.html).toContain(words["s14.google.warning.title"]);
  // A read connection offers no write command of any kind.
  expect(commands(done.html).map(item => item.kind)).toEqual(["personal.oauth.begin"]);
  const calendar = formFields(await page("/settings/google/new?service=calendar"), "/s14/forms/google-connection");
  expect(calendar.calendarId).toBe("primary");
  await land(await post("/s14/forms/google-connection", { ...calendar, account: "owner@example.test", consent_write: "on" }));
  expect(f.app.personal.settings(f.auth.actor).connections[1]).toMatchObject({ scopes: ["calendar.events", "calendar.readonly"], calendarId: "primary" });
});

test("sign-in walks begin, open, Google, a session-free return page, then one finish press", async () => {
  const { f, get, page, post, press, land, words } = await broker();
  const connection = f.app.execute(f.auth.actor, { kind: "personal.connection.create", requestId: retryId(), expectedRevision: 0, payload: { label: "Inbox", service: "gmail", scopes: ["gmail.readonly"], account: "owner@example.test", calendarId: null } }).connection!;
  const opened = await press(await page(`/settings/google/connections/${connection.id}`), "personal.oauth.begin");
  expect(opened.html).toContain(words["s14.google.open.go"]);
  const link = /href="(https:\/\/accounts\.google\.com\/[^"]+)"/.exec(opened.html)![1]!, url = new URL(unescape(link));
  expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
  expect(url.searchParams.get("redirect_uri")).toBe(callback);
  // Google's redirect arrives with no cookie: SameSite=Strict is not sent on a chain that started cross-site.
  const googleQuery = new URLSearchParams({ state: url.searchParams.get("state")!, code: "fixture-code-value", iss: "https://accounts.google.com",
    scope: "https://www.googleapis.com/auth/gmail.readonly", authuser: "0", prompt: "consent", hd: "example.test", session_state: "provider-session", future_parameter: "ignored" });
  const back = await get(`/s14/personal/oauth/callback?${googleQuery}`, false);
  expect(back.status).toBe(303); expect(back.headers.get("location")).toBe("/s14/personal/oauth/done"); expect(back.headers.get("referrer-policy")).toBe("no-referrer");
  const done = await get("/s14/personal/oauth/done", false), body = await done.text();
  expect(done.status).toBe(200); expect(body).toContain("data-go"); expect(body).toContain('href="/settings/google"'); expect(body).not.toContain("fixture-code-value"); strict(body);
  expect(done.headers.get("referrer-policy")).toBe("no-referrer");
  const home = await page("/settings/google"), attention = await page("/");
  expect(home).toContain(words["s14.google.need.finish"]); expect(attention).toContain(words["s14.google.need.finish"]);
  const detail = await page(`/settings/google/connections/${connection.id}`), form = formFields(detail, "/s14/personal/oauth/complete");
  expect(detail).toContain(words["s14.google.finish.go"]);
  const finished = await land(await post("/s14/personal/oauth/complete", form));
  expect(finished.path).toBe(`/settings/google/connections/${connection.id}#next`);
  expect(finished.html).toContain(words["s14.google.state.connected"]); expect(finished.html).toContain(words["s14.google.account.checked"]);
  expect(finished.html).toContain(words["s14.google.bots_lead"]);
  // Completing is not work authorization: nothing started and no Bot gained the account.
  expect(f.app.authority.list(f.auth.actor)).toHaveLength(0); expect(f.app.personal.settings(f.auth.actor).grants).toHaveLength(0);
});

test.each(["wrong issuer", "empty issuer", "duplicate issuer", "missing state", "duplicate state", "duplicate code", "code and error", "neither code nor error", "duplicate extra"])("Google callback refuses %s without consuming the pending flow", async variant => {
  const { f, get } = await broker();
  const connection = f.app.execute(f.auth.actor, { kind: "personal.connection.create", requestId: retryId(), expectedRevision: 0, payload: { label: "Inbox", service: "gmail", scopes: ["gmail.readonly"], account: "owner@example.test", calendarId: null } }).connection!;
  const flow = f.app.execute(f.auth.actor, { kind: "personal.oauth.begin", requestId: retryId(), expectedRevision: connection.revision, payload: { connectionId: connection.id } }).flow!;
  const state = new URL(f.app.personal.authorization(f.auth.actor, flow.id).url).searchParams.get("state")!;
  const query = new URLSearchParams({ state, code: "fixture-code-value", iss: "https://accounts.google.com" });
  if (variant === "wrong issuer") query.set("iss", "https://other.example.test");
  if (variant === "empty issuer") query.set("iss", "");
  if (variant === "duplicate issuer") query.append("iss", "https://accounts.google.com");
  if (variant === "missing state") query.delete("state");
  if (variant === "duplicate state") query.append("state", state);
  if (variant === "duplicate code") query.append("code", "other-code-value");
  if (variant === "code and error") query.set("error", "access_denied");
  if (variant === "neither code nor error") query.delete("code");
  if (variant === "duplicate extra") { query.append("future_parameter", "one"); query.append("future_parameter", "two"); }
  const refused = await get(`/s14/personal/oauth/callback?${query}`, false);
  expect(refused.status).toBe(303); expect(refused.headers.get("location")).toBe("/s14/personal/oauth/done?refused=1");
  expect(refused.headers.get("referrer-policy")).toBe("no-referrer"); expect(await refused.text()).not.toContain("fixture-code-value");
  expect(f.app.personal.settings(f.auth.actor).flows.find(item => item.id === flow.id)?.state).toBe("pending");
  // A refused shape/issuer must not consume the valid state or require a new owner consent.
  const valid = await get(`/s14/personal/oauth/callback?state=${state}&code=fixture-code-value`, false);
  expect(valid.headers.get("location")).toBe("/s14/personal/oauth/done");
});

test("a refused callback leaves no code in the address, and a failed finish names the likely causes", async () => {
  const { f, get, page, post, land, words } = await broker();
  const refused = await get("/s14/personal/oauth/callback?state=forged&code=stolen-code-value", false);
  expect(refused.status).toBe(303); expect(refused.headers.get("location")).toBe("/s14/personal/oauth/done?refused=1");
  const body = await (await get("/s14/personal/oauth/done?refused=1", false)).text();
  expect(body).toContain(words["s14.google.return.failed"]); expect(body).not.toContain("stolen-code-value"); expect(body).not.toContain("data-go");
  const connection = f.app.execute(f.auth.actor, { kind: "personal.connection.create", requestId: retryId(), expectedRevision: 0, payload: { label: "Inbox", service: "gmail", scopes: ["gmail.readonly"], account: "other@example.test", calendarId: null } }).connection!;
  const flow = f.app.execute(f.auth.actor, { kind: "personal.oauth.begin", requestId: retryId(), expectedRevision: connection.revision, payload: { connectionId: connection.id } }).flow!;
  const state = new URL(f.app.personal.authorization(f.auth.actor, flow.id).url).searchParams.get("state")!;
  await get(`/s14/personal/oauth/callback?state=${state}&code=fixture-code-value`, false);
  // The profile says owner@example.test, so a different login must not connect.
  const failed = await post("/s14/personal/oauth/complete", formFields(await page(`/settings/google/connections/${connection.id}`), "/s14/personal/oauth/complete")), text = await failed.text();
  expect(failed.status).toBe(409); expect(text).toContain(words["s14.error.personal_oauth_failed_reauthorize"]); expect(text).toContain('href="/settings/google"');
  const after = await page(`/settings/google/connections/${connection.id}`);
  expect(after).toContain(words["s14.google.again.cause_1"]); expect(after).toContain(words["s14.google.again.begin"]);
  const home = await page("/"); expect(home).toContain(words["s14.google.need.sign_in"]);
  const expired = await land(await post("/s14/commands", { csrf: f.app.authenticate(f.token).csrf, command: JSON.stringify(commandOf(after, "personal.oauth.begin")) }));
  f.clock.now += 11 * 60000;
  expect(expired.html).toContain(words["s14.google.open.go"]);
  const late = await page(`/settings/google/connections/${connection.id}`);
  expect(late).toContain(words["s14.google.expired.title"]); expect(late).not.toContain("accounts.google.com/o/oauth2");
});

test.each(["th", "en"] as const)("each Bot is allowed one by one, with revocation that says what it cannot recall (%s)", async language => {
  const { f, page, press, words } = await broker(language);
  const connection = await connect(f);
  const html = await page(`/settings/google/connections/${connection.id}`);
  safe(html, language);
  expect(html).toContain(words["s14.google.bot.ready"]); expect(html).toContain(words["s14.google.bot.grant_note"]);
  const command = commandOf(html, "personal.grant.set");
  expect(command).toMatchObject({ expectedRevision: 0, payload: { connectionId: connection.id, botId: "jit", active: true } });
  const allowed = await press(html, "personal.grant.set");
  expect(allowed.html).toContain(words["s14.google.done.grant"]); expect(allowed.html).toContain(words["s14.google.bot.granted"]);
  expect(f.app.authority.list(f.auth.actor)).toHaveLength(0);
  const stop = commandOf(allowed.html, "personal.grant.set");
  expect(stop).toMatchObject({ expectedRevision: 1, payload: { active: false } });
  const stopped = await press(allowed.html, "personal.grant.set");
  expect(stopped.html).toContain(words["s14.google.done.grant_off"]); expect(stopped.html).toContain(words["s14.google.bot.ready"]);
  // The same slot is reused at its current revision, so allowing again is one exact press.
  expect(commandOf(stopped.html, "personal.grant.set")).toMatchObject({ expectedRevision: 2, payload: { scopeId: command.payload.scopeId, active: true } });
  const revoke = await page(`/settings/google/connections/${connection.id}?action=revoke`);
  safe(revoke, language);
  expect(revoke).toContain(words["s14.google.revoke.not_1"]); expect(revoke).toContain(words["s14.google.revoke.sibling"]);
  const revoked = await press(revoke, "personal.connection.revoke");
  expect(revoked.html).toContain(words["s14.google.state.revoked"]); expect(revoked.html).toContain(words["s14.google.revoked.remote_pending"]);
  expect(revoked.html).toContain("myaccount.google.com/connections");
  expect(revoked.html).not.toContain(words["s14.google.revoked.remote_confirmed"]);
  expect(commands(revoked.html)).toHaveLength(0);
  await f.app.personal.drain();
  expect(await page(`/settings/google/connections/${connection.id}`)).toContain(words["s14.google.revoked.remote_confirmed"]);
});

test.each([false, true])("a Bot without a slot reaches its exact ceiling proposal and a separate grant with default resource policy=%s", async defaultResources => {
  const { f, get, page, post, land, press, words } = await broker("en", defaultResources ? {
    policy: { routes: [{ id: "selected", provider: "codex", model: "fixture" }], tools: ["personal_read", "effect_send", "effect_calendar"], resources: [] },
  } : {});
  const slot = defaultResources ? "share_slot_01" : "mail";
  f.app.execute(f.auth.actor, { kind: "bot.capabilities.propose", requestId: retryId(), expectedRevision: f.app.home(f.auth.actor).bots.find(b => b.id === "jit")!.revision, payload: { botId: "jit", capabilities: { tools: ["personal_read"], resources: [] } } });
  const proposal = f.app.botLifecycle.view(f.auth.actor, "jit").proposals[0]!;
  f.app.execute(f.auth.actor, { kind: "bot.capabilities.accept", requestId: retryId(), expectedRevision: proposal.revision, payload: { proposalId: proposal.id, proposalHash: proposal.hash } });
  await f.app.botLifecycle.drain({ async open() { return { async listSessions() { return { sessions: [] }; }, async retireSession() {}, async deleteSession(reference) { return { status: "deleted", session: reference, removed: [], nextAction: "none" }; }, async close() {} }; } });
  const connection = await connect(f), html = await page(`/settings/google/connections/${connection.id}`);
  expect(html).toContain(words["s14.google.bot.needs_ceiling"]); expect(commands(html).filter(item => item.kind === "personal.grant.set")).toHaveLength(0);
  const link = unescape(/href="(\/team\/jit\/capabilities\?[^"]+)"/.exec(html)![1]!);
  expect(link).toContain(`account=${connection.id}`); expect(link).toContain(`slot=${slot}`);
  const form = await page(link), fields = formFields(form, "/s14/forms/capability-propose");
  expect(fields[`resource:${slot}`]).toBe("on"); expect(fields["tool:personal_read"]).toBe("on"); expect(fields.account).toBe(connection.id);
  const proposed = await land(await post("/s14/forms/capability-propose", fields));
  expect(proposed.path).toContain(`account=${connection.id}`);
  const accepted = await land(await post("/s14/forms/capability-accept", formFields(proposed.html, "/s14/forms/capability-accept")));
  expect(accepted.path).toContain(`account=${connection.id}`);
  await f.app.botLifecycle.drain({ async open() { return { async listSessions() { return { sessions: [] }; }, async retireSession() {}, async deleteSession(reference) { return { status: "deleted", session: reference, removed: [], nextAction: "none" }; }, async close() {} }; } });
  const landed = await (await get(accepted.path)).text();
  expect(landed).toContain(words["s14.life.back_to_account"]);
  const after = await page(`/settings/google/connections/${connection.id}`);
  expect(commandOf(after, "personal.grant.set").payload).toMatchObject({ scopeId: slot, active: true });
  expect(f.app.personal.settings(f.auth.actor).grants).toEqual([]);
  await press(after, "personal.grant.set");
  expect(f.app.personal.settings(f.auth.actor).grants).toMatchObject([{ id: slot, connectionId: connection.id, botId: "jit", active: true }]);
});

test("start forms name an account with one unticked box, and ordinary work never gains an account gap", async () => {
  const { f, page, post, land } = await broker();
  const connection = await connect(f); grant(f, connection.id);
  const home = await page("/"), form = formFields(home, "/s14/forms/compose");
  expect(home).toContain('name="account:mail"'); expect(form["account:mail"]).toBeUndefined();
  expect(home).not.toContain('name="tool:personal_read"');
  await land(await post("/s14/forms/compose", { ...form, text: "No account here", work: "on" }));
  const plain = f.app.authority.list(f.auth.actor)[0]!;
  expect(f.app.authority.view(f.auth.actor, plain.id).grant).toMatchObject({ tools: expect.not.arrayContaining(["personal_read"]), scopes: [] });
  await land(await post("/s14/forms/compose", { ...formFields(await page("/"), "/s14/forms/compose"), text: "Triage my inbox", work: "on", "account:mail": "1" }));
  const work = f.app.authority.list(f.auth.actor).find(item => item.title === "Triage my inbox")!, grantView = f.app.authority.view(f.auth.actor, work.id).grant!;
  expect(grantView.tools).toContain("personal_read"); expect(grantView.scopes.map(scope => scope.ref)).toEqual([{ kind: "resource", id: "mail", revision: 1 }]);
  const tabs = await page(`/work/${work.id}`);
  expect(tabs).toContain("tab=brief");
  expect(await page(`/work/${plain.id}`)).not.toContain("tab=brief");
});

test("a send-only account can be named for drafts without adding the read tool, and routines never offer it", async () => {
  const { f, page, post, land, words } = await broker();
  const connection = await connect(f, "gmail", ["gmail.send"]); grant(f, connection.id);
  const home = await page("/"), form = formFields(home, "/s14/forms/compose");
  expect(home).toContain('name="account-write:mail"'); expect(home).toContain(words["s14.google.start_write_only"]);
  await land(await post("/s14/forms/compose", { ...form, text: "Draft a note", work: "on", "account-write:mail": "1", "tool:effect_send": "on" }));
  const work = f.app.authority.list(f.auth.actor)[0]!, granted = f.app.authority.view(f.auth.actor, work.id).grant!;
  expect(granted.tools).toEqual(["effect_send"]); expect(granted.scopes.map(scope => scope.ref.id)).toEqual(["mail"]);
  expect(await page("/routines/new")).not.toContain("account-write:");
});

test("the morning brief opens the ordinary routine review, and enabling captures the exact account", async () => {
  const { f, page, post, land, words } = await broker();
  const connection = await connect(f); grant(f, connection.id);
  expect(await page("/settings/google")).toContain("/routines/new?brief=1");
  const html = await page("/routines/new?brief=1"), form = formFields(html, "/s14/forms/routine-preview");
  expect(form.purpose).toBe(words["s14.google.brief.purpose"]); expect(form.time).toBe("07:00"); expect(form["account:mail"]).toBe("1");
  expect(f.app.routines.list(f.auth.actor)).toHaveLength(0);
  const review = await (await post("/s14/forms/routine-preview", { ...form, timezone: "Asia/Bangkok" })).text();
  expect(review).toContain("resource:mail r1"); expect(review).toContain("personal_read");
  await land(await post("/s14/forms/routine-enable", formFields(review, "/s14/forms/routine-enable")));
  const payload = f.app.routines.list(f.auth.actor)[0]!.routine.capture.command.payload;
  expect(payload.tools).toContain("personal_read"); expect(payload.scopes).toEqual([{ kind: "resource", id: "mail", revision: 1 }]);
});

test.each(["th", "en"] as const)("a brief lists sources with times and zones, and shows missing, stale and unread inputs, never nothing to report (%s)", async language => {
  const { f, page, words } = await broker(language);
  const mailConnection = await connect(f), calendar = await connect(f, "calendar"); grant(f, mailConnection.id, "mail"); grant(f, calendar.id, "calendar");
  const scopes = [{ kind: "resource" as const, id: "mail", revision: 1 }, { kind: "resource" as const, id: "calendar", revision: 1 }];
  const receipt = f.app.execute(f.auth.actor, { kind: "work.start", requestId: retryId(), expectedRevision: f.app.conversation(f.auth.actor, f.conversationId).conversation.revision, payload: { conversationId: f.conversationId, task: null, title: "Morning", purpose: "Brief me", completionRule: "Evidence", bots: [{ id: "jit", revision: f.app.home(f.auth.actor).bots.find(b => b.id === "jit")!.revision }], tools: ["personal_read"], scopes, limits: { attempts: 4, steps: 4, calls: 64, outputBytes: 65536, wallMs: 60000, concurrency: 2, reads: 20 }, expiresAt: f.clock.now + 60000 } });
  const workId = receipt.work!.id, brief = () => page(`/work/${workId}?tab=brief`);
  const empty = await brief();
  safe(empty, language);
  expect(empty).toContain(words["s14.brief.status.missing"]); expect(empty).toContain(words["s14.brief.status.missing_detail"]); expect(empty).toContain(words["s14.brief.unread"]);
  const attempt = f.app.authority.admit(workId, retryId(), { botId: "jit", tools: ["personal_read"], scopes, input: "Read", calls: 64, outputBytes: 32768 });
  await f.app.personal.reads.read(attempt.id, readInput(f, "mail"));
  const partly = await brief();
  safe(partly, language);
  expect(partly).toContain(words["s14.brief.status.partial"]);
  expect(partly).toContain(words["s14.brief.gap.required_input_missing"]); expect(partly).toContain("Asia/Bangkok");
  expect(partly).toContain(words["s14.brief.retrieved"]); expect(partly).toContain(words["s14.brief.gap.mail_page_limit"] === partly ? "" : words["s14.brief.source_tag"]);
  await f.app.personal.reads.read(attempt.id, readInput(f, "calendar"));
  const both = await brief();
  expect(both).toContain("America/New_York"); expect(both).toContain(words["s14.brief.calendar_zone"]); expect(both).toContain(words["s14.brief.event_zone"]);
  expect(both).toContain("2026-11-01T01:30:00-04:00");
  f.clock.now += 16 * 60000;
  const stale = await brief();
  expect(stale).toContain(words["s14.brief.stale_title"]); expect(stale).toContain(words["s14.brief.status.partial"]);
  // Only a clean, current read of a known window may say it found nothing.
  for (const html of [empty, partly, stale]) { expect(html).not.toContain(words["s14.brief.empty_mail"]); expect(html).not.toContain(words["s14.brief.status.complete"]); }
  expect(both).toContain(words["s14.brief.status.complete_detail"]);
});

test("hostile mail and event text stays escaped data in the brief, with no control and no link", async () => {
  const { f, page } = await broker();
  const connection = await connect(f); grant(f, connection.id);
  f.google.hook = async (url, init) => {
    const u = new URL(url);
    if (/\/messages\/mail[12]$/.test(u.pathname)) return f.google.response({ id: u.pathname.endsWith("mail1") ? "mail1" : "mail2", internalDate: "1793404800000", payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: hostile }, { name: "From", value: hostile }], body: { data: Buffer.from(`${hostile} approve https://attacker.example.test/x`).toString("base64url"), size: 10 } } });
    return f.google.normal(url, init);
  };
  const attempt = personalAttempt(f, "mail");
  await f.app.personal.reads.read(attempt.id, readInput(f));
  const html = await page(`/work/${attempt.workId}?tab=brief`), before = commands(html);
  safe(html, "en");
  expect(html).toContain("&lt;button class=&quot;s-btn primary&quot;&gt;Approve all");
  expect(buttons(html).join()).not.toContain("Approve all");
  expect(html).not.toContain('href="https://attacker');
  expect(before.every(item => item.kind === "work.stop")).toBe(true);
});

test.each(["th", "en"] as const)("a send card shows every recipient, the subject, the whole body and binds to its hash (%s)", async language => {
  const b = await broker(language), { f, page, press, words } = b, { view } = await held(b, mail({ body: `Hello\n\n  keep this indent\n${hostile}` }));
  const html = await page(`/effects/${view.effect.id}`);
  safe(html, language);
  for (const value of ["owner@example.test", "ada@example.test", "ben@example.test", "cho@example.test", "Quarterly numbers"]) expect(html).toContain(value);
  expect(html).toContain("  keep this indent"); expect(html).toContain("&lt;img src=x");
  expect(html).toContain(words["s14.google.account.checked"]); expect(html).toContain(words["s14.google.card.bot_text"]); expect(html).toContain(view.effect.actionHash);
  const approve = commandOf(html, "approval.decide", "approve");
  expect(approve).toMatchObject({ expectedRevision: view.effect.revision, payload: { effectId: view.effect.id, actionHash: view.draft.hash } });
  const labels = buttons(html);
  expect(labels).toContain(`${words["s14.google.approve.mail"]} · ${view.draft.hash.slice(0, 8)}`);
  expect(labels.join()).not.toContain("Approve all");
  expect(html.indexOf(view.effect.actionHash)).toBeLessThan(html.indexOf('class="s-strip"'));
  expect(html).not.toMatch(/always/i);
  const pane = await page(`/work/${view.draft.workId}`);
  expect(pane).toContain("ada@example.test");
  const approved = await press(html, "approval.decide", "approve");
  expect(approved.html).toContain(words["s14.effect_state.approved"]);
  expect(commands(approved.html).filter(item => item.kind === "approval.decide")).toHaveLength(0);
  expect(f.google.calls.filter(call => call.init.method === "POST" && call.url.includes("/send"))).toHaveLength(0);
});

test.each(["th", "en"] as const)("an event card shows calendar, time, timezone, attendees and the change in full (%s)", async language => {
  const b = await broker(language), { page, words } = b, { view } = await held(b, event());
  const html = await page(`/effects/${view.effect.id}`);
  safe(html, language);
  for (const value of ["2026-11-01T01:30:00-04:00", "2026-11-01T02:30:00-05:00", "America/New_York", "ada@example.test", "RRULE:FREQ=WEEKLY;COUNT=3", "cal@example.test", (view.draft.content as PersonalEventDraft).eventId!]) expect(html).toContain(value);
  expect(html).toContain(words["s14.google.card.op_create"]); expect(html).toContain(words["s14.google.card.notify_all"]); expect(html).toContain(words["s14.google.card.event_id_new"]);
  expect(html).toContain(words["s14.google.account.typed"]);
  expect(buttons(html)).toContain(`${words["s14.google.approve.create"]} · ${view.draft.hash.slice(0, 8)}`);
});

test("update and delete cards say what they replace and what they cannot show", async () => {
  const b = await broker(), { page, words } = b, updated = await held(b, event("update"));
  const html = await page(`/effects/${updated.view.effect.id}`);
  expect(html).toContain(words["s14.google.card.update_note"]); expect(html).toContain("&quot;etag1&quot;"); expect(html).toContain(words["s14.google.card.op_update"]);
  const removed = b.f.app.personal.effects.propose(updated.attempt.id, retryId(), readInput(b.f, "calendar").scope, event("delete"), b.f.clock.now + 50000);
  const gone = await page(`/effects/${removed.effect.id}`);
  expect(gone).toContain(words["s14.google.card.delete_title"]); expect(gone).toContain(words["s14.google.card.notify_all"]);
  expect(buttons(gone)).toContain(`${words["s14.google.approve.delete"]} · ${removed.draft.hash.slice(0, 8)}`);
});

test("editing makes a new card with a field diff, invalidates the old hash, and a refused edit keeps the typing", async () => {
  const b = await broker(), { f, get, page, post, land, words } = b, { view } = await held(b, mail());
  const before = await page(`/effects/${view.effect.id}`);
  const edit = await page(`/effects/${view.effect.id}?edit=1`), form = formFields(edit, "/s14/forms/draft-revise");
  safe(edit, "en");
  expect(form).toMatchObject({ to: "ada@example.test", cc: "ben@example.test", bcc: "cho@example.test", subject: "Quarterly numbers", draftHash: view.draft.hash });
  expect(edit).not.toContain('name="account"');
  const refused = await post("/s14/forms/draft-revise", { ...form, to: "not an address", subject: "Kept subject" }), refusedBody = await refused.text();
  expect(refused.status).toBe(400); expect(refusedBody).toContain(words["s14.error.personal_invalid_recipients"]); expect(refusedBody).toContain("Kept subject");
  const saved = await land(await post("/s14/forms/draft-revise", { ...form, to: "dee@example.test\nada@example.test", subject: "Revised numbers" }));
  expect(saved.path).toBe(`/effects/${view.effect.id}#slip`);
  expect(saved.html).toContain(words["s14.effect.changed"]); expect(saved.html).toContain("s-diff-old"); expect(saved.html).toContain("Revised numbers");
  const current = f.app.personal.effects.view(f.auth.actor, view.draft.id);
  expect(current.draft.hash).not.toBe(view.draft.hash); expect(saved.html).toContain(current.draft.hash);
  expect(buttons(saved.html)).toContain(`${words["s14.google.approve.mail"]} · ${current.draft.hash.slice(0, 8)}`);
  // The stale tab still holds the old hash, and the service refuses it.
  const stale = await post("/s14/commands", { csrf: f.app.authenticate(f.token).csrf, command: JSON.stringify(commandOf(before, "approval.decide", "approve")) });
  expect(stale.status).toBe(409);
  expect(f.app.personal.effects.view(f.auth.actor, view.draft.id).effect.state).toBe("pending");
  expect((await get(`/effects/${view.effect.id}?edit=1`)).status).toBe(200);
});

test("event edits keep identity fixed, and a timezone that does not match the time is refused with the typing kept", async () => {
  const b = await broker(), { page, post, land, words } = b, { view } = await held(b, event());
  const form = formFields(await page(`/effects/${view.effect.id}?edit=1`), "/s14/forms/draft-revise");
  expect(form).toMatchObject({ timezone: "America/New_York", start: "2026-11-01T01:30:00-04:00", attendees: "ada@example.test", sendUpdates: "all" });
  const refused = await post("/s14/forms/draft-revise", { ...form, timezone: "Asia/Bangkok" }), body = await refused.text();
  expect(refused.status).toBe(400); expect(body).toContain(words["s14.error.personal_timezone_offset_mismatch"]); expect(body).toContain('value="Asia/Bangkok"');
  const saved = await land(await post("/s14/forms/draft-revise", { ...form, sendUpdates: "none", attendees: "" }));
  expect(saved.html).toContain(words["s14.google.card.notify_none"]);
  expect(saved.html).toContain((view.draft.content as PersonalEventDraft).eventId!);
});

test("an expired or revoked card cannot run, and says so", async () => {
  const b = await broker(), { f, page, words } = b, { connection, view } = await held(b, mail());
  f.app.execute(f.auth.actor, { kind: "personal.connection.revoke", requestId: retryId(), expectedRevision: f.app.personal.settings(f.auth.actor).connections[0]!.revision, payload: { connectionId: connection.id } });
  const html = await page(`/effects/${view.effect.id}`);
  expect(html).toContain(words["s14.google.card.account_changed"]);
  expect(commands(html).filter(item => item.payload.decision === "approve")).toHaveLength(0);
  f.clock.now += 60000;
  const late = await page(`/effects/${view.effect.id}`);
  expect(late).toContain(words["s14.effect_state.expired"]); expect(commands(late).filter(item => item.kind === "approval.decide")).toHaveLength(0);
});

test.each(["th", "en"] as const)("unknown delivery is reconcile-only: read-back and an owner statement stay apart, and nothing resends (%s)", async language => {
  const b = await broker(language), { f, page, post, land, words } = b, { view } = await held(b, mail());
  let sends = 0, readable = false;
  f.google.hook = async (url, init) => {
    if (url.includes("/messages/send")) { sends++; return f.google.response({ id: "sent1" }); }
    if (url.includes("/messages/sent1") && readable) return f.google.response({ id: "sent1", raw: personalMailRaw(f.app.personal.effects.view(f.auth.actor, view.draft.id).draft) });
    if (url.includes("/messages/")) throw new Error("timeout");
    return f.google.normal(url, init);
  };
  f.app.execute(f.auth.actor, { kind: "approval.decide", requestId: retryId(), expectedRevision: view.effect.revision, payload: { effectId: view.effect.id, actionHash: view.effect.actionHash, decision: "approve" } });
  await f.app.personal.effects.drain();
  const route = `/effects/${view.effect.id}`, unknown = await page(route), form = formFields(unknown, `/s14/personal/drafts/${view.draft.id}/readback`);
  safe(unknown, language);
  expect(sends).toBe(1);
  expect(unknown).toContain(words["s14.effect_state.unknown"]); expect(unknown).toContain(words["s14.google.readback.go"]); expect(unknown).toContain(words["s14.google.readback.note"]);
  expect(buttons(unknown).join()).not.toMatch(/retry|resend|ลองใหม่|ส่งซ้ำ/i);
  expect(buttons(unknown)).not.toContain(`${words["s14.google.approve.mail"]} · ${view.draft.hash.slice(0, 8)}`);
  readable = true;
  const checked = await land(await post(`/s14/personal/drafts/${view.draft.id}/readback`, form));
  expect(checked.path).toBe(`${route}#slip`); expect(sends).toBe(1);
  expect(checked.html).toContain(words["s14.google.observed.verified"]); expect(checked.html).toContain(words["s14.google.meaning.matching_sent_copy"]);
  // A matching copy is provider evidence: the dispatch state stays unknown and the card never turns green.
  expect(checked.html).toContain(words["s14.effect_state.unknown"]); expect(f.app.personal.effects.view(f.auth.actor, view.draft.id).effect.state).toBe("unknown");
  const stated = await land(await post("/s14/forms/effect-reconcile", { ...formFields(checked.html, "/s14/forms/effect-reconcile"), outcome: "occurred", note: "Ada replied to it" }));
  expect(stated.html).toContain(words["s14.statement.occurred"]); expect(stated.html).toContain(words["s14.google.observed.verified"]); expect(stated.html).not.toContain(`${words["s14.statement.not_checked"]}</span>`);
  expect(sends).toBe(1);
  await f.app.personal.effects.drain();
  expect(sends).toBe(1);
});

test.each(["th", "en"] as const)("an unknown calendar card describes a calendar change before and after an owner statement (%s)", async language => {
  const b = await broker(language), { f, page, words } = b, { view } = await held(b, event());
  f.google.hook = async () => { throw new Error("Interrupted calendar change"); };
  f.app.execute(f.auth.actor, { kind: "approval.decide", requestId: retryId(), expectedRevision: view.effect.revision,
    payload: { effectId: view.effect.id, actionHash: view.effect.actionHash, decision: "approve" } });
  await f.app.personal.effects.drain();
  const route = `/effects/${view.effect.id}`, unknown = await page(route);
  safe(unknown, language);
  expect(unknown).toContain(words["s14.effect.calendar_unknown_detail"]);
  expect(unknown).toContain(words["s14.effect.calendar_unknown_next"]);
  expect(unknown).not.toContain(words["s14.effect.unknown_detail"]);
  expect(unknown).not.toContain(words["s14.effect.unknown_next"]);
  const current = f.app.personal.effects.view(f.auth.actor, view.draft.id).effect;
  f.app.execute(f.auth.actor, { kind: "effect.reconcile", requestId: retryId(), expectedRevision: current.revision,
    payload: { effectId: current.id, actionHash: current.actionHash, outcome: "occurred", note: "Checked the calendar" } });
  const stated = await page(route);
  expect(stated).toContain(words["s14.statement.calendar_banner_detail"]);
  expect(stated).not.toContain(words["s14.statement.banner_detail"]);
});

test("send-only consent shows accepted but unchecked, and read-back is blocked with the reason", async () => {
  const b = await broker(), { f, page, words } = b, { view } = await held(b, mail(), ["gmail.send"]);
  f.google.hook = async (url, init) => url.includes("/messages/send") ? f.google.response({ id: "sent1" }) : f.google.normal(url, init);
  f.app.execute(f.auth.actor, { kind: "approval.decide", requestId: retryId(), expectedRevision: view.effect.revision, payload: { effectId: view.effect.id, actionHash: view.effect.actionHash, decision: "approve" } });
  await f.app.personal.effects.drain();
  const html = await page(`/effects/${view.effect.id}`);
  expect(html).toContain(words["s14.google.observed.accepted_unverified"]); expect(html).toContain("sent1"); expect(html).toContain(words["s14.google.account.typed"]);
  expect(html).toContain(words["s14.google.readback.blocked_scope"]); expect(html).not.toContain("/readback");
});

test("read-back needs the session, Origin and CSRF of any other post", async () => {
  const b = await broker(), { f, post } = b, { view } = await held(b, mail());
  expect((await post(`/s14/personal/drafts/${view.draft.id}/readback`, { csrf: "forged", expectedRevision: "1", actionHash: view.draft.hash })).status).toBe(403);
  const csrf = f.app.authenticate(f.token).csrf;
  expect((await post(`/s14/personal/drafts/${view.draft.id}/readback`, { csrf, expectedRevision: "1", actionHash: view.draft.hash })).status).toBe(409);
  expect((await post(`/s14/personal/drafts/${view.draft.id}/readback`, { csrf, expectedRevision: "1", actionHash: view.draft.hash, extra: "x" })).status).toBe(400);
});

test("a report names a personal gap with the Brief's words, and an unknown code stays visible", async () => {
  const { briefGapRow } = await import("../src/s14/web-personal-brief");
  const { withLocale } = await import("../src/i18n");
  const html = withLocale("en", () => briefGapRow("mail", true, ["mail_page_limit", "mail_page_limit", "<script>"], "/work/x?tab=brief"));
  expect(html).toContain(dictionaries.en["s14.brief.gap.mail_page_limit"]); expect(html).toContain(dictionaries.en["s14.brief.gap.other"]); expect(html).toContain(dictionaries.en["s14.brief.stale"]); expect(html).toContain("/work/x?tab=brief"); expect(html).not.toContain("<script>");
});
