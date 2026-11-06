import { currentLocale, tr, trMaybe } from "../../i18n";
import type { PolicyProposal, StandingPolicy } from "../policy";
import type { VmCapability, VmStatus } from "../vm";
import type { VmMachineFacts } from "../vm/types";
import { banner, codeText, e, fill, form, hidden, icon, key, notYet, pill, refusal } from "./render";
import type { S15AccountRow, S15BudgetEntry, S15LocalHost, S15MachineCheck, S15ProvisioningJob } from "./types";

/** Process-local enrollment progress: only the public line and the observed check, never key material. */
export interface S15ComputerProgress { setup: { setupId: string; command: string } | null; check: (S15MachineCheck & { host: string }) | null }
/** SETUP15-01 card input: controller-observed host capability, the durable job projection and the render clock. */
export interface S15ComputerLocal { host: S15LocalHost | null; job: S15ProvisioningJob | null; now: number }
/** Working computer card input. `status` null means not yet registered; `unavailable` means VM15 is not composed. */
export interface S15ComputerCard { csrf: string; unavailable: boolean; status: VmStatus | null; progress: S15ComputerProgress; hypervisor: string | null; refused: string | null; address: string; return: "setup" | "computer"; local?: S15ComputerLocal }

const gib = (bytes: number) => `${(bytes / 1073741824).toFixed(bytes >= 10737418240 ? 0 : 1)} GiB`;
export function factsList(facts: VmMachineFacts): string {
  return `<dl class="s-kv"><dt>${tr("s15.computer.fact.architecture")}</dt><dd class="s-mono">${e(facts.architecture)}</dd><dt>${tr("s15.computer.fact.os")}</dt><dd class="s-mono">${e(facts.os)}</dd>
    <dt>${tr("s15.computer.fact.cpu")}</dt><dd>${facts.cpuCount}</dd><dt>${tr("s15.computer.fact.memory")}</dt><dd>${gib(facts.memoryBytes)}</dd><dt>${tr("s15.computer.fact.disk")}</dt><dd>${gib(facts.diskBytes)}</dd>
    <dt>${tr("s15.computer.fact.sudo")}</dt><dd>${tr(facts.sudo ? "s15.computer.yes" : "s15.computer.no")}</dd><dt>${tr("s15.computer.fact.docker")}</dt><dd>${tr(facts.docker ? "s15.computer.yes" : "s15.computer.not_found")}</dd></dl><p class="s-note">${tr("s15.vm.reported")}</p>`;
}

type Row = { label: string; state: "proven" | "reported" | "missing" | "unproven" | "unavailable"; note?: string };
const rowState: Record<Row["state"], [string, string, string]> = { proven: ["s15.computer.row.proven", "ok", "✓"], reported: ["s15.computer.row.reported", "ok", "✓"], missing: ["s15.computer.row.missing", "", "×"], unproven: ["s15.computer.row.unproven", "", "?"], unavailable: ["s15.computer.row.unavailable", "", "×"] };
/** Capability rows observed on this VM generation. Nothing is ✓ unless observed or reported by the machine itself. */
export function capabilityRows(status: VmStatus, hypervisor: string | null): string {
  const cap = (id: VmCapability["id"]) => status.capabilities.find(item => item.id === id);
  const mapped = (item: VmCapability | undefined): Row["state"] => item?.state === "proven" ? "proven" : item?.state === "unavailable" ? "unavailable" : "unproven";
  const facts = status.facts, running = status.state === "ready" || status.state === "unproven";
  const snapshot = mapped(cap("snapshot-recovery"));
  const rows: Row[] = [
    { label: tr("s15.computer.cap.commands"), state: running ? "proven" : "unproven" },
    { label: tr("s15.computer.cap.sudo"), state: facts?.sudo ? "reported" : "unproven" },
    { label: tr("s15.computer.cap.docker"), state: facts ? facts.docker ? "reported" : "missing" : "unproven" },
    { label: tr("s15.computer.cap.network"), state: mapped(cap("network-isolated")) },
    { label: tr("s15.computer.cap.snapshot"), state: snapshot, ...(snapshot === "unavailable" ? { note: hypervisor ? fill("s15.vm.no_snapshot", { hypervisor }) : tr("s15.computer.no_snapshot_generic") } : {}) },
    { label: tr("s15.computer.cap.stop"), state: mapped(cap("hypervisor-stop")) },
  ];
  return `<ul class="s15-caps" aria-label="${tr("s15.computer.caps_title")}">${rows.map(row => { const [word, tone, glyph] = rowState[row.state];
    return `<li><span class="s-grow">${e(row.label)}${row.note ? `<small>${e(row.note)}</small>` : ""}</span>${pill(tr(key(word)), tone, glyph)}</li>`; }).join("")}</ul><p class="s-note">${tr("s15.computer.caps_note")}</p>`;
}

