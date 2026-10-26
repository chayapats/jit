import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { dictionaries, locales, negotiateLocale, withLocale, tr, trMaybe } from "../src/i18n";
import { th } from "../src/i18n/th";
import { TransactionStore, schemaVersion } from "../src/store";
import { backupImageTables } from "../src/ops/backup";
import { colorTokens, contrastPairs, contrastRatio } from "../src/web-design";
import { assetUrl, lookupAsset, staticAssets } from "../src/web-assets";
import { faviconSvg, logoLockup, logoMark } from "../src/web-logo";
import { contentSecurityPolicy, createWebHandler } from "../src/web";

const password = "fixture-owner-password";
const origin = "http://localhost:3000";
const directories: string[] = [];
const stores: TransactionStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jit-ux01-")); directories.push(dir);
  const path = join(dir, "app.sqlite");
  const store = new TransactionStore(path); stores.push(store);
  const app = new Application(store, readConfig({ JIT_DATABASE: path }), { now: () => Date.UTC(2027, 0, 15, 8) });
  await app.setupOwner(password);
  const token = await app.login(password);
  return { app, store, token, auth: app.authenticate(token), web: createWebHandler(app) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function get(f: Fixture, path: string, headers: Record<string, string> = {}, signedIn = true) {
  return f.web(new Request(`${origin}${path}`, { headers: { ...(signedIn ? { cookie: `jit_session=${f.token}` } : {}), ...headers } }));
}
function postForm(f: Fixture, path: string, fields: Record<string, string>, headers: Record<string, string> = {}, token: string | null = f.token) {
  return f.web(new Request(`${origin}${path}`, { method: "POST", body: new URLSearchParams(fields).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", origin, ...(token ? { cookie: `jit_session=${token}` } : {}), ...headers } }));
}
const hostile = "<script>alert(1)</script>";
const thaiPattern = /[฀-๿]/;

/** Seeds a project with a topic, a message and a task so most existing pages have content. */
function seed(f: Fixture, name = `Project ${hostile}`) {
  const { actor } = f.auth;
  const project = f.app.execute(actor, { kind: "project.create", requestId: crypto.randomUUID(), projectId: null, expectedRevision: f.app.workspace(actor).revision, payload: { name } }).project;
  const topic = f.app.execute(actor, { kind: "topic.create", requestId: crypto.randomUUID(), projectId: project.id, expectedRevision: f.app.project(actor, project.id).revision, payload: { title: `Topic ${hostile}` } }).topic;
  const current = f.app.conversation(actor, project.id, topic.id).topic;
  f.app.execute(actor, { kind: "message.send", requestId: crypto.randomUUID(), projectId: project.id, expectedRevision: current.revision, payload: { topicId: topic.id, text: `Message ${hostile}` } });
  const fresh = f.app.conversation(actor, project.id, topic.id).topic;
  const task = f.app.execute(actor, { kind: "task.propose", requestId: crypto.randomUUID(), projectId: project.id, expectedRevision: fresh.revision,
    payload: { topicId: topic.id, title: `Task ${hostile}`, summary: "Summary" } }).task;
  return { project, topic: fresh, task };
}
function setPreferences(f: Fixture, theme: "system" | "dark" | "light", language: "auto" | "th" | "en") {
  const { revision } = f.app.preferences(f.auth.actor);
  return f.app.execute(f.auth.actor, { kind: "ui.preferences.set", requestId: crypto.randomUUID(), projectId: null, expectedRevision: revision, payload: { theme, language } });
}
/** Hidden inputs and action of the first form in `html` whose action matches. */
function form(html: string, action: string | RegExp): { action: string; fields: Record<string, string> } {
  for (const match of html.matchAll(/<form\b[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)) {
    if (typeof action === "string" ? match[1] !== action : !action.test(match[1]!)) continue;
    const fields: Record<string, string> = {};
    for (const input of match[2]!.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[input[1]!] = input[2]!;
    return { action: match[1]!, fields };
  }
  throw new Error(`no form for ${action}`);
}
/** Every <script> must be the hashed external module; no inline code, no inline handlers, no javascript: URLs. */
function expectNoInlineScript(html: string) {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  for (const [tag, body] of scripts) {
    expect(body).toBe("");
    expect(tag).toBe(`<script type="module" src="${assetUrl("app.js")}"></script>`);
  }
  expect(html.match(/<script\b/g)?.length ?? 0).toBe(scripts.length);
  expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  expect(html).not.toContain("javascript:");
  expect(html).not.toMatch(/(?:src|href|action)="(?:https?:)?\/\//);
}

test("ui.i18n_dictionary/v1: every language defines exactly the Thai key set with plain, non-empty text", () => {
  const keys = Object.keys(th).sort();
  expect(keys.length).toBeGreaterThan(900);
  for (const locale of locales) {
    const dictionary = dictionaries[locale];
    expect(Object.keys(dictionary).sort()).toEqual(keys);
    for (const key of keys) {
      const value = dictionary[key as keyof typeof th];
      expect(typeof value).toBe("string");
      expect(value.trim().length).toBeGreaterThan(0);
      // Values are inserted unescaped, so markup characters are forbidden.
      expect(value).not.toMatch(/[<>&"'`]/);
      expect(value).not.toBe(key);
    }
  }
  // English is a translation, not a copy: only identifiers/technical labels may stay Thai-free and equal.
  const thaiInEnglish = keys.filter(key => thaiPattern.test(dictionaries.en[key as keyof typeof th]));
  expect(thaiInEnglish).toEqual([]);
  expect(withLocale("en", () => tr("shell.settings"))).toBe("Settings");
  expect(tr("shell.settings")).toBe("ตั้งค่า");
  expect(trMaybe("error.not_a_code")).toBeNull();
  expect(() => withLocale("en", () => Promise.resolve("x"))).toThrow("synchronous");
});

test("Accept-Language negotiation picks a supported language by weight and falls back to Thai", () => {
  expect(negotiateLocale(null)).toBe("th");
  expect(negotiateLocale("en-US,en;q=0.9")).toBe("en");
  expect(negotiateLocale("fr-FR, en;q=0.5, th;q=0.8")).toBe("th");
  expect(negotiateLocale("de, fr")).toBe("th");
  expect(negotiateLocale("en;q=0")).toBe("th");
  expect(negotiateLocale("x".repeat(600))).toBe("th");
  // Malformed or out-of-range qvalues disqualify the range instead of counting as q=1.
  for (const header of ["en;q=1.5", "en;q=1.001", "en;q=bogus", "en;q=", "en;q=0.5;q=1", "en;q =0", "en;q", "en;foo=bar", "en; q=1; x=y"]) expect(negotiateLocale(header)).toBe("th");
  expect(negotiateLocale("en; q=0.8")).toBe("en");
  expect(negotiateLocale("en;q=1.000")).toBe("en");
  expect(negotiateLocale("en;q=bogus, th;q=0.1")).toBe("th");
});

test("ui.design_tokens/v1: text and status pairs meet WCAG AA in both themes and both themes define every token", () => {
  expect(Object.keys(colorTokens.light).sort()).toEqual(Object.keys(colorTokens.dark).sort());
  expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  expect(contrastRatio("#777777", "#777777")).toBe(1);
  for (const theme of ["dark", "light"] as const) {
    for (const [fg, bg] of contrastPairs) {
      const ratio = contrastRatio(colorTokens[theme][fg], colorTokens[theme][bg]);
      if (ratio < 4.5) throw new Error(`${theme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
    }
  }
  // Monochrome: only the semantic tokens carry hue.
  for (const theme of ["dark", "light"] as const) {
    for (const [name, value] of Object.entries(colorTokens[theme])) {
      if (["ok", "warn", "danger"].includes(name)) continue;
      const [r, g, b] = [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
      expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThanOrEqual(3);
    }
  }
});

test("web.static_assets/v1: hashed, immutable, self-hosted assets with font licences; unknown paths are 404", async () => {
  const f = await fixture();
  expect([...staticAssets.keys()].sort()).toEqual(["OFL-Inter.txt", "OFL-JetBrainsMono.txt", "OFL-NotoSansThai.txt", "app.css", "app.js", "favicon.svg", "inter.woff2", "jetbrains-mono.woff2", "noto-sans-thai.woff2"]);
  for (const asset of staticAssets.values()) {
    expect(asset.hash).toBe(createHash("sha256").update(asset.body).digest("hex").slice(0, 16));
    expect(asset.path).toMatch(new RegExp(`^/assets/[a-zA-Z-]+\\.${asset.hash}\\.(css|js|svg|woff2|txt)$`));
    // Assets are public (the sign-in page needs them) and carry no owner data.
    const response = await get(f, asset.path, {}, false);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(asset.contentType);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("content-security-policy")).toBe(contentSecurityPolicy);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(asset.body);
  }
  for (const font of ["inter.woff2", "noto-sans-thai.woff2", "jetbrains-mono.woff2"] as const) {
    expect(new TextDecoder().decode(staticAssets.get(font)!.body.slice(0, 4))).toBe("wOF2");
  }
  for (const licence of ["OFL-Inter.txt", "OFL-NotoSansThai.txt", "OFL-JetBrainsMono.txt"] as const) {
    expect(new TextDecoder().decode(staticAssets.get(licence)!.body)).toContain("SIL Open Font License, Version 1.1");
  }
  const css = new TextDecoder().decode(staticAssets.get("app.css")!.body);
  const urls = [...css.matchAll(/url\("([^"]+)"\)/g)].map(m => m[1]!);
  expect(urls.sort()).toEqual([assetUrl("inter.woff2"), assetUrl("jetbrains-mono.woff2"), assetUrl("noto-sans-thai.woff2")].sort());
  for (const asset of staticAssets.values()) {
    if (asset.contentType.startsWith("font/") || asset.name.endsWith(".txt")) continue;
    // No remote origin anywhere (the SVG namespace URI is an identifier, not a request).
    expect(new TextDecoder().decode(asset.body).replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toMatch(/https?:\/\/|\/\/[a-z0-9.-]+\.[a-z]{2,}\//i);
  }
  const js = new TextDecoder().decode(staticAssets.get("app.js")!.body);
  expect(js).not.toMatch(/\beval\s*\(|new Function|fetch\(|XMLHttpRequest|localStorage|sessionStorage|document\.cookie/);
  for (const path of ["/assets/app.css", "/assets/app.0000000000000000.css", "/assets/fonts/Inter-Variable.woff2", `${assetUrl("app.css")}x`]) {
    expect((await get(f, path, {}, false)).status).toBe(404);
  }
  // Dot segments are normalized away before routing, so they never reach the asset table or the file system.
  expect((await get(f, "/assets/%2e%2e/web.ts", {}, false)).status).toBe(303);
  expect(lookupAsset("/assets/app.css")).toBeNull();
});

test("the generated stylesheet has only valid property names and keeps literal text layout", () => {
  const css = new TextDecoder().decode(staticAssets.get("app.css")!.body).replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [...css.matchAll(/\{([^{}]*)\}/g)].map(m => m[1]!);
  expect(blocks.length).toBeGreaterThan(100);
  const properties = new Set<string>();
  for (const block of blocks) {
    for (const declaration of block.split(";").map(d => d.trim()).filter(Boolean)) {
      const property = declaration.slice(0, declaration.indexOf(":")).trim();
      if (!/^(?:--[a-z0-9-]+|-?[a-z][a-z-]*)$/.test(property)) throw new Error(`invalid declaration: ${declaration}`);
      properties.add(property);
    }
  }
  expect(properties.has("white-space")).toBe(true);
  expect(css).toMatch(/\.literal \{ white-space: pre-wrap;/);
  expect(css).toMatch(/\bcode \{[^}]*white-space: pre;/);
  // Semantic status text never sits on a tinted background (all status pairs are covered by contrastPairs).
  for (const tone of ["ok", "warn", "danger"]) expect(css).toContain(`--${tone}-bg: transparent;`);
});

test("layout templates contain no hard-coded English or Thai text nodes", async () => {
  const source = await Bun.file(join(import.meta.dir, "../src/web-layout.ts")).text();
  const nodes = [...source.matchAll(/>([^<>$`{}\n=;'"]*[A-Za-z\u0E00-\u0E7F]{2,}[^<>$`{}\n=;'"]*)</g)].map(m => m[1]!.trim()).filter(Boolean);
  // Allowed literals: vendored font names and contract identifiers, which are the same in every language.
  const literals = [...new Set(nodes)].filter(node => !/^[a-z_.]+\/v\d+$/.test(node) && !node.includes("(value)")).sort();
  expect(literals).toEqual(["Inter", "JetBrains Mono", "Noto Sans Thai", "quarantine (OPS02)"]);
  expect(source).not.toMatch(/[\u0E00-\u0E7F]/);
  // Capitalised word literals in expressions are product names only, never labels.
  expect([...new Set(source.match(/"[A-Z][a-z]+(?: [a-zA-Z]+)*"/g))].sort()).toEqual(['"Codex"', '"Grok"', '"Jit"']);
});

test("CSP is exactly ADR 0028 on pages, API, assets, redirects and errors", async () => {
  const f = await fixture();
  expect(contentSecurityPolicy).toBe("default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  for (const response of [await get(f, "/"), await get(f, "/api/projects"), await get(f, "/login", {}, false), await get(f, "/", {}, false),
    await get(f, "/nope"), await get(f, assetUrl("app.js"), {}, false), await postForm(f, "/projects", { name: "x" })]) {
    expect(response.headers.get("content-security-policy")).toBe(contentSecurityPolicy);
  }
});

test("every existing page renders through the shell in Thai and English, dark and light, without raw keys or inline script", async () => {
  const f = await fixture();
  const { project, topic, task } = seed(f);
  const routes = [
    "/", `/projects/${project.id}`, `/projects/${project.id}/topics`, `/projects/${project.id}/topics/${topic.id}`,
    `/projects/${project.id}/sources/${topic.source.sourceId}?revision=${topic.source.revision}&generation=${topic.source.generation}`,
    "/team", `/projects/${project.id}/team`, `/projects/${project.id}/tasks`, `/projects/${project.id}/tasks/${task.id}`,
    `/projects/${project.id}/jobs`, `/projects/${project.id}/delivery`, `/projects/${project.id}/pr/reports`, `/projects/${project.id}/schedules`,
    `/projects/${project.id}/memory`, `/projects/${project.id}/memory/deletions`, `/projects/${project.id}/exports`,
    "/backups", "/upgrades", "/restores", "/settings", `/projects/${project.id}/topics/00000000-0000-0000-0000-000000000000`,
  ];
  const keys = Object.keys(th);
  const keyPattern = new RegExp(`(?:^|[\\s>"])(?:${keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?=[\\s<"]|$)`);
  for (const theme of ["dark", "light"] as const) {
    for (const language of ["th", "en"] as const) {
      setPreferences(f, theme, language);
      for (const route of routes) {
        const response = await get(f, route);
        expect([200, 404]).toContain(response.status);
        const html = await response.text();
        expect(html.startsWith(`<!doctype html><html lang="${language}" data-theme="${theme}">`)).toBe(true);
        expect(response.headers.get("content-language")).toBe(language);
        expect(html).toContain(`<meta name="color-scheme" content="${theme}">`);
        expect(html).toContain(`href="${assetUrl("app.css")}"`);
        if (response.status === 200) {
          expect(html).toContain('<aside class="sidebar" id="sidebar"');
          expect(html).toContain('href="/settings"');
          expect(html).toContain('<a class="menu-button" href="#sidebar"');
        }
        expect(html).not.toMatch(keyPattern);
        expectNoInlineScript(html);
        expect(html).not.toContain(hostile);
        if (language === "en") {
          // Owner content in this fixture is ASCII, so any Thai left on an English page is an untranslated label.
          const text = html.replace(/<[^>]+>/g, " ");
          const leaked = text.split(/\s{2,}|\n/).filter(part => thaiPattern.test(part));
          if (leaked.length) throw new Error(`${route}: untranslated ${JSON.stringify(leaked.slice(0, 5))}`);
        }
      }
    }
  }
});

test("theme and language follow the browser until the owner saves a preference, and saved values win", async () => {
  const f = await fixture();
  const english = { "accept-language": "en-US,en;q=0.9" };
  let html = await (await get(f, "/login", english, false)).text();
  expect(html.startsWith('<!doctype html><html lang="en"><head>')).toBe(true);
  expect(html).toContain('<meta name="color-scheme" content="dark light">');
  expect(html).toContain("Sign in");
  html = await (await get(f, "/login", {}, false)).text();
  expect(html.startsWith('<!doctype html><html lang="th"><head>')).toBe(true);
  expect(f.app.preferences(f.auth.actor)).toEqual({ theme: "system", language: "auto", revision: 0, updatedAt: null });
  html = await (await get(f, "/", english)).text();
  expect(html.startsWith('<!doctype html><html lang="en"><head>')).toBe(true);
  setPreferences(f, "light", "th");
  html = await (await get(f, "/", english)).text();
  expect(html.startsWith('<!doctype html><html lang="th" data-theme="light">')).toBe(true);
  setPreferences(f, "system", "auto");
  html = await (await get(f, "/", english)).text();
  expect(html.startsWith('<!doctype html><html lang="en"><head>')).toBe(true);
  // CSS: dark tokens by default, light under prefers-color-scheme unless the owner chose dark, and for an explicit light choice.
  const css = new TextDecoder().decode(staticAssets.get("app.css")!.body);
  expect(css).toContain(`--bg:${colorTokens.dark.bg};`);
  expect(css).toMatch(/@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme="dark"\]\) \{ color-scheme: light; --bg:#fafaf9;/);
  expect(css).toContain(`:root[data-theme="light"] { color-scheme: light; --bg:${colorTokens.light.bg};`);
  expect(css).toContain(".sidebar:target");
  expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*animation: none !important/);
});

test("ui.preferences.set is an owner command: revisioned, idempotent, validated and persisted in schema 24", async () => {
  const f = await fixture();
  const { actor } = f.auth;
  expect(schemaVersion).toBe(24);
  expect(backupImageTables.owner_preferences).toBe("include");
  const command = { kind: "ui.preferences.set" as const, requestId: "prefs-request-01", projectId: null, expectedRevision: 0, payload: { theme: "light" as const, language: "en" as const } };
  const first = f.app.execute(actor, command);
  expect(first.preferences).toMatchObject({ theme: "light", language: "en", revision: 1 });
  expect(f.app.execute(actor, command)).toEqual(first);
  expect(() => f.app.execute(actor, { ...command, payload: { theme: "dark", language: "en" } })).toThrow("request_id_conflict");
  expect(() => f.app.execute(actor, { ...command, requestId: "prefs-request-02" })).toThrow("stale_revision");
  for (const payload of [{ theme: "blue", language: "en" }, { theme: "dark", language: "fr" }, { theme: "dark", language: "en", extra: 1 }]) {
    expect(() => f.app.execute(actor, { ...command, requestId: crypto.randomUUID(), expectedRevision: 1, payload } as never)).toThrow("invalid_preferences");
  }
  expect(() => f.app.execute({ ownerId: "owner", channel: "web" } as never, { ...command, requestId: crypto.randomUUID(), expectedRevision: 1 })).toThrow("authentication_required");
  expect(f.store.read(tx => tx.get("SELECT theme, language, revision FROM owner_preferences WHERE id = 1"))).toEqual({ theme: "light", language: "en", revision: 1 });
  expect(f.store.read(tx => tx.all("SELECT command_kind FROM audit WHERE command_kind = 'ui.preferences.set'"))).toHaveLength(1);
  // JSON API uses the same session, Origin and CSRF checks as forms.
  const api = (body: unknown, headers: Record<string, string>) => f.web(new Request(`${origin}/api/settings/preferences`, { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", cookie: `jit_session=${f.token}`, ...headers } }));
  const body = { requestId: "prefs-api-01", expectedRevision: 1, theme: "dark", language: "th" };
  expect((await api(body, { origin })).status).toBe(403);
  expect((await api(body, { origin: "http://evil.example", "x-csrf-token": f.auth.csrf })).status).toBe(403);
  const ok = await api(body, { origin, "x-csrf-token": f.auth.csrf });
  expect(ok.status).toBe(200);
  expect((await ok.json()).preferences).toMatchObject({ theme: "dark", language: "th", revision: 2 });
  expect(await (await get(f, "/api/settings/preferences")).json()).toMatchObject({ theme: "dark", language: "th", revision: 2 });
});

test("core flows work by plain form post through the new shell with no script", async () => {
  const f = await fixture();
  // Sign in with the rendered form; the browser follows redirects with its own cookie.
  const loginHtml = await (await get(f, "/login", {}, false)).text();
  expect(loginHtml).toContain('<form method="post" action="/login">');
  const login = await postForm(f, "/login", { password }, {}, null);
  expect(login.status).toBe(303);
  const token = /jit_session=([^;]+)/.exec(login.headers.get("set-cookie")!)![1]!;
  const session: Fixture = { ...f, token };
  // Create a project from the home form.
  let html = await (await get(session, "/")).text();
  let next = form(html, "/projects");
  let response = await postForm(session, next.action, { ...next.fields, name: "No-script project" });
  expect(response.status).toBe(303);
  html = await (await get(session, "/")).text();
  const projectId = /href="\/projects\/([a-f0-9-]{36})"/.exec(html)![1]!;
  expect(html).toContain("No-script project");
  // Create a topic from the project page and send a message from the composer.
  html = await (await get(session, `/projects/${projectId}`)).text();
  next = form(html, `/projects/${projectId}/topics`);
  response = await postForm(session, next.action, { ...next.fields, title: "Form topic" });
  expect(response.status).toBe(303);
  const topicPath = response.headers.get("location")!;
  html = await (await get(session, topicPath)).text();
  next = form(html, /\/messages$/);
  response = await postForm(session, next.action, { ...next.fields, text: "Sent without script" });
  expect(response.status).toBe(303);
  html = await (await get(session, response.headers.get("location")!)).text();
  expect(html).toContain("Sent without script");
  // Propose a task from the topic page.
  next = form(html, `/projects/${projectId}/tasks`);
  response = await postForm(session, next.action, { ...next.fields, title: "Form task", summary: "From a plain form" });
  expect(response.status).toBe(303);
  expect(await (await get(session, response.headers.get("location")!)).text()).toContain("Form task");
  // Save appearance and language from settings.
  html = await (await get(session, "/settings")).text();
  next = form(html, "/settings/preferences");
  expect(html).toContain('<input type="radio" name="theme" value="system" checked>');
  response = await postForm(session, next.action, { ...next.fields, theme: "light", language: "en" });
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/settings#appearance");
  html = await (await get(session, "/settings")).text();
  expect(html.startsWith('<!doctype html><html lang="en" data-theme="light">')).toBe(true);
  expect(html).toContain('<input type="radio" name="language" value="en" checked>');
  // Replaying the old form is a stale revision with a translated, escaped error page; forged posts are refused.
  response = await postForm(session, next.action, { ...next.fields, requestId: crypto.randomUUID(), theme: "dark", language: "th" });
  expect(response.status).toBe(409);
  const error = await response.text();
  expect(error).toContain(dictionaries.en["error.stale_revision"]);
  expect(error).toContain('<html lang="en" data-theme="light">');
  expect((await postForm(session, next.action, { ...next.fields, csrf: "0".repeat(64), theme: "dark", language: "th" })).status).toBe(403);
  expect((await postForm(session, next.action, { ...next.fields, theme: "dark", language: "th" }, { origin: "http://evil.example" })).status).toBe(403);
  // Sign out from the sidebar form.
  next = form(html, "/logout");
  response = await postForm(session, next.action, next.fields);
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/login");
});

test("status labels always carry text and the drawer works through :target without script", async () => {
  const f = await fixture();
  const { project, topic, task } = seed(f, "Plain");
  let seen = 0;
  for (const route of [`/projects/${project.id}/tasks`, `/projects/${project.id}/tasks/${task.id}`, `/projects/${project.id}/topics/${topic.id}`]) {
    const html = await (await get(f, route)).text();
    const statuses = [...html.matchAll(/<(span|p|strong|div) class="(?:job-status|committed)"[^>]*>([\s\S]*?)<\/\1>/g)];
    seen += statuses.length;
    for (const [, , inner] of statuses) expect(inner!.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").trim().length).toBeGreaterThan(0);
    expect(html).toContain('<aside class="sidebar" id="sidebar"');
    expect(html).toContain('<a class="drawer-close" href="#main-content"');
  }
  expect(seen).toBeGreaterThan(1);
});

test("fixed domain notes shown in pages are dictionary entries, so English pages never fall back to Thai notes", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const sources = readdirSync(join(import.meta.dir, "../src"), { recursive: true, encoding: "utf8" })
    .filter(file => file.endsWith(".ts") && !file.startsWith("i18n"))
    .map(file => readFileSync(join(import.meta.dir, "../src", file), "utf8").replace(/" \+\n\s*"/g, "")).join("\n");
  const { systemText } = await import("../src/i18n");
  for (const key of Object.keys(th).filter(k => k.startsWith("system."))) {
    const value = th[key as keyof typeof th];
    // Each entry mirrors an exact string a domain module returns; a drifted string would silently stay Thai.
    expect(sources).toContain(JSON.stringify(value));
    expect(withLocale("en", () => systemText(value))).toBe(dictionaries.en[key as keyof typeof th]);
  }
  expect(withLocale("en", () => systemText("owner text"))).toBe("owner text");
});

test("logo is one-colour hand-built SVG: mark, lockup with drawn wordmark, favicon", () => {
  const mark = logoMark({ size: 48, label: "Jit" });
  expect(mark).toContain('viewBox="0 0 24 24"');
  expect(mark).toContain('fill="currentColor"');
  expect(mark).toContain('class="jit-halo"');
  expect(mark).toContain('class="jit-dot"');
  expect(logoMark({ size: 16 })).not.toContain("jit-halo");
  expect(logoMark({ size: 16 })).toContain('aria-hidden="true"');
  const lockup = logoLockup();
  for (const svg of [mark, lockup, faviconSvg]) {
    // Drawn paths only: no font text, raster images or external references.
    expect(svg).not.toMatch(/<text|<image|href=|url\(/);
  }
  expect(lockup).toContain('aria-label="Jit"');
  expect(faviconSvg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg"');
  expect(staticAssets.get("favicon.svg")!.contentType).toBe("image/svg+xml");
});

/** Minimal DOM stand-in for the enhancement module: just the nodes and events app.js touches. */
function fakeDom(hash: string) {
  const listeners: Record<string, ((event: any) => void)[]> = {};
  const on = (target: string) => (type: string, fn: (event: any) => void) => { (listeners[`${target}:${type}`] ??= []).push(fn); };
  const fire = (target: string, type: string, event: any = {}) => { for (const fn of listeners[`${target}:${type}`] ?? []) fn({ preventDefault() { event.prevented = true; }, ...event }); return event; };
  const focused: string[] = [];
  const attributes: Record<string, string> = {};
  const app = { dataset: {} as Record<string, string> };
  const menuButton = { setAttribute: (k: string, v: string) => { attributes[k] = v; }, addEventListener: on("menu"), focus: () => focused.push("menu") };
  const closers = [{ addEventListener: on("close") }, { addEventListener: on("scrim") }];
  const submitted: string[] = [];
  const form = { reportValidity: () => true, requestSubmit: () => submitted.push("composer") };
  const textarea = { form, addEventListener: on("textarea"), style: {} as Record<string, string>, scrollHeight: 40 };
  const location = { hash, pathname: "/projects/p/topics/t", search: "" };
  const replaced: string[] = [];
  const globals = {
    document: {
      documentElement: { dataset: {} as Record<string, string> },
      querySelector: (selector: string) => selector === ".app" ? app : selector === ".menu-button" ? menuButton : null,
      getElementById: (id: string) => id === "sidebar" ? { querySelector: () => ({ focus: () => focused.push("sidebar") }) } : null,
      querySelectorAll: (selector: string) => selector === ".drawer-close, .drawer-scrim" ? closers : selector === ".composer textarea" ? [textarea] : [],
      addEventListener: on("document"),
    },
    window: { addEventListener: on("window") },
    location,
    history: { replaceState: (_s: unknown, _t: string, url: string) => { replaced.push(url); location.hash = ""; } },
    CSS: { supports: () => true },
  };
  return { app, attributes, focused, submitted, replaced, location, fire, globals };
}
/** Installs the fake globals, loads a fresh copy of app.js and returns a function that restores the globals. */
async function runAppScript(dom: ReturnType<typeof fakeDom>): Promise<() => void> {
  const saved = new Map(Object.keys(dom.globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const restore = () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
  };
  for (const [key, value] of Object.entries(dom.globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try { await import(`../src/web-assets/app.js?case=${crypto.randomUUID()}`); } catch (error) { restore(); throw error; }
  return restore;
}

test("app.js contract: drawer follows the no-script #sidebar target both ways; Escape, close controls and ⌘Enter behave", async () => {
  const dom = fakeDom("#sidebar");
  const restore = await runAppScript(dom);
  try {
  // Opened before the module loaded (refresh / direct link): script state agrees with CSS :target.
  expect(dom.app.dataset.drawer).toBe("open");
  expect(dom.attributes["aria-expanded"]).toBe("true");
  dom.fire("document", "keydown", { key: "Escape" });
  expect(dom.app.dataset.drawer).toBe("closed");
  expect(dom.attributes["aria-expanded"]).toBe("false");
  expect(dom.location.hash).toBe("");
  expect(dom.replaced).toEqual(["/projects/p/topics/t"]);
  expect(dom.focused.at(-1)).toBe("menu");
  // Back/forward navigation to and away from #sidebar.
  dom.location.hash = "#sidebar"; dom.fire("window", "hashchange");
  expect(dom.app.dataset.drawer).toBe("open");
  dom.location.hash = ""; dom.fire("window", "hashchange");
  expect(dom.app.dataset.drawer).toBe("closed");
  expect(dom.attributes["aria-expanded"]).toBe("false");
  // Menu button toggles without touching history; close and scrim links close.
  const click = dom.fire("menu", "click", {});
  expect(click.prevented).toBe(true);
  expect(dom.app.dataset.drawer).toBe("open");
  expect(dom.focused.at(-1)).toBe("sidebar");
  dom.fire("scrim", "click");
  expect(dom.app.dataset.drawer).toBe("closed");
  dom.fire("menu", "click"); dom.fire("close", "click");
  expect(dom.app.dataset.drawer).toBe("closed");
  // ⌘/Ctrl+Enter submits through the form's own post; plain Enter does not.
  dom.fire("textarea", "keydown", { key: "Enter" });
  expect(dom.submitted).toEqual([]);
  dom.fire("textarea", "keydown", { key: "Enter", metaKey: true });
  dom.fire("textarea", "keydown", { key: "Enter", ctrlKey: true });
  expect(dom.submitted).toEqual(["composer", "composer"]);
  } finally { restore(); }

  const closedStart = fakeDom("");
  (await runAppScript(closedStart))();
  expect(closedStart.app.dataset.drawer).toBe("closed");
  expect(closedStart.replaced).toEqual([]);
});
