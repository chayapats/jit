import { createHash } from "node:crypto";
import { AppError } from "./errors";
import type { AppConfig } from "./config";
import { mutateConversation, type TopicReceipt } from "./conversation";
import { dictionaries, type Locale } from "./i18n";
import { JobQueue, jobData, readJob } from "./jobs/queue";
import type { Job, JobLimits, WorkDefinition } from "./jobs/types";
import { personaIdentity, readPersona, writePersona, type Persona, type PersonaLanguage, type PersonaParticle, type PersonaPersonality, type PersonaSettings } from "./persona";
import { readPreferences, writePreferences } from "./preferences";
import { commitServiceOutput, requireId } from "./sources";
import type { AppTransaction, TransactionStore } from "./store";
import { mutateTeamConfiguration, readTeam, requireRoleRoute } from "./team/configuration";
import { jitCoordinator } from "./team/jit-reply";
import type { ApplicationRunPort } from "./team/run-port";
import { normalizePortResult, validateRunRequest } from "./team/scripted-port";
import { portFailureOutcome, schwayMaxAttempts } from "./team/schway-port";
import type { ApplicationRunOutcome, ApplicationRunRequest, RoleRoute } from "./team/types";

/**
 * app.setup/v1 — the first-run "ตั้งจิต" setup (S09-D07, FR-23, FR-13, FR-25, NFR-05).
 *
 * Steps run in order: wake (interface language) → connect (Jit's model route, plus an owner-started check that
 * the route answers) → know (how Jit addresses the owner and the language it speaks) → personality (skippable)
 * → ceremony. Progress is one revisioned row (`setup_state`, schema 26). Every step is an owner command with a
 * request id and the setup revision, so a double submit replays its receipt and a stale form is rejected. Every
 * step writes "set to this value" through the existing owner configuration paths (ui.preferences/v1,
 * app.role_configuration/v1, app.persona/v1), so repeating a step after a refresh or restart never creates a
 * second route, coordinator, persona or General space. After the ceremony setup is closed; the same values stay
 * editable in settings.
 *
 * Setup never creates specialists or projects other than the General space, and model output never writes any
 * of it: the route check stores only a reason code and the adapter mode, never the model's text.
 */
export const setupSteps = Object.freeze(["wake", "connect", "know", "personality", "ceremony"] as const);
export type SetupStep = (typeof setupSteps)[number];

/**
 * Evidence-based route state (FR-13). `configured` means a route is saved but no check covers it; `checking` means
 * a check job is queued or running; `verified` needs a completed production call on that exact route; a scripted
 * (fixture) answer or an inconclusive check is `unverified`; quota, sign-in, route or model problems are `blocked`.
 * Finding a token is never evidence.
 */
export type ConnectionStatus = "missing" | "configured" | "checking" | "verified" | "unverified" | "blocked";

/** Jit's route as setup sees it, with the latest check that covers exactly this route. */
export interface SetupConnection {
  route: RoleRoute | null; roleId: string | null; status: ConnectionStatus;
  reason: string | null; nextAction: string | null; mode: "fixture" | "production" | null;
  check: { id: string; jobId: string | null; projectId: string | null; createdAt: number; checkedAt: number | null } | null;
}
/** app.general_space/v1: the one system project of kind general (ADR 0031), its first topic and the greeting. */
export interface GeneralSpace { projectId: string; topicId: string; greetingMessageId: string | null; createdAt: number }
/** app.setup/v1 read model. `step` is the first unfinished step, or `ceremony`. */
export interface SetupView {
  revision: number; complete: boolean; completedAt: number | null; step: SetupStep;
  done: { wake: boolean; connect: boolean; know: boolean; personality: boolean };
  personalitySkipped: boolean;
  connection: SetupConnection;
  persona: Persona;
  general: GeneralSpace | null;
}

