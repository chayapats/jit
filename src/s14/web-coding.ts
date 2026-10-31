import { tr, trMaybe } from "../i18n";
import type { WorkView } from "./authority-types";
import type { CodingCheck, CodingCheckResult, CodingRepository, CodingRun } from "./coding-types";
import type { GitConnection } from "./coding-git-types";
import type { Bot } from "./types";
import type { S14Page } from "./web";
import { banner, botName, commandForm, e, effectPill, flat, hidden, k, notice, ownerStrip, pill, short, shell, size, untrusted, when, workPill } from "./web-pages";
import { reach } from "./web-memory";
import { proposalExpiry, registryHosts, type S14CodingHub, type S14CodingNew, type S14CodingRepositoryPage, type S14CodingStart, type S14CodingSurface, type S14GitDraft, type S14WorkCoding } from "./web-product-coding";

/* Coding (CODE14-01, CODE14-02). A repository is a resource, not a project. Results come only from commands Jit really ran, and every string a repository, a command or a model wrote is escaped data in an untrusted frame. Forms post without script; the service rechecks everything shown here. */
const nameOf = (bot: Bot | null, id: string) => e(botName(bot ?? { id, name: id }));
/** Exact literal text with its label. Mono means this is the value itself, not a summary. */
export const exactBlock = (label: string, value: string) => `<div><p class="s-exact-label">${label}</p><pre class="s-exact">${e(value)}</pre></div>`;
const reasonWord = (code: string) => trMaybe(`s14.coding.reason.${code}`) ?? tr("s14.coding.reason.generic");
const reasonLine = (code: string | null) => code ? `<p class="s-sub">${e(reasonWord(code))}</p><p class="s-mono s-meta">${e(code)}</p>` : "";

/** One state word for a registry scope. On is never green: it names a disclosure boundary, not a safeguard. */
const registryPill = (repository: CodingRepository) => repository.registry ? pill(`${tr("s14.coding.registry_on")} · ${repository.registry.hosts.length}`, "warn", "!") : pill(tr("s14.coding.registry_off"));
const repositoryPill = (repository: CodingRepository) => repository.active ? pill(tr("s14.coding.active")) : pill(tr("s14.coding.revoked"));
/** Network facts in one place, so no page implies internet access the seam does not give. */
function networkFacts(repository: CodingRepository): string {
  return `<dt>${tr("s14.coding.network")}</dt><dd>${tr("s14.coding.network_none")}</dd><dt>${tr("s14.coding.registry")}</dt><dd>${repository.registry ? `${repository.registry.hosts.map(host => `<span class="s-mono">${e(host)}</span>`).join(" · ")}<br><span class="s-note">${tr("s14.coding.registry_risk")}</span>` : tr("s14.coding.registry_off_detail")}</dd>`;
}
function repositoryFacts(repository: CodingRepository, bot: Bot | null): string {
  return `<dl class="s-kv"><dt>${tr("s14.coding.url")}</dt><dd class="s-mono">${e(repository.url)}</dd><dt>${tr("s14.coding.base_commit")}</dt><dd class="s-mono">${e(repository.baseCommit)}</dd><dt>${tr("s14.grant.bots")}</dt><dd>${nameOf(bot, repository.botId)}</dd>${networkFacts(repository)}<dt>${tr("s14.coding.revision")}</dt><dd class="s-mono">r${repository.revision}</dd></dl>`;
}
const repositoryRow = (repository: CodingRepository, bot: Bot | null) => `<a class="s-work-row" href="/coding/repositories/${e(repository.id)}"><span><span class="s-mono">${e(repository.url)}</span><small>${nameOf(bot, repository.botId)} · ${tr("s14.coding.base_commit")} ${e(short(repository.baseCommit))}</small></span><span class="s-row-pills">${registryPill(repository)}${repositoryPill(repository)}</span></a>`;
const workOn = (page: S14Page, repositoryId?: string) => page.overview.views.filter(view => view.grant?.tools.includes("coding") && (!repositoryId || view.grant.scopes[0]?.ref.id === repositoryId));
const workRows = (views: WorkView[]) => views.map(view => `<a class="s-work-row" href="/work/${e(view.work.id)}?tab=coding"><span><span>${e(view.work.title)}</span><small>${when(view.work.createdAt)}</small></span><span class="s-row-pills">${workPill(view.work.state)}</span></a>`).join("");

