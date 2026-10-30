import { dirname } from "node:path";
import { AppError } from "../errors";
import { brokerGit } from "./coding-git-mirror";
import type { GitAction, GitRemotePort, GitRemoteProof } from "./coding-git-types";

const repository = (action: GitAction) => action.repository.url.slice("https://github.com/".length, -4);
const branch = (action: GitAction) => action.update.ref.slice("refs/heads/".length);
const endpoint = (action: GitAction) => `https://api.github.com/repos/${repository(action)}/pulls`;

/** Fixed GitHub/HTTPS transport supports exact push, PR creation and read-back only; no merge/update endpoint exists. */
export class GitHubCodingRemote implements GitRemotePort {
  constructor(readonly fetcher: typeof fetch = fetch) {}

  /** Pushes from a verified broker mirror with one explicit refspec and compare-and-swap old commit. */
  async push(mirror: string, action: GitAction, secret: string, allowed: () => void): Promise<"succeeded" | "failed" | "unknown"> {
    allowed();
    const result = await brokerGit(dirname(mirror), ["-c", "protocol.https.allow=always", "-C", mirror, "push", "--porcelain", "--atomic", "--no-verify",
      `--force-with-lease=${action.update.ref}:${action.update.oldCommit ?? ""}`, "--", action.repository.url, `${action.update.newCommit}:${action.update.ref}`], secret);
    if (result.code === 0) return "succeeded";
    return result.stdout.split("\n").some(line => line.startsWith("!\t") && /\[rejected\]|\[remote rejected\]/.test(line)) ? "failed" : "unknown";
  }

  private async request(action: GitAction, secret: string, method: "GET" | "POST", url: string, allowed: () => void, payload?: unknown): Promise<{ response: Response; body: unknown }> {
    if (!url.startsWith(endpoint(action))) throw new AppError("git_endpoint_refused", 403);
    allowed();
    const response = await this.fetcher(url, { method, redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { authorization: `Bearer ${secret}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", "user-agent": "jit-s14" },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const reader = response.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 65536) { await reader.cancel(); throw new AppError("git_response_bound", 409); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
    }
    let body: unknown = null;
    try { body = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); } catch { /* Unreadable responses never certify a remote outcome. */ }
    return { response, body };
  }

  /** Creates only the exact approved PR payload once; malformed success responses remain unknown. */
  async createPr(action: GitAction, secret: string, allowed: () => void): Promise<{ outcome: "succeeded" | "failed" | "unknown"; number: number | null }> {
    if (!action.pr) throw new AppError("git_pr_missing");
    const { response, body } = await this.request(action, secret, "POST", endpoint(action), allowed,
      { title: action.pr.title, head: branch(action), base: action.pr.base, body: action.pr.body, draft: action.pr.draft });
    if (response.status === 201 && body && typeof body === "object" && "number" in body && Number.isSafeInteger(body.number) && (body.number as number) > 0) {
      return { outcome: "succeeded", number: body.number as number };
    }
    // Server/proxy errors may follow a committed mutation. Only explicit client refusals certify rejection.
    return { outcome: [400, 401, 403, 404, 422].includes(response.status) ? "failed" : "unknown", number: null };
  }

  /** Reads exact refs and bounded PR matches without any mutation or automatic retry. */
  async readBack(action: GitAction, secret: string, allowed: () => void): Promise<GitRemoteProof> {
    // A fresh empty broker directory is never a workspace or a source-controlled configuration.
    const { CodingGitMirror } = await import("./coding-git-mirror");
    const mirror = new CodingGitMirror();
    try {
      allowed();
      const refs = await brokerGit(mirror.directory, ["-c", "protocol.https.allow=always", "ls-remote", "--refs", "--", action.repository.url,
        action.update.ref, ...(action.pr ? [`refs/heads/${action.pr.base}`] : [])], secret);
      const proof: GitRemoteProof = { headCommit: null, baseCommit: null, prs: [], complete: refs.code === 0 };
      for (const line of refs.stdout.trim().split("\n").filter(Boolean)) {
        const parts = /^([a-f0-9]{40})\t(refs\/heads\/.+)$/.exec(line);
        if (!parts) { proof.complete = false; continue; }
        if (parts[2] === action.update.ref) proof.headCommit = parts[1]!;
        if (parts[2] === `refs/heads/${action.pr?.base}`) proof.baseCommit = parts[1]!;
      }
      if (!action.pr) return proof;
      const query = new URLSearchParams({ state: "all", head: `${repository(action).split("/")[0]}:${branch(action)}`, base: action.pr.base, per_page: "100" });
      const { response, body } = await this.request(action, secret, "GET", `${endpoint(action)}?${query}`, allowed);
      if (response.status !== 200 || !Array.isArray(body) || body.length >= 100 || response.headers.has("link")) { proof.complete = false; return proof; }
      for (const value of body) {
        if (!value || typeof value !== "object" || !Number.isSafeInteger(value.number) || value.number <= 0 ||
            typeof value.title !== "string" || typeof value.body !== "string" && value.body !== null || typeof value.draft !== "boolean" ||
            !/^[a-f0-9]{40}$/.test(value.head?.sha) || !/^[a-f0-9]{40}$/.test(value.base?.sha) ||
            value.head?.repo?.full_name !== repository(action) || value.base?.repo?.full_name !== repository(action) || typeof value.head?.ref !== "string" || typeof value.base?.ref !== "string") {
          proof.complete = false;
          continue;
        }
        proof.prs.push({ number: value.number, headCommit: value.head.sha, baseCommit: value.base.sha, base: value.base.ref,
          head: value.head.ref, title: value.title, body: value.body ?? "", draft: value.draft });
      }
      return proof;
    } finally { mirror.close(); }
  }
}
