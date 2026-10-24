import { AppError } from "../errors";
import type {
  GitHubReadPort,
  PrMonitor,
  ProtocolCheck,
  ProtocolFile,
  ProtocolIssue,
  ProtocolPull,
  ProtocolSpec,
  RepositoryIdentity,
} from "./types";

const SHA = /^[a-f0-9]{40}$/;

/** Evidence kinds whose adapter denials are normalized at the connector boundary. */
export type PrDenialKind = "issue" | "spec" | "ci";

/** Closed set of service-owned denial categories; adapter text never reaches a snapshot. */
export const PR_DENIAL_CATEGORIES = ["not_found", "forbidden", "rate_limited", "not_allowed", "unavailable"] as const;

/**
 * Maps any adapter-supplied denial reason to the bounded service code `<kind>_<category>`
 * (for example `issue_forbidden`). Only a short string is inspected, and only to pick a category
 * from {@link PR_DENIAL_CATEGORIES}; the adapter text itself (which may be huge or carry
 * credentials) is never returned.
 */
export function prDenialReason(kind: PrDenialKind, raw: unknown): string {
  const text = typeof raw === "string" && raw.length <= 64 ? raw.toLowerCase() : "";
  const category: typeof PR_DENIAL_CATEGORIES[number] =
    /not_allowed/.test(text) ? "not_allowed"
      : /not[_ -]?found|missing|\b404\b/.test(text) ? "not_found"
        : /rate|throttl|\b429\b/.test(text) ? "rate_limited"
          : /forbid|denied|permission|unauthori|\b40[13]\b/.test(text) ? "forbidden"
            : "unavailable";
  return `${kind}_${category}`;
}

/** Listing reasons the poller/snapshot act on; anything else from an adapter fails safe as `pagination_failed`. */
function listReason(raw: unknown, incomplete: boolean): "rate_limited" | "pagination_failed" | "more_pages" | null {
  if (raw === "rate_limited" || raw === "pagination_failed" || raw === "more_pages") return raw;
  if (raw === null || raw === undefined) return incomplete ? "more_pages" : null;
  return "pagination_failed";
}

/** In-memory fake GitHub protocol used by deterministic PR01 tests. */
export class FakeGitHubFixture implements GitHubReadPort {
  pulls: ProtocolPull[] = [];
  files = new Map<string, ProtocolFile[]>();
  issues = new Map<number, ProtocolIssue | { readonly denied: true; reason: string }>();
  specs = new Map<string, ProtocolSpec | { readonly denied: true; reason: string } | { readonly truncated: true; path: string; text: string }>();
  checks = new Map<string, ProtocolCheck[] | { readonly denied: true; reason: string }>();
  pageSize = 30;
  failPages = new Set<number>();
  rateLimited = false;
  mutateCalls = 0;
  redirects: string[] = [];
  requestedUrls: string[] = [];

  key(number: number, base: string, head: string): string {
    return `${number}:${base}:${head}`;
  }

  listPulls(page: number) {
    if (this.rateLimited) return { items: [], incomplete: true, etag: null, reason: "rate_limited" };
    if (this.failPages.has(page)) return { items: [], incomplete: true, etag: null, reason: "pagination_failed" };
    const start = (page - 1) * this.pageSize;
    const slice = this.pulls.slice(start, start + this.pageSize);
    const more = start + this.pageSize < this.pulls.length;
    return { items: structuredClone(slice), incomplete: more, etag: `etag-${this.pulls.length}-${page}`, reason: more ? "more_pages" : null };
  }

  resolvePull(number: number) {
    return structuredClone(this.pulls.find(p => p.number === number) ?? null);
  }

  listFiles(number: number, baseSha: string, headSha: string, page: number) {
    if (this.rateLimited) return { items: [], incomplete: true, truncated: false, reason: "rate_limited" };
    const all = this.files.get(this.key(number, baseSha, headSha)) ?? [];
    const start = (page - 1) * this.pageSize;
    const slice = all.slice(start, start + this.pageSize);
    const more = start + this.pageSize < all.length;
    const truncated = slice.some(f => f.truncated || (f.patch !== null && f.patch.length === 0 && f.status !== "removed"));
    return { items: structuredClone(slice), incomplete: more, truncated, reason: more ? "more_pages" : null };
  }

  readIssue(number: number): ProtocolIssue | { denied: true; reason: string } {
    return structuredClone(this.issues.get(number) ?? { denied: true as const, reason: "issue_not_found" });
  }

  readSpec(path: string, ref: string): ProtocolSpec | { denied: true; reason: string } | { truncated: true; path: string; text: string } {
    return structuredClone(this.specs.get(`${ref}:${path}`) ?? { denied: true as const, reason: "spec_not_found" });
  }

  readChecks(headSha: string): ProtocolCheck[] | { denied: true; reason: string } {
    return structuredClone(this.checks.get(headSha) ?? { denied: true as const, reason: "ci_unavailable" });
  }

  /** Fixture-only mutation counter; trusted connector never exposes write methods. */
  postComment(): void { this.mutateCalls += 1; }
}

/**
 * Trusted connector bound to one monitor's configured endpoint and repository.
 * Model-supplied URLs, auth headers, redirects and mutable refs cannot widen access.
 */