export const statusTone: Record<VmStatus["state"], [string, string, string]> = { ready: ["s15.computer.state.ready", "ok", "✓"], unproven: ["s15.computer.state.unproven", "warn", "!"], uncertain: ["s15.computer.state.uncertain", "danger", "?"], stopped: ["s15.computer.state.stopped", "warn", "!"] };
/** Shown status of one registered computer: state, generation, sessions, reason, option B, rows and facts. */
export function computerStatus(status: VmStatus, hypervisor: string | null): string {
  const [word, tone, glyph] = statusTone[status.state];
  return `<div class="s-row">${pill(tr(key(word)), tone, glyph)}<span class="s-meta">${fill("s15.computer.generation", { n: status.generation })} · ${fill("s15.computer.sessions", { n: status.activeSessions, max: status.maxSessions })}</span></div>
      ${status.reason ? `<p class="s-sub">${codeText(status.reason)}</p>` : ""}${optionB()}${capabilityRows(status, hypervisor)}${status.facts ? `<details class="s-more"><summary>${tr("s15.computer.facts_title")}</summary><div>${factsList(status.facts)}</div></details>` : ""}`;
}
const optionB = () => `<p class="s15-option-b">${icon("lock")}<span>${tr("s15.vm.option_b")}</span></p>`;
/** Owner-supplied VM enrollment: paste one public-key line, type the address once, check, then use it. */
export function enrollmentFlow(card: S15ComputerCard): string {
  const back = hidden("return", card.return), failure = `${refusal(card.refused)}${optionB()}`;
  if (card.progress.check) {
    const check = card.progress.check;
    return `${failure}<h4 class="s-section-t">${tr("s15.computer.checked_title")}</h4><dl class="s-kv"><dt>${tr("s15.vm.address")}</dt><dd class="s-mono">${e(check.address)}</dd><dt>${tr("s15.computer.fingerprint")}</dt><dd class="s-mono s15-break">${e(check.fingerprint)}</dd></dl>${factsList(check.facts)}
      <p class="s-note">${tr("s15.computer.use_note")}</p><div class="s-row">${form("/s15/forms/computer/use", card.csrf, `${back}${hidden("checkId", check.checkId)}${hidden("fingerprint", check.fingerprint)}<button class="s-btn primary">${tr("s15.vm.use")}</button>`)}${form("/s15/forms/computer/forget-check", card.csrf, `${back}<button class="s-btn">${tr("s15.computer.other_address")}</button>`)}</div>`;
  }
  if (card.progress.setup) {
    const setup = card.progress.setup;
    return `${failure}<ol class="s15-steps"><li><p>${tr("s15.computer.make_vm")}</p><p>${tr("s15.vm.paste_line")}</p><pre class="s-exact" id="s15-paste-line">${e(setup.command)}</pre><p class="s-row"><button class="s-btn" type="button" data-copy="s15-paste-line" data-copied="${tr("s15.computer.copied")}" hidden>${tr("s15.computer.copy")}</button></p><p class="s-note">${tr("s15.computer.line_note")}</p></li>
      <li>${form("/s15/forms/computer/check", card.csrf, `${back}${hidden("setupId", setup.setupId)}<label class="s-field"><span>${tr("s15.vm.address")}</span><input name="host" required maxlength="253" autocomplete="off" spellcheck="false" inputmode="url" value="${e(card.address)}" placeholder="${tr("s15.computer.address_placeholder")}"></label>
        <details class="s-more"><summary>${tr("s15.computer.details")}</summary><div><label class="s-field"><span>${tr("s15.computer.port")}</span><input name="port" inputmode="numeric" pattern="[0-9]{1,5}" value="22"></label><label class="s-field"><span>${tr("s15.computer.user")}</span><input name="user" maxlength="32" autocomplete="off" spellcheck="false" value="jit"></label><p class="s-note">${tr("s15.computer.details_note")}</p></div></details>
        <div><button class="s-btn primary">${tr("s15.vm.check")}</button></div>`, ' class="s-stack"')}</li></ol>`;
  }
  return `${failure}<p>${tr("s15.computer.make_vm")}</p>${form("/s15/forms/computer/begin", card.csrf, `${back}<button class="s-btn primary">${tr("s15.computer.begin")}</button>`)}<p class="s-note">${tr("s15.computer.begin_note")}</p>`;
}