type Empty = Record<string, never>;
interface Command<K extends string, P> { kind: K; requestId: string; projectId: null; expectedRevision: number; payload: P }
/** Owner setup commands. `expectedRevision` is the setup revision the owner saw (0 before the first step). */
export type SetupCommand =
  | Command<"setup.wake", { language: Locale }>
  | Command<"setup.connect", { route: RoleRoute }>
  | Command<"setup.check", Empty>
  | Command<"setup.connect.continue", Empty>
  | Command<"setup.know", { addressAs: string; selfReference: string; language: PersonaLanguage; particle: PersonaParticle }>
  | Command<"setup.personality", { personality: PersonaPersonality; aboutMe: string }>
  | Command<"setup.personality.skip", Empty>
  | Command<"setup.complete", Empty>;
export interface SetupReceipt { setup: SetupView }
export const setupCommandKinds: readonly SetupCommand["kind"][] = Object.freeze(["setup.wake", "setup.connect", "setup.check", "setup.connect.continue",
  "setup.know", "setup.personality", "setup.personality.skip", "setup.complete"]);
export const isSetupCommand = (command: { kind?: unknown } | null | undefined): command is SetupCommand =>
  (setupCommandKinds as readonly unknown[]).includes(command?.kind);

/** Registered work type of the owner-started route check. */
export const setupCheckWorkId = "setup.route-check";
/** Stored job purpose; it equals the `system.setup_check_purpose` entry, so job pages translate it. */
export const setupCheckPurpose = "ตรวจการเชื่อมจิต";
/** The only operator line of a route check. It names no owner, project or credential. */
export const setupCheckMarker = "Jit setup connection check (app.setup/v1). Reply with the single word OK. Nothing you write is stored or shown, and this check grants no authority.";
const setupCheckResponsibility = "Answer the connection check.";

interface CheckRecord {
  id: string; route: RoleRoute; roleId: string; projectId: string; jobId: string | null; createdAt: number;
  /** Why no job was admitted. */
  notAdmitted: "scheduler_unavailable" | "queue_full" | null;
  /** Reason code and adapter mode only; the model's text is never kept. */
  result: { state: "verified" | "fixture" | "blocked" | "failed"; reason: string; mode: "fixture" | "production"; at: number } | null;
}
interface SetupRecord {
  done: { wake: number | null; connect: number | null; know: number | null; personality: number | null };
  personalitySkipped: boolean;
  check: CheckRecord | null;
}
const emptyRecord = (): SetupRecord => ({ done: { wake: null, connect: null, know: null, personality: null }, personalitySkipped: false, check: null });

function readRow(tx: AppTransaction): { revision: number; record: SetupRecord; completedAt: number | null } {
  const row = tx.get<{ revision: number; record_json: string; completed_at: number | null }>("SELECT revision, record_json, completed_at FROM setup_state WHERE id = 1");
  return row ? { revision: row.revision, record: JSON.parse(row.record_json) as SetupRecord, completedAt: row.completed_at } : { revision: 0, record: emptyRecord(), completedAt: null };
}

/** app.general_space/v1: the installation's General space, or null before setup creates it. */
export function readGeneralSpace(tx: AppTransaction): GeneralSpace | null {
  return tx.get<GeneralSpace>("SELECT project_id AS projectId, topic_id AS topicId, greeting_message_id AS greetingMessageId, created_at AS createdAt FROM general_space WHERE id = 1");
}

/** Whether the owner finished setup. Until then the workspace home leads to setup (FR-23). */
export function setupComplete(tx: AppTransaction): boolean {
  return tx.get<{ completed_at: number | null }>("SELECT completed_at FROM setup_state WHERE id = 1")?.completed_at != null;
}

