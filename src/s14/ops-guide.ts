import { defaultLocale, dictionaries, type Locale, type MessageKey } from "../i18n";
import type { OpsCommand, OpsStage } from "./ops-types";
import { digest } from "./validation";

/** Fields an owner-facing next step needs. Internal directories are not part of it. */
export type S14OpsStage = Pick<OpsStage, "id" | "mode" | "backupId" | "state" | "reason" | "actionHash" | "recoveryBackupId">;
/** One exact maintenance command: the file it is saved in, and the block that writes that file and submits it. */
export interface S14OpsStep { key: "prepare" | "activate" | "validate" | "discard" | "rollback"; command: OpsCommand; script: string }

/** The service's start command. The running page and the terminal name it the same way. */
export const s14ServeCommand = "bun src/main.ts serve --s14";
/** Read-only offline status. It prints where a maintenance operation stands and the next command. */
export const s14OpsStatusCommand = "bun src/main.ts ops --s14";

/**
 * Retry identity comes from the command itself, so a reloaded page or reprinted step is the same request, and a repeat after
 * an interruption returns its receipt. The service stays the authority: a stale revision or hash is refused either way.
 */
function exact<K extends OpsCommand["kind"]>(kind: K, expectedRevision: number, payload: Extract<OpsCommand, { kind: K }>["payload"]): OpsCommand {
  return { kind, requestId: digest(JSON.stringify([kind, expectedRevision, payload])).slice(0, 32), expectedRevision, payload } as OpsCommand;
}
/** A credential-free block for a terminal. JSON stays on one line, so no value can end the quoted heredoc early. */
export function opsScript(command: OpsCommand): string {
  const file = `.local/s14-${command.kind.replace(".", "-")}.json`;
  return `umask 077 && mkdir -p .local\ncat > ${file} <<'JSON'\n${JSON.stringify(command)}\nJSON\nbun src/main.ts ops --s14 --command ${file}`;
}
const step = (key: S14OpsStep["key"], command: OpsCommand): S14OpsStep => ({ key, command, script: opsScript(command) });
/** The first command of a restore, at the maintenance revision the caller just read. */
export const restorePrepareStep = (revision: number, backupId: string): S14OpsStep => step("prepare", exact("restore.prepare", revision, { backupId }));

/**
 * Exact next commands for a stage. Activation appears only for a current validated hash or an interrupted activation, which
 * retries that same hash. These are words for a person to read: a stale or forged one changes nothing, because
 * `S14Maintenance.execute` rechecks the owner, revision and hash.
 */
export function stageSteps(stage: S14OpsStage, revision: number): S14OpsStep[] {
  const { id: stageId, state, actionHash, mode } = stage, payload = { stageId };
  const leave = step(mode === "upgrade" ? "rollback" : "discard", exact(mode === "upgrade" ? "upgrade.rollback" : "restore.discard", revision, payload));
  const confirmed = !!actionHash && /^[a-f0-9]{64}$/.test(actionHash);
  if (state === "activating") return confirmed ? [step("activate", exact("restore.activate", revision, { stageId, actionHash: actionHash! }))] : [];
  if (state === "validated") return confirmed ? [step("activate", exact("restore.activate", revision, { stageId, actionHash: actionHash! })), leave] : [leave];
  if (state === "preparing" || state === "partial" || state === "blocked") return [step("validate", exact("restore.validate", revision, payload)), leave];
  return [];
}

/** Result of `ops --s14`: a status has no `state`, a receipt does. */
export interface S14OpsResult { revision: number; state?: string; stage?: S14OpsStage | null; pendingBackupId?: string | null }
const text = (locale: Locale, key: string) => dictionaries[locale][key as MessageKey] as string | undefined;
function reasonLines(locale: Locale, reason: string | null): string[] {
  if (!reason) return [];
  return [`  ${text(locale, "s14.backup.guide.reason")}  ${text(locale, `s14.error.${reason}`) ?? text(locale, "s14.backup.reason_generic")} (${reason})`, ...(text(locale, `s14.next.${reason}`) ? [`  ${text(locale, `s14.next.${reason}`)}`] : [])];
}
/**
 * Next step for the terminal, in the owner's language, printed apart from the JSON result on stdout. The Web page cannot show
 * it: an unfinished stage keeps the service from starting. Returns "" when there is nothing to do, so status stays quiet.
 */
export function opsGuide(result: S14OpsResult, locale: Locale = defaultLocale): string {
  const say = (key: string, fill: Record<string, string> = {}) => Object.entries(fill).reduce((line, [name, value]) => line.replaceAll(`{${name}}`, value), text(locale, `s14.backup.guide.${key}`) ?? "");
  const run = (lead: string, steps: S14OpsStep[]) => steps.flatMap(item => ["", say(`${lead}${item.key}`), "", item.script]);
  if (result.state === "discarded") return [say("discarded"), "", say("start", { command: s14ServeCommand })].join("\n");
  const stage = result.stage ?? null;
  if (!stage) {
    if (!result.pendingBackupId) return "";
    const command = exact("restore.discard", result.revision, { stageId: result.pendingBackupId });
    return [say("pending"), "", opsScript(command)].join("\n");
  }
  const facts = (extra: string[] = []) => [`  ${say("stage")}  ${stage.id}`, `  ${say("source")}  ${stage.backupId}`, `  ${say("recovery")}  ${stage.recoveryBackupId}`, ...extra];
  if (stage.state === "complete" || stage.state === "discarded") return result.state ? [say(`finished_${stage.mode}`), "", say("start", { command: s14ServeCommand }), say("after")].join("\n") : "";
  const steps = stageSteps(stage, result.revision);
  if (stage.state === "validated" || stage.state === "activating") return [say(`${stage.state}_${stage.mode}`), ...facts(stage.actionHash ? [`  ${say("hash")}  ${stage.actionHash}`] : []), ...run("run_", steps), "", say("stopped")].join("\n");
  return [say(`stuck_${stage.mode}`), ...facts(reasonLines(locale, stage.reason)), ...run("run_", steps), "", say("stopped")].join("\n");
}