const provisionSteps = ["host", "download", "checksum", "disk", "boot", "connect", "checks"] as const;
/** Elapsed time as m:ss (or h:mm:ss), from the composed clock; never negative. */
export function elapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000)), h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), sec = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
const stepName = (step: string) => tr(key(`s15.provision.step.${step}`));
/** Ordered step list; the current step is marked for assistive technology and carries its own word. */
function stepList(job: S15ProvisioningJob, mode: "now" | "failed" | "paused"): string {
  const current = provisionSteps.indexOf((mode === "failed" ? job.failedStep ?? job.step : job.step) as typeof provisionSteps[number]);
  return `<ol class="s15-provision-steps" aria-label="${tr("s15.provision.steps_label")}">${provisionSteps.map((step, index) => {
    const state = index < current ? "done" : index === current ? mode : null;
    const mark = state === "done" ? pill(tr("s15.provision.state.done"), "ok", "✓") : state === "now" ? pill(tr("s15.provision.state.now"), "strong", "") : state === "failed" ? pill(tr("s15.provision.state.failed"), "danger", "×") : state === "paused" ? pill(tr("s15.provision.state.paused"), "warn", "!") : "";
    return `<li${index === current ? ' aria-current="step"' : ""} data-state="${state ?? "todo"}"><span class="s-grow">${e(stepName(step))}</span>${mark}</li>`;
  }).join("")}</ol>`;
}
/** Next step for one refusal code; every failure names one, falling back to the generic instruction. */
const nextStep = (code: string | null) => e(trMaybe(`s15.provision.next.${code ?? ""}`) ?? tr("s15.provision.next.generic"));
/** Host facts line for honest capacity refusals; controller-observed values only. */
const hostFacts = (host: S15LocalHost | null) => host?.facts ? `<p class="s-meta">${fill("s15.provision.host_facts", { cpus: host.facts.cpus, memory: host.facts.memoryGiB, disk: host.facts.diskFreeGiB })}</p>` : "";
/**
 * SETUP15-01 automatic working computer (F1 step 3, `/resources/computer`): the job's progress with the current
 * step and elapsed time, an honest failure with its step, reason, next step and "Try again", or, when this
 * host cannot run a nested VM, the specific missing item followed by the owner-supplied VM enrollment.
 * Nothing here claims the computer is ready; readiness appears only from the registered `VmStatus`.
 */
