import { chromium, type Page } from "playwright-core";
import type { Locale } from "../../i18n";
import { en } from "../../i18n/en";
import { th } from "../../i18n/th";
import { desktopService } from "./boundary";
import { desktopBrowser, desktopIgnoredDefaults } from "./launcher";

const escape = (text: string) => text.replace(/[&<>"']/g, value => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[value]!);
/** A credential-free local choice surface. Its one binding is never installed in an authenticated browser context. */
export interface DesktopConnectionWindow { page: Page; choice: Promise<string>; close(): Promise<void> }

/**
 * Opens an ephemeral, network-denied local connect window. The callback accepts only a bounded canonical service
 * origin from this exact main frame. Destroy this whole browser before opening any protected service profile.
 */
export async function openDesktopConnection(options: { browser: string; locale: Locale; initialService?: string; headless?: boolean }): Promise<DesktopConnectionWindow> {
  const copy = options.locale === "en" ? en : th, initial = options.initialService ? desktopService(options.initialService) : "";
  const browser = await chromium.launch({ executablePath: desktopBrowser(options.browser), chromiumSandbox: true, headless: options.headless ?? false, ignoreDefaultArgs: [...desktopIgnoredDefaults] });
  try {
    const context = await browser.newContext({ viewport: { width: 760, height: 620 }, locale: options.locale === "en" ? "en-US" : "th-TH" });
    await context.route("**/*", route => route.abort("blockedbyclient"));
    const page = await context.newPage(), selected = Promise.withResolvers<string>(); void selected.promise.catch(() => {});
    let chosen = false;
    await page.exposeBinding("jitDesktopConnect", (source, value: unknown) => {
      if (chosen || source.page !== page || source.frame !== page.mainFrame() || page.url() !== "about:blank" || typeof value !== "string") return { ok: false };
      try { const origin = desktopService(value); chosen = true; selected.resolve(origin); return { ok: true }; }
      catch { return { ok: false }; }
    });
    page.once("close", () => { if (!chosen) selected.reject(new Error("desktop_connection_closed")); });
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const html = `<!doctype html><html lang="${options.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; connect-src 'none'"><title>Jit</title><style nonce="${nonce}">:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#101116;color:#f3f2ef}body{margin:0;padding:32px;box-sizing:border-box;min-height:100vh;display:grid;place-items:center}main{max-width:480px;width:100%}h1{font-size:32px;letter-spacing:-1px;margin:0 0 32px}h2{font-size:24px;margin:0 0 12px}p{line-height:1.6;color:#b9bbc6}label{display:block;margin:24px 0 8px}input,button{font:inherit;border-radius:10px;padding:12px;box-sizing:border-box}input{width:100%;color:inherit;background:#181920;border:1px solid #555763}button{margin-top:20px;background:#eeeae0;color:#171820;border:0;cursor:pointer}button:disabled{opacity:.5}small{display:block;margin-top:24px;color:#b9bbc6;line-height:1.6}#error{min-height:24px;color:#ffb6a8}input:focus-visible,button:focus-visible{outline:3px solid #9daeff;outline-offset:3px}</style></head><body><main><h1>Jit</h1><h2>${escape(copy["s16.desktop.connectTitle"])}</h2><p>${escape(copy["s16.desktop.connectLead"])}</p><form><label for="service">${escape(copy["s16.desktop.address"])}</label><input id="service" name="service" type="url" required autocomplete="url" inputmode="url" spellcheck="false" placeholder="https://" value="${escape(initial)}" aria-describedby="error"><p id="error" role="alert"></p><button type="submit">${escape(copy["s16.desktop.connect"])}</button></form><small>${escape(copy["s16.desktop.connectPrivacy"])}</small></main><script nonce="${nonce}">const form=document.querySelector('form'),input=document.querySelector('input'),button=document.querySelector('button'),error=document.querySelector('#error');form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;error.textContent='';try{const result=await window.jitDesktopConnect(input.value.trim());if(!result.ok){error.textContent=${JSON.stringify(copy["s16.desktop.addressInvalid"])};button.disabled=false;input.focus()}}catch{error.textContent=${JSON.stringify(copy["s16.desktop.failed"])};button.disabled=false}});input.focus();</script></body></html>`;
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    return { page, choice: selected.promise, close: () => browser.close() };
  } catch { await browser.close(); throw new Error("desktop_connection_unavailable"); }
}