function hubPage(page: S14Page, view: S14CodingHub): string {
  const bot = (repository: CodingRepository) => page.state.bots.find(item => item.id === repository.botId) ?? null, active = view.repositories.filter(item => item.active), ended = view.repositories.filter(item => !item.active), work = workOn(page);
  const section = (id: string, title: string, rows: string) => rows ? `<section aria-labelledby="${id}"><h2 class="s-section-t" id="${id}">${title}</h2>${rows}</section>` : "";
  return shell(page, tr("s14.coding.title"), `<div class="s-col"><p class="s-sub">${tr("s14.coding.lead")}</p><p><a class="s-btn primary" href="/coding/new">${tr("s14.coding.grant")}</a></p>${section("s14-coding-active", tr("s14.coding.active_title"), active.map(item => repositoryRow(item, bot(item))).join(""))}${view.repositories.length ? "" : `<p class="s-sub">${tr("s14.coding.none")}</p>`}${section("s14-coding-work", tr("s14.coding.work_title"), workRows(work))}${section("s14-coding-ended", tr("s14.coding.ended_title"), ended.map(item => repositoryRow(item, bot(item))).join(""))}</div>`, { current: "more" });
}

const registryWarning = () => banner("warn", tr("s14.coding.registry_risk_title"), tr("s14.coding.registry_risk"));
/** Off by default. Each host is its own box, and ticking none is the whole of "off", so there is no master switch to misread. */
function registryChoices(chosen: string[]): string {
  return `<fieldset class="s-field"><legend>${tr("s14.coding.registry_legend")}</legend><p class="s-note">${tr("s14.coding.registry_lead")}</p>${registryHosts.map(host => `<label class="s-check"><input type="checkbox" name="registry:${e(host)}" value="on"${chosen.includes(host) ? " checked" : ""}><span class="s-mono">${e(host)}</span></label>`).join("")}${registryWarning()}</fieldset>`;
}
function receiverChoices(view: S14CodingNew): string {
  const value = (item: S14CodingNew["receivers"][number]) => `${item.bot.id}:${item.scopeId}`;
  const radios = view.receivers.map(item => `<label class="s-choice"><input type="radio" name="receiver" value="${e(value(item))}" required${view.draft?.receiver === value(item) || (!view.draft && view.receivers.length === 1) ? " checked" : ""}><span>${e(botName(item.bot))}</span></label>`).join("");
  const others = view.others.map(({ bot, why }) => `<li><span>${e(botName(bot))}</span><small>${tr(k(`s14.coding.why.${why}`))}</small>${why === "stopping" ? "" : `<a class="s-link-text" href="/team/${e(bot.id)}/capabilities?add=coding&amp;edit=1">${tr("s14.coding.add_tools")}</a>`}</li>`).join("");
  return `<fieldset class="s-field"><legend>${tr("s14.coding.which_bot")}</legend>${radios ? `<div class="s-choices">${radios}</div>` : `<p class="s-note">${tr("s14.coding.no_receiver")}</p>`}${others ? `<ul class="s-coding-others">${others}</ul>` : ""}</fieldset>`;
}
/** The owner's exact selection. Nothing here comes from a repository, a model or a chat, and granting starts nothing. */
function grantPage(page: S14Page, view: S14CodingNew): string {
  const draft = view.draft, ready = view.receivers.length > 0 && view.configured;
  const form = `<form class="s-stack" id="s14-coding-grant" method="post" action="/s14/forms/coding-grant">${flat(page.csrf, 0)}<label class="s-field"><span>${tr("s14.coding.url")}</span><input name="url" required maxlength="300" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://github.com/owner/repository" value="${e(draft?.url ?? "")}"><span class="s-note">${tr("s14.coding.url_note")}</span></label><label class="s-field"><span>${tr("s14.coding.base_input")}</span><input class="s-mono" name="baseCommit" required maxlength="200" autocomplete="off" autocapitalize="off" spellcheck="false" value="${e(draft?.baseCommit ?? "")}"><span class="s-note">${tr("s14.coding.base_note")}</span></label>${receiverChoices(view)}${registryChoices(draft?.hosts ?? [])}</form>`;
  const strip = ready ? ownerStrip(`<button class="s-btn primary" form="s14-coding-grant">${tr("s14.coding.grant")}</button>`, tr("s14.coding.grant_note")) : "";
  const slots = view.configured ? "" : banner("warn", tr("s14.coding.no_slot_title"), tr("s14.coding.no_slot_detail"));
  return shell(page, tr("s14.coding.grant"), `<div class="s-col">${notice(view.notice)}${slots}<article class="s-slip" aria-label="${tr("s14.coding.grant")}"><div class="s-slip-hd"><div><h2 id="slip" tabindex="-1" data-focus-on-load>${tr("s14.coding.grant")}</h2><p class="s-meta">${tr("s14.coding.grant_meta")}</p></div></div><div class="s-slip-body">${form}${reach(["s14.coding.does_1", "s14.coding.does_2", "s14.coding.does_3"], ["s14.coding.not_1", "s14.coding.not_2", "s14.coding.not_3", "s14.coding.not_4"])}</div>${strip}</article><p><a class="s-link-text" href="/coding">${tr("s14.coding.back")}</a></p></div>`, { current: "more" });
}