function localComputer(card: S15ComputerCard, local: S15ComputerLocal): string | null {
  const back = hidden("return", card.return), job = local.job, host = local.host;
  const anchor = card.return === "setup" ? "/setup#s15-setup-computer" : "/resources/computer";
  if (job?.state === "running" && job.active) {
    return `<div class="s15-provision" role="status" data-s15-refresh="5"><p class="s-row"><b>${tr("s15.provision.title_running")}</b>${job.attempts > 1 ? ` <span class="s-meta">${fill("s15.provision.attempt", { n: job.attempts })}</span>` : ""}</p>
      <p class="s-sub">${tr("s15.provision.lead_running")}</p>${stepList(job, "now")}
      <p class="s-meta">${fill("s15.provision.elapsed", { time: elapsed(local.now - job.startedAt) })} · ${fill("s15.provision.step_elapsed", { time: elapsed(local.now - job.stepStartedAt) })}</p>
      <p class="s-row"><a class="s-btn" href="${anchor}">${tr("s15.provision.refresh")}</a></p><p class="s-note">${tr("s15.provision.leave_note")}</p></div>${optionB()}`;
  }
  if (job?.state === "running") {
    return `${refusal(card.refused)}<div role="status">${banner("warn", fill("s15.provision.paused_title", { step: stepName(job.step) }), tr("s15.provision.paused_lead"))}</div>${stepList(job, "paused")}
      <div class="s-row">${form("/s15/forms/computer/provision", card.csrf, `${back}<button class="s-btn primary">${tr("s15.provision.continue")}</button>`)}</div><p class="s-note">${tr("s15.provision.leave_note")}</p>`;
  }
  const hostMissing = host?.state === "missing";
  if (job?.state === "failed") {
    const code = job.error;
    const retry = hostMissing ? "" : `<div class="s-row">${form("/s15/forms/computer/provision", card.csrf, `${back}<button class="s-btn primary">${tr("s15.provision.retry")}</button>`)}</div><p class="s-note">${tr("s15.provision.retry_note")}</p>`;
    const failure = `${refusal(card.refused)}<div role="alert">${banner("warn", fill("s15.provision.failed_title", { step: stepName(job.failedStep ?? job.step) }), codeText(code), `<p>${nextStep(code)}</p><p class="s-mono s-meta">${e(code ?? "")}</p>`)}</div>${hostFacts(host)}${stepList(job, "failed")}${retry}`;
    // A host that can no longer run the nested VM offers the owner-supplied enrollment instead of a retry loop.
    return hostMissing ? `${failure}${fallback(card)}` : failure;
  }
  if (hostMissing) {
    return `<div role="status">${banner("", tr("s15.provision.unavailable_title"), codeText(host.code), `<p>${nextStep(host.code)}</p><p class="s-mono s-meta">${e(host.code ?? "")}</p>`)}</div>${refusal(card.refused)}${hostFacts(host)}${fallback(card)}`;
  }
  if (host?.state === "ready" && host.resources) {
    const r = host.resources;
    return `${refusal(card.refused)}<p><b>${tr("s15.provision.ready_title")}</b></p><p class="s-sub">${fill("s15.provision.ready_lead", { cpus: r.cpus, memory: Math.round(r.memoryMiB / 1024), disk: r.diskGiB })}</p>
      <div class="s-row">${form("/s15/forms/computer/provision", card.csrf, `${back}<button class="s-btn primary">${tr("s15.provision.start")}</button>`)}</div>${optionB()}`;
  }
  return null;
}
const fallback = (card: S15ComputerCard) => `<h4 class="s-section-t">${tr("s15.provision.own_vm_title")}</h4>${enrollmentFlow({ ...card, refused: null })}`;

/** F1 step 3 and `/resources/computer`: automatic creation on KVM hosts, otherwise paste one line and type the address once. */
export function computerCard(card: S15ComputerCard): string {
  if (card.unavailable) return `${notYet("s15.computer.not_composed")}${optionB()}`;
  if (card.status) return computerStatus(card.status, card.hypervisor);
  const local = card.local ? localComputer(card, card.local) : null;
  if (local !== null) return local;
  return enrollmentFlow(card);
}

