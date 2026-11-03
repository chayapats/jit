import { createHash } from "node:crypto";
import type { ConnectionVault } from "../../exec/connections";
import { AppError } from "../../errors";
import { registerSecretFingerprint } from "../../security/secret-fingerprints";
import type { Ref } from "../policy";
import { s15CredentialKey } from "../credentials";
import type { GithubStore } from "./store";
import type { GithubRepository } from "./types";
import { canonical, repository } from "./validation";

/**
 * GIT15-04 (ADR 0073) protected Web GitHub connection. The owner pastes one fine-grained token; it is written only to
 * `ConnectionVault` under a stable installation key, fingerprint-registered and never returned, rendered or logged.
 * The connection record (identity, accessible repositories, the owner's selection) is revisioned in the protected
 * GitHub journal. Verification only reads (`GET /user`, `GET /user/repos`); nothing is written to GitHub.
 */
export const s15GithubConnectionAlias = "github_web_connection";
/** The GitHub API service as a disclosure/publication recipient, active only while a connection exists. */
export const s15GithubRecipient: Readonly<Ref> = Object.freeze({ id: "github_service", revision: 1, generation: 1 });

/** One repository the token can access, as GitHub reported it at verification. */
export interface GithubAccessibleRepository { name: string; target: string; private: boolean; push: boolean; admin: boolean }
/** One owner-selected repository and the resource identity work and policy bind to. */
export interface GithubSelectedRepository { repository: GithubRepository; private: boolean; selectedAt: number }
/** Revisioned connection state. Removal keeps the history rows; a removed connection admits no new work. */
export interface GithubConnectionRecord {
  contract: "s15-github-connection/v1"; revision: number; state: "connected" | "removed";
  login: string | null; tokenFingerprint: string | null; tokenExpiresAt: number | null; verifiedAt: number | null;
  accessible: GithubAccessibleRepository[]; truncated: boolean; selected: GithubSelectedRepository[];
  /** Resource revision and generation per repository name; selecting a repository again after it was unselected or
   * disconnected advances both, so stale policies and TEAM rows over the earlier identity stop matching. */
  generations: Record<string, number>; changedAt: number;
}

