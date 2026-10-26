import { createHash } from "node:crypto";
import { AppError } from "./errors";
import type { AppTransaction } from "./store";

/**
 * ui.preferences/v1 — the owner's persisted interface theme and language (S09 UX01, FR-24, FR-25).
 *
 * One installation-wide row (schema 24, `owner_preferences`). Before the owner saves anything the defaults
 * apply: `theme: "system"` follows `prefers-color-scheme`, and `language: "auto"` follows `Accept-Language`
 * with Thai as the fallback. Preferences change only through the `ui.preferences.set` owner command, which
 * is revisioned and idempotent by request id like every other command. They are configuration, not project
 * data, and grant no authority.
 */
export type ThemeChoice = "system" | "dark" | "light";
export type LanguageChoice = "auto" | "th" | "en";
export interface UiPreferences { theme: ThemeChoice; language: LanguageChoice; revision: number; updatedAt: number | null }
export interface SetPreferencesCommand {
  kind: "ui.preferences.set";
  requestId: string;
  projectId: null;
  /** Revision of the preferences row the owner saw (0 before the first save). */
  expectedRevision: number;
  payload: { theme: ThemeChoice; language: LanguageChoice };
}
export interface PreferencesReceipt { preferences: UiPreferences }

export const themeChoices: readonly ThemeChoice[] = Object.freeze(["system", "dark", "light"]);
export const languageChoices: readonly LanguageChoice[] = Object.freeze(["auto", "th", "en"]);
export const defaultPreferences: UiPreferences = Object.freeze({ theme: "system", language: "auto", revision: 0, updatedAt: null });

/** Reads the owner preferences, or the defaults when none were saved. */
export function readPreferences(tx: AppTransaction): UiPreferences {
  const row = tx.get<{ theme: ThemeChoice; language: LanguageChoice; revision: number; updated_at: number }>(
    "SELECT theme, language, revision, updated_at FROM owner_preferences WHERE id = 1");
  return row ? { theme: row.theme, language: row.language, revision: row.revision, updatedAt: row.updated_at } : { ...defaultPreferences };
}

/** Validates a command shape and returns its stable identity for receipt replay. */
export function preferencesIdentity(command: SetPreferencesCommand): string {
  if (!command || command.kind !== "ui.preferences.set" || command.projectId !== null ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 ||
      !command.payload || typeof command.payload !== "object" ||
      !themeChoices.includes(command.payload.theme) || !languageChoices.includes(command.payload.language) ||
      Object.keys(command.payload).some(key => key !== "theme" && key !== "language")) throw new AppError("invalid_preferences");
  return createHash("sha256").update(JSON.stringify([command.kind, command.expectedRevision, command.payload.theme, command.payload.language])).digest("hex");
}

/** Applies a validated command inside the caller's write transaction. A stale revision is rejected. */
export function writePreferences(tx: AppTransaction, command: SetPreferencesCommand, now: number): UiPreferences {
  const current = readPreferences(tx);
  if (current.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  const next: UiPreferences = { theme: command.payload.theme, language: command.payload.language, revision: current.revision + 1, updatedAt: now };
  tx.run(`INSERT INTO owner_preferences (id, revision, theme, language, updated_at) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, theme = excluded.theme, language = excluded.language, updated_at = excluded.updated_at`,
  next.revision, next.theme, next.language, now);
  return next;
}
