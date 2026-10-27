import { currentLocale, tr, type MessageKey } from "./i18n";
import type { Persona } from "./persona";
import type { ConnectionStatus, SetupConnection, SetupStep, SetupView } from "./setup";
import { setupSteps } from "./setup";
import { scaleTokens } from "./web-design";
import { documentPage, escape, hiddenCommand, icon } from "./web-layout";
import { logoLockup, logoMark } from "./web-logo";

/**
 * app.setup/v1 Web pages (the setup ceremony of S09-D07, docs/design/README.md). One server-rendered page per step, outside the
 * workspace shell. Every step is a plain form post that redirects back here, so the whole flow works without
 * script; the enhancement script only plays the ceremony (halo draws in, then the dot rises) before the final
 * form submits, and skips it under reduced motion.
 */

/** Pill tone per route state; the label text always comes with it (NFR-11). */
export const connectionTone: Readonly<Record<ConnectionStatus, string>> = Object.freeze({
  missing: "waiting", configured: "waiting", checking: "running", verified: "succeeded", unverified: "waiting", blocked: "blocked",
});
/** Localised route state, its explanation and its next action. Shared by the connect step and the ceremony summary. */
export function connectionLabels(connection: Pick<SetupConnection, "status" | "nextAction">): { state: string; note: string; next: string | null } {
  return {
    state: tr(`setup.status.${connection.status}` as MessageKey), note: tr(`setup.status_note.${connection.status}` as MessageKey),
    next: connection.nextAction ? tr(`setup.next.${connection.nextAction}` as MessageKey) : null,
  };
}

/** Which step a request may show: a reached step when asked for, otherwise the first unfinished one. */
export function visibleStep(setup: SetupView, requested: string | null): SetupStep {
  const current = setupSteps.indexOf(setup.step);
  const asked = setupSteps.indexOf(requested as SetupStep);
  return asked >= 0 && asked <= current ? setupSteps[asked]! : setup.step;
}

const routeText = (connection: SetupConnection) => connection.route
  ? `${connection.route.provider === "grok" ? "Grok" : "Codex"} · ${connection.route.model} · ${connection.route.authRoute}` : tr("setup.no_route");
const choice = (name: string, value: string, label: string, current: string) =>
  `<label class="choice"><input type="radio" name="${name}" value="${value}"${value === current ? " checked" : ""}>${label}</label>`;
const back = (step: SetupStep) => `<a class="setup-back" href="/setup?step=${step}">${tr("setup.back")}</a>`;
const action = (path: string, csrf: string, revision: number, label: string, extra = "", primary = false) =>
  `<form method="post" action="/setup/${path}"${extra}>${hiddenCommand(csrf, revision)}<button${primary ? ' class="primary"' : ""}>${label}</button></form>`;

function progress(setup: SetupView, shown: SetupStep): string {
  const done = (step: SetupStep) => step === "ceremony" ? setup.complete : setup.done[step];
  return `<ol class="setup-steps" aria-label="${tr("setup.progress")}">${setupSteps.map(step => {
    const state = done(step) ? "done" : step === setup.step ? "current" : "todo";
    return `<li data-state="${state}"${step === shown ? ' aria-current="step"' : ""}><span class="setup-step-name">${tr(`setup.step.${step}` as MessageKey)}</span><span class="setup-step-state">${state === "done" ? `${icon("check")}${tr("setup.state_done")}` : state === "current" ? tr("setup.state_current") : tr("setup.state_todo")}</span></li>`;
  }).join("")}</ol>`;
}

