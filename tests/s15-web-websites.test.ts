import { afterEach, expect, test } from "bun:test";
import { dictionaries, withLocale } from "../src/i18n";
import { BrowserError } from "../src/s15/browser";
import type { S15ApprovedWebsite, S15WebWebsites, S15WebsiteEngine } from "../src/s15/web";
import { limitNotice } from "../src/s15/web/browser";
import { accountsBody } from "../src/s15/web/resources";
import { webFixture, type WebActor, type WebFixture } from "./fixtures/s15-web";

// BROW15-02 Resources → Websites (`/resources/websites`), th and en, over a fake owner port.
const fixtures: WebFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
const T = (key: string, locale: "th" | "en" = "th") => (dictionaries[locale] as Record<string, string>)[key]!;
const escaped = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const at = 1_800_000_000_000;

function setup(state: { engine: S15WebsiteEngine; sites: S15ApprovedWebsite[] } | null, calls: string[] = []) {
  const port: S15WebWebsites<WebActor> = {
    status: () => state!.engine,
    list: () => state!.sites,
    add(_a, _id, input) { calls.push(`add:${input}`); if (input.startsWith("http://")) throw new BrowserError("website_https_required"); const site = { origin: "https://example.com", revision: 1, addedAt: at }; state!.sites = [...state!.sites, site]; return site; },
    remove(_a, _id, origin, revision) { calls.push(`remove:${origin}:${revision}`); if (revision !== 1) throw new BrowserError("website_changed"); state!.sites = state!.sites.filter(site => site.origin !== origin); },
    retry() { calls.push("retry"); state!.engine = { state: "provisioning", step: "verify", version: "156.0.8078.4" }; },
  };
  const f = webFixture(() => state ? { websites: port } : {}); fixtures.push(f); return f;
}
const page = async (f: WebFixture, locale: "th" | "en" = "th", path = "/resources/websites") => (await f.get(path, { "accept-language": locale })).text();
const ready: S15WebsiteEngine = { state: "ready", version: "156.0.8078.4" };

test("not composed: the page explains itself and its forms do not exist", async () => {
  const f = setup(null);
  const th = await page(f), en = await page(f, "en");
  expect(th).toContain(escaped(T("s15.websites.lead"))); expect(th).toContain(escaped(T("s15.websites.not_composed"))); expect(en).toContain(escaped(T("s15.websites.not_composed", "en")));
  expect(th).toContain(escaped(T("s15.websites.signin_none"))); expect(th).toContain('href="/resources/websites" aria-current="page"');
  expect((await f.post("/s15/forms/websites/add", { website: "example.com" })).status).toBe(404);
});

for (const locale of ["th", "en"] as const) test(`ready with approved websites (${locale}): status, rows with remove, add form and limits`, async () => {
  const f = setup({ engine: ready, sites: [{ origin: "https://docs.example.org", revision: 3, addedAt: at }] });
  const html = await page(f, locale);
  expect(html).toContain(escaped(T("s15.websites.engine_ready", locale))); expect(html).toContain(escaped(T("s15.websites.engine_version", locale).replace("{version}", "156.0.8078.4")));
  expect(html).toContain(">https://docs.example.org<"); expect(html).toContain('name="revision" value="3"');
  expect(html).toContain(`aria-label="${escaped(T("s15.websites.remove_label", locale).replace("{origin}", "https://docs.example.org"))}"`);
  expect(html).toContain('action="/s15/forms/websites/add"'); expect(html).toContain('name="website" type="text" inputmode="url"'); expect(html).not.toContain('aria-invalid="true"');
  for (const name of ["read", "no_forms", "private", "public"]) expect(html).toContain(escaped(T(`s15.websites.limit.${name}`, locale)));
  expect(html).toContain(escaped(T("s15.websites.engine_where", locale))); expect(html).not.toContain("/s15/forms/websites/retry");
  expect(html).not.toMatch(/name="decision"/);
});

test("preparing: ordered steps with the current one marked, self-refresh, and no retry", async () => {
  const f = setup({ engine: { state: "provisioning", step: "download", version: "156.0.8078.4" }, sites: [] });
  const th = await page(f), en = await page(f, "en");
  expect(th).toContain(escaped(T("s15.websites.engine_preparing"))); expect(th).toContain('data-s15-refresh="5"');
  expect(th).toContain(`<li aria-current="step" data-state="now"><span class="s-grow">${escaped(T("s15.websites.step.download").replace("{version}", "156.0.8078.4"))}`);
  expect(th).toContain(`data-state="done"><span class="s-grow">${escaped(T("s15.websites.step.verify"))}`);
  expect(en).toContain(escaped(T("s15.websites.engine_preparing_lead", "en"))); expect(th).toContain(escaped(T("s15.websites.none")));
  expect(th).not.toContain("/s15/forms/websites/retry");
});

