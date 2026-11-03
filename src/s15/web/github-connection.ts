import { currentLocale, tr } from "../../i18n";
import { ownerStrip } from "../../s14/web-pages";
import { banner, e, fill, form, hidden, notYet, pill, refusal } from "./render";
import type { S15GithubConnectionView } from "./types";

/**
 * GIT15-04 Resources → GitHub. The owner pastes one fine-grained token (write-only: the field is never pre-filled and
 * the token is never shown again), Jit verifies it read-only and lists what it can reach, and the owner picks the
 * repositories Jit may work on. Publication stays on the product default; the personal exception lives on `/rules`.
 */
export interface S15GithubConnectionPage { csrf: string; view: S15GithubConnectionView | null; refused: string | null; saved: "connected" | "selected" | "removed" | null; now: number }

const day = (value: number) => `<time datetime="${new Date(value).toISOString()}">${e(new Intl.DateTimeFormat(currentLocale() === "en" ? "en-GB" : "th-TH", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value)))}</time>`;
/** Exactly the permissions the owner steps list; nothing broader is asked for. */
const permissions = ["contents", "issues", "pulls", "checks", "statuses", "administration", "metadata"] as const;

function tokenForm(csrf: string, replacing: boolean): string {
  const steps = `<ol class="s15-list"><li>${tr("s15.ghc.step.open")} <a class="s-link-text" href="https://github.com/settings/personal-access-tokens/new" rel="noopener noreferrer" target="_blank">github.com/settings/personal-access-tokens/new</a></li>
    <li>${tr("s15.ghc.step.repositories")}</li><li>${tr("s15.ghc.step.permissions")}<ul class="s15-facts s15-ghc-perms">${permissions.map(p => `<li><b>${tr(`s15.ghc.perm.${p}` as Parameters<typeof tr>[0])}</b></li>`).join("")}</ul></li><li>${tr("s15.ghc.step.expiry")}</li><li>${tr("s15.ghc.step.paste")}</li></ol>`;
  const field = form("/s15/forms/github-connection/connect", csrf, `<label class="s-field"><span>${tr("s15.ghc.token")}</span><input type="password" name="token" autocomplete="off" autocapitalize="off" spellcheck="false" required maxlength="300" aria-describedby="s15-ghc-token-note"></label>
    <p class="s-note" id="s15-ghc-token-note">${tr("s15.ghc.token_note")}</p><div class="s-row"><button class="s-btn primary">${tr(replacing ? "s15.ghc.replace" : "s15.ghc.connect")}</button></div>`, ' class="s-stack"');
  return `${steps}${field}`;
}

/** Whole page body. */
export function githubConnectionBody(page: S15GithubConnectionPage): string {
  const v = page.view;
  if (!v) return `<div class="s-col">${notYet("s15.ghc.not_composed")}</div>`;
  const saved = page.saved ? `<div role="status">${banner("ok", tr(`s15.ghc.saved.${page.saved}` as Parameters<typeof tr>[0]), page.saved === "selected" ? `<a class="s-link-text" href="/rules#s15-policy-review">${tr("s15.ghc.saved.selected_next")}</a>` : "")}</div>` : "";
  const intro = `<p class="s-sub">${tr("s15.ghc.lead")}</p><p class="s-note">${tr("s15.ghc.custody")}</p>`;
  if (v.state !== "connected") {
    const was = v.state === "removed" ? `<p class="s-row">${pill(tr("s15.ghc.state.removed"))}</p>` : "";
    return `<div class="s-col">${saved}${refusal(page.refused)}<section class="s-card" id="s15-ghc" aria-labelledby="s15-ghc-t"><h2 id="s15-ghc-t">${tr("s15.ghc.title")}</h2>${was}${intro}${tokenForm(page.csrf, false)}</section></div>`;
  }
  const expiry = v.tokenExpiresAt === null ? tr("s15.ghc.no_expiry") : `${tr("s15.ghc.expires")} ${day(v.tokenExpiresAt)}`;
  const soon = v.tokenExpiresAt !== null && v.tokenExpiresAt - page.now < 14 * 86_400_000;
  const status = `<p class="s-row">${pill(fill("s15.ghc.connected_as", { login: v.login ?? "" }), "ok", "✓")}</p><p class="s-sub">${expiry}${v.verifiedAt ? ` · ${tr("s15.ghc.verified")} ${day(v.verifiedAt)}` : ""}</p>
    ${soon ? `<div role="status">${banner("warn", tr(v.tokenExpiresAt! <= page.now ? "s15.ghc.expired" : "s15.ghc.expires_soon"), tr("s15.ghc.replace_lead"))}</div>` : ""}`;
  const choices = v.accessible.length ? `<fieldset class="s-stack"><legend>${tr("s15.ghc.pick_legend")}</legend>${v.accessible.map((repo, index) => `<label class="s-check"><input type="checkbox" name="repo_${index}" value="${e(repo.name)}"${v.selected.includes(repo.name) ? " checked" : ""}><span><b class="s-mono s15-break">${e(repo.name)}</b><small>${tr(repo.private ? "s15.ghc.private" : "s15.ghc.public")} · ${tr("s15.ghc.default_branch")} <span class="s-mono">${e(repo.target)}</span> · ${tr(repo.push ? "s15.ghc.can_push" : "s15.ghc.read_only")}</small></span></label>`).join("")}</fieldset>` : `<p class="s-sub">${tr("s15.ghc.no_access")}</p>`;
  const picker = `<section class="s-card" id="s15-ghc-repos" aria-labelledby="s15-ghc-repos-t"><h2 id="s15-ghc-repos-t">${tr("s15.ghc.repos_title")}</h2><p class="s-sub">${tr("s15.ghc.repos_lead")}</p>
    ${form("/s15/forms/github-connection/select", page.csrf, `${hidden("revision", v.revision)}${choices}${v.truncated ? `<p class="s-note">${tr("s15.ghc.truncated")}</p>` : ""}<p class="s-note">${tr("s15.ghc.unselected_note")}</p>${v.accessible.length ? `<div class="s-row"><button class="s-btn primary">${tr("s15.ghc.use_selected")}</button></div>` : ""}`, ' class="s-stack"')}
    <p class="s-note">${tr("s15.ghc.default_profile")} <a class="s-link-text" href="/rules#s15-rules-github">${tr("s15.ghc.personal_link")}</a></p></section>`;
  const replace = `<details class="s15-ghc-replace"><summary>${tr("s15.ghc.replace_title")}</summary><p class="s-sub">${tr("s15.ghc.replace_lead")}</p>${tokenForm(page.csrf, true)}</details>`;
  const remove = ownerStrip(form("/s15/forms/github-connection/remove", page.csrf, `${hidden("revision", v.revision)}<button class="s-btn">${tr("s15.ghc.remove")}</button>`, ' class="s15-strip-form"'), tr("s15.ghc.remove_note"));
  return `<div class="s-col">${saved}${refusal(page.refused)}<section class="s-card" id="s15-ghc" aria-labelledby="s15-ghc-t"><h2 id="s15-ghc-t">${tr("s15.ghc.title")}</h2>${status}${intro}${replace}</section>${picker}<section class="s-card" aria-labelledby="s15-ghc-remove-t"><h2 id="s15-ghc-remove-t">${tr("s15.ghc.remove_title")}</h2>${remove}</section></div>`;
}
