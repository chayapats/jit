import { existsSync, readFileSync, statSync } from "node:fs";
import { AppError } from "../errors";

/** Reads the bot token only from the configured secret path; never invents or echoes it. */
export function readBotToken(path: string): string | null {
  if (!existsSync(path)) return null;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new AppError("telegram_token_permissions", 503);
  const token = readFileSync(path, "utf8").trim();
  if (!token || token.length > 256 || /\s/.test(token)) throw new AppError("telegram_token_invalid", 503);
  return token;
}

/** Reports whether a token file exists without exposing its contents. */
export function botCredentialConfigured(path: string): boolean {
  try { return readBotToken(path) !== null; } catch { return false; }
}
