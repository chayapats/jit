import { tr } from "../i18n";
import type { WorkView } from "./authority-types";
import type { WorkStep } from "./graph-types";
import type { Artifact, EvidenceRequirement, Report, ReportClaim, ReportGap, ReportReview, ReportView } from "./report-types";
import { banner, botName, commandForm, e, k, ownerStrip, pill, untrusted, when } from "./web-pages";
import { briefGapRow } from "./web-personal-brief";
import { fileShare } from "./web-sharing";
import type { S14Page } from "./web";
import type { S14WorkResearch } from "./web-product-memory";
import type { S14ReportHint, S14WorkTeam } from "./web-product-team";

/* Report page (REPORT14-01, F8). Review state, coverage, missing evidence and owner review are four separate facts; accepting one never moves another. Every string a model or source wrote is escaped data inside an untrusted frame. */
type Flag = ReportClaim["flags"][number];
const flagTone: Record<Flag, [string, string]> = { inference: ["", ""], snippet: ["warn", "!"], excerpt: ["warn", "!"], cached_reported: ["warn", "!"], freshness_unknown: ["", "?"], conflicting: ["warn", "!"], unsupported: ["danger", "×"] };
const flagPill = (flag: Flag) => pill(tr(k(`s14.report.flag.${flag}`)), ...flagTone[flag]);
const coverageWord = (coverage: Report["coverage"]) => tr(k(`s14.report.coverage.${coverage}`));
const coveragePill = (coverage: Report["coverage"]) => coverage === "partial" ? pill(coverageWord(coverage), "warn", "!") : pill(coverageWord(coverage), "strong");
const reportId = (item: ReportView) => item.state === "available" ? item.report.id : item.id;
const revisionOf = (item: ReportView) => item.state === "available" ? item.report.revision : item.revision;
const typeWord = (file: Artifact) => tr(k(`s14.report.type.${file.mediaType === "text/markdown" ? "markdown" : file.mediaType === "text/plain" ? "text" : "json"}`));
const targetsOf = (view: WorkView): EvidenceRequirement[] => view.grant?.command.payload.requiredEvidence ?? [];

/** Short report line for a card or list: the revision and its coverage, never a completion word. */
export const reportHintPill = (hint: S14ReportHint | undefined) => hint ? `${pill(`${tr("s14.tab.report")} r${hint.revision}`)}${hint.coverage === "partial" ? coveragePill("partial") : ""}` : "";

