import { AppError } from "../errors";
import { tr } from "../i18n";
import type { S14Application } from "./application";
import type { Work } from "./authority-types";
import type { Artifact, ReportCatalog, ReportView } from "./report-types";
import type { OwnerActor } from "./types";
import type { S14Page } from "./web";
import { botName, e, k, pill, shell, when } from "./web-pages";

/** Read-only catalog and provenance; unavailable entries never carry report or file payloads. */
export interface S14Library { kind: "library"; catalog: ReportCatalog; works: Record<string, Pick<Work, "id" | "title" | "conversationId">>; tab: "reports" | "artifacts"; before: number | null; limit: number }

/** Parses a bounded catalog request behind normal owner authentication; no command is issued. */
export function libraryView(app: S14Application, actor: OwnerActor, url: URL): S14Library {
  const number = (name: string, fallback: number | null) => {
    const values = url.searchParams.getAll(name);
    if (!values.length) return fallback;
    if (values.length !== 1 || !/^[1-9][0-9]*$/.test(values[0]!)) throw new AppError("invalid_number");
    return Number(values[0]);
  };
  const tab = url.searchParams.get("tab") ?? "reports";
  if (tab !== "reports" && tab !== "artifacts") throw new AppError("not_found", 404);
  const before = number("before", null), limit = number("limit", 20)!;
  const catalog = app.reports.catalog(actor, { before, limit });
  const ids = [...new Set(catalog.items.flatMap(item => item.state === "available" ? [item.report.workId] : []))];
  const works = app.store.read(tx => {
    app.requireOwner(tx, actor);
    if (!ids.length) return {};
    // Provenance needs three work fields, never attempts, effects or potentially large result histories.
    const rows = tx.all<Pick<Work, "id" | "title" | "conversationId">>(`SELECT id,json_extract(record_json,'$.title') AS title,json_extract(record_json,'$.conversationId') AS conversationId FROM work_items WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
    if (rows.length !== ids.length) throw new AppError("not_found", 404);
    return Object.fromEntries(rows.map(row => [row.id, row]));
  });
  return { kind: "library", catalog, works, tab, before, limit };
}

/** An immutable file link always goes through the existing authenticated download gateway. */
export function outputFile(file: Artifact): string {
  return `<li class="s-file"><div><p>${e(file.name)}</p><p class="s-meta">${e(file.mediaType)} · ${file.size} ${tr("s14.report.bytes")} · ${when(file.createdAt)}</p><p class="s-mono s-meta">SHA-256 ${e(file.sha256)}</p></div><a class="s-btn" href="/s14/artifacts/${e(file.id)}/download" download="${e(file.name)}">${tr("s14.report.download")}</a></li>`;
}

/** Coverage, review and exact report revision remain separate facts in list and inline presentations. */
export function outputFacts(view: Extract<ReportView, { state: "available" }>, href: string): string {
  const { report } = view;
  const completion = view.completion === "owner_accepted" ? `${tr("s14.report.review.accepted")} r${report.revision}` : tr("s14.report.completion.owner_review_required");
  return `<p class="s-row"><a class="s-link-text" href="${href}">${e(report.title)} · r${report.revision}</a>${pill(tr("s14.report.state.ready_for_review"))}${pill(tr(k(`s14.report.coverage.${report.coverage}`)), report.coverage === "partial" ? "warn" : "")}${pill(completion, view.completion === "owner_accepted" ? "ok" : "")}</p>`;
}

/** Cross-work output rows retain existing exact-revision detail links and safe withdrawn identities. */
export function libraryPage(page: S14Page, view: S14Library): string {
  const tabs = (["reports", "artifacts"] as const).map(tab => `<a href="/library?tab=${tab}"${view.tab === tab ? ' aria-current="page"' : ""}>${tr(k(`s14.library.${tab}`))}</a>`).join("");
  const items = view.catalog.items.map(item => {
    if (item.state === "unavailable") return `<article class="s-card s-stack"><p>${tr("s14.report.withdrawn")} r${item.revision}</p><p class="s-mono s-meta">${e(item.id)}</p><p>${tr("s14.report.withdrawn_detail")}</p><a class="s-link-text" href="/work/${e(item.workId)}?tab=report&amp;report=${e(item.id)}">${tr("s14.effect.back_to_work")}</a></article>`;
    const work = view.works[item.report.workId]!, bots = item.report.botIds.map(id => botName(page.state.bots.find(bot => bot.id === id) ?? { id, name: id })).join(" · "), href = `/chats/${e(work.conversationId)}?work=${e(work.id)}&amp;tab=report&amp;report=${e(item.report.id)}`;
    return `<article class="s-card s-stack">${outputFacts(item, href)}<p class="s-meta">${e(bots)} · <a class="s-link-text" href="/work/${e(work.id)}">${e(work.title)}</a> · ${when(item.report.createdAt)}</p>${view.tab === "artifacts" ? `<ul class="s-files">${item.artifacts.map(outputFile).join("")}</ul>` : `<p class="s-meta">${item.report.claims.length} ${tr("s14.library.claims")} · ${item.artifacts.length} ${tr("s14.library.artifacts")}</p>`}</article>`;
  }).join("");
  const next = view.catalog.nextBefore ? `<a class="s-btn" href="/library?tab=${view.tab}&amp;limit=${view.limit}&amp;before=${view.catalog.nextBefore}">${tr("s14.library.next")}</a>` : "";
  return shell(page, tr("s14.library.title"), `<div class="s-col"><p class="s-sub">${tr("s14.library.intro")}</p><nav class="s-worktabs" aria-label="${tr("s14.library.title")}">${tabs}</nav>${items || `<p>${tr("s14.library.empty")}</p>`}<nav class="s-row" aria-label="${tr("s14.library.pages")}">${view.before ? `<a class="s-btn" href="/library?tab=${view.tab}">${tr("s14.library.first")}</a>` : ""}${next}</nav><p><a class="s-link-text" href="/memory">${tr("s14.more.memory")}</a> · <a class="s-link-text" href="/shares">${tr("s14.more.shares")}</a></p></div>`, { current: "more" });
}