const minorDigits = (currency: string) => { try { return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2; } catch { return 2; } };
/** Converts an owner-typed decimal amount to canonical integer minor units without binary floats. */
export function toMinor(amount: string, currency: string): string | null {
  const digits = minorDigits(currency), match = /^(\d{1,15})(?:\.(\d+))?$/.exec(amount.trim().replaceAll(",", ""));
  if (!match || (match[2]?.length ?? 0) > digits) return null;
  const minor = BigInt(match[1]!) * 10n ** BigInt(digits) + BigInt((match[2] ?? "").padEnd(digits, "0") || "0");
  return minor > 0n ? minor.toString() : null;
}
/** Formats canonical minor units for display only; never parsed back. */
export function fromMinor(minor: string, currency: string): string {
  const digits = minorDigits(currency), value = BigInt(minor), unit = 10n ** BigInt(digits), whole = value / unit, part = (value % unit).toString().padStart(digits, "0");
  return `${whole.toLocaleString(currentLocale() === "en" ? "en-GB" : "th-TH")}${digits ? `.${part}` : ""} ${currency}`;
}

/** Rules section input. `entry` echoes only what the owner typed; `proposal` comes from the protected service. */
export interface S15RulesCard {
  csrf: string; unavailable: boolean; current: StandingPolicy | null; proposal: PolicyProposal | null;
  options: { currencies: string[]; periods: { id: string; days: number }[] };
  entry: { amount: string; currency: string; periodId: string } | null; budget: S15BudgetEntry | null; refused: string | null; installed: boolean;
}
const doesAlone = ["research", "computer", "edits", "accounts", "models", "sends", "github"] as const;
// AUTH16-01 (S16-D07): owner-named sends and GitHub work after required checks no longer ask.
const alwaysAsks = ["messages", "production", "payments", "recipients", "major", "new_accounts", "credentials"] as const;
/** The two plain F1 lists (does alone / always asks first) and the quiet personal-GitHub line. */
export function ruleLists(personalNote = true): string {
  return `<div class="s15-rule-lists"><section><h4 class="s-section-t">${tr("s15.setup.does_alone")}</h4><ul>${doesAlone.map(item => `<li>${tr(key(`s15.setup.alone.${item}`))}</li>`).join("")}</ul></section>
    <section><h4 class="s-section-t">${tr("s15.setup.always_asks")}</h4><ul>${alwaysAsks.map(item => `<li>${tr(key(`s15.setup.asks.${item}`))}</li>`).join("")}</ul></section></div>${personalNote ? `<p class="s-note">${tr("s15.setup.personal_off")}</p>` : ""}`;
}
const fieldLabels: Record<string, string> = { "budget.currency": "s15.budget.field.currency", "budget.startsAt": "s15.budget.field.starts", "budget.expiresAt": "s15.budget.field.expires", "budget.ceiling.spendMinor": "s15.budget.field.spend",
  "budget.ceiling.attempts": "s15.budget.field.attempts", "budget.ceiling.steps": "s15.budget.field.steps", "budget.ceiling.calls": "s15.budget.field.calls", "budget.ceiling.reads": "s15.budget.field.reads",
  "budget.ceiling.outputBytes": "s15.budget.field.output", "budget.ceiling.activeMs": "s15.budget.field.active", "budget.concurrency": "s15.budget.field.concurrency" };
