import { tr } from "../../i18n";
import { banner, clock, codeText, e, fill, form, notYet, pill, refusal } from "./render";
import type { S15TelegramStatus } from "./types";

/** Saved notices after a Telegram settings post; anything else shows nothing. */
export type S15TelegramSaved = "token" | "removed" | "revoked" | "cancelled" | "gap";
const savedKeys: Record<S15TelegramSaved, Parameters<typeof tr>[0]> = { token: "s15.telegram.saved.token", removed: "s15.telegram.saved.removed", revoked: "s15.telegram.saved.revoked", cancelled: "s15.telegram.saved.cancelled", gap: "s15.telegram.saved.gap" };
export const telegramSaved = (value: string | null): S15TelegramSaved | null => value && Object.hasOwn(savedKeys, value) ? value as S15TelegramSaved : null;

const grouped = (code: string) => code.replace(/(.{4})(?=.)/g, "$1-");
/** Write-only token field. The page never renders a stored or refused token back. */
const tokenForm = (csrf: string, label: string, button: string) => form("/s15/forms/telegram/token", csrf, `<label class="s-field"><span>${tr("s15.telegram.token_label")}</span><input name="token" type="password" required maxlength="128" autocomplete="off" spellcheck="false" autocapitalize="off" inputmode="text" aria-describedby="s15-tg-token-note" placeholder="${tr("s15.telegram.token_placeholder")}"></label>
  <p class="s-note" id="s15-tg-token-note">${tr("s15.telegram.token_note")}</p><div class="s-row"><button class="s-btn primary" aria-label="${e(label)}">${button}</button></div>`);

/**
 * `/resources/telegram` (CHAN15-01): one bot token, one bound owner account, and how messages flow. Every
 * control is an authenticated no-script form post; the page holds no authority and offers no approve control.
 * Telegram only notifies and links back here for held actions (S15 UX Q4).
 */