const sameRoute = (a: RoleRoute | null, b: RoleRoute | null) => !!a && !!b && a.provider === b.provider && a.model === b.model && a.authRoute === b.authRoute;
/** The coordinator that answers as Jit in the General space (or owner scope before it exists), by the app.jit_reply/v1 rule. */
const jitRole = (tx: AppTransaction, config: AppConfig) => jitCoordinator(readTeam(tx, readGeneralSpace(tx)?.projectId ?? null, config.team).roles) ?? null;
const uiLanguage = (tx: AppTransaction): Locale => readPreferences(tx).language === "en" ? "en" : "th";

const blockedNext: Record<string, string> = {
  quota: "wait_for_quota_then_check", needs_login: "sign_in_then_check", route_unavailable: "check_route_then_check", unknown_model: "fix_model_then_check",
};

function connection(tx: AppTransaction, record: SetupRecord, config: AppConfig): SetupConnection {
  // Only a route a coordinator actually resolves counts; an owner default with no coordinator cannot answer.
  const jit = jitRole(tx, config);
  const route = jit?.effective.route ?? null;
  const base = { route, roleId: jit?.id ?? null, mode: null, check: null };
  if (!route) return { ...base, status: "missing", reason: null, nextAction: "configure_route" };
  const check = record.check;
  if (!check || !sameRoute(check.route, route) || check.roleId !== jit?.id) return { ...base, status: "configured", reason: null, nextAction: "check_route" };
  const summary = { id: check.id, jobId: check.jobId, projectId: check.projectId, createdAt: check.createdAt, checkedAt: check.result?.at ?? null };
  if (check.notAdmitted) {
    return { ...base, check: summary, status: "unverified", reason: check.notAdmitted,
      nextAction: check.notAdmitted === "queue_full" ? "wait_then_check_again" : "start_service_then_check_again" };
  }
  const result = check.result;
  if (result) {
    const known = { ...base, check: summary, mode: result.mode, reason: result.reason };
    if (result.state === "verified") return { ...known, status: "verified", nextAction: null };
    if (result.state === "fixture") return { ...known, status: "unverified", nextAction: "connect_live_host_then_check" };
    if (result.state === "blocked") return { ...known, status: "blocked", nextAction: blockedNext[result.reason] ?? "check_route_then_check" };
    return { ...known, status: "unverified", nextAction: "check_again" };
  }
  const job = check.jobId ? readJob(tx, check.projectId, check.jobId) : null;
  if (job && (job.state === "queued" || job.state === "admitted")) return { ...base, check: summary, status: "checking", reason: job.reason, nextAction: null };
  // No committed result and nothing running: stopped, past its deadline, or waiting after a restart interrupted it
  // (the queue never resumes a waiting job by itself, so the owner checks again).
  return { ...base, check: summary, status: "unverified", reason: job?.reason ?? "interrupted", nextAction: "check_again" };
}

/** app.setup/v1 read model, derived from persisted state only. It never starts a check. */
export function readSetup(tx: AppTransaction, config: AppConfig): SetupView {
  const { revision, record, completedAt } = readRow(tx);
  const done = { wake: record.done.wake !== null, connect: record.done.connect !== null, know: record.done.know !== null, personality: record.done.personality !== null };
  const step: SetupStep = !done.wake ? "wake" : !done.connect ? "connect" : !done.know ? "know" : !done.personality ? "personality" : "ceremony";
  return { revision, complete: completedAt !== null, completedAt, step, done, personalitySkipped: record.personalitySkipped,
    connection: connection(tx, record, config), persona: readPersona(tx), general: readGeneralSpace(tx) };
}

const exact = (value: unknown, keys: readonly string[]) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const payloadKeys: Record<SetupCommand["kind"], readonly string[]> = {
  "setup.wake": ["language"], "setup.connect": ["route"], "setup.check": [], "setup.connect.continue": [],
  "setup.know": ["addressAs", "selfReference", "language", "particle"], "setup.personality": ["personality", "aboutMe"],
  "setup.personality.skip": [], "setup.complete": [],
};