export class TrustedGitHubConnector implements GitHubReadPort {
  #port: GitHubReadPort;
  #monitor: PrMonitor;
  #cacheRoot: string;

  constructor(port: GitHubReadPort, monitor: PrMonitor, cacheRoot: string) {
    this.#port = port;
    this.#monitor = monitor;
    this.#cacheRoot = cacheRoot;
    if (!this.#cacheRoot || this.#cacheRoot.includes("\0")) throw new AppError("invalid_pr_cache");
  }

  /** Rejects attempts to retarget the connector via model/PR-controlled values. */
  assertTrusted(request: {
    url?: string;
    authorization?: string;
    repository?: RepositoryIdentity;
    ref?: string;
    redirect?: string;
  }): void {
    if (request.authorization) throw new AppError("pr_connector_auth_rejected");
    if (request.url) {
      let parsed: URL;
      try { parsed = new URL(request.url); } catch { throw new AppError("pr_connector_url_rejected"); }
      const configured = new URL(this.#monitor.apiBase);
      if (parsed.origin !== configured.origin || !parsed.pathname.startsWith(configured.pathname || "/")) {
        throw new AppError("pr_connector_url_rejected");
      }
      if (parsed.username || parsed.password) throw new AppError("pr_connector_url_rejected");
    }
    if (request.redirect) throw new AppError("pr_connector_redirect_rejected");
    if (request.repository) {
      const r = request.repository, m = this.#monitor.repository;
      if (r.host !== m.host || r.owner !== m.owner || r.name !== m.name) throw new AppError("pr_connector_repo_rejected");
    }
    if (request.ref !== undefined && !SHA.test(request.ref)) throw new AppError("pr_connector_mutable_ref_rejected");
  }

  /** Service-owned cache destination; never an executable checkout or AGENTS autoload root. */
  cacheDestination(...segments: string[]): string {
    for (const segment of segments) {
      if (!segment || segment.includes("\0") || segment === ".." || segment.includes("/") || segment.includes("\\")) {
        throw new AppError("pr_cache_path_rejected");
      }
    }
    return [this.#cacheRoot, "pr-snapshots", this.#monitor.id, ...segments].join("/");
  }

  listPulls(page: number) {
    if (this.#monitor.state !== "active") throw new AppError("pr_monitor_not_active", 409);
    const listed = this.#port.listPulls(page);
    return { ...listed, reason: listReason(listed.reason, listed.incomplete) };
  }

  resolvePull(number: number) {
    const pull = this.#port.resolvePull(number);
    if (pull && (!SHA.test(pull.base.sha) || !SHA.test(pull.head.sha))) throw new AppError("pr_connector_mutable_ref_rejected");
    return pull;
  }

  listFiles(number: number, baseSha: string, headSha: string, page: number) {
    this.assertTrusted({ ref: baseSha });
    this.assertTrusted({ ref: headSha });
    const listed = this.#port.listFiles(number, baseSha, headSha, page);
    return { ...listed, reason: listReason(listed.reason, listed.incomplete) };
  }

  /** Denials carry only a bounded service code from {@link prDenialReason}. */
  readIssue(number: number): ProtocolIssue | { denied: true; reason: string } {
    if (!this.#monitor.allowed.issues) return { denied: true as const, reason: prDenialReason("issue", "not_allowed") };
    const issue = this.#port.readIssue(number);
    return "denied" in issue ? { denied: true as const, reason: prDenialReason("issue", issue.reason) } : issue;
  }

  readSpec(path: string, ref: string): ProtocolSpec | { denied: true; reason: string } | { truncated: true; path: string; text: string } {
    if (!this.#monitor.allowed.specs) return { denied: true as const, reason: prDenialReason("spec", "not_allowed") };
    this.assertTrusted({ ref });
    if (!path || path.includes("\0") || path.split("/").includes("..") || path.startsWith("/") || path.includes("\\")) {
      throw new AppError("pr_spec_path_rejected");
    }
    // Snapshots are untrusted data: AGENTS/skills/config paths are never autoloaded as authority.
    let spec: ReturnType<GitHubReadPort["readSpec"]>;
    try { spec = this.#port.readSpec(path, ref); } catch { return { denied: true as const, reason: prDenialReason("spec", null) }; }
    return "denied" in spec ? { denied: true as const, reason: prDenialReason("spec", spec.reason) } : spec;
  }

  readChecks(headSha: string): ProtocolCheck[] | { denied: true; reason: string } {
    if (!this.#monitor.allowed.ci) return { denied: true as const, reason: prDenialReason("ci", "not_allowed") };
    this.assertTrusted({ ref: headSha });
    const checks = this.#port.readChecks(headSha);
    return "denied" in checks ? { denied: true as const, reason: prDenialReason("ci", checks.reason) } : checks;
  }
}

/** Builds a protocol pull with exact immutable SHAs for fixtures. */
export function fixturePull(partial: Partial<ProtocolPull> & Pick<ProtocolPull, "number" | "base" | "head">): ProtocolPull {
  return {
    title: partial.title ?? `PR #${partial.number}`,
    body: partial.body ?? "",
    draft: partial.draft ?? false,
    state: partial.state ?? "open",
    updatedAt: partial.updatedAt ?? "2026-10-18T00:00:00Z",
    ...partial,
  };
}