const password = (label: string, note: string) => `<label class="s-field"><span>${label}</span><input type="password" name="secret" required maxlength="4096" autocomplete="off" autocapitalize="off" spellcheck="false"><span class="s-note">${note}</span></label>`;
const secretForm = (page: S14Page, connection: GitConnection, form: "git-secret" | "git-rotate", label: string, button: string) => `<form class="s-stack s-strip-form" method="post" action="/s14/forms/${form}">${flat(page.csrf, connection.revision)}${hidden("repositoryId", connection.repositoryId)}${hidden("connectionId", connection.id)}${password(label, tr("s14.git.token_note"))}<div><button class="s-btn">${button}</button></div></form>`;
const connectionPill = (connection: GitConnection) => connection.removed ? pill(tr("s14.git.removed")) : connection.secret === "set" ? pill(tr("s14.git.stored"), "strong") : pill(tr("s14.git.empty"), "warn", "!");
/** Metadata and write-only forms. The stored value has no query, so no page can show it, and a form can only replace it. */
function connectionCard(page: S14Page, connection: GitConnection, active: boolean): string {
  const head = `<div class="s-slip-hd"><div><h3>${e(connection.label)}</h3><p class="s-meta s-mono">${e(connection.kind)} · r${connection.revision}</p></div>${connectionPill(connection)}</div>`;
  if (connection.removed || !active) return `<article class="s-slip" data-state="closed" aria-label="${tr("s14.git.connection")}">${head}</article>`;
  const remove = commandForm(page.csrf, "git.connection.remove", connection.revision, { connectionId: connection.id }, tr("s14.git.remove"));
  if (connection.secret === "empty") return `<article class="s-slip" aria-label="${tr("s14.git.connection")}">${head}${ownerStrip(`${secretForm(page, connection, "git-secret", tr("s14.git.token"), tr("s14.git.save_token"))}${remove}`, tr("s14.git.write_only"))}</article>`;
  const rotate = `<details class="s-more"><summary>${tr("s14.git.rotate")}</summary><div>${secretForm(page, connection, "git-rotate", tr("s14.git.new_token"), tr("s14.git.rotate"))}</div></details>`;
  return `<article class="s-slip" data-state="closed" aria-label="${tr("s14.git.connection")}">${head}${ownerStrip(`${commandForm(page.csrf, "git.connection.test", connection.revision, { connectionId: connection.id }, tr("s14.git.check"))}${remove}`, tr("s14.git.change_note"), "", rotate)}</article>`;
}
function landing(view: S14CodingRepositoryPage): string {
  const receipt = view.receipt; if (!receipt) return "";
  const test = "test" in receipt ? receipt.test : undefined;
  if (receipt.kind === "git.connection.test") return test === "present" ? banner("", tr("s14.git.test_present"), tr("s14.git.test_local")) : banner("warn", tr(k(`s14.git.test_${test ?? "missing"}`)), tr("s14.git.test_local"));
  return banner("", tr(k(`s14.coding.done.${receipt.kind.replaceAll(".", "_")}`)), "");
}
function repositoryPage(page: S14Page, view: S14CodingRepositoryPage): string {
  const { repository, bot, connections } = view, active = repository.active, work = workOn(page, repository.id);
  const add = active ? `<form class="s-stack" method="post" action="/s14/forms/git-connection">${flat(page.csrf, 0)}${hidden("repositoryId", repository.id)}<label class="s-field"><span>${tr("s14.git.label")}</span><input name="label" required maxlength="80" value="GitHub"></label><div><button class="s-btn">${tr("s14.git.add")}</button></div></form>` : "";
  const start = active ? `<p><a class="s-btn primary" href="/coding/repositories/${e(repository.id)}/start">${tr("s14.coding.start")}</a></p>` : "";
  const revoke = active ? `<div class="s-slip" data-state="closed">${ownerStrip(commandForm(page.csrf, "coding.repository.revoke", repository.revision, { repositoryId: repository.id }, tr("s14.coding.revoke"), "s-btn danger"), tr("s14.coding.revoke_note"))}</div>` : "";
  return shell(page, tr("s14.coding.repository"), `<div class="s-col">${notice(view.notice)}${landing(view)}${active ? "" : banner("", tr("s14.coding.revoked"), tr("s14.coding.revoked_detail"))}<div class="s-between"><p class="s-mono">${e(repository.url)}</p><span class="s-row-pills">${registryPill(repository)}${repositoryPill(repository)}</span></div>${repositoryFacts(repository, bot)}${start}
    ${work.length ? `<section aria-labelledby="s14-repo-work"><h2 class="s-section-t" id="s14-repo-work">${tr("s14.coding.work_title")}</h2>${workRows(work)}</section>` : ""}
    <section class="s-stack" id="connections" aria-labelledby="s14-repo-git"><h2 class="s-section-t" id="s14-repo-git">${tr("s14.git.connections")}</h2><p class="s-sub">${tr("s14.git.lead")}</p>${connections.map(item => connectionCard(page, item, active)).join("")}${add}</section>${revoke}<p><a class="s-link-text" href="/coding">${tr("s14.coding.back")}</a></p></div>`, { current: "more" });
}

