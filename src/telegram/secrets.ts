import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import { AppError } from "../errors";

/** Upper bound on the bot token file; a Bot API token is far shorter. */
export const botTokenFileLimit = 512;

/** Metadata verdict for the bot token file. Never opens or reads it. */
export type BotTokenFileState =
  | { state: "missing" }
  | { state: "blocked"; code: "telegram_token_not_regular" | "telegram_token_permissions" | "telegram_token_invalid" }
  | { state: "present" };

function judge(stats: Stats): BotTokenFileState {
  if (stats.isSymbolicLink() || !stats.isFile()) return { state: "blocked", code: "telegram_token_not_regular" };
  if ((stats.mode & 0o077) !== 0) return { state: "blocked", code: "telegram_token_permissions" };
  if (stats.size < 1 || stats.size > botTokenFileLimit) return { state: "blocked", code: "telegram_token_invalid" };
  return { state: "present" };
}

/**
 * Metadata-only inspection (lstat, never follows a symlink, never opens):
 * the token file must be a regular, owner-only file of 1..512 bytes. A
 * FIFO, device, symlink or oversized file is blocked without blocking the
 * caller or reading anything.
 */
export function inspectBotTokenFile(path: string): BotTokenFileState {
  let stats: Stats;
  try { stats = lstatSync(path); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : { state: "blocked", code: "telegram_token_not_regular" }; }
  return judge(stats);
}

/**
 * Reads the bot token only from the configured secret path; never invents or
 * echoes it. The file is checked with lstat first, opened with
 * `O_NOFOLLOW | O_NONBLOCK` (a swapped-in symlink fails, a FIFO cannot
 * block), re-checked with fstat against the same inode, and read for at most
 * `botTokenFileLimit + 1` bytes.
 */
export function readBotToken(path: string): string | null {
  const before = inspectBotTokenFile(path);
  if (before.state === "missing") return null;
  if (before.state === "blocked") throw new AppError(before.code, 503);
  const link = lstatSync(path);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new AppError("telegram_token_not_regular", 503); }
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== link.ino || opened.dev !== link.dev) throw new AppError("telegram_token_not_regular", 503);
    const verdict = judge(opened);
    if (verdict.state === "blocked") throw new AppError(verdict.code, 503);
    const buffer = Buffer.alloc(botTokenFileLimit + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > botTokenFileLimit) throw new AppError("telegram_token_invalid", 503);
    const token = buffer.subarray(0, length).toString("utf8").trim();
    if (!token || token.length > 256 || /\s/.test(token)) throw new AppError("telegram_token_invalid", 503);
    return token;
  } finally { closeSync(fd); }
}

/** Reports whether a usable token file exists, from metadata only; contents are never read. */
export function botCredentialConfigured(path: string): boolean {
  return inspectBotTokenFile(path).state === "present";
}