/** Validates the exact command shape and returns its receipt identity. */
export function setupIdentity(command: SetupCommand): string {
  if (!exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) || !isSetupCommand(command) || command.projectId !== null ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 || !exact(command.payload, payloadKeys[command.kind])) {
    throw new AppError("invalid_setup_command");
  }
  if (command.kind === "setup.wake" && !["th", "en"].includes(command.payload.language)) throw new AppError("invalid_setup_command");
  if (command.kind === "setup.connect") {
    try { requireRoleRoute(command.payload.route); } catch { throw new AppError("invalid_setup_command"); }
    if (command.payload.route === null) throw new AppError("invalid_setup_command");
  }
  // Persona fields reuse the app.persona/v1 validation (enums, bounds, single-line names).
  if (command.kind === "setup.know") personaIdentity(personaCommand(command.requestId, 0, { ...command.payload, personality: "calm", aboutMe: "" }));
  if (command.kind === "setup.personality") personaIdentity(personaCommand(command.requestId, 0, { addressAs: "", selfReference: "", language: "th", particle: "none", ...command.payload }));
  return createHash("sha256").update(JSON.stringify([command.kind, command.expectedRevision, payloadKeys[command.kind].map(key => (command.payload as Record<string, unknown>)[key])])).digest("hex");
}

const personaCommand = (requestId: string, expectedRevision: number, payload: PersonaSettings) =>
  ({ kind: "persona.set" as const, requestId, projectId: null, expectedRevision, payload });
const settingsOf = (persona: Persona): PersonaSettings => ({ addressAs: persona.addressAs, language: persona.language, selfReference: persona.selfReference,
  particle: persona.particle, personality: persona.personality, aboutMe: persona.aboutMe });

/** Writes one persona revision through app.persona/v1 only when the owner's values differ (or none was saved yet). */
function savePersona(tx: AppTransaction, requestId: string, changes: Partial<PersonaSettings>, now: number): void {
  const current = readPersona(tx);
  const next = { ...settingsOf(current), ...changes };
  const command = personaCommand(requestId, current.revision, next);
  personaIdentity(command);
  const trimmed = { ...next, addressAs: next.addressAs.trim(), selfReference: next.selfReference.trim(), aboutMe: next.aboutMe.trim() };
  if (current.revision > 0 && JSON.stringify(settingsOf({ ...current, ...trimmed })) === JSON.stringify(settingsOf(current))) return;
  writePersona(tx, command, now);
}

/**
 * Saves Jit's route through app.role_configuration/v1, on the layer that wins for Jit (app.jit_reply/v1 resolution
 * in the General space): its project-role override, the General project default, its own role route, or the owner
 * default. Other roles keep resolving as before. When no coordinator is enabled, setup creates one (the role that
 * answers as Jit) inheriting the owner default. Setup never creates specialists. Afterwards Jit's effective route
 * is exactly the submitted route, so the check that follows tests what the owner chose.
 */