function connectionStatus(connection: SetupConnection, csrf: string, revision: number): string {
  const labels = connectionLabels(connection);
  const check = connection.check;
  const actions = [
    connection.status !== "missing" && connection.status !== "checking" ? action("check", csrf, revision, tr("setup.check_again")) : "",
    connection.status === "checking" ? `<a class="setup-refresh" href="/setup?step=connect">${tr("setup.refresh")}</a>` : "",
    check?.jobId && check.projectId ? `<a href="/projects/${check.projectId}/jobs/${check.jobId}#job-${check.jobId}">${tr("setup.view_check_job")}</a>` : "",
  ].filter(Boolean).join("");
  return `<section class="setup-connection" id="connection" aria-labelledby="connection-title"><h2 id="connection-title">${tr("setup.connection_state")}</h2>
    <p class="setup-connection-head"><span class="job-status" data-state="${connectionTone[connection.status]}">${escape(labels.state)}</span><span class="setup-route">${escape(routeText(connection))}</span></p>
    <p class="setup-note" role="status">${escape(labels.note)}</p>${labels.next ? `<p class="setup-next">${escape(labels.next)}</p>` : ""}
    ${connection.mode ? `<p class="setup-meta">${tr("setup.check_mode")} ${connection.mode === "production" ? tr("setup.mode_production") : tr("setup.mode_fixture")}</p>` : ""}
    ${actions ? `<div class="setup-actions">${actions}</div>` : ""}</section>`;
}

function wakeStep(setup: SetupView, csrf: string): string {
  const locale = currentLocale();
  return `<div class="setup-hero">${logoMark({ size: 72 })}<h1>${tr("setup.wake_title")}</h1><p>${tr("setup.wake_text")}</p></div>
    <nav class="setup-language" aria-label="${tr("setup.language_switch")}"><a href="/setup?step=wake&amp;lang=th" lang="th"${locale === "th" ? ' aria-current="true"' : ""}>${tr("settings.language_th")}</a><a href="/setup?step=wake&amp;lang=en" lang="en"${locale === "en" ? ' aria-current="true"' : ""}>${tr("settings.language_en")}</a></nav>
    <form method="post" action="/setup/wake">${hiddenCommand(csrf, setup.revision)}<input type="hidden" name="language" value="${locale}"><button class="primary">${tr("setup.wake_start")}</button></form>`;
}

function connectStep(setup: SetupView, csrf: string): string {
  const route = setup.connection.route;
  const provider = route?.provider ?? "grok";
  return `<div class="setup-head"><h1>${tr("setup.connect_title")}</h1><p>${tr("setup.connect_text")}</p></div>
    <form class="team-form setup-form" method="post" action="/setup/connect">${hiddenCommand(csrf, setup.revision)}
      <label>${tr("setup.provider")}<select name="provider"><option value="grok"${provider === "grok" ? " selected" : ""}>${"Grok"}</option><option value="codex"${provider === "codex" ? " selected" : ""}>${"Codex"}</option></select></label>
      <label>${tr("setup.model")}<input name="model" maxlength="120" required autocomplete="off" spellcheck="false" value="${escape(route?.model ?? "")}"></label>
      <label>${tr("setup.auth_route")}<input name="authRoute" maxlength="64" required autocomplete="off" spellcheck="false" value="${escape(route?.authRoute ?? "")}"><small>${tr("setup.auth_route_note")}</small></label>
      <button class="primary">${route ? tr("setup.connect_save_again") : tr("setup.connect_save")}</button></form>
    ${connectionStatus(setup.connection, csrf, setup.revision)}
    <div class="setup-foot">${back("wake")}${setup.connection.status === "missing" ? "" : `<div class="setup-continue">${setup.connection.status === "verified" ? "" : `<p class="setup-meta">${tr("setup.continue_unverified")}</p>`}${action("connect-continue", csrf, setup.revision, tr("setup.continue"), "", true)}</div>`}</div>`;
}

function knowStep(setup: SetupView, csrf: string): string {
  const persona = setup.persona;
  // Before the owner saves a persona, Jit speaks the interface language chosen at wake (FR-25); both stay separate settings.
  const language = persona.revision === 0 ? currentLocale() : persona.language;
  return `<div class="setup-head"><h1>${tr("setup.know_title")}</h1><p>${tr("setup.know_text")}</p></div>
    <form class="team-form setup-form" method="post" action="/setup/know">${hiddenCommand(csrf, setup.revision)}
      <label>${tr("settings.persona_address")}<input name="addressAs" maxlength="60" autocomplete="off" value="${escape(persona.addressAs)}" placeholder="${tr("setup.address_placeholder")}"></label>
      <label>${tr("settings.persona_self")}<input name="selfReference" maxlength="30" autocomplete="off" value="${escape(persona.selfReference)}" placeholder="${tr("setup.self_placeholder")}"></label>
      <fieldset class="choice-group"><legend>${tr("setup.jit_language")}</legend>${choice("language", "th", tr("settings.language_th"), language)}${choice("language", "en", tr("settings.language_en"), language)}</fieldset>
      <fieldset class="choice-group"><legend>${tr("settings.persona_particle")}</legend>${choice("particle", "khrap", tr("settings.persona_particle_khrap"), persona.particle)}${choice("particle", "kha", tr("settings.persona_particle_kha"), persona.particle)}${choice("particle", "none", tr("settings.persona_particle_none"), persona.particle)}</fieldset>
      <button class="primary">${tr("setup.continue")}</button></form>
    <div class="setup-foot">${back("connect")}</div>`;
}