for (const [code, locale] of [["browser_libraries_missing", "th"], ["browser_checksum_mismatch", "en"], ["browser_download_unavailable", "th"], ["browser_disk_insufficient", "en"], ["browser_extract_failed", "th"], ["browser_directory_unsafe", "en"], ["browser_engine_unavailable", "th"]] as const) test(`failed ${code} (${locale}): reason, step, next step, code and Try again`, async () => {
  const calls: string[] = [];
  const f = setup({ engine: { state: "failed", code, step: code === "browser_libraries_missing" ? "libraries" : "download", library: code === "browser_libraries_missing" ? "libnss3.so" : null, version: "156.0.8078.4" }, sites: [] }, calls);
  const html = await page(f, locale);
  expect(html).toContain(escaped(T("s15.websites.engine_failed", locale))); expect(html).toContain(escaped(T(`s15.code.${code}`, locale))); expect(html).toContain(escaped(T(`s15.websites.next.${code}`, locale)));
  expect(html).toContain(`>${code}<`); expect(html).toContain('action="/s15/forms/websites/retry"'); expect(html).toContain('data-state="failed"');
  if (code === "browser_libraries_missing") expect(html).toContain(escaped(T("s15.websites.missing_library", locale).replace("{library}", "libnss3.so")));
  const retried = await f.post("/s15/forms/websites/retry", {}); expect(retried.status).toBe(303); expect(retried.headers.get("location")).toBe("/resources/websites?retried=1#s15-web-engine");
  expect(calls).toEqual(["retry"]); expect(await page(f, locale, "/resources/websites?retried=1")).toContain(escaped(T("s15.websites.retry_started", locale)));
});

test("an unsupported host names the reason and next step without a retry that cannot help", async () => {
  const f = setup({ engine: { state: "failed", code: "browser_host_unsupported", step: null, library: null, version: null }, sites: [] });
  const html = await page(f, "en");
  expect(html).toContain(escaped(T("s15.code.browser_host_unsupported", "en"))); expect(html).toContain(escaped(T("s15.websites.next.browser_host_unsupported", "en")));
  expect(html).not.toContain("/s15/forms/websites/retry"); expect(html).not.toContain("s15-provision-steps");
});

test("add and remove are owner form posts; refusals keep the entry; notices only reflect the current list", async () => {
  const calls: string[] = [], f = setup({ engine: ready, sites: [] }, calls);
  const refused = await f.post("/s15/forms/websites/add", { website: "http://example.com/a" }, { "accept-language": "en" });
  expect(refused.status).toBe(409); const html = await refused.text();
  expect(html).toContain(escaped(T("s15.code.website_https_required", "en"))); expect(html).toContain('value="http://example.com/a"'); expect(html).toContain('aria-invalid="true"');
  const added = await f.post("/s15/forms/websites/add", { website: "example.com" });
  expect(added.status).toBe(303); expect(added.headers.get("location")).toBe("/resources/websites?added=https%3A%2F%2Fexample.com#s15-web-list");
  expect(await page(f, "th", "/resources/websites?added=https%3A%2F%2Fexample.com")).toContain(escaped(T("s15.websites.saved_added").replace("{origin}", "https://example.com")));
  // A crafted link cannot show a notice the list does not support.
  expect(await page(f, "th", "/resources/websites?added=https%3A%2F%2Fevil.example")).not.toContain(escaped(T("s15.websites.saved_added").replace("{origin}", "https://evil.example")));
  expect(await page(f, "th", "/resources/websites?removed=https%3A%2F%2Fexample.com")).not.toContain(escaped(T("s15.websites.saved_removed").replace("{origin}", "https://example.com")));
  const stale = await f.post("/s15/forms/websites/remove", { origin: "https://example.com", revision: "2" });
  expect(stale.status).toBe(409); const staleHtml = await stale.text(); expect(staleHtml).toContain(escaped(T("s15.code.website_changed"))); expect(staleHtml).not.toContain('aria-invalid="true"');
  expect((await f.post("/s15/forms/websites/remove", { origin: "https://example.com", revision: "x" })).status).toBe(400);
  expect((await f.post("/s15/forms/websites/remove", { origin: "https://example.com", revision: "1", extra: "1" })).status).toBe(400);
  const removed = await f.post("/s15/forms/websites/remove", { origin: "https://example.com", revision: "1" }); expect(removed.status).toBe(303);
  expect(await page(f, "en", "/resources/websites?removed=https%3A%2F%2Fexample.com")).toContain(escaped(T("s15.websites.saved_removed", "en").replace("{origin}", "https://example.com")));
  expect(calls).toEqual(["add:http://example.com/a", "add:example.com", "remove:https://example.com:2", "remove:https://example.com:1"]);
  // Session, Origin and CSRF are required for every command.
  expect((await f.post("/s15/forms/websites/add", { website: "example.org" }, { origin: "http://evil.test" })).status).toBe(403);
  expect((await f.post("/s15/forms/websites/add", { website: "example.org", csrf: "wrong" })).status).toBe(403);
  f.expire(); expect((await f.post("/s15/forms/websites/add", { website: "example.org" })).status).toBe(401); expect(calls).toHaveLength(4);
});

test("a refused browser step points to the websites page; the accounts page links it", () => {
  for (const locale of ["th", "en"] as const) withLocale(locale, () => {
    const unlisted = limitNotice("website_not_approved", "c1", "r1", null, "csrf");
    expect(unlisted).toContain('href="/resources/websites#s15-web-add"'); expect(unlisted).toContain(escaped(T("s15.websites.add_from_limit", locale))); expect(unlisted).toContain(escaped(T("s15.code.website_not_approved", locale)));
    const preparing = limitNotice("browser_provisioning", "c1", "r1", null, "csrf");
    expect(preparing).toContain('href="/resources/websites#s15-web-engine"'); expect(preparing).toContain(escaped(T("s15.code.browser_provisioning", locale)));
    expect(limitNotice("upload_unsupported", "c1", "r1", null, "csrf")).not.toContain("/resources/websites");
    expect(accountsBody({ team: [], accounts: [], browsers: [], csrf: "csrf" })).toContain(`<a class="s-link-text" href="/resources/websites">${escaped(T("s15.websites.manage_link", locale))}</a>`);
  });
});