const acceptedPill = (revision: number) => pill(`${tr("s14.report.review.accepted")} r${revision}`, "strong", "✓");
/** Owner review reads the live review target only: an earlier revision can never be accepted, so it never asks for that. */
function reviewFact(report: Report, review: ReportReview | null): string {
  if (review?.reportId !== report.id) return pill(tr("s14.report.review.latest_only"));
  return review.acceptance ? acceptedPill(report.revision) : `${pill(tr("s14.report.completion.owner_review_required"), "warn", "!")}<a class="s-link-text" href="#s14-review">${tr("s14.report.review.jump")}</a>`;
}
/** Service gaps and Bot-reported gaps are counted apart, so a Bot's sentence never inflates a recorded fact. */
function missingFact(report: Report): string {
  const service = report.missing.length, bot = report.modelMissing.length;
  if (!service && !bot) return pill(tr("s14.report.missing_none"));
  return `${service ? pill(`${service} ${tr("s14.report.missing_count")}`, "warn", "!") : ""}${bot ? pill(`${bot} ${tr("s14.report.missing_from_bot")}`) : ""}`;
}
function facts(report: Report, review: ReportReview | null): string {
  const row = (label: string, value: string) => `<div><dt>${tr(k(label))}</dt><dd>${value}</dd></div>`;
  return `<dl class="s-facts" aria-label="${tr("s14.report.facts")}">${row("s14.report.fact_state", pill(tr(k(`s14.report.state.${report.state}`)), "ok", "✓"))}${row("s14.report.fact_coverage", coveragePill(report.coverage))}${row("s14.report.fact_missing", missingFact(report))}${row("s14.report.fact_review", reviewFact(report, review))}</dl><p class="s-note">${tr(report.coverage === "partial" ? "s14.report.note_partial" : "s14.report.note_covered")}</p>`;
}
function revisions(reports: ReportView[], selected: ReportView, href: (id: string) => string): string {
  const latest = reports.at(-1), row = (item: ReportView) => {
    const current = reportId(item) === reportId(selected), label = `r${revisionOf(item)}`;
    const detail = item.state === "available" ? `${when(item.report.createdAt)} ${coveragePill(item.report.coverage)}` : pill(tr("s14.report.withdrawn_short"));
    return `<li><a href="${href(reportId(item))}"${current ? ' aria-current="page"' : ""}><b>${label}</b>${item === latest ? `<small>${tr("s14.report.latest")}</small>` : ""}<span class="s-grow"></span><span class="s-rev-meta">${detail}</span></a></li>`;
  };
  return `<section class="s-stack" aria-labelledby="s14-revisions"><h3 class="s-section-t" id="s14-revisions">${tr("s14.report.revisions")}</h3><ol class="s-revs">${reports.toReversed().map(row).join("")}</ol><p class="s-note">${tr("s14.report.revisions_note")}</p></section>`;
}
const claimAnchor = (id: string) => `#claim-${encodeURIComponent(id)}`;
/** Only typed service gaps produce service wording; model gaps always stay in the untrusted frame. */
function missingRow(item: ReportGap, view: WorkView, steps: WorkStep[], evidenceHref: string, nameOf: (step: WorkStep) => string): string {
  const stepName = (id: string) => { const step = steps.find(s => s.id === id); return step ? e(nameOf(step)) : e(id); };
  switch (item.kind) {
    case "required_evidence": return `<li>${tr("s14.report.miss.target")} <b>${e(targetsOf(view).find(t => t.id === item.targetId)?.label ?? item.targetId)}</b></li>`;
    case "completion_rule_not_machine_verified": return `<li>${tr("s14.report.miss.rule")}</li>`;
    case "unsupported_claim": case "conflicting_claim": return `<li><a class="s-link-text" href="${claimAnchor(item.claimId)}">${tr(item.kind === "unsupported_claim" ? "s14.report.miss.unsupported" : "s14.report.miss.conflict")}</a></li>`;
    case "step": return `<li>${tr("s14.report.miss.step")} ${stepName(item.stepId)} · ${tr(k(`s14.step_state.${item.state}`))}</li>`;
    case "handoff": return `<li>${tr("s14.report.miss.gap")} ${stepName(item.stepId)} <span class="s-mono">${e(item.reason)}</span></li>`;
    case "read": if (item.personal) return briefGapRow(item.personal.scopeId, item.personal.stale, item.personal.missing, evidenceHref.replace("tab=evidence", "tab=brief"));
      return `<li><a class="s-link-text" href="${evidenceHref}">${tr("s14.report.miss.read")}</a> · ${tr(k(`s14.web_outcome.${item.outcome}`))}</li>`;
    case "missing_url": return `<li>${tr("s14.report.miss.url")} <span class="s-mono">${e(item.url)}</span></li>`;
    case "failed_url": return `<li>${tr("s14.report.miss.failed")} <span class="s-mono">${e(item.url)}</span> · <span class="s-mono">${e(item.failureKind)}</span></li>`;
  }
}
/** Bounded source checks, missing evidence and limitations precede claims; target prose is not machine-verified. */
function coverageBlock(report: Report, view: WorkView, team: S14WorkTeam, evidenceHref: string, nameOf: (step: WorkStep) => string): string {
  const targets = targetsOf(view), steps = team.graph?.steps ?? [], other = report.modelMissing;
  const typed = report.missing.map(item => missingRow(item, view, steps, evidenceHref, nameOf));
  const covered = report.covered.map(id => { const target = targets.find(t => t.id === id); return `<li>${target ? e(target.label) : `<span class="s-mono">${e(id)}</span>`}</li>`; }).join("");
  const bot = (items: string[], label: string) => untrusted(`<ul class="s-reach-list">${items.map(item => `<li>${e(item)}</li>`).join("")}</ul>`, label);
  const missing = typed.length || other.length ? `<div class="s-stack"><p class="s-exact-label">${tr("s14.report.missing")}</p>${typed.length ? `<p class="s-note">${tr("s14.report.missing_service")}</p><ul class="s-reach-list">${typed.join("")}</ul>` : ""}${other.length ? bot(other, tr("s14.report.missing_bot")) : ""}</div>` : `<p class="s-sub">${tr("s14.report.nothing_listed")}</p>`;
  return `<section class="s-card s-stack" aria-labelledby="s14-coverage"><h3 id="s14-coverage">${tr("s14.report.coverage_title")}</h3>${covered ? `<div><p class="s-exact-label">${tr("s14.report.covered")}</p><p class="s-note">${tr("s14.report.covered_scope")}</p><ul class="s-reach-list">${covered}</ul></div>` : ""}${missing}${report.limitations.length ? `<div class="s-stack"><p class="s-exact-label">${tr("s14.report.limitations")}</p>${bot(report.limitations, tr("s14.report.untrusted"))}</div>` : ""}</section>`;
}
/** One exact citation. The URL is literal text, never a link: only the row in Evidence is one click away. */
function citationRow(claim: ReportClaim, index: number, numbers: Map<string, number>, base: string): string {
  const citation = claim.citations[index]!, source = claim.evidence[index], number = numbers.get(citation.id) ?? 0;
  const personal = source?.tool === "personal_read", head = personal ? `<p>${tr(k(`s14.brief.kind.${source.kind}`))}</p>` : source ? `<p class="s-mono">${e(source.url)}</p>` : "";
  const url = source ? `${head}<p class="s-meta">${tr(k(`s14.report.scope.${citation.scope}`))} · ${tr(k(`s14.coverage.${source.coverage}`))}${personal ? "" : ` · ${tr(k(`s14.freshness.${source.freshness}`))}`} · ${tr("s14.evidence.received")} ${when(source.retrievedAt)}</p>` : `<p class="s-sub">${tr("s14.report.source_gone")}</p>`;
  return `<li><a class="s-cite" href="${personal ? base.replace("tab=evidence", "tab=brief") : base}#source-${e(citation.id)}" aria-label="${tr("s14.report.open_source")} ${number}">${number}</a><div class="s-stack">${url}<details class="s-more"><summary>${tr("s14.report.show_quote")}</summary><div>${untrusted(`<p>${e(citation.quote)}</p>`, tr("s14.untrusted.source"))}</div></details></div></li>`;
}
function claimCard(claim: ReportClaim, index: number, report: Report, targets: EvidenceRequirement[], numbers: Map<string, number>, evidenceBase: string): string {
  const kind = pill(tr(k(`s14.report.kind.${claim.kind}`))), support = claim.support === "supported" ? pill(tr("s14.report.supported"), "strong") : "";
  const flags = claim.flags.filter(flag => flag !== "inference" || claim.kind !== "inference").map(flagPill).join("");
  const conflicts = claim.conflicts.flatMap(id => { const other = report.claims.find(item => item.id === id); return other ? [`<div class="s-stack"><p class="s-exact-label"><a class="s-link-text" href="${claimAnchor(id)}">${tr("s14.report.conflicts_with")} ${report.claims.indexOf(other) + 1}</a></p>${untrusted(`<p>${e(other.text)}</p>`, tr("s14.report.untrusted"))}</div>`] : []; }).join("");
  const covers = claim.covers.flatMap(id => { const target = targets.find(t => t.id === id); return target ? [target.label] : []; }), declaredTargets = covers.length ? `<p class="s-meta">${tr("s14.report.covers")} ${covers.map(e).join(" · ")}</p>` : "";
  const cites = claim.citations.length ? `<ol class="s-cites">${claim.citations.map((_, i) => citationRow(claim, i, numbers, evidenceBase)).join("")}</ol>` : `<p class="s-sub">${tr("s14.report.no_citation")}</p>`;
  return `<article class="s-claim" id="claim-${encodeURIComponent(claim.id)}" aria-label="${tr("s14.report.claim")} ${index + 1}"><div class="s-mem-hd"><span class="s-source-n" aria-hidden="true">${index + 1}</span>${kind}${support}${flags}</div>${untrusted(`<p>${e(claim.text)}</p>`, tr("s14.report.untrusted"))}${conflicts}${declaredTargets}${cites}</article>`;
}
function filesBlock(files: Artifact[]): string {
  const row = (file: Artifact) => `<li class="s-file"><div class="s-stack"><p class="s-mono">${e(file.name)}</p><dl class="s-kv"><dt>${tr("s14.report.file_type")}</dt><dd>${e(typeWord(file))} · <span class="s-mono">${e(file.mediaType)}</span></dd><dt>${tr("s14.report.file_size")}</dt><dd>${file.size} ${tr("s14.report.bytes")}</dd><dt>SHA-256</dt><dd class="s-mono">${e(file.sha256)}</dd><dt>${tr("s14.report.file_made")}</dt><dd>${when(file.createdAt)}</dd></dl></div><a class="s-btn" href="/s14/artifacts/${e(file.id)}/download" download="${e(file.name)}" aria-label="${tr("s14.report.download")} ${e(file.name)}">${tr("s14.report.download")}</a>${fileShare(file)}</li>`;
  return `<section class="s-stack" aria-labelledby="s14-files"><h3 class="s-section-t" id="s14-files">${tr("s14.report.files")}</h3>${files.length ? `<ul class="s-files">${files.map(row).join("")}</ul><p class="s-note">${tr("s14.report.files_note")}</p>` : `<p class="s-sub">${tr("s14.report.no_files")}</p>`}</section>`;
}
/** Owner review of the live target, after the gaps and claims. The control names the revision and, when partial, that it stays partial. */
function reviewBlock(page: S14Page, report: Report, review: ReportReview): string {
  const section = (body: string, strip = "") => `<section class="s-slip s-review" data-state="closed" id="s14-review" aria-labelledby="s14-review-t"><div class="s-slip-hd"><div class="s-stack"><h3 id="s14-review-t">${tr("s14.report.fact_review")}</h3>${body}</div></div>${strip}</section>`;
  if (review.acceptance) return section(`<div class="s-row">${acceptedPill(report.revision)}${coveragePill(report.coverage)}</div><p class="s-meta">${tr("s14.report.review.accepted_at")} ${when(review.acceptance.acceptedAt)}</p><p class="s-note">${tr("s14.report.review.clears")}</p>`);
  const partial = report.coverage === "partial", gaps = report.missing.length + report.modelMissing.length;
  const label = `${tr("s14.report.review.accept")} r${report.revision}${partial ? ` ${tr("s14.report.review.as_partial")}` : ""}`;
  return section(partial ? `<p class="s-sub">${tr("s14.report.review.stays_partial")} ${gaps} ${tr("s14.report.missing_count")}</p>` : `<p class="s-sub">${tr("s14.report.note_covered")}</p>`,
    ownerStrip(commandForm(page.csrf, "report.review.accept", review.revision, { reportId: report.id, reportRevision: report.revision }, label, partial ? "s-btn" : "s-btn primary"), tr("s14.report.review.accept_note")));
}
/** Report tab: the selected revision with its gaps first, then claims, files, owner review and every earlier revision. */
export function reportTab(page: S14Page, view: WorkView, team: S14WorkTeam, research: S14WorkResearch | null, base: string): string {
  const sep = base.includes("?") ? "&amp;" : "?", { reports, selected } = team, href = (id: string) => `${base}${sep}tab=report&amp;report=${e(id)}`;
  if (!selected) {
    const live = ["queued", "running", "waiting"].includes(view.work.state);
    return banner("", tr("s14.report.none"), tr(live ? "s14.report.none_live" : "s14.report.none_detail"));
  }
  const history = revisions(reports, selected, href), older = selected !== reports.at(-1) ? banner("", `${tr("s14.report.older")} r${revisionOf(selected)}`, tr("s14.report.older_detail"), `<p><a class="s-link-text" href="${href(reportId(reports.at(-1)!))}">${tr("s14.report.open_latest")} r${revisionOf(reports.at(-1)!)}</a></p>`) : "";
  if (selected.state === "unavailable") return `${older}${banner("warn", `${tr("s14.report.withdrawn")} r${selected.revision}`, `${tr("s14.report.withdrawn_detail")}. ${tr("s14.report.review.withdrawn")}`)}${history}`;
  const { report, artifacts } = selected, numbers = new Map<string, number>(), steps = team.graph?.steps ?? [], targets = targetsOf(view);
  for (const claim of report.claims) for (const citation of claim.citations) if (!numbers.has(citation.id)) numbers.set(citation.id, numbers.size + 1);
  const evidenceBase = `${base}${sep}tab=evidence`, nameOf = (step: WorkStep) => { const bot = page.state.bots.find(item => item.id === step.botId) ?? { id: step.botId, name: step.botId }; return `${botName(bot)} · ${tr(k(`s14.step_handler.${step.handler}`))}`; };
  const authors = report.botIds.map(id => botName(page.state.bots.find(bot => bot.id === id) ?? { id, name: id })), review = team.review;
  return `${older}<div class="s-stack"><div class="s-between"><h3 class="s-report-t">${tr("s14.tab.report")} r${report.revision}</h3><span class="s-meta">${when(report.createdAt)}</span></div>${untrusted(`<p><b>${e(report.title)}</b></p>`, tr("s14.report.untrusted"))}<p class="s-meta">${tr("s14.report.by")} ${authors.map(e).join(" · ")}</p>${facts(report, review)}</div>
    ${coverageBlock(report, view, team, evidenceBase, nameOf)}<section class="s-stack" aria-labelledby="s14-claims"><h3 class="s-section-t" id="s14-claims">${tr("s14.report.claims")} ${report.claims.length}</h3>${report.claims.map((claim, i) => claimCard(claim, i, report, targets, numbers, evidenceBase)).join("")}</section>${filesBlock(artifacts)}${review?.reportId === report.id ? reviewBlock(page, report, review) : ""}${history}`;
}