function saveRoute(tx: AppTransaction, requestId: string, route: RoleRoute, config: AppConfig, now: number): void {
  const generalId = readGeneralSpace(tx)?.projectId ?? null;
  // The coordinator comes first, so the layer chosen below is the one that wins for the role that will answer.
  if (!readTeam(tx, null, config.team).roles.some(role => role.kind === "coordinator" && role.enabled)) {
    const language = uiLanguage(tx);
    mutateTeamConfiguration(tx, { kind: "role.save", requestId, projectId: null, expectedRevision: readTeam(tx, null, config.team).ownerRevision, payload: {
      roleId: null, name: dictionaries[language]["setup.coordinator_name"], kind: "coordinator",
      responsibility: dictionaries[language]["setup.coordinator_responsibility"], enabled: true, route: null } }, config.team, now);
  }
  const team = readTeam(tx, generalId, config.team);
  const target = jitCoordinator(team.roles) ?? team.roles.find(role => role.kind === "coordinator" && role.enabled)!;
  if (!sameRoute(target.effective.route, route)) {
    const layer = target.effective.layer;
    if (layer === "project_role" || layer === "project_default") {
      mutateTeamConfiguration(tx, { kind: "route.save", requestId, projectId: generalId!, expectedRevision: team.projectRevision,
        payload: { roleId: layer === "project_role" ? target.id : null, route } }, config.team, now);
    } else if (layer === "owner_role") {
      mutateTeamConfiguration(tx, { kind: "role.save", requestId, projectId: null, expectedRevision: team.ownerRevision, payload: {
        roleId: target.id, name: target.name, kind: target.kind, responsibility: target.responsibility, enabled: true, route } }, config.team, now);
    } else {
      // owner_default, or nothing resolves yet: the owner default is the layer the coordinator inherits.
      mutateTeamConfiguration(tx, { kind: "route.save", requestId, projectId: null, expectedRevision: team.ownerRevision, payload: { roleId: null, route } }, config.team, now);
    }
  }
  if (!sameRoute(jitRole(tx, config)?.effective.route ?? null, route)) throw new AppError("setup_route_not_effective", 409);
}

/**
 * app.general_space/v1: returns the installation's General space, creating it on first use: one ordinary project
 * (with its group), named in the owner's language, and its first topic. The singleton row makes a second one
 * impossible. It is created by the first route check (a job always belongs to a project) or, at the latest, by
 * the ceremony; no other path creates it.
 */
export function ensureGeneralSpace(tx: AppTransaction, requestId: string, now: number): GeneralSpace {
  const existing = readGeneralSpace(tx);
  if (existing) return existing;
  const language = uiLanguage(tx);
  const projectId = crypto.randomUUID(), groupId = crypto.randomUUID();
  tx.run("INSERT INTO projects VALUES (?, ?, 1, ?)", projectId, dictionaries[language]["setup.general_name"], now);
  tx.run("INSERT INTO project_groups VALUES (?, ?)", groupId, projectId);
  tx.run("UPDATE app_state SET revision = revision + 1 WHERE id = 1");
  const { topic } = mutateConversation(tx, { kind: "topic.create", projectId, requestId, expectedRevision: 1, payload: { title: dictionaries[language]["setup.general_topic"] } }, now) as TopicReceipt;
  tx.run("INSERT INTO general_space (id, project_id, topic_id, greeting_message_id, created_at) VALUES (1, ?, ?, NULL, ?)", projectId, topic.id, now);
  return readGeneralSpace(tx)!;
}

/** Replaces `{name}` placeholders of a trusted template in one pass; owner text is inserted literally, never re-scanned. */
const fill = (template: string, values: Readonly<Record<string, string>>) =>
  template.replace(/\{([a-z]+)\}/g, (token, name: string) => Object.hasOwn(values, name) ? values[name]! : token);

/** Jit's first message in the General space, built from the owner's persona. Fixed product text, never model output. */
export function setupGreeting(persona: Persona): string {
  const words = dictionaries[persona.language];
  const particle = persona.language === "th" ? persona.particle === "khrap" ? "ครับ" : persona.particle === "kha" ? "ค่ะ" : "" : "";
  const self = persona.selfReference || words["setup.coordinator_name"];
  const hello = fill(words["setup.greeting_hello"], { p: particle }) + (persona.addressAs ? ` ${persona.addressAs}` : "");
  return fill(words["setup.greeting"], { hello, self, p: particle });
}

