import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { actionFacts, computerBrowserObservation, dispatchBrowserTarget, humanBrowserRow, inspectBrowserTarget, type BrowserInput } from "../src/s16/computers/browser-actions";

let browser: Browser;
beforeAll(async () => {
  if (process.env.JIT_S16_BROWSER_TESTS === "1") browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--disable-background-networking", "--no-first-run"] });
});
afterAll(async () => { await browser?.close(); });
const nativeTest = test.skipIf(process.env.JIT_S16_BROWSER_TESTS !== "1");

async function nativePage(html: string): Promise<Page> {
  const page = await browser.newPage();
  // Fulfill a secure origin locally so production randomUUID works without any network or polyfill.
  await page.route("**/*", route => route.request().url() === "https://fixture.jit.test/continue"
    ? route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html>" }) : route.abort());
  await page.goto("https://fixture.jit.test/continue");
  await page.setContent(`<form id="pay"><input name="pay_now" value="20"><input type="password" value="not-observed"></form><form id="neutral"><input name="notes"></form><form id="encdel"><input name="delete_account"></form>${html}`);
  await page.evaluate(() => {
    const state = window as unknown as { submissions: string[]; edits: number };
    state.submissions = []; state.edits = 0;
    document.addEventListener("submit", event => { event.preventDefault(); state.submissions.push((event.target as HTMLFormElement).id); });
    document.addEventListener("input", () => { state.edits++; });
  });
  return page;
}

async function target(page: Page, kind: "field" | "child", op: BrowserInput) {
  const observation = await page.evaluate(computerBrowserObservation) as { elements: { ref: string; tag: string; name: string }[] };
  const ref = observation.elements.find(e => kind === "field" ? e.name === "Quantity" : e.tag === "span")!.ref;
  const facts = actionFacts(await page.evaluate(inspectBrowserTarget(ref)));
  return { row: humanBrowserRow(op, facts), dispatch: () => page.evaluate(dispatchBrowserTarget(ref, facts.revision, op)) };
}
const enter: BrowserInput = { kind: "type", generation: 1, target: "unused", value: "30\n" };
const click: BrowserInput = { kind: "click", generation: 1, target: "unused" };

for (const [owner, fieldOwner, tag, row] of [["neutral", "pay", "input", null], ["pay", "encdel", "input", "a"], ["missing", "pay", "textarea", null]] as const) {
  nativeTest(`native Enter refuses ${fieldOwner} field inside ${owner} button without input or submission`, async () => {
    const page = await nativePage(`<button type="${owner === "missing" ? "button" : "submit"}" form="${owner}">Continue<${tag} aria-label="Quantity" form="${fieldOwner}">${tag === "textarea" ? "old</textarea>" : ""}</button>`);
    try {
      const action = await target(page, "field", enter); expect(action.row).toBe(row);
      expect(await action.dispatch()).toMatchObject({ code: "computer_browser_target_invalid" });
      expect(await page.evaluate("({submissions,edits})")).toEqual({ submissions: [], edits: 0 });
    } finally { await page.close(); }
  });
}

for (const reassociate of [false, true]) nativeTest(`native Enter submits the reviewed owner with reassociation=${reassociate}`, async () => {
  const page = await nativePage('<button type="submit" form="neutral">Continue<input aria-label="Quantity" form="neutral"></button>');
  try {
    if (reassociate) await page.evaluate(() => document.querySelector("[aria-label=Quantity]")!.addEventListener("keydown", event => (event.target as HTMLInputElement).setAttribute("form", "encdel")));
    const action = await target(page, "field", enter); expect(action.row).toBeNull(); expect(await action.dispatch()).toEqual({ state: "sent" });
    expect(await page.evaluate("submissions")).toEqual(["neutral"]);
  } finally { await page.close(); }
});

for (const state of ["false", "true"]) for (const type of ["button", "reset", "submit"]) for (const owner of ["missing", "neutral"]) {
  nativeTest(`native ${type}/${owner} with ${state} label child refuses another submitter`, async () => {
    const page = await nativePage(`<button id="pay-button" type="submit" form="pay">Pay</button><button type="${type}" form="${owner}">Continue<label for="pay-button"><span contenteditable="${state}">!</span></label></button>`);
    try {
      const action = await target(page, "child", click); expect(action.row).toBeNull();
      expect(await action.dispatch()).toEqual({ code: "computer_browser_target_invalid" });
      expect(await page.evaluate("submissions")).toEqual([]);
    } finally { await page.close(); }
  });
}

nativeTest("native external label forwards while a link inside the external label remains independent", async () => {
  for (const link of [false, true]) {
    const page = await nativePage(`<button id="pay-button" type="submit" form="pay">Pay</button><label for="pay-button">${link ? '<a href="#continue">' : ""}<span contenteditable="false">!</span>${link ? "</a>" : ""}</label>`);
    try {
      const action = await target(page, "child", click); expect(action.row).toBe(link ? null : "a");
      expect(await action.dispatch()).toEqual({ state: "sent" }); expect(await page.evaluate("submissions")).toEqual(link ? [] : ["pay"]);
    } finally { await page.close(); }
  }
});
