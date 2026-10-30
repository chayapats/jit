import { tr } from "../i18n";
import type { WorkView } from "./authority-types";
import type { WorkStep } from "./graph-types";
import type { ExternalEvidence, WebRead } from "./parallel-types";
import type { Artifact, EvidenceRequirement, Report, ReportClaim, ReportView } from "./report-types";
import { banner, botName, e, k, pill, untrusted, when } from "./web-pages";
import type { S14Page } from "./web";
import type { S14WorkResearch } from "./web-product-memory";
import type { S14ReportHint, S14WorkTeam } from "./web-product-team";

/* Report page (REPORT14-01, F8). Review state, coverage, missing evidence and owner review are four separate facts. Every string a model or source wrote is escaped data inside an untrusted frame. */
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

function facts(report: Report, missing: number): string {
  const row = (label: string, value: string) => `<div><dt>${tr(k(label))}</dt><dd>${value}</dd></div>`;
  return `<dl class="s-facts" aria-label="${tr("s14.report.facts")}">${row("s14.report.fact_state", pill(tr(k(`s14.report.state.${report.state}`)), "ok", "✓"))}${row("s14.report.fact_coverage", coveragePill(report.coverage))}${row("s14.report.fact_missing", missing ? pill(`${missing} ${tr("s14.report.missing_count")}`, "warn", "!") : pill(tr("s14.report.missing_none")))}${row("s14.report.fact_review", pill(tr(k(`s14.report.completion.${report.completion}`)), "warn", "!"))}</dl><p class="s-note">${tr(report.coverage === "partial" ? "s14.report.note_partial" : "s14.report.note_covered")}</p>`;
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
/** Rebuilds a stored gap into words only when typed data corroborates it; a look-alike stays visible as Bot text. */
function missingRow(item: string, report: Report, view: WorkView, steps: WorkStep[], reads: WebRead[], evidenceHref: string, nameOf: (step: WorkStep) => string): string | null {
  const after = (prefix: string) => item.startsWith(prefix) ? item.slice(prefix.length) : null, targets = targetsOf(view);
  const target = after("required_evidence:"), found = target === null ? undefined : targets.find(t => t.id === target);
  if (found) return `<li>${tr("s14.report.miss.target")} <b>${e(found.label)}</b></li>`;
  if (item === "completion_rule_not_machine_verified" && !targets.length) return `<li>${tr("s14.report.miss.rule")}</li>`;
  for (const [prefix, key] of [["unsupported_claim:", "s14.report.miss.unsupported"], ["conflicting_claim:", "s14.report.miss.conflict"]] as const) {
    const id = after(prefix); if (id !== null && report.claims.some(claim => claim.id === id)) return `<li><a class="s-link-text" href="${claimAnchor(id)}">${tr(key)}</a></li>`;
  }
  const lane = /^step:(.+):([a-z_]+)$/.exec(item), step = lane ? steps.find(s => s.id === lane[1]) : undefined;
  if (lane && step) return `<li>${tr("s14.report.miss.step")} ${e(nameOf(step))} · ${tr(k(`s14.step_state.${lane[2] as WorkStep["state"]}`))}</li>`;
  const gap = /^(.+): ([a-z_]+)$/.exec(item), gapStep = gap ? steps.find(s => s.id === gap[1]) : undefined;
  if (gap && gapStep) return `<li>${tr("s14.report.miss.gap")} ${e(nameOf(gapStep))} <span class="s-mono">${e(gap[2]!)}</span></li>`;
  const read = /^read:([^:]+):([a-z_]+)$/.exec(item), known = read ? reads.find(r => r.id === read[1]) : undefined;
  if (read && known) return `<li><a class="s-link-text" href="${evidenceHref}">${tr("s14.report.miss.read")}</a> · ${tr(k(`s14.web_outcome.${known.outcome}`))}</li>`;
  const url = after("missing_url:");
  if (url !== null && reads.some(r => r.missing.includes(url))) return `<li>${tr("s14.report.miss.url")} <span class="s-mono">${e(url)}</span></li>`;
  const failed = after("failed_url:"), failure = failed === null ? undefined : reads.flatMap(r => r.failures).find(f => failed === `${f.url}:${f.kind}`);
  if (failure) return `<li>${tr("s14.report.miss.failed")} <span class="s-mono">${e(failure.url)}</span> · <span class="s-mono">${e(failure.kind)}</span></li>`;
  return null;
}
/** Covered, missing and limitations sit before any claim, so a reader cannot reach the claims without passing them. */
function coverageBlock(report: Report, view: WorkView, team: S14WorkTeam, research: S14WorkResearch | null, evidenceHref: string, nameOf: (step: WorkStep) => string): string {
  const typed: string[] = [], other: string[] = [], targets = targetsOf(view), steps = team.graph?.steps ?? [];
  for (const item of report.missing) { const row = missingRow(item, report, view, steps, research?.reads ?? [], evidenceHref, nameOf); if (row) typed.push(row); else other.push(item); }
  const covered = report.covered.map(id => { const target = targets.find(t => t.id === id); return `<li>${target ? e(target.label) : `<span class="s-mono">${e(id)}</span>`}</li>`; }).join("");
  const bot = (items: string[]) => untrusted(`<ul class="s-reach-list">${items.map(item => `<li>${e(item)}</li>`).join("")}</ul>`, tr("s14.report.untrusted"));
  const missing = typed.length || other.length ? `<div class="s-stack"><p class="s-exact-label">${tr("s14.report.missing")}</p>${typed.length ? `<ul class="s-reach-list">${typed.join("")}</ul>` : ""}${other.length ? bot(other) : ""}</div>` : `<p class="s-sub">${tr("s14.report.nothing_listed")}</p>`;
  return `<section class="s-card s-stack" aria-labelledby="s14-coverage"><h3 id="s14-coverage">${tr("s14.report.coverage_title")}</h3>${covered ? `<div><p class="s-exact-label">${tr("s14.report.covered")}</p><ul class="s-reach-list">${covered}</ul></div>` : ""}${missing}${report.limitations.length ? `<div class="s-stack"><p class="s-exact-label">${tr("s14.report.limitations")}</p>${bot(report.limitations)}</div>` : ""}</section>`;
}
/** One exact citation. The URL is literal text, never a link: only the row in Evidence is one click away. */
function citationRow(claim: ReportClaim, index: number, numbers: Map<string, number>, base: string): string {
  const citation = claim.citations[index]!, source: ExternalEvidence | undefined = claim.evidence[index], number = numbers.get(citation.id) ?? 0;
  const url = source ? `<p class="s-mono">${e(source.url)}</p><p class="s-meta">${tr(k(`s14.report.scope.${citation.scope}`))} · ${tr(k(`s14.coverage.${source.coverage}`))} · ${tr(k(`s14.freshness.${source.freshness}`))} · ${tr("s14.evidence.received")} ${when(source.retrievedAt)}</p>` : `<p class="s-sub">${tr("s14.report.source_gone")}</p>`;
  return `<li><a class="s-cite" href="${base}#source-${e(citation.id)}" aria-label="${tr("s14.report.open_source")} ${number}">${number}</a><div class="s-stack">${url}<details class="s-more"><summary>${tr("s14.report.show_quote")}</summary><div>${untrusted(`<p>${e(citation.quote)}</p>`, tr("s14.untrusted.source"))}</div></details></div></li>`;
}
function claimCard(claim: ReportClaim, index: number, report: Report, targets: EvidenceRequirement[], numbers: Map<string, number>, evidenceBase: string): string {
  const kind = pill(tr(k(`s14.report.kind.${claim.kind}`))), support = claim.support === "supported" ? pill(tr("s14.report.supported"), "strong") : "";
  const flags = claim.flags.filter(flag => flag !== "inference" || claim.kind !== "inference").map(flagPill).join("");
  const conflicts = claim.conflicts.flatMap(id => { const other = report.claims.find(item => item.id === id); return other ? [`<div class="s-stack"><p class="s-exact-label"><a class="s-link-text" href="${claimAnchor(id)}">${tr("s14.report.conflicts_with")} ${report.claims.indexOf(other) + 1}</a></p>${untrusted(`<p>${e(other.text)}</p>`, tr("s14.report.untrusted"))}</div>`] : []; }).join("");
  const covers = claim.covers.flatMap(id => { const target = targets.find(t => t.id === id); return target ? [target.label] : []; }), meets = covers.length ? `<p class="s-meta">${tr("s14.report.covers")} ${covers.map(e).join(" · ")}</p>` : "";
  const cites = claim.citations.length ? `<ol class="s-cites">${claim.citations.map((_, i) => citationRow(claim, i, numbers, evidenceBase)).join("")}</ol>` : `<p class="s-sub">${tr("s14.report.no_citation")}</p>`;
  return `<article class="s-claim" id="claim-${encodeURIComponent(claim.id)}" aria-label="${tr("s14.report.claim")} ${index + 1}"><div class="s-mem-hd"><span class="s-source-n" aria-hidden="true">${index + 1}</span>${kind}${support}${flags}</div>${untrusted(`<p>${e(claim.text)}</p>`, tr("s14.report.untrusted"))}${conflicts}${meets}${cites}</article>`;
}
function filesBlock(files: Artifact[]): string {
  const row = (file: Artifact) => `<li class="s-file"><div class="s-stack"><p class="s-mono">${e(file.name)}</p><dl class="s-kv"><dt>${tr("s14.report.file_type")}</dt><dd>${e(typeWord(file))} · <span class="s-mono">${e(file.mediaType)}</span></dd><dt>${tr("s14.report.file_size")}</dt><dd>${file.size} ${tr("s14.report.bytes")}</dd><dt>SHA-256</dt><dd class="s-mono">${e(file.sha256)}</dd><dt>${tr("s14.report.file_made")}</dt><dd>${when(file.createdAt)}</dd></dl></div><a class="s-btn" href="/s14/artifacts/${e(file.id)}/download" download="${e(file.name)}" aria-label="${tr("s14.report.download")} ${e(file.name)}">${tr("s14.report.download")}</a></li>`;
  return `<section class="s-stack" aria-labelledby="s14-files"><h3 class="s-section-t" id="s14-files">${tr("s14.report.files")}</h3>${files.length ? `<ul class="s-files">${files.map(row).join("")}</ul><p class="s-note">${tr("s14.report.files_note")}</p>` : `<p class="s-sub">${tr("s14.report.no_files")}</p>`}</section>`;
}
/** Report tab: the selected revision with its gaps first, then claims, files and every earlier revision. */
export function reportTab(page: S14Page, view: WorkView, team: S14WorkTeam, research: S14WorkResearch | null, base: string): string {
  const sep = base.includes("?") ? "&amp;" : "?", { reports, selected } = team, href = (id: string) => `${base}${sep}tab=report&amp;report=${e(id)}`;
  if (!selected) {
    const live = ["queued", "running", "waiting"].includes(view.work.state);
    return banner("", tr("s14.report.none"), tr(live ? "s14.report.none_live" : "s14.report.none_detail"));
  }
  const history = revisions(reports, selected, href), older = selected !== reports.at(-1) ? banner("", `${tr("s14.report.older")} r${revisionOf(selected)}`, tr("s14.report.older_detail"), `<p><a class="s-link-text" href="${href(reportId(reports.at(-1)!))}">${tr("s14.report.open_latest")} r${revisionOf(reports.at(-1)!)}</a></p>`) : "";
  if (selected.state === "unavailable") return `${older}${banner("warn", `${tr("s14.report.withdrawn")} r${selected.revision}`, tr("s14.report.withdrawn_detail"))}${history}`;
  const { report, artifacts } = selected, numbers = new Map<string, number>(), steps = team.graph?.steps ?? [], targets = targetsOf(view);
  for (const claim of report.claims) for (const citation of claim.citations) if (!numbers.has(citation.id)) numbers.set(citation.id, numbers.size + 1);
  const evidenceBase = `${base}${sep}tab=evidence`, nameOf = (step: WorkStep) => { const bot = page.state.bots.find(item => item.id === step.botId) ?? { id: step.botId, name: step.botId }; return `${botName(bot)} · ${tr(k(`s14.step_handler.${step.handler}`))}`; };
  const authors = report.botIds.map(id => botName(page.state.bots.find(bot => bot.id === id) ?? { id, name: id }));
  return `${older}<div class="s-stack"><div class="s-between"><h3 class="s-report-t">${tr("s14.tab.report")} r${report.revision}</h3><span class="s-meta">${when(report.createdAt)}</span></div>${untrusted(`<p><b>${e(report.title)}</b></p>`, tr("s14.report.untrusted"))}<p class="s-meta">${tr("s14.report.by")} ${authors.map(e).join(" · ")}</p>${facts(report, report.missing.length)}</div>
    ${coverageBlock(report, view, team, research, evidenceBase, nameOf)}<section class="s-stack" aria-labelledby="s14-claims"><h3 class="s-section-t" id="s14-claims">${tr("s14.report.claims")} ${report.claims.length}</h3>${report.claims.map((claim, i) => claimCard(claim, i, report, targets, numbers, evidenceBase)).join("")}</section>${filesBlock(artifacts)}${history}`;
}