function fieldValue(path: string, value: unknown, currency: string | null): string {
  if (value === null || value === undefined) return `<span class="s-sub">${tr("s15.setup.no_reviewed_value")}</span>`;
  if (path === "budget.ceiling.spendMinor" && currency) return e(fromMinor(String(value), currency));
  if (path === "budget.startsAt" || path === "budget.expiresAt") return `<time datetime="${new Date(Number(value)).toISOString()}">${e(new Intl.DateTimeFormat(currentLocale() === "en" ? "en-GB" : "th-TH", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(Number(value))))}</time>`;
  if (path === "budget.ceiling.activeMs") return fill("s15.budget.minutes", { n: Math.round(Number(value) / 60000) });
  if (path === "budget.ceiling.outputBytes") return `${Math.floor(Number(value) / 1024)} KiB`;
  return e(String(value));
}
/** F1 section 5: plain rule lists, empty budget fields and the exact proposal hash for `policy.install`. */
export function rulesCard(card: S15RulesCard): string {
  if (card.unavailable) return notYet("s15.rules.not_composed");
  if (card.current) return `${card.installed ? `<div role="status">${banner("ok", fill("s15.rules.installed", { n: card.current.revision }))}</div>` : `<p class="s-row">${pill(fill("s15.rules.active", { n: card.current.revision }), "ok", "✓")}</p>`}${ruleLists()}`;
  const options = card.options, entry = card.entry, proposal = card.proposal;
  const select = (name: string, label: string, items: { value: string; text: string }[], chosen: string) => `<label class="s-field"><span>${e(label)}</span>${items.length ? `<select name="${name}" required>${items.length > 1 ? `<option value=""${chosen ? "" : " selected"}>${tr("s15.budget.choose")}</option>` : ""}${items.map(item => `<option value="${e(item.value)}"${item.value === chosen || items.length === 1 ? " selected" : ""}>${e(item.text)}</option>`).join("")}</select>` : `<span class="s-sub">${tr("s15.setup.no_reviewed_value")}</span>`}</label>`;
  const budgetForm = form("/s15/forms/rules/review", card.csrf, `<fieldset class="s-field"><legend>${tr("s15.budget.legend")}</legend>
      <label class="s-field"><span>${tr("s15.budget.amount")}</span><input name="amount" inputmode="decimal" autocomplete="off" value="${e(entry?.amount ?? "")}" aria-describedby="s15-budget-note"></label>
      ${select("currency", tr("s15.budget.field.currency"), options.currencies.map(code => ({ value: code, text: code })), entry?.currency ?? "")}
      ${select("periodId", tr("s15.budget.period"), options.periods.map(period => ({ value: period.id, text: fill("s15.budget.days", { n: period.days }) })), entry?.periodId ?? "")}
      <p class="s-note" id="s15-budget-note">${tr("s15.setup.budget_required")}</p></fieldset><div><button class="s-btn">${tr("s15.rules.review")}</button></div>`, ' class="s-stack"');
  const currency = card.budget?.currency ?? null;
  const fields = proposal ? `<dl class="s-kv s15-fields">${proposal.fields.map(field => `<dt>${tr(key(fieldLabels[field.path] ?? "s15.budget.field.other"))}</dt><dd>${fieldValue(field.path, field.value, currency)}${field.status !== "provided" ? ` <small>${tr(key(`s15.budget.status.${field.status}`))}</small>` : ""}</dd>`).join("")}</dl>` : "";
  const missing = proposal?.fields.filter(field => field.status !== "provided" || field.value === null) ?? [];
  const reason = !card.budget ? tr("s15.setup.budget_required") : !proposal?.installable ? missing.length ? tr("s15.setup.no_reviewed_value") : codeText("proposal_incomplete") : "";
  const install = proposal?.installable && card.budget ? form("/s15/forms/rules/install", card.csrf, `${hidden("proposalHash", proposal.proposalHash)}<button class="s-btn primary">${tr("s15.setup.apply_rules")}</button>`) : `<button class="s-btn primary" type="button" disabled aria-describedby="s15-rules-reason">${tr("s15.setup.apply_rules")}</button><p class="s-note" id="s15-rules-reason">${e(reason)}</p>`;
  return `${refusal(card.refused)}${ruleLists()}${budgetForm}${proposal ? `<section class="s-stack" aria-labelledby="s15-proposal-title"><h4 class="s-section-t" id="s15-proposal-title">${tr("s15.rules.proposal_title")}</h4>${fields}${proposal.installable ? `<p class="s-note">${tr("s15.rules.exact_note")} <span class="s-mono">${e(proposal.proposalHash.slice(0, 12))}</span></p>` : ""}</section>` : ""}<div class="s-row">${install}</div>`;
}

