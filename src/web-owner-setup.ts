import { tr } from "./i18n";
import { documentPage, escape } from "./web-document";

/** Password creation form for an already validated installer capability; the token is never rendered. */
export function ownerSetupPage(csrf: string): string {
  return documentPage(tr("owner_setup.title"), `<main id="main-content"><section class="login-card"><h1>${tr("owner_setup.title")}</h1>
    <p>${tr("owner_setup.note")}</p><form method="post" action="/owner/setup">
    <input type="hidden" name="csrf" value="${escape(csrf)}">
    <label>${tr("owner_setup.password")}<input name="password" type="password" minlength="12" maxlength="256" required autocomplete="new-password"></label>
    <label>${tr("owner_setup.confirm")}<input name="confirm" type="password" minlength="12" maxlength="256" required autocomplete="new-password"></label>
    <button class="primary">${tr("owner_setup.submit")}</button></form></section></main>`);
}
