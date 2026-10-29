import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { AppError } from "../errors";
import type { AppTransaction, TransactionStore } from "../store";

const lifetimeMs = 15 * 60 * 1000;
const tokenPattern = /^[a-f0-9]{64}$/;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const setupPath = (store: TransactionStore) => `${store.path}.owner-setup.json`;

/** Checks a bootstrap capability without consuming it; only an installation without an owner accepts it. */
export function requireOwnerSetup(store: TransactionStore, tx: AppTransaction, token: unknown, now: number): void {
  const denied = () => new AppError("owner_setup_link_invalid", 403);
  if (typeof token !== "string" || !tokenPattern.test(token) || tx.get("SELECT id FROM owner WHERE id = 'owner'")) throw denied();
  let fd: number | undefined;
  try {
    fd = openSync(setupPath(store), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 256 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw denied();
    const record = JSON.parse(readFileSync(fd, "utf8")) as { hash: string; expiresAt: number };
    if (!tokenPattern.test(record.hash) || !Number.isSafeInteger(record.expiresAt) || now >= record.expiresAt ||
        record.expiresAt > now + lifetimeMs || !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(record.hash))) throw denied();
  } catch { throw denied(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * Local installer capability, never an owner session. Replaces the prior link under SQLite's writer lock,
 * stores only its SHA-256 and 15-minute expiry in a 0600 sibling file (outside backups/exports), and returns
 * the sole printable URL. An existing owner is never reset or given a new capability. Caller must not log it.
 */
export function issueOwnerSetupLink(store: TransactionStore, origin: string, now = Date.now()): string | null {
  const url = new URL(origin);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("invalid_setup_origin");
  return store.transaction(tx => {
    if (tx.get("SELECT id FROM owner WHERE id = 'owner'")) return null;
    const token = randomBytes(32).toString("hex"), path = setupPath(store), temporary = `${path}.${randomBytes(8).toString("hex")}`;
    try {
      writeFileSync(temporary, JSON.stringify({ hash: hash(token), expiresAt: now + lifetimeMs }), { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
    url.pathname = "/owner/setup";
    url.searchParams.set("token", token);
    return url.href;
  });
}

/** Removes a consumed hash file; owner existence makes the capability unusable even if cleanup fails. */
export function removeOwnerSetupLink(store: TransactionStore): void {
  try { rmSync(setupPath(store), { force: true }); } catch { /* The committed owner is the single-use fence. */ }
}

/** Browser CSRF proof tied to the short-lived HttpOnly setup cookie; contains no capability. */
export function ownerSetupCsrf(token: string): string { return hash(`jit.owner-setup.csrf.v1:${token}`); }
