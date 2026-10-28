import { createHash } from "node:crypto";
import { AppError } from "./errors";
import type { AppTransaction } from "./store";

/**
 * app.persona/v1 — how Jit speaks to the owner (S09 BOT01, ADR 0029, FR-19, FR-17).
 *
 * The persona is owner configuration: it is written only by the `persona.set` owner command (from setup or
 * settings), every save creates a new immutable revision in `persona_revisions` (schema 25), and replies
 * cite the revision they were built from. It is trusted instruction text for the Jit reply run. Model
 * output, topic history and retrieved content can never write it: no work definition, adapter or result
 * path calls {@link writePersona}.
 *
 * Interface language stays in ui.preferences/v1; `language` here is the language Jit replies in.
 */
export type PersonaLanguage = "th" | "en";
/** Thai sentence-ending politeness particle. English replies ignore it. */
export type PersonaParticle = "khrap" | "kha" | "none";
export type PersonaPersonality = "calm" | "direct" | "friendly";
export interface PersonaSettings {
  /** How Jit addresses the owner, e.g. a name or "คุณ". Empty means the language's neutral "you". */
  addressAs: string;
  language: PersonaLanguage;
  /** How Jit refers to itself. Empty means "Jit"/"จิต". */
  selfReference: string;
  particle: PersonaParticle;
  personality: PersonaPersonality;
  /** Free text the owner wrote about themselves; trusted, bounded. */
  aboutMe: string;
}
export interface Persona extends PersonaSettings { revision: number; updatedAt: number | null }
export interface SetPersonaCommand {
  kind: "persona.set";
  requestId: string;
  projectId: null;
  /** Revision the owner saw (0 before the first save). */
  expectedRevision: number;
  payload: PersonaSettings;
}
export interface PersonaReceipt { persona: Persona }

export const personaLanguages: readonly PersonaLanguage[] = Object.freeze(["th", "en"]);
export const personaParticles: readonly PersonaParticle[] = Object.freeze(["khrap", "kha", "none"]);
export const personaPersonalities: readonly PersonaPersonality[] = Object.freeze(["calm", "direct", "friendly"]);
/** Field bounds in characters; the `aboutMe` bound keeps the whole persona inside one operator instruction line. */
export const personaBounds = Object.freeze({ addressAs: 60, selfReference: 30, aboutMe: 600 });
export const defaultPersona: Persona = Object.freeze({
  addressAs: "", language: "th", selfReference: "", particle: "none", personality: "calm", aboutMe: "", revision: 0, updatedAt: null,
});
const keys = ["addressAs", "language", "selfReference", "particle", "personality", "aboutMe"] as const;

/** Reads the current persona revision, or the defaults (revision 0) before the owner saves one. */
export function readPersona(tx: AppTransaction): Persona {
  const row = tx.get<{ revision: number; record_json: string; created_at: number }>(
    "SELECT revision, record_json, created_at FROM persona_revisions ORDER BY revision DESC LIMIT 1");
  if (!row) return { ...defaultPersona };
  return { ...(JSON.parse(row.record_json) as PersonaSettings), revision: row.revision, updatedAt: row.created_at };
}

/** Reads one exact retained revision; revision 0 is the defaults. */
export function readPersonaRevision(tx: AppTransaction, revision: number): Persona | null {
  if (revision === 0) return { ...defaultPersona };
  const row = tx.get<{ record_json: string; created_at: number }>("SELECT record_json, created_at FROM persona_revisions WHERE revision = ?", revision);
  return row ? { ...(JSON.parse(row.record_json) as PersonaSettings), revision, updatedAt: row.created_at } : null;
}

const plain = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && value.isWellFormed() &&
  // One line of plain text: no control characters, so the value cannot open a new instruction line.
  !/[\u0000-\u001f\u007f\u2028\u2029]/.test(value);

/** Validates the exact command shape and returns its receipt identity. */
export function personaIdentity(command: SetPersonaCommand): string {
  const p = command?.payload;
  if (!command || command.kind !== "persona.set" || command.projectId !== null ||
      Object.keys(command).sort().join(",") !== "expectedRevision,kind,payload,projectId,requestId" ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 ||
      !p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).sort().join(",") !== [...keys].sort().join(",") ||
      !plain(p.addressAs, personaBounds.addressAs) || !plain(p.selfReference, personaBounds.selfReference) ||
      typeof p.aboutMe !== "string" || p.aboutMe.length > personaBounds.aboutMe || !p.aboutMe.isWellFormed() || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(p.aboutMe) ||
      !personaLanguages.includes(p.language) || !personaParticles.includes(p.particle) || !personaPersonalities.includes(p.personality)) {
    throw new AppError("invalid_persona");
  }
  return createHash("sha256").update(JSON.stringify([command.kind, command.expectedRevision, ...keys.map(key => p[key])])).digest("hex");
}

/** Appends a new persona revision inside the caller's owner command transaction. A stale revision is rejected. */
export function writePersona(tx: AppTransaction, command: SetPersonaCommand, now: number): Persona {
  const current = readPersona(tx);
  if (current.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  const settings: PersonaSettings = {
    addressAs: command.payload.addressAs.trim(), language: command.payload.language, selfReference: command.payload.selfReference.trim(),
    particle: command.payload.particle, personality: command.payload.personality, aboutMe: command.payload.aboutMe.trim(),
  };
  const revision = current.revision + 1;
  tx.run("INSERT INTO persona_revisions (revision, record_json, created_at) VALUES (?, ?, ?)", revision, JSON.stringify(settings), now);
  return { ...settings, revision, updatedAt: now };
}

/**
 * The trusted persona instruction lines for a reply run (one line, plus one for "about me" when set).
 * Owner text is JSON-quoted so it stays one value; the model receives it as operator instruction, never
 * as manifest data. Each line stays under the run port's 2048-byte operator line bound.
 */
export function personaInstructions(persona: Persona): string[] {
  const language = persona.language === "en" ? "English" : "Thai";
  const particle = persona.language === "th" && persona.particle !== "none"
    ? ` End sentences with the polite particle ${JSON.stringify(persona.particle === "khrap" ? "ครับ" : "ค่ะ")}.` : "";
  const address = persona.addressAs ? JSON.stringify(persona.addressAs) : persona.language === "en" ? "\"you\"" : "\"คุณ\"";
  const self = persona.selfReference ? JSON.stringify(persona.selfReference) : persona.language === "en" ? "\"Jit\"" : "\"จิต\"";
  return [
    `Owner persona (app.persona/v1 revision ${persona.revision}, owner-configured and final): reply in ${language}; address the owner as ${address}; refer to yourself as ${self}; personality: ${persona.personality}.${particle}`,
    ...(persona.aboutMe ? [`About the owner, written by the owner: ${JSON.stringify(persona.aboutMe)}`] : []),
  ];
}