const namePattern = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
/** Stable protected resource id for a repository full name (`owner/name`), unique per case-insensitive name. */
export function githubResourceId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 96);
  return `gh_${slug}_${createHash("sha256").update(name.toLowerCase()).digest("hex").slice(0, 8)}`;
}
const parseExpiry = (header: string | null): number | null => {
  // GitHub reports e.g. "2026-12-01 00:00:00 UTC" for expiring fine-grained tokens.
  const match = header ? /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/.exec(header.trim()) : null;
  const value = match ? Date.parse(`${match[1]}T${match[2]}Z`) : NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
/** Protected DATA15 source identity of one repository generation; its resource is that generation's repository ref. */
export function githubSourceId(name: string): string { return githubResourceId(name).replace(/^gh_/, "ghs_"); }

/** Connection store and verifier. All commands are owner-only; composition checks the owner before calling. */
export class GithubConnections {
  private readonly key: string;
  private readonly now: () => number;
  /** Connect commands are serialized: the vault value and the committed fingerprint always change together. */
  private connecting: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: { store: GithubStore; vault: ConnectionVault; installationId: string; now?: () => number; fetch?: typeof fetch; maxRepositories?: number }) {
    this.key = s15CredentialKey(options.installationId, s15GithubConnectionAlias); this.now = options.now ?? Date.now;
    // Screen echoes of an already stored token from boot on; a disconnect interrupted after its commit finishes here.
    const c = this.current();
    if (c?.state === "connected") try { registerSecretFingerprint(options.vault.read(this.key)); } catch { /* Reported as github_credential_unavailable on use. */ }
    if (c?.state === "removed") try { options.vault.remove(this.key); } catch { /* Retried at the next boot; credential() refuses meanwhile. */ }
  }
  /** Current record, or null before the first connection. */
  current(): GithubConnectionRecord | null { return this.options.store.get<GithubConnectionRecord>("connection", "current"); }
  /** Selected repositories admitted for new work; empty when removed. */
  repositories(): GithubRepository[] { const c = this.current(); return c?.state === "connected" ? c.selected.map(s => structuredClone(s.repository)) : []; }
  /** Protected catalog row for a repository resource: active only while selected on a live connection. */
  resource(id: string): { ref: Ref; active: boolean } | null {
    const c = this.current(); if (!c) return null;
    const live = c.state === "connected" ? c.selected.find(s => s.repository.resource.id === id) : undefined;
    if (live) return { ref: structuredClone(live.repository.resource), active: true };
    const name = Object.keys(c.generations).find(n => githubResourceId(n) === id);
    return name ? { ref: { id, revision: c.generations[name]!, generation: c.generations[name]! }, active: false } : null;
  }
  /**
   * DATA15 private source of one repository generation (H, ADR 0073). Every generation ever selected stays resolvable
   * and private, so existing lineage is never declassified; only a currently selected generation gets approvals.
   */
  source(ref: Ref): import("../disclosure").DisclosureSource | null {
    const c = this.current(); if (!c) return null;
    const name = Object.keys(c.generations).find(n => githubSourceId(n) === ref.id), latest = name ? c.generations[name]! : 0;
    if (!name || ref.revision !== 1 || !Number.isSafeInteger(ref.generation) || ref.generation < 1 || ref.generation > latest) return null;
    return { ref: { id: ref.id, revision: 1, generation: ref.generation }, resource: { id: githubResourceId(name), revision: ref.generation, generation: ref.generation }, classification: "private", active: true, ownerReleasable: true };
  }
  /** The latest source per repository, and whether that generation is currently selected on a live connection. */
  sources(): { source: import("../disclosure").DisclosureSource; selected: boolean }[] {
    const c = this.current(); if (!c) return [];
    return Object.entries(c.generations).map(([name, generation]) => ({ source: this.source({ id: githubSourceId(name), revision: 1, generation })!,
      selected: c.state === "connected" && c.selected.some(s => s.repository.name === name && s.repository.resource.generation === generation) }));
  }
  /** Protected catalog row for the GitHub service recipient. */
  recipient(id: string): { ref: Ref; active: boolean } | null {
    if (id !== s15GithubRecipient.id) return null; const c = this.current(); if (!c) return null;
    return { ref: { ...s15GithubRecipient }, active: c.state === "connected" };
  }
  /** Host-only token read for the protected GitHub gateway; never for display. */
  credential(): string {
    if (this.current()?.state !== "connected") throw new AppError("github_not_connected", 409);
    let secret: string; try { secret = this.options.vault.read(this.key); } catch { throw new AppError("github_credential_unavailable", 409); }
    registerSecretFingerprint(secret);
    // Fail closed unless the vault holds exactly the token the committed record was verified with.
    if (sha256(secret) !== this.current()?.tokenFingerprint) throw new AppError("github_credential_unavailable", 409);
    return secret;
  }
  private receiptOf(requestId: string, command: unknown): { id: string; hash: string; prior: GithubConnectionRecord | null } {
    const id = `gc_${requestId}`, hash = sha256(canonical(command));
    return { id, hash, prior: this.options.store.receipt<GithubConnectionRecord>(id, hash) };
  }
  private commit(requestId: string, command: unknown, next: () => GithubConnectionRecord): GithubConnectionRecord {
    const { id, hash, prior } = this.receiptOf(requestId, command); if (prior) return prior;
    return this.options.store.tx(() => {
      if (this.options.store.receipt(id, hash)) throw new AppError("request_id_conflict", 409);
      const record = next();
      this.options.store.put("connection", "current", record); this.options.store.put("connection_history", `r${String(record.revision).padStart(9, "0")}`, record);
      this.options.store.commitReceipt(id, hash, record); return record;
    });
  }
  private async api(token: string, path: string): Promise<{ status: number; value: unknown; headers: Headers }> {
    let response: Response;
    try { response = await (this.options.fetch ?? fetch)(`https://api.github.com${path}`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "jit-s15" } }); }
    catch { throw new AppError("github_unreachable", 503); }
    const text = await response.text().catch(() => "");
    if (text.length > 2 * 1024 * 1024) throw new AppError("github_verify_failed", 502);
    let value: unknown = null; try { value = JSON.parse(text); } catch { value = null; }
    return { status: response.status, value, headers: response.headers };
  }
  /**
   * Verify a pasted token (identity and accessible repositories, read-only) and store it write-only. A token already
   * connected is replaced; the owner's previous selection is kept for repositories the new token can still access.
   */
  async connect(requestId: string, token: string): Promise<GithubConnectionRecord> {
    const run = this.connecting.then(() => this.connectOnce(requestId, token), () => this.connectOnce(requestId, token));
    this.connecting = run.catch(() => undefined); return run;
  }
  private async connectOnce(requestId: string, token: string): Promise<GithubConnectionRecord> {
    const secret = token.trim();
    if (!secret) throw new AppError("github_token_required", 409);
    // The owner steps ask for a fine-grained token scoped to chosen repositories; a classic token is broader.
    if (/^gh[pousr]_/.test(secret)) throw new AppError("github_token_fine_grained_required", 409);
    if (!/^github_pat_[A-Za-z0-9_]{20,250}$/.test(secret)) throw new AppError("github_token_invalid", 409);
    registerSecretFingerprint(secret);
    // A replayed request returns its own committed record and never touches the vault; a reused request id with a
    // different token conflicts before any verification or vault write.
    const fingerprint = sha256(secret), command = { kind: "connect", fingerprint };
    const replay = this.receiptOf(requestId, command); if (replay.prior) return replay.prior;
    const user = await this.api(secret, "/user");
    if (user.status === 401) throw new AppError("github_token_invalid", 409);
    if (user.status === 403) throw new AppError("github_token_forbidden", 409);
    const login = (user.value as { login?: unknown } | null)?.login;
    if (user.status !== 200 || typeof login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new AppError("github_verify_failed", 502);
    const listed = await this.api(secret, "/user/repos?per_page=100&sort=full_name");
    if (listed.status === 401) throw new AppError("github_token_invalid", 409);
    if (listed.status !== 200 || !Array.isArray(listed.value)) throw new AppError("github_verify_failed", 502);
    const max = this.options.maxRepositories ?? 100;
    const accessible: GithubAccessibleRepository[] = [];
    for (const raw of listed.value as Record<string, unknown>[]) {
      const name = raw?.full_name, target = raw?.default_branch, permissions = raw?.permissions as Record<string, unknown> | undefined;
      if (typeof name !== "string" || !namePattern.test(name) || typeof target !== "string") continue;
      try { repository({ resource: { id: githubResourceId(name), revision: 1, generation: 1 }, name, target }); } catch { continue; }
      accessible.push({ name, target, private: raw.private === true, push: permissions?.push === true, admin: permissions?.admin === true });
      if (accessible.length >= max) break;
    }
    const truncated = /rel="next"/.test(listed.headers.get("link") ?? "") || (listed.value as unknown[]).length > accessible.length;
    const expiresAt = parseExpiry(user.headers.get("github-authentication-token-expiration")), at = this.now();
    if (this.receiptOf(requestId, command).prior) return this.receiptOf(requestId, command).prior!;
    // Vault first, so a committed record never names a token that is missing; a failed journal write restores the
    // previous value. A crash between the two leaves a value whose fingerprint no record names: credential() refuses it.
    let previous: string | null = null; try { previous = this.options.vault.read(this.key); } catch { previous = null; }
    this.options.vault.write(this.key, secret);
    try { return this.commitConnect(requestId, command, () => {
      const prior = this.current();
      const kept = (prior?.selected ?? []).filter(s => accessible.some(a => a.name === s.repository.name && a.target === s.repository.target));
      return { contract: "s15-github-connection/v1", revision: (prior?.revision ?? 0) + 1, state: "connected", login, tokenFingerprint: fingerprint, tokenExpiresAt: expiresAt, verifiedAt: at, accessible, truncated, selected: prior?.state === "connected" ? kept : [], generations: { ...(prior?.generations ?? {}) }, changedAt: at };
    }); } catch (error) {
      try { if (previous === null) this.options.vault.remove(this.key); else this.options.vault.write(this.key, previous); } catch { /* credential() refuses a value no record names. */ }
      throw error;
    }
  }
  /** Commit a connect record; a receipt that appeared meanwhile is a conflict, so the caller restores the vault. */
  private commitConnect(requestId: string, command: unknown, next: () => GithubConnectionRecord): GithubConnectionRecord {
    const { id, hash } = this.receiptOf(requestId, command);
    return this.options.store.tx(() => {
      if (this.options.store.receipt(id, hash)) throw new AppError("request_id_conflict", 409);
      const record = next();
      this.options.store.put("connection", "current", record); this.options.store.put("connection_history", `r${String(record.revision).padStart(9, "0")}`, record);
      this.options.store.commitReceipt(id, hash, record); return record;
    });
  }
  /** Replace the selection with exactly these accessible repositories. Unlisted ones stop admitting new work. */
  select(requestId: string, expectedRevision: number, names: readonly string[]): GithubConnectionRecord {
    if (!Array.isArray(names) || names.length > 32 || new Set(names).size !== names.length || names.some(n => typeof n !== "string" || !namePattern.test(n))) throw new AppError("invalid_body");
    return this.commit(requestId, { kind: "select", expectedRevision, names: [...names].sort() }, () => {
      const c = this.current(); if (!c || c.state !== "connected") throw new AppError("github_not_connected", 409);
      if (c.revision !== expectedRevision) throw new AppError("stale_revision", 409);
      const at = this.now(), generations = { ...c.generations };
      const selected = names.map(name => {
        const accessible = c.accessible.find(a => a.name === name); if (!accessible) throw new AppError("github_repository_denied", 409);
        const existing = c.selected.find(s => s.repository.name === name); if (existing) return existing;
        generations[name] = (generations[name] ?? 0) + 1;
        return { repository: { resource: { id: githubResourceId(name), revision: generations[name]!, generation: generations[name]! }, name, target: accessible.target }, private: accessible.private, selectedAt: at };
      }).sort((a, b) => a.repository.name.localeCompare(b.repository.name));
      return { ...c, revision: c.revision + 1, selected, generations, changedAt: at };
    });
  }
  /** Remove the token from the vault and stop new GitHub work. History rows stay; in-flight effects stay fenced. */
  remove(requestId: string, expectedRevision: number): GithubConnectionRecord {
    // Commit first: once the record says removed, credential() refuses at once; the vault value is then deleted
    // (and again at the next boot if this process stops in between).
    const record = this.commit(requestId, { kind: "remove", expectedRevision }, () => {
      const c = this.current(); if (!c || c.state !== "connected") throw new AppError("github_not_connected", 409);
      if (c.revision !== expectedRevision) throw new AppError("stale_revision", 409);
      return { ...c, revision: c.revision + 1, state: "removed", tokenFingerprint: null, tokenExpiresAt: null, selected: [], changedAt: this.now() };
    });
    if (this.current()?.state === "removed") this.options.vault.remove(this.key);
    return record;
  }
}