const tick = (name: string, checked: boolean, label: string, note = "") => `<label class="s-check"><input type="checkbox" name="${name}" value="on"${checked ? " checked" : ""}><span>${e(label)}${note ? `<small>${e(note)}</small>` : ""}</span></label>`;
/** One typed start: the same press creates work and its grant, as every other work start does. Commands are owner text, and the model never adds one. */
function startPage(page: S14Page, view: S14CodingStart): string {
  const { repository, bot, conversation, draft } = view, ready = repository.active && !!bot?.enabled && !!conversation, push = bot?.capabilities.tools.includes("effect_push"), stored = view.connections.filter(item => !item.removed && item.secret === "set");
  const number = (name: string, value: number, min: number, max: number, label: string) => `<label class="s-limit"><input type="number" name="${name}" min="${min}" max="${max}" value="${value}" inputmode="numeric"><span>${e(label)}</span></label>`;
  const read = stored.length ? `<fieldset class="s-field"><legend>${tr("s14.coding.read_legend")}</legend><div class="s-choices"><label class="s-choice"><input type="radio" name="connection" value=""${draft.connection ? "" : " checked"}><span>${tr("s14.coding.read_public")}</span></label>${stored.map(item => `<label class="s-choice"><input type="radio" name="connection" value="${e(item.id)}:${item.revision}"${draft.connection === `${item.id}:${item.revision}` ? " checked" : ""}><span>${e(item.label)} <span class="s-mono s-meta">r${item.revision}</span></span></label>`).join("")}</div><p class="s-note">${tr("s14.coding.read_note")}</p></fieldset>` : hidden("connection", "");
  const registry = repository.registry ? `<fieldset class="s-field"><legend>${tr("s14.coding.use_registry")}</legend>${tick("installRegistry", draft.installRegistry, tr("s14.coding.install"))}${tick("testsRegistry", draft.testsRegistry, tr("s14.coding.tests"))}${registryWarning()}</fieldset>` : `<p class="s-note">${tr("s14.coding.no_registry_note")}</p>`;
  const form = `<form class="s-stack" id="s14-coding-start" method="post" action="/s14/forms/coding-start">${flat(page.csrf, conversation?.revision ?? 0)}${hidden("repositoryId", repository.id)}${hidden("repositoryRevision", repository.revision)}${hidden("botRevision", bot?.revision ?? 0)}${hidden("conversationId", conversation?.id ?? "")}
    <label class="s-field"><span>${tr("s14.coding.purpose")}</span><textarea name="purpose" required rows="3" maxlength="16384">${e(draft.purpose)}</textarea></label>
    <label class="s-field"><span>${tr("s14.coding.install")}</span><input class="s-mono" name="install" maxlength="4000" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="bun install --frozen-lockfile" value="${e(draft.install)}"><span class="s-note">${tr("s14.coding.install_note")}</span></label>
    <label class="s-field"><span>${tr("s14.coding.tests")}</span><textarea class="s-mono" name="tests" rows="3" maxlength="8000" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="bun test">${e(draft.tests)}</textarea><span class="s-note">${tr("s14.coding.tests_note")}</span></label>
    ${registry}${read}<fieldset class="s-limits"><legend>${tr("s14.limits.title")}</legend>${number("minutes", draft.minutes, 1, 1440, tr("s14.limits.minutes"))}${number("timeout", draft.timeout, 1, 5, tr("s14.coding.per_command"))}</fieldset><p class="s-note">${tr("s14.coding.time_note")}</p>
    ${push ? `<fieldset class="s-field"><legend>${tr("s14.grant.external")}</legend>${tick("push", draft.push, tr("s14.coding.allow_push"), tr("s14.coding.allow_push_note"))}</fieldset>` : `<p class="s-note">${tr("s14.coding.no_push_note")}</p>`}
    <details class="s-more"><summary>${tr("s14.composer.more")}</summary><div><label class="s-field"><span>${tr("s14.composer.completion")}</span><input name="completion" maxlength="1000" value="${e(draft.completion)}" placeholder="${tr("s14.coding.completion_default")}"></label><label class="s-field"><span>${tr("s14.coding.coverage")}</span><input name="coverage" maxlength="500" value="${e(draft.coverage)}"><span class="s-note">${tr("s14.coding.coverage_note")}</span></label></div></details></form>`;
  const blocked = !conversation ? banner("warn", tr("s14.coding.no_chat"), tr("s14.coding.no_chat_detail")) : !repository.active ? banner("", tr("s14.coding.revoked"), tr("s14.coding.revoked_detail")) : !bot?.enabled ? banner("", tr("s14.coding.bot_closed"), tr("s14.coding.bot_closed_detail")) : "";
  const strip = ready ? ownerStrip(`<button class="s-btn primary" form="s14-coding-start">${tr("s14.coding.start_submit")}</button>`, tr("s14.coding.start_note")) : "";
  return shell(page, tr("s14.coding.start"), `<div class="s-col">${notice(view.notice)}${blocked}${repositoryFacts(repository, bot)}<article class="s-slip" aria-label="${tr("s14.coding.start")}"><div class="s-slip-hd"><div><h2 id="slip" tabindex="-1" data-focus-on-load>${tr("s14.coding.start")}</h2><p class="s-meta">${tr("s14.coding.start_meta")}</p></div></div><div class="s-slip-body">${ready ? form : ""}${reach(["s14.coding.start_does_1", "s14.coding.start_does_2", "s14.coding.start_does_3"], ["s14.coding.not_1", "s14.coding.not_2", "s14.coding.start_not_3"])}</div>${strip}</article><p><a class="s-link-text" href="/coding/repositories/${e(repository.id)}">${tr("s14.coding.back_repository")}</a></p></div>`, { current: "more" });
}