/** F1 sections 2 and 4: one-click sign-in rows. Configured is never shown as tested. */
export function accountRows(rows: S15AccountRow[] | null, kind: S15AccountRow["kind"]): string {
  if (!rows) return notYet(kind === "model" ? "s15.accounts.models_not_composed" : "s15.accounts.not_composed");
  const own = rows.filter(row => row.kind === kind);
  if (!own.length) return `<p class="s-sub">${tr(kind === "model" ? "s15.accounts.no_models" : "s15.accounts.none")}</p>`;
  const tone: Record<S15AccountRow["state"], [string, string]> = { not_connected: ["", ""], configured: ["warn", "!"], checked: ["ok", "✓"], unavailable: ["danger", "×"] };
  const safe = (href: string | null) => href && /^\/(?!\/)[A-Za-z0-9/_.?=&%-]*$/.test(href) ? href : null;
  return `<ul class="s15-accounts">${own.map(row => { const href = safe(row.signInHref);
    return `<li><div class="s-grow"><p><b>${e(row.label)}</b></p>${row.uses.length ? `<p class="s-meta">${row.uses.map(use => tr(key(`s15.accounts.use.${use}`))).join(" · ")}${kind === "service" ? ` · ${tr("s15.resources.team")}` : ""}</p>` : ""}</div>${pill(tr(key(`s15.accounts.state.${row.state}`)), ...tone[row.state])}${href && row.state !== "checked" ? `<a class="s-btn" href="${e(href)}">${fill("s15.accounts.sign_in", { provider: row.label })}</a>` : ""}</li>`; }).join("")}</ul>`;
}

/** Whole F1 page body: five short sections, each with its own state; reload resumes at the first unfinished one. */
export function setupBody(input: { computer: string; computerDone: boolean; rules: string; rulesDone: boolean; models: string; modelsDone: boolean; accounts: string }): string {
  const sections = [
    { id: "password", done: true, title: "s15.setup.section.password", body: `<p>${tr("s15.setup.password_done")}</p>` },
    { id: "models", done: input.modelsDone, title: "s15.setup.section.models", body: `${input.models}<p class="s-note">${tr("s15.setup.models_note")}</p>` },
    { id: "computer", done: input.computerDone, title: "s15.vm.title", body: input.computer },
    { id: "accounts", done: true, optional: true, title: "s15.setup.section.accounts", body: `${input.accounts}<p class="s-row"><a class="s-link-text" href="#s15-setup-rules">${tr("s15.setup.skip")}</a></p>` },
    { id: "rules", done: input.rulesDone, title: "s15.setup.section.rules", body: input.rules },
  ];
  const next = sections.find(section => !section.done);
  const steps = `<ol class="s-setup-steps s15-setup-steps">${sections.map((section, index) => `<li${section === next ? ' aria-current="step"' : ""}><a href="#s15-setup-${section.id}">${index + 1}. ${tr(key(section.title))}</a> ${section.done ? pill(tr(section.optional ? "s15.setup.optional" : "s15.setup.done"), section.optional ? "" : "ok", section.optional ? "" : "✓") : pill(tr("s15.setup.todo"))}</li>`).join("")}</ol>`;
  return `<div class="s-col s15-setup"><p class="s-sub">${tr("s15.setup.lead")}</p>${next ? `<p><a class="s-btn" href="#s15-setup-${next.id}">${fill("s15.setup.resume", { section: tr(key(next.title)) })}</a></p>` : `<div role="status">${banner("ok", tr("s15.setup.complete"), tr("s15.setup.complete_detail"), `<p><a class="s-btn primary" href="/chats/new">${tr("s15.setup.start_chat")}</a></p>`)}</div>`}${steps}
    ${sections.map((section, index) => `<section class="s-card s15-setup-section" id="s15-setup-${section.id}" aria-labelledby="s15-setup-${section.id}-title"${section === next ? ' data-next="true"' : ""}><h2 id="s15-setup-${section.id}-title">${index + 1}. ${tr(key(section.title))}</h2>${section.body}</section>`).join("")}</div>`;
}