function postGreeting(tx: AppTransaction, general: GeneralSpace, now: number): void {
  if (general.greetingMessageId) return;
  const source = commitServiceOutput(tx, { projectId: general.projectId, service: "jit-setup", text: setupGreeting(readPersona(tx)), committedAt: now });
  const topic = tx.get<{ sequence: number }>("SELECT message_sequence AS sequence FROM topics WHERE project_id = ? AND id = ?", general.projectId, general.topicId)!;
  const messageId = crypto.randomUUID();
  tx.run("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", messageId, general.projectId, general.topicId, topic.sequence + 1, now,
    JSON.stringify({ kind: "service", service: "jit-setup" }), source.sourceId, source.revision, source.generation);
  // Like a Jit reply, a service message advances message order only; the topic revision counts owner changes.
  tx.run("UPDATE topics SET message_sequence = message_sequence + 1 WHERE project_id = ? AND id = ?", general.projectId, general.topicId);
  tx.run("UPDATE general_space SET greeting_message_id = ? WHERE id = 1", messageId);
}

/** Bounded limits for one check: one admitted attempt (a host may replay once after a refresh), small output. */
export function setupCheckLimits(maximum: JobLimits): JobLimits {
  return { roles: Math.min(1, maximum.roles), calls: Math.min(2, maximum.calls), rounds: Math.min(2, maximum.rounds), hops: Math.min(1, maximum.hops),
    contextTokens: Math.min(1024, maximum.contextTokens), outputTokens: Math.min(256, maximum.outputTokens), retries: Math.min(1, maximum.retries),
    wallMs: Math.min(30_000, maximum.wallMs) };
}

/** Admits one route check job unless one is already queued or running for the same route. */
function startCheck(tx: AppTransaction, record: SetupRecord, input: SetupContext, requestId: string): void {
  const { config, queue, generation, now } = input;
  const current = connection(tx, record, config);
  if (current.status === "checking") return;
  // A check of an earlier route that is still queued or running is stopped; its late result is fenced anyway.
  const previous = record.check?.jobId ? readJob(tx, record.check.projectId, record.check.jobId) : null;
  if (previous && queue?.available(tx) && (previous.state === "queued" || previous.state === "admitted" || previous.state === "waiting")) {
    queue.execute(tx, { kind: "job.stop", requestId, projectId: previous.projectId, expectedRevision: previous.revision, payload: { jobId: previous.id } }, generation, now);
  }
  const general = ensureGeneralSpace(tx, requestId, now);
  const jit = jitRole(tx, config);
  if (!jit?.effective.route) throw new AppError("setup_route_required", 409);
  const check: CheckRecord = { id: crypto.randomUUID(), route: structuredClone(jit.effective.route), roleId: jit.id, projectId: general.projectId,
    jobId: null, createdAt: now, notAdmitted: null, result: null };
  record.check = check;
  if (!queue || !queue.available(tx) || !queue.registered(setupCheckWorkId)) { check.notAdmitted = "scheduler_unavailable"; return; }
  const revision = tx.get<{ revision: number }>("SELECT revision FROM projects WHERE id = ?", general.projectId)!.revision;
  let job: Job;
  try {
    ({ job } = queue.execute(tx, { kind: "job.enqueue", requestId, projectId: general.projectId, expectedRevision: revision,
      payload: { type: setupCheckWorkId, configurationRevision: 1, policyRevision: config.jobs.revision, purpose: setupCheckPurpose,
        inputRevision: 1, input: { checkId: check.id }, priority: "interactive", limits: setupCheckLimits(config.jobs.maximum) } }, generation, now));
  } catch (error) {
    if (error instanceof AppError && error.code === "job_queue_full") { check.notAdmitted = "queue_full"; return; }
    throw error;
  }
  check.jobId = job.id;
}

/** Trusted inputs for one setup command transaction. */
export interface SetupContext { config: AppConfig; queue: JobQueue | undefined; generation: number; now: number }

/**
 * Applies one validated setup command inside the caller's owner command transaction (receipt and audit are the
 * caller's). Steps must follow the order; a finished setup refuses every step (`setup_complete`).
 */