export function telegramBody(input: { status: S15TelegramStatus | null; csrf: string; refused: string | null; saved: S15TelegramSaved | null; now: number }): string {
  const lead = `<p class="s-sub">${tr("s15.telegram.lead")}</p><p class="s-note">${tr("s15.telegram.approvals_web_only")}</p>`;
  if (!input.status) return `<div class="s-col">${lead}${notYet("s15.telegram.not_composed")}</div>`;
  const s = input.status, csrf = input.csrf, bot = s.token === "present" ? s.bot : null;
  const done = input.saved ? `<div role="status">${banner("ok", input.saved === "token" && bot ? fill("s15.telegram.saved.token_bot", { bot: `@${bot.username}` }) : tr(savedKeys[input.saved]))}</div>` : "";

  // 1. Bot token: write-only, verified with Telegram before it is stored.
  const botBody = bot
    ? `<dl class="s-kv"><dt>${tr("s15.telegram.bot")}</dt><dd><b>@${e(bot.username)}</b> ${pill(tr("s15.telegram.bot_active"), "ok", "✓")}</dd></dl>
      <details class="s-more"><summary>${tr("s15.telegram.replace")}</summary><div>${tokenForm(csrf, tr("s15.telegram.replace"), tr("s15.telegram.replace_submit"))}</div></details>
      ${form("/s15/forms/telegram/remove", csrf, `<div class="s-row"><button class="s-btn" aria-describedby="s15-tg-remove-note">${tr("s15.telegram.remove")}</button></div><p class="s-note" id="s15-tg-remove-note">${tr("s15.telegram.remove_note")}</p>`)}`
    : `${s.token === "unsafe" ? `<div role="alert">${banner("warn", tr("s15.telegram.token_unsafe"), tr("s15.telegram.token_unsafe_detail"))}</div>` : ""}
      <ol class="s15-steps"><li>${tr("s15.telegram.step_botfather")}</li><li>${tr("s15.telegram.step_paste")}</li></ol>${tokenForm(csrf, tr("s15.telegram.save"), tr("s15.telegram.save"))}`;

  // 2. Owner binding: a one-time code sent from the owner's own private chat binds the numeric IDs.
  const b = s.binding, start = (label: string) => form("/s15/forms/telegram/bind", csrf, `<div class="s-row"><button class="s-btn primary">${label}</button></div>`);
  const cancel = form("/s15/forms/telegram/cancel", csrf, `<button class="s-btn">${tr("s15.telegram.code_cancel")}</button>`);
  const bindingBody = !bot ? `<p class="s-sub">${tr("s15.telegram.binding_needs_bot")}</p>`
    : b.state === "unbound" ? `<p>${tr("s15.telegram.binding_lead")}</p>${start(tr("s15.telegram.binding_start"))}`
    : b.state === "pending" && b.expired ? `<div role="alert">${banner("warn", tr("s15.telegram.code_expired"), tr("s15.telegram.code_expired_detail"))}</div><div class="s-row">${start(tr("s15.telegram.code_new"))}${cancel}</div>`
    : b.state === "pending" ? `<p>${fill("s15.telegram.code_send", { bot: `@${bot.username}` })}</p>
      <p class="s-mono s15-tg-code" aria-label="${tr("s15.telegram.code_label")}">${e(grouped(b.code))}</p>
      <p class="s-meta">${tr("s15.telegram.code_valid_until")} ${clock(b.expiresAt)} · ${tr("s15.telegram.code_once")}</p>
      <div class="s-row"><a class="s-btn primary" href="https://t.me/${e(bot.username)}?start=${e(b.code)}" rel="noopener noreferrer">${fill("s15.telegram.code_open", { bot: `@${bot.username}` })}</a><a class="s-btn" href="/resources/telegram#s15-tg-binding">${tr("s15.telegram.code_reload")}</a>${cancel}</div>
      <p class="s-note">${tr("s15.telegram.code_note")}</p>`
    : `${b.current ? `<div role="status">${banner("ok", tr("s15.telegram.bound"))}</div>` : `<div role="alert">${banner("warn", tr("s15.telegram.bound_stale"), tr("s15.telegram.bound_stale_detail"))}</div>${start(tr("s15.telegram.binding_start"))}`}
      <dl class="s-kv"><dt>${tr("s15.telegram.account")}</dt><dd>${b.username ? `@${e(b.username)}` : tr("s15.telegram.no_username")}</dd><dt>${tr("s15.telegram.user_id")}</dt><dd class="s-mono">${e(b.userId)}</dd><dt>${tr("s15.telegram.bound_at")}</dt><dd>${clock(b.boundAt)}</dd></dl>
      <p class="s-note">${tr("s15.telegram.username_display_only")}</p>
      ${form("/s15/forms/telegram/revoke", csrf, `<div class="s-row"><button class="s-btn" aria-describedby="s15-tg-revoke-note">${tr("s15.telegram.revoke")}</button></div><p class="s-note" id="s15-tg-revoke-note">${tr("s15.telegram.revoke_note")}</p>`)}`;

  // 3. Message flow: last poll, the visible retention gap, refusals and deliveries whose outcome is unknown.
  const p = s.poll;
  const flow = p.state === "off" ? `<p class="s-sub">${tr("s15.telegram.poll_off")}</p>`
    : p.state === "starting" ? `<p>${pill(tr("s15.telegram.poll_starting"), "", "")}</p>`
    : p.state === "trouble" ? `<div role="alert">${banner("warn", tr("s15.telegram.poll_trouble"), codeText(p.code), `<p class="s-mono s-meta">${e(p.code ?? "")}</p>`)}</div>${p.lastPollAt ? `<p class="s-meta">${tr("s15.telegram.poll_last")} ${clock(p.lastPollAt)}</p>` : ""}`
    : `<p>${pill(tr("s15.telegram.poll_receiving"), "ok", "✓")} <span class="s-meta">${tr("s15.telegram.poll_last")} ${p.lastPollAt ? clock(p.lastPollAt) : ""}</span></p>`;
  const gap = p.gap ? `<div role="alert">${banner("warn", tr("s15.telegram.gap"), "", `<p>${tr("s15.telegram.gap_detail")} ${tr("s15.telegram.gap_since")} ${clock(p.gap.since)}</p>${form("/s15/forms/telegram/gap", csrf, `<button class="s-btn">${tr("s15.telegram.gap_ack")}</button>`)}`)}</div>` : "";
  const counts = [s.counts.refused ? fill("s15.telegram.count_refused", { n: s.counts.refused }) : "", s.counts.unknown ? fill("s15.telegram.count_unknown", { n: s.counts.unknown }) : "", s.counts.queued ? fill("s15.telegram.count_queued", { n: s.counts.queued }) : ""].filter(Boolean);
  const flowBody = `${gap}${flow}${counts.length ? `<ul class="s15-list">${counts.map(line => `<li>${line}</li>`).join("")}</ul>` : ""}`;

  const sends = (["s15.telegram.sends.reply", "s15.telegram.sends.progress", "s15.telegram.sends.stall", "s15.telegram.sends.held"] as const).map(name => `<li>${tr(name)}</li>`).join("");
  const card = (id: string, title: string, body: string) => `<section class="s-card" id="${id}" aria-labelledby="${id}-title"><h2 id="${id}-title">${title}</h2>${body}</section>`;
  return `<div class="s-col s15-telegram">${lead}${done}${refusal(input.refused)}
    ${card("s15-tg-bot", tr("s15.telegram.bot_title"), botBody)}
    ${card("s15-tg-binding", tr("s15.telegram.binding_title"), bindingBody)}
    ${card("s15-tg-flow", tr("s15.telegram.flow_title"), `${flowBody}<h3 class="s-section-t">${tr("s15.telegram.sends_title")}</h3><ul class="s15-list">${sends}</ul><p class="s-note">${tr("s15.telegram.text_only")}</p>`)}</div>`;
}
