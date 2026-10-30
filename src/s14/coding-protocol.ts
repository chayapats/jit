import type { ExecutionBackend, ExecutionSpawnResult } from "schway/host";
import { AppError } from "../errors";
import { containsCredential } from "../security/credentials";
import { exact, integer, text } from "./validation";
import type { CodingCheck } from "./coding-types";

/** Registry scopes are exact DNS names from the existing registry design, never URLs, IPs or repository-provided hosts. */
export function codingRegistry(value: unknown): asserts value is { hosts: string[] } | null {
  if (value === null) return;
  exact(value, ["hosts"]);
  const registries = ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "proxy.golang.org", "crates.io"];
  if (!Array.isArray(value.hosts) || !value.hosts.length || value.hosts.length > registries.length ||
      new Set(value.hosts).size !== value.hosts.length || value.hosts.some(host => !registries.includes(host))) throw new AppError("coding_registry_scope_invalid");
}

/** Full SHA-1 object identity supported by this version; abbreviated or alternate-format repositories refuse. */
export function codingCommit(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value) || /^0+$/.test(value)) throw new AppError("coding_commit_invalid");
}
/** Restricts repository origins to explicit credential-free GitHub HTTPS identities. */
export function codingOrigin(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.git$/.test(value) || containsCredential(value)) throw new AppError("coding_origin_invalid");
}
/** Validates finite argv data without evaluating shell syntax or accepting secrets. */
export function codingCheck(value: unknown): asserts value is CodingCheck {
  exact(value, ["argv", "timeoutMs", "network", "coverage"]);
  if (!Array.isArray(value.argv) || !value.argv.length || value.argv.length > 32) throw new AppError("coding_command_invalid");
  for (const arg of value.argv) {
    if (typeof arg !== "string" || arg.length > 1024 || /[\u0000-\u001f\u007f]/.test(arg) || containsCredential(arg)) throw new AppError("coding_command_invalid");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(value.argv[0] as string)) throw new AppError("coding_command_invalid");
  integer(value.timeoutMs, 1, 300000);
  if (!["none", "registry"].includes(value.network as string) || text(value.coverage, 1000) !== value.coverage || containsCredential(value.coverage as string)) throw new AppError("coding_command_invalid");
}
/** Quotes one shell argument literally for the isolated runner, including apostrophes and substitution syntax. */
export const codingQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
/** Refuses path aliases and symlinked parents before any trusted repository operation. */
export async function codingPath(backend: ExecutionBackend, path: string): Promise<void> {
  if (backend.workspaceRoot !== "/workspace" || !/^\/workspace\/(repositories|coding)\/[a-zA-Z0-9_-]+$/.test(path)) throw new AppError("coding_path_refused", 403);
  let parent = "/workspace";
  for (const part of path.slice(11).split("/")) {
    const entry = (await backend.list(parent)).find(item => item.name === part);
    if (!entry || entry.type !== "directory") throw new AppError("coding_path_refused", 403);
    parent += `/${part}`;
    if (await backend.realpath(parent) !== parent) throw new AppError("coding_path_refused", 403);
  }
  const git = (await backend.list(path)).find(item => item.name === ".git");
  if (!git || git.type !== "directory" || await backend.realpath(`${path}/.git`) !== `${path}/.git`) throw new AppError("coding_gitdir_refused", 403);
}
/** Executes fixed Git operations only through the Bot backend with hooks, helpers and ambient config disabled. */
export async function codingGit(backend: ExecutionBackend, cwd: string, args: string[], signal?: AbortSignal): Promise<ExecutionSpawnResult> {
  return backend.spawn({ cwd, command: ["env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp", "LANG=C.UTF-8", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null", "GIT_TERMINAL_PROMPT=0", "git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c", "commit.gpgsign=false", "-c", "protocol.allow=never", ...args].map(codingQuote).join(" "), timeoutMs: 60000, ...(signal ? { signal } : {}) });
}
/** Requires an actual successful bounded Git observation; truncation or process uncertainty is never evidence. */
export function codingGitOutput(result: ExecutionSpawnResult): string {
  if (result.exitCode !== 0 || result.timedOut || Buffer.byteLength(result.stdout) > 32768) throw new AppError("coding_git_unconfirmed", 409);
  return result.stdout;
}