export function applySetup(tx: AppTransaction, command: SetupCommand, input: SetupContext): SetupReceipt {
  const { config, now } = input;
  const row = readRow(tx);
  if (row.completedAt !== null) throw new AppError("setup_complete", 409);
  if (row.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  const record = row.record, done = record.done;
  const requires = (...steps: (keyof SetupRecord["done"])[]) => { if (steps.some(step => done[step] === null)) throw new AppError("setup_step_unavailable", 409); };
  switch (command.kind) {
    case "setup.wake": {
      const preferences = readPreferences(tx);
      if (preferences.language !== command.payload.language) {
        writePreferences(tx, { kind: "ui.preferences.set", requestId: command.requestId, projectId: null, expectedRevision: preferences.revision,
          payload: { theme: preferences.theme, language: command.payload.language } }, now);
      }
      done.wake ??= now;
      break;
    }
    case "setup.connect":
      requires("wake");
      saveRoute(tx, command.requestId, command.payload.route, config, now);
      startCheck(tx, record, input, command.requestId);
      break;
    case "setup.check":
      requires("wake");
      startCheck(tx, record, input, command.requestId);
      break;
    case "setup.connect.continue":
      requires("wake");
      if (connection(tx, record, config).status === "missing") throw new AppError("setup_route_required", 409);
      done.connect ??= now;
      break;
    case "setup.know":
      requires("wake", "connect");
      savePersona(tx, command.requestId, command.payload, now);
      done.know ??= now;
      break;
    case "setup.personality":
      requires("wake", "connect", "know");
      savePersona(tx, command.requestId, command.payload, now);
      done.personality ??= now; record.personalitySkipped = false;
      break;
    case "setup.personality.skip":
      requires("wake", "connect", "know");
      // Skipping keeps the persona's personality as it is. A step already answered stays answered.
      if (done.personality === null) { done.personality = now; record.personalitySkipped = true; }
      break;
    case "setup.complete": {
      requires("wake", "connect", "know", "personality");
      if (connection(tx, record, config).status === "missing") throw new AppError("setup_route_required", 409);
      postGreeting(tx, ensureGeneralSpace(tx, command.requestId, now), now);
      break;
    }
  }
  const revision = row.revision + 1;
  tx.run(`INSERT INTO setup_state (id, revision, record_json, completed_at) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, record_json = excluded.record_json, completed_at = excluded.completed_at`,
  revision, JSON.stringify(record), command.kind === "setup.complete" ? now : null);
  return { setup: readSetup(tx, config) };
}

const validInput = (input: unknown): input is { checkId: string } => {
  try { if (!exact(input, ["checkId"])) return false; requireId((input as { checkId: string }).checkId); return true; } catch { return false; }
};
/** The check this job belongs to, while it is still the current, unanswered check. */
function currentCheck(tx: AppTransaction, job: Pick<Job, "id" | "input">): CheckRecord | null {
  if (!validInput(job.input)) return null;
  const check = readRow(tx).record.check;
  return check && check.id === job.input.checkId && check.jobId === job.id && !check.result ? check : null;
}

/**
 * app.setup/v1 route check work: one bounded, attempt-fenced call through app.run_port/v1 on Jit's exact route,
 * with a fixed prompt, an empty manifest and no tools. Only the outcome's reason code and adapter mode are
 * recorded; the model's text is discarded. Quota, sign-in, route and model problems end the check as `blocked`
 * (no waiting, no fallback, no retry loop). A newer check or a stop fences a late result.
 */
export function setupCheckWork(store: TransactionStore, config: AppConfig, port: ApplicationRunPort, now: () => number = Date.now): WorkDefinition {
  return {
    id: setupCheckWorkId, title: setupCheckPurpose, revision: 1, replay: "read",
    route: { provider: "jit-fixture", model: "scripted", authRoute: "internal" },
    cost: { roles: 1, calls: 1, rounds: 1, hops: 1 },
    validate: input => validInput(input),
    prepare: (tx, job, generation) => {
      const check = currentCheck(tx, job);
      if (!check) throw new AppError("invalid_job_input");
      const team = readTeam(tx, job.projectId, config.team);
      const role = team.roles.find(item => item.id === check.roleId);
      if (!role) throw new AppError("invalid_job_input");
      const general = readGeneralSpace(tx);
      if (!general || general.projectId !== job.projectId) throw new AppError("invalid_job_input");
      const request: ApplicationRunRequest = {
        runId: crypto.randomUUID(), projectId: job.projectId, topicId: general.topicId, roleId: role.id, purpose: "Jit setup connection check",
        route: structuredClone(check.route),
        configuration: { ownerRevision: team.ownerRevision, projectRevision: team.projectRevision, roleRevision: role.revision },
        context: { id: crypto.randomUUID(), generation: 1 },
        fence: { jobId: job.id, generation, ownerGeneration: job.authorization.generation },
        instructions: { operator: [setupCheckMarker], responsibility: setupCheckResponsibility },
        manifest: { sources: [], claims: [] }, tools: [],
        policy: { genericExecution: false, arbitraryFetch: false, hostedLookup: false, repositoryDiscovery: false },
        limits: structuredClone(job.limits),
      };
      validateRunRequest(request, config.team);
      tx.run("INSERT INTO team_contexts VALUES (?, 1, 'active')", request.context.id);
      return { native: { adapter: port.adapter, runId: request.runId, sessionId: request.runId, context: request.context },
        data: JSON.parse(jobData(request, config.team.contextBytes)) };
    },
    isCurrent: (tx, job, attempt) => {
      const request = attempt.data as unknown as ApplicationRunRequest;
      return !!currentCheck(tx, job) && request.fence.jobId === job.id && request.fence.generation === attempt.generation &&
        request.fence.ownerGeneration === job.authorization.generation &&
        tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ? AND generation = ?", request.context.id, request.context.generation)?.state === "active";
    },
    run: async ({ job, attempt, signal, reserve, commit }) => {
      if (!validInput(job.input)) return { state: "failed", reason: "worker_failed" };
      const checkId = job.input.checkId;
      const request = structuredClone(attempt.data) as unknown as ApplicationRunRequest;
      reserve({ contextTokens: Math.ceil(Buffer.byteLength(jobData(request, config.team.contextBytes)) / 4), outputTokens: job.limits.outputTokens });
      if (port.adapter === "schway") {
        const extra = schwayMaxAttempts(request) - 1;
        if (extra > 0) reserve({ calls: extra, rounds: extra });
      }
      let outcome: ApplicationRunOutcome;
      try { outcome = normalizePortResult(await port.invoke(request, signal, () => {}), request, Math.min(config.jobs.outputBytes, job.limits.outputTokens * 4, 65000)); }
      catch { outcome = portFailureOutcome(port); }
      const state = outcome.state === "complete" && outcome.output?.trim() ? outcome.mode === "production" ? "verified" : "fixture"
        : ["quota", "needs_login", "route_unavailable", "unknown_model"].includes(outcome.reason) ? "blocked" : "failed";
      // Language-neutral codes only; the model's text is never stored.
      const evidence = `setup-check · ${outcome.mode} · ${state}/${outcome.reason} · tools none · check ${checkId}`;
      const result = state === "verified" || state === "fixture" ? { state: "succeeded" as const, evidence } : { state: "partial" as const, evidence };
      const committed = commit(result, tx => {
        const row = readRow(tx), check = row.record.check;
        if (!check || check.id !== checkId || check.result) throw new AppError("invalid_job_input");
        check.result = { state, reason: outcome.reason, mode: outcome.mode, at: now() };
        // A background result never moves the setup revision, so a form the owner is looking at stays valid.
        tx.run("UPDATE setup_state SET record_json = ? WHERE id = 1", JSON.stringify(row.record));
      });
      return committed ? result : { state: "failed", reason: "worker_failed" };
    },
  };
}