function personalityStep(setup: SetupView, csrf: string): string {
  const persona = setup.persona;
  return `<div class="setup-head"><h1>${tr("setup.personality_title")}</h1><p>${tr("setup.personality_text")}</p></div>
    <form class="team-form setup-form" method="post" action="/setup/personality">${hiddenCommand(csrf, setup.revision)}
      <fieldset class="choice-group"><legend>${tr("settings.persona_personality")}</legend>${choice("personality", "calm", tr("settings.persona_calm"), persona.personality)}${choice("personality", "direct", tr("settings.persona_direct"), persona.personality)}${choice("personality", "friendly", tr("settings.persona_friendly"), persona.personality)}</fieldset>
      <label>${tr("settings.persona_about")}<textarea name="aboutMe" maxlength="600" rows="3">${escape(persona.aboutMe)}</textarea></label>
      <button class="primary">${tr("setup.continue")}</button></form>
    <div class="setup-foot">${back("know")}${action("personality-skip", csrf, setup.revision, tr("setup.skip"))}</div>`;
}

function summary(setup: SetupView): string {
  const persona: Persona = setup.persona;
  const labels = connectionLabels(setup.connection);
  const row = (label: string, value: string) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  return `<dl class="setup-summary">
    ${row(tr("setup.summary_route"), `${escape(routeText(setup.connection))} <span class="job-status" data-state="${connectionTone[setup.connection.status]}">${escape(labels.state)}</span>`)}
    ${row(tr("settings.persona_address"), escape(persona.addressAs || tr("setup.address_placeholder")))}
    ${row(tr("settings.persona_self"), escape(persona.selfReference || tr("setup.self_placeholder")))}
    ${row(tr("setup.jit_language"), persona.language === "en" ? tr("settings.language_en") : tr("settings.language_th"))}
    ${row(tr("settings.persona_personality"), setup.personalitySkipped ? tr("setup.skipped") : tr(`settings.persona_${persona.personality}` as MessageKey))}</dl>`;
}

function ceremonyStep(setup: SetupView, csrf: string): string {
  return `<div class="setup-hero ceremony" data-ceremony="ready" data-ceremony-ms="${scaleTokens.motion.ceremony}">${logoMark({ size: 120 })}<h1>${tr("setup.ceremony_title")}</h1><p>${tr("setup.ceremony_text")}</p></div>
    ${summary(setup)}${setup.connection.status === "verified" ? "" : `<p class="setup-meta">${escape(connectionLabels(setup.connection).note)}</p>`}
    <form method="post" action="/setup/complete" data-ceremony-form>${hiddenCommand(csrf, setup.revision)}<button class="primary">${tr("setup.ceremony_start")}</button></form>
    <p class="setup-meta">${tr("setup.editable_in_settings")}</p>
    <div class="setup-foot">${back("personality")}</div>`;
}

/** The setup page for one step, in the request's language and theme. */
export function setupPage(setup: SetupView, csrf: string, shown: SetupStep): string {
  const body = shown === "wake" ? wakeStep(setup, csrf) : shown === "connect" ? connectStep(setup, csrf) : shown === "know" ? knowStep(setup, csrf)
    : shown === "personality" ? personalityStep(setup, csrf) : ceremonyStep(setup, csrf);
  return documentPage(`${tr(`setup.step.${shown}` as MessageKey)} · ${tr("setup.title")}`, `<main class="setup" id="main-content"><div class="setup-card" data-step="${shown}">
    <header class="setup-top">${logoLockup({ height: 28, label: "Jit" })}<p class="setup-eyebrow">${tr("setup.title")}</p></header>${progress(setup, shown)}${body}</div></main>`);
}