const checkTone: Record<CodingCheckResult["state"], [string, string]> = { passed: ["ok", "✓"], failed: ["danger", "×"], skipped: ["warn", "!"], unknown: ["danger", "?"] };
/** Green needs a recorded exit 0 from a finished run. Any other record reads as unknown, whatever its state field says. */
const realPass = (result: CodingCheckResult) => result.state === "passed" && result.exitCode === 0 && !result.timedOut;
const shownState = (result: CodingCheckResult) => result.state === "passed" && !realPass(result) ? "unknown" : result.state;
const argvText = (command: CodingCheck) => command.argv.map(word => /^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`).join(" ");
const exitWord = (result: CodingCheckResult) => result.timedOut ? tr("s14.coding.timed_out") : result.exitCode === null ? tr("s14.coding.no_exit") : `${tr("s14.coding.exit")} ${result.exitCode}`;
function output(result: CodingCheckResult, open: boolean): string {
  const stream = (label: string, text: string) => text ? untrusted(`<pre class="s-output">${e(text)}</pre>`, label) : "";
  const body = `${stream(tr("s14.coding.stdout"), result.stdout)}${stream(tr("s14.coding.stderr"), result.stderr)}`;
  return body ? `<details class="s-more"${open ? " open" : ""}><summary>${tr("s14.coding.output")}</summary><div>${body}<p class="s-note">${tr("s14.coding.output_note")}</p></div></details>` : `<p class="s-note">${tr("s14.coding.no_output")}</p>`;
}
function checkRow(command: CodingCheck, kind: "install" | "tests", result: CodingCheckResult | null, live: boolean, open: boolean): string {
  const state = result ? shownState(result) : null, head = state ? pill(`${tr(k(`s14.coding.check.${state}`))} · ${exitWord(result!)}`, ...checkTone[state]) : pill(tr(live ? "s14.coding.check.waiting" : "s14.coding.check.not_run"), live ? "" : "warn", live ? "" : "!");
  return `<li class="s-coding-check"><div class="s-between"><span class="s-meta">${tr(k(`s14.coding.${kind}`))}</span>${head}</div><pre class="s-exact">${e(argvText(command))}</pre><p class="s-meta">${tr(k(`s14.coding.net.${command.network}`))} · ${Math.ceil(command.timeoutMs / 60000)} ${tr("s14.time.minutes")}</p>${result?.reason ? `<p class="s-sub">${e(reasonWord(result.reason))}</p>` : ""}<p class="s-meta">${tr("s14.coding.declared")}: ${e(command.coverage)}</p>${result ? output(result, open && state !== "passed") : ""}</li>`;
}
/** Every planned command, in order, joined to what was really recorded. A planned command with no record stays visibly unrun. `open` must be off on a page that refreshes itself, because live reads wait for an open section to close. */
export function checksBlock(coding: S14WorkCoding, live: boolean, open = !live): string {
  const job = coding.view.job, attempt = coding.run?.attemptId, results = coding.view.checks.filter(item => item.attemptId === attempt).map(item => item.result);
  const plan: [CodingCheck, "install" | "tests"][] = job ? [...(job.install ? [[job.install, "install"] as [CodingCheck, "install"]] : []), ...job.tests.map(test => [test, "tests"] as [CodingCheck, "tests"])] : [];
  const rows = plan.map(([command, kind], index) => ({ command, kind, result: results[index] ?? null }));
  const count = (state: CodingCheckResult["state"]) => rows.filter(row => row.result && shownState(row.result) === state).length, unrun = rows.filter(row => !row.result).length;
  const summary = [["passed", count("passed")], ["failed", count("failed")], ["skipped", count("skipped")], ["unknown", count("unknown")]].filter(([, n]) => n).map(([state, n]) => `${n} ${tr(k(`s14.coding.count.${state}`))}`);
  if (unrun) summary.push(`${unrun} ${tr("s14.coding.count.not_run")}`);
  const body = rows.length ? `<ol class="s-coding-checks">${rows.map(row => checkRow(row.command, row.kind, row.result, live, open)).join("")}</ol>` : `<p class="s-sub">${tr("s14.coding.no_checks")}</p>`;
  return `<section class="s-stack" aria-labelledby="s14-coding-checks"><h3 class="s-section-t" id="s14-coding-checks">${tr("s14.coding.checks")}${summary.length ? ` · ${summary.join(" · ")}` : ""}</h3>${body}<p class="s-note">${tr("s14.coding.checks_note")}</p></section>`;
}
const diffLine = (line: string) => `<span class="s-code-line${/^(\+\+\+|---|diff --git|index )/.test(line) ? " meta" : line.startsWith("@@") ? " hunk" : line.startsWith("+") ? " add" : line.startsWith("-") ? " del" : ""}">${e(line) || " "}</span>`;
/** Counts only: a line-level summary of the immutable bytes, never a substitute for them. */
function diffCounts(text: string): string {
  const lines = text.split("\n"), files = lines.filter(line => line.startsWith("diff --git ")).length, added = lines.filter(line => line.startsWith("+") && !line.startsWith("+++")).length, removed = lines.filter(line => line.startsWith("-") && !line.startsWith("---")).length;
  return `${files} ${tr("s14.coding.files")} · +${added} · −${removed}`;
}
/** The whole diff: the service caps it, so nothing is cut here. It is repository text, escaped and plain, and it scrolls inside its own box. */
export function diffBlock(coding: S14WorkCoding): string {
  const heading = `<h3 class="s-section-t" id="s14-coding-diff">${tr("s14.coding.diff")}</h3>`;
  if (coding.mismatch) return `<section class="s-stack" aria-labelledby="s14-coding-diff">${heading}${banner("danger", tr("s14.coding.diff_mismatch"), tr("s14.coding.diff_mismatch_detail"))}</section>`;
  if (!coding.diff) return `<section class="s-stack" aria-labelledby="s14-coding-diff">${heading}<p class="s-sub">${tr(coding.run?.reportId ? "s14.coding.diff_gone" : "s14.coding.diff_none")}</p></section>`;
  const { artifact, text } = coding.diff, lines = text.replace(/\n$/, "").split("\n");
  return `<section class="s-stack" aria-labelledby="s14-coding-diff">${heading}<p class="s-meta">${e(diffCounts(text))} · ${tr("s14.coding.diff_immutable")}</p>${untrusted(`<pre class="s-code" tabindex="0" aria-label="${tr("s14.coding.diff")}">${lines.map(diffLine).join("")}</pre>`, tr("s14.coding.diff_tag"))}<dl class="s-kv"><dt>${tr("s14.effect.hash")}</dt><dd class="s-mono">${e(artifact.sha256)}</dd><dt>${tr("s14.coding.size")}</dt><dd>${artifact.size} B · ${e(size(artifact.size))}</dd></dl><p><a class="s-btn" href="/s14/artifacts/${e(artifact.id)}/download">${tr("s14.coding.download_diff")}</a></p></section>`;
}
function runBanner(coding: S14WorkCoding, view: WorkView): string {
  const { run } = coding, again = coding.repository?.active ? `<p><a class="s-link-text" href="/coding/repositories/${e(coding.repository.id)}/start">${tr("s14.coding.start_again")}</a></p>` : "";
  if (!coding.view.available) return banner("warn", tr("s14.coding.withheld"), tr("s14.coding.withheld_detail"));
  if (!run) return banner("", tr("s14.coding.not_started"), tr(view.work.state === "stopped" ? "s14.coding.not_started_stopped" : "s14.coding.not_started_detail"));
  if (run.state === "running") return banner("", tr("s14.coding.running"), tr("s14.coding.running_detail"));
  if (run.state === "reviewable") return banner("ok", tr("s14.coding.reviewable"), tr("s14.coding.reviewable_detail"));
  if (run.state === "partial") return banner("warn", tr("s14.coding.partial"), tr("s14.coding.partial_detail"), `${reasonLine(run.reason)}${run.reason === "coding_changed_during_tests" ? again : ""}`);
  return banner("warn", tr("s14.coding.interrupted"), tr("s14.coding.interrupted_detail"), `${reasonLine(run.reason)}${again}`);
}
function runFacts(coding: S14WorkCoding, run: CodingRun | null): string {
  const job = coding.view.job, repository = coding.repository;
  const row = (label: string, value: string | null, empty = tr("s14.coding.not_recorded")) => `<dt>${label}</dt><dd${value ? ' class="s-mono"' : ""}>${value ? e(value) : empty}</dd>`;
  return `<dl class="s-kv">${row(tr("s14.coding.url"), repository?.url ?? null)}${row(tr("s14.coding.branch"), job?.branch ?? null)}${row(tr("s14.coding.worktree"), job?.path ?? null)}${row(tr("s14.coding.base_commit"), run?.baseCommit ?? job?.repository.baseCommit ?? null)}${row(tr("s14.coding.head_commit"), run?.headCommit ?? null)}${row(tr("s14.coding.diff_hash"), run?.diffHash ?? null)}</dl>`;
}
const blockText = (block: NonNullable<S14WorkCoding["block"]>) => tr(k(`s14.git.block.${block}`));
/** Prepares a card and approves nothing. Everything typed here is shown again as exact content before any decision. */
function pushForm(page: S14Page, view: WorkView, coding: S14WorkCoding): string {
  const run = coding.run!, job = coding.view.job, draft: S14GitDraft | null = coding.draft, connections = coding.connections.filter(item => !item.removed && item.secret === "set"), base = coding.repository?.baseCommit ?? "";
  const radio = (value: string, label: string, checked: boolean) => `<label class="s-choice"><input type="radio" name="connection" value="${e(value)}" required${checked ? " checked" : ""}><span>${label}</span></label>`;
  const text = (name: string, label: string, value: string, note = "") => `<label class="s-field"><span>${label}</span><input class="s-mono" name="${name}" maxlength="120" autocomplete="off" autocapitalize="off" spellcheck="false" value="${e(value)}">${note ? `<span class="s-note">${note}</span>` : ""}</label>`;
  const pr = `<div class="s-stack s-git-pr">${text("base", tr("s14.git.pr_base"), draft?.base ?? "main")}${text("baseCommit", tr("s14.git.pr_base_commit"), draft?.baseCommit ?? base, tr("s14.git.pr_base_note"))}<label class="s-field"><span>${tr("s14.git.pr_title")}</span><input name="title" maxlength="200" value="${e(draft?.title ?? view.work.title)}"></label><label class="s-field"><span>${tr("s14.git.pr_body")}</span><textarea name="body" rows="4" maxlength="12000">${e(draft?.body ?? "")}</textarea></label>${tick("draft", draft?.draft ?? true, tr("s14.git.pr_draft"))}</div>`;
  return `<form class="s-stack s-card s-git-form" method="post" action="/s14/forms/git-propose">${flat(page.csrf, 0)}${hidden("workId", view.work.id)}${hidden("attemptId", run.attemptId)}${hidden("newCommit", run.headCommit!)}${hidden("expiresAt", proposalExpiry(page.now, view.grant!.expiresAt))}<fieldset class="s-field"><legend>${tr("s14.git.connection")}</legend><div class="s-choices">${connections.map(item => radio(`${item.id}:${item.revision}`, `${e(item.label)} <span class="s-mono s-meta">r${item.revision}</span>`, draft ? draft.connection === `${item.id}:${item.revision}` : connections.length === 1)).join("")}</div></fieldset>${text("branch", tr("s14.git.branch"), draft?.branch ?? job?.branch ?? "", tr("s14.git.branch_note"))}${text("oldCommit", tr("s14.git.old_commit"), draft?.oldCommit ?? "", tr("s14.git.old_commit_note"))}${tick("pr", draft?.pr ?? false, tr("s14.git.pr_open"))}${pr}<div><button class="s-btn">${tr("s14.git.prepare")}</button></div><p class="s-note">${tr("s14.git.prepare_note")}</p></form>`;
}
function gitSection(page: S14Page, view: WorkView, coding: S14WorkCoding): string {
  const rows = coding.effects.map(effect => `<a class="s-work-row" href="/effects/${e(effect.id)}#slip"><span><span>${tr("s14.git.card")} · r${effect.revision}</span><small class="s-mono">${e(effect.actionHash.slice(0, 16))}</small></span><span class="s-row-pills">${effectPill(effect.state)}</span></a>`).join("");
  const none = !rows && (coding.block === "no_grant" || coding.block === "no_evidence") && !coding.run ? "" : coding.block === "no_connection" && coding.repository ? `<p class="s-note">${blockText("no_connection")} <a class="s-link-text" href="/coding/repositories/${e(coding.repository.id)}#connections">${tr("s14.git.add")}</a></p>` : coding.block ? `<p class="s-note">${blockText(coding.block)}</p>` : pushForm(page, view, coding);
  return `<section class="s-stack" aria-labelledby="s14-coding-git"><h3 class="s-section-t" id="s14-coding-git">${tr("s14.git.title")}</h3><p class="s-note">${tr("s14.git.no_merge")}</p>${rows}${none}</section>`;
}
/** The Coding tab of one work. Its result words read only from the run and the checks, never from model text. */
export function codingTab(page: S14Page, view: WorkView, coding: S14WorkCoding | null): string {
  if (!coding) return banner("", tr("s14.coding.not_started"), tr("s14.coding.not_started_detail"));
  const live = ["queued", "running"].includes(view.work.state) || coding.run?.state === "running", phase = coding.run ? tr(k(`s14.coding.run.${coding.run.state}`)) : tr("s14.coding.not_started");
  const files = coding.checksFile ? `<p><a class="s-link-text" href="/s14/artifacts/${e(coding.checksFile.id)}/download">${tr("s14.coding.download_checks")}</a></p>` : "";
  return `<span hidden data-phase="${e(phase)}"></span>${notice(coding.notice)}${runBanner(coding, view)}<p class="s-note">${tr("s14.coding.evidence_rule")}</p>${runFacts(coding, coding.run)}${coding.view.available ? `${checksBlock(coding, live)}${files}${diffBlock(coding)}` : ""}${gitSection(page, view, coding)}`;
}

/** Renders the repository surfaces. Every value from a query is escaped here. */
export function renderCodingSurface(page: S14Page, view: S14CodingSurface): string {
  switch (view.kind) {
    case "coding": return hubPage(page, view);
    case "coding-new": return grantPage(page, view);
    case "coding-repository": return repositoryPage(page, view);
    default: return startPage(page, view);
  }
}
