import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { firstRunFixture } from "./fixtures/s15-first-run";
import { githubSkillFixture } from "./fixtures/s16-skills";
import { en } from "../src/i18n/en";
import { th } from "../src/i18n/th";

const browserTest = process.env.JIT_S16_BROWSER_TESTS === "1" ? test : test.skip;
let browser: Browser;
beforeAll(async () => { if (process.env.JIT_S16_BROWSER_TESTS === "1") browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true }); });
afterAll(async () => { await browser?.close(); }, 30000);

browserTest.each([1440, 390])("actual Skills UI: GitHub receipt recovery, preview/review/use, folder update and revoke at width %i", async width => {
  const f = await firstRunFixture(o => ({ ...o, skills: {}, connections: { vault: o.githubWeb!.vault } }));
  const fixtures = githubSkillFixture(new Map([["SKILL.md", "---\nname: browser-notes\ndescription: Use the fixture notes.\nlicense: MIT\n---\nThe test command is bun test.\n"], ["LICENSE", "MIT License\nSelf-authored browser fixture.\n"], ["hooks/hooks.json", '{"start":"touch /protected/must-not-run"}']]));
  f.service.skills!.options.network.request = fixtures.network.request;
  const setup = await f.page("/setup", "en"), hash = (name: string) => new RegExp(`name="${name}" value="([a-f0-9]{64})"`).exec(setup.html)?.[1];
  await f.form("/s15/forms/rules/install", { proposalHash: hash("proposalHash")!, ...(hash("listHash") ? { listHash: hash("listHash")! } : {}), return: "setup" });
  const copy = width === 1440 ? en : th, language = width === 1440 ? "en" : "th";
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: width === 1440 ? "en-US" : "th-TH" }), page = await context.newPage();
  const errors: string[] = [], external: string[] = [], posts: string[] = []; let lose = true, authorized = true;
  page.on("pageerror", error => errors.push(error.message));
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()); if (url.origin !== f.config.origin) { external.push(request.url()); await route.abort(); return; }
    const body = request.method() === "POST" ? request.postDataJSON() : undefined;
    if (request.method() === "POST" && url.pathname.endsWith("/skills/commands")) posts.push(body.kind);
    const response = await f.request(url.pathname + url.search, request.method(), body, { "accept-language": language, ...(!authorized ? { cookie: "jit_s14=withdrawn" } : {}) });
    if (request.method() === "POST" && url.pathname.endsWith("/messages") && response.status === 202) await f.service.drain();
    if (lose && body?.kind === "skill.import") { lose = false; await route.abort("failed"); return; }
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const directory = mkdtempSync(join(tmpdir(), "jit-browser-skill-"));
  try {
    await page.goto(f.config.origin + "/s16/connections"); await page.getByRole("tab", { name: copy["s16.connections.tabApps"], exact: true }).focus(); await page.keyboard.press("End");
    expect(await page.getByRole("tab", { name: copy["s16.skills.title"], exact: true }).evaluate(element => document.activeElement === element)).toBe(true);
    await page.getByLabel(copy["s16.skills.url"], { exact: true }).fill("https://github.com/owner/repo"); await page.getByRole("button", { name: copy["s16.skills.inspect"], exact: true }).click();
    await page.getByText(copy["s16.skills.unknown"], { exact: true }).waitFor(); expect(posts).toEqual(["skill.import"]); const recoveryHash = new URL(page.url()).hash; expect(recoveryHash).toMatch(/^#skill-command=/);
    // Reload preserves only the original identity, never the upload body or an automatic retry.
    await page.reload(); await page.getByRole("button", { name: copy["s16.skills.checkStatus"], exact: true }).click(); await page.getByRole("heading", { name: "browser-notes", exact: true }).last().waitFor();
    expect(posts).toEqual(["skill.import"]); expect(f.service.skills!.records()).toHaveLength(1);
    const detail = page.locator(".skill-detail"); expect(await detail.locator("h3").evaluate(element => document.activeElement === element)).toBe(true);
    await detail.getByRole("button", { name: "LICENSE", exact: true }).click(); await detail.locator("pre").filter({ hasText: "Self-authored browser fixture." }).waitFor();
    await detail.getByText(copy["s16.skills.unsupported"].replace("{count}", "1"), { exact: true }).click(); expect(await detail.textContent()).toContain("automatic_hooks_unsupported");
    await detail.getByLabel(copy["s16.skills.computer"], { exact: true }).check(); await detail.getByRole("button", { name: copy["s16.skills.confirm"], exact: true }).click();
    await page.getByText(copy["s16.skills.active"], { exact: true }).waitFor(); const active = f.service.skills!.records()[0]!, oldPin = active.activePin!;
    // Actual bundled chat reads the reviewed instruction and displays owning-service pin provenance.
    f.interpretation = { intent: "execute", purposeId: "owner_requested_work", resourceIds: ["computer", active.resource.id], access: "reversible_write", subject: null };
    const unitId = f.service.skills!.package(oldPin).units[0]!.id;
    f.script = [{ type: "tool_call", id: "load", name: "skill_load", arguments: { skillId: active.id, unitId, offset: 0 } }];
    await page.goto(f.config.origin + "/s16/chat/first"); await page.getByRole("textbox", { name: copy["s16.chat.prompt"], exact: true }).fill("Use the reviewed notes."); await page.getByRole("button", { name: copy["s16.chat.send"], exact: true }).click();
    await page.getByText(copy["s16.skills.used"].replace("{count}", "1"), { exact: true }).waitFor(); expect(f.prompts.some(prompt => prompt.includes("The test command is bun test."))).toBe(true);
    await page.goto(f.config.origin + "/s16/connections"); await page.getByRole("tab", { name: copy["s16.skills.title"], exact: true }).click(); await page.getByRole("button", { name: copy["s16.skills.open"], exact: true }).click();
    await detail.getByRole("button", { name: copy["s16.skills.update"], exact: true }).click(); await page.getByLabel(copy["s16.skills.folder"], { exact: true }).check();
    writeFileSync(join(directory, "SKILL.md"), "---\nname: browser-notes\ndescription: Updated fixture notes.\n---\nThe test command is bun test --timeout 30000.\n"); writeFileSync(join(directory, "LICENSE"), "MIT License\nSelf-authored updated fixture.\n");
    await page.getByLabel(copy["s16.skills.chooseFolder"], { exact: true }).setInputFiles(directory); await page.getByRole("button", { name: copy["s16.skills.inspect"], exact: true }).click();
    await page.getByText(copy["s16.skills.candidate"], { exact: true }).waitFor(); expect(f.service.skills!.records()[0]!.activePin).toBe(oldPin); expect(f.service.skills!.records()[0]!.candidatePin).not.toBe(oldPin);
    await detail.getByRole("button", { name: copy["s16.skills.confirm"], exact: true }).click(); await page.waitForFunction(() => !document.querySelector(".skills .notice")?.textContent?.includes("…"));
    await detail.getByRole("button", { name: copy["s16.skills.revoke"], exact: true }).click(); const confirmation = detail.getByRole("alertdialog");
    await confirmation.getByRole("button", { name: copy["s16.skills.revoke"], exact: true }).click(); await page.getByText(copy["s16.skills.revoked"], { exact: true }).waitFor(); expect(f.service.skills!.records()[0]!.state).toBe("revoked");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    authorized = false; await detail.getByRole("button", { name: "LICENSE", exact: true }).click(); await page.getByText(copy["s16.common.authenticationRequired"], { exact: true }).waitFor();
    expect(await page.locator(".skill-detail").count()).toBe(0); expect(await page.locator("body").textContent()).not.toContain("Self-authored"); expect(external).toEqual([]); expect(errors).toEqual([]);
  } finally { await context.close(); await f.close(); rmSync(directory, { recursive: true, force: true }); }
}, 60000);
