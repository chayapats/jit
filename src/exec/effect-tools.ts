import type { ExecutionBackend, ToolDefinition, ToolExecutionResult } from "schway/host";
import { AppError } from "../errors";
import type { TransactionStore } from "../store";
import type { ApplicationRunRequest } from "../team/types";
import {
  createCard, maximumCommitSummaries, maximumRefUpdates, readDeployTarget, readRemote, validBranch, validRepository,
  type ApprovalCard, type EffectAction, type GitRemote,
} from "./approval-cards";

/**
 * app.effect_tools/v1 (EXE07, ADR 0037): the only way a model reaches an external effect. Admitted only to a run whose
 * frozen grant is `full` (exec.run_tools/v1); every call is fenced and audited like the core tools.
 *
 * A call validates its input, resolves the owner-named remote or deploy target, pins the exact action — for a push,
 * the full SHAs read from the box now — and inserts an approval card. It returns `pending_approval` with the card id
 * (or `approved` when a Web-written auto-approve rule decided it); it never performs the effect itself.
 */
export const effectToolNames = Object.freeze({
  "effect.git_push": "effect_git_push", "effect.github_pr_create": "effect_github_pr_create", "effect.github_comment": "effect_github_comment",
  "effect.github_pr_merge": "effect_github_pr_merge", "effect.deploy": "effect_deploy",
} as const);

/** Runs approved cards after their transaction commits (the effect executor). */
export interface EffectRunner { run(projectId: string, cardId: string): Promise<unknown> }

const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const fail = (content: string): ToolExecutionResult => ({ content, isError: true });
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const nameSchema = { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" };
const pendingNote = "Nothing has happened yet: the owner decides this approval card in Jit. Do not retry or work around it; continue or end your turn.";

function result(card: ApprovalCard): ToolExecutionResult {
  return { content: JSON.stringify({ state: card.state === "executing" ? "approved" : "pending_approval", cardId: card.id, kind: card.kind, digest: card.digest,
    expiresAt: new Date(card.expiresAt).toISOString(), note: card.state === "executing" ? "An owner auto-approve rule approved this card; Jit runs it once and posts the outcome to this topic." : pendingNote }) };
}

/** The effect tool definitions of one `full` run. `backend` is the run's box, used only to read SHAs for a push. */
export function effectToolDefinitions(store: TransactionStore, request: ApplicationRunRequest, backend: ExecutionBackend, runner: EffectRunner, now: () => number): ToolDefinition[] {
  const origin = { projectId: request.projectId, topicId: request.topicId, runId: request.runId, jobId: request.fence.jobId, roleId: request.roleId };
  const propose = (action: EffectAction): ToolExecutionResult => {
    let card: ApprovalCard;
    try { card = store.transaction(tx => createCard(tx, origin, action, now(), { autoApprove: true })); }
    catch (error) { return fail(`Jit refused the effect: ${error instanceof AppError ? error.code : "invalid_effect_action"}.`); }
    if (card.state === "executing") void runner.run(card.projectId, card.id).catch(() => undefined);
    return result(card);
  };
  const remote = (name: unknown, github: boolean): GitRemote | ToolExecutionResult => {
    if (typeof name !== "string" || !NAME.test(name)) return fail("remote must be the name of a remote the owner configured.");
    const found = store.read(tx => readRemote(tx, request.projectId, name));
    if (!found) return fail(`No owner-configured remote named ${name}. Ask the owner to add it in Jit; do not add credentials yourself.`);
    if (github && !found.github) return fail(`The remote ${name} has no GitHub repository configured.`);
    return found;
  };
  const pinned = (found: GitRemote) => ({ name: found.name, url: found.url, revision: found.revision });

  return [
    {
      name: effectToolNames["effect.git_push"],
      description: "Propose pushing commits from a repository in the box to an owner-configured remote. Jit pins each branch update as old SHA → new SHA read from the box now and creates an approval card; the push happens only after the owner approves, from Jit, never from the box. Later commits or branch moves are not part of the card.",
      inputSchema: object({
        remote: nameSchema,
        repository: { type: "string", maxLength: 200, description: "Repository directory relative to /workspace (default \".\")." },
        branches: { type: "array", minItems: 1, maxItems: maximumRefUpdates, items: object({
          branch: { type: "string", maxLength: 200, description: "Remote branch to update." },
          source: { type: "string", maxLength: 200, description: "Local branch or commit to push (default: the same branch)." },
          oldSha: { type: "string", pattern: "^([0-9a-f]{40}|new)$", description: "Expected current remote SHA, or \"new\" to create the branch (default: the box's remote-tracking ref)." },
        }, ["branch"]) },
      }, ["remote", "branches"]),
      execution: "exclusive", effect: "mutating",
      async execute(input): Promise<ToolExecutionResult> {
        const args = input as { remote?: unknown; repository?: unknown; branches?: unknown };
        const found = remote(args.remote, false);
        if (!("revision" in found)) return found;
        const repository = args.repository === undefined ? "." : args.repository;
        if (!validRepository(repository)) return fail("repository must be a relative directory inside /workspace.");
        if (!Array.isArray(args.branches) || args.branches.length < 1 || args.branches.length > maximumRefUpdates) return fail(`branches must list 1 to ${maximumRefUpdates} updates.`);
        const root = backend.workspaceRoot.replace(/\/$/, ""), dir = repository === "." ? root : `${root}/${repository}`;
        const g = `git -c core.hooksPath=/dev/null -c core.fsmonitor=false -C ${quote(dir)}`;
        const updates: { ref: string; oldSha: string | null; newSha: string }[] = [];
        const commits: { sha: string; summary: string }[] = [];
        for (const raw of args.branches as unknown[]) {
          const item = raw as { branch?: unknown; source?: unknown; oldSha?: unknown };
          const source = item.source ?? item.branch;
          if (!validBranch(item.branch) || !(validBranch(source) || (typeof source === "string" && SHA.test(source)))) return fail("branch and source must be plain branch names (or a full commit SHA for source).");
          if (item.oldSha !== undefined && !(item.oldSha === "new" || (typeof item.oldSha === "string" && SHA.test(item.oldSha)))) return fail("oldSha must be a full SHA or \"new\".");
          // Read-only lookups in the box; their output is untrusted and only accepted as full SHAs.
          const script = [
            `printf 'NEW %s\\n' "$(${g} rev-parse --verify --quiet --end-of-options ${quote(`${source}^{commit}`)})"`,
            item.oldSha === undefined ? `printf 'OLD %s\\n' "$(${g} rev-parse --verify --quiet --end-of-options ${quote(`refs/remotes/${found.name}/${item.branch}^{commit}`)})"` : "true",
          ].join("; ");
          const read = await backend.spawn({ command: script, cwd: root, timeoutMs: 30_000 });
          const newSha = /^NEW ([0-9a-f]{40})$/m.exec(read.stdout)?.[1];
          if (!newSha) return fail(`Cannot resolve ${source} to a commit in ${repository}.`);
          const tracked = /^OLD ([0-9a-f]{40})$/m.exec(read.stdout)?.[1] ?? null;
          const oldSha = item.oldSha === "new" ? null : typeof item.oldSha === "string" ? item.oldSha : tracked;
          if (oldSha === newSha) return fail(`${item.branch} is already at ${newSha}.`);
          updates.push({ ref: `refs/heads/${item.branch}`, oldSha, newSha });
          if (commits.length < maximumCommitSummaries) {
            const range = oldSha ? `${quote(newSha)} --not ${quote(oldSha)}` : quote(newSha);
            const log = await backend.spawn({ command: `${g} cat-file -e ${quote(`${oldSha ?? newSha}^{commit}`)} 2>/dev/null && ${g} log --format='%H%x09%s' -n ${maximumCommitSummaries} ${range} 2>/dev/null || ${g} log --format='%H%x09%s' -n ${maximumCommitSummaries} ${quote(newSha)}`, cwd: root, timeoutMs: 30_000 });
            for (const line of log.stdout.split("\n")) {
              const tab = line.indexOf("\t"), sha = line.slice(0, tab);
              if (tab === 40 && SHA.test(sha) && commits.length < maximumCommitSummaries && !commits.some(commit => commit.sha === sha)) commits.push({ sha, summary: line.slice(41, 341) });
            }
          }
        }
        return propose({ kind: "effect.git_push", remote: pinned(found), repository, updates, commits });
      },
    },
    {
      name: effectToolNames["effect.github_pr_create"],
      description: "Propose opening a pull request on the GitHub repository of an owner-configured remote. Creates an approval card; nothing happens until the owner approves.",
      inputSchema: object({ remote: nameSchema, base: { type: "string", maxLength: 200 }, head: { type: "string", maxLength: 200 }, title: { type: "string", maxLength: 256 },
        body: { type: "string", maxLength: 65536 }, draft: { type: "boolean" } }, ["remote", "base", "head", "title"]),
      execution: "exclusive", effect: "mutating",
      async execute(input): Promise<ToolExecutionResult> {
        const args = input as { remote?: unknown; base?: unknown; head?: unknown; title?: unknown; body?: unknown; draft?: unknown };
        const found = remote(args.remote, true);
        if (!("revision" in found)) return found;
        if (!validBranch(args.base) || !validBranch(args.head)) return fail("base and head must be plain branch names.");
        return propose({ kind: "effect.github_pr_create", remote: pinned(found), github: found.github!, base: args.base, head: args.head,
          title: String(args.title ?? ""), body: typeof args.body === "string" ? args.body : "", draft: args.draft === true });
      },
    },
    {
      name: effectToolNames["effect.github_comment"],
      description: "Propose posting a comment on an issue or pull request of an owner-configured GitHub remote. Creates an approval card; nothing happens until the owner approves.",
      inputSchema: object({ remote: nameSchema, issueNumber: { type: "integer", minimum: 1 }, body: { type: "string", maxLength: 65536 } }, ["remote", "issueNumber", "body"]),
      execution: "exclusive", effect: "mutating",
      async execute(input): Promise<ToolExecutionResult> {
        const args = input as { remote?: unknown; issueNumber?: unknown; body?: unknown };
        const found = remote(args.remote, true);
        if (!("revision" in found)) return found;
        return propose({ kind: "effect.github_comment", remote: pinned(found), github: found.github!, issueNumber: Number(args.issueNumber), body: String(args.body ?? "") });
      },
    },
    {
      name: effectToolNames["effect.github_pr_merge"],
      description: "Propose merging a pull request of an owner-configured GitHub remote, pinned to its current head SHA (the merge is refused if the head moved). Creates an approval card; nothing happens until the owner approves.",
      inputSchema: object({ remote: nameSchema, pullNumber: { type: "integer", minimum: 1 }, headSha: { type: "string", pattern: "^[0-9a-f]{40}$" },
        method: { type: "string", enum: ["merge", "squash", "rebase"] } }, ["remote", "pullNumber", "headSha"]),
      execution: "exclusive", effect: "mutating",
      async execute(input): Promise<ToolExecutionResult> {
        const args = input as { remote?: unknown; pullNumber?: unknown; headSha?: unknown; method?: unknown };
        const found = remote(args.remote, true);
        if (!("revision" in found)) return found;
        const method = args.method === undefined ? "merge" : args.method;
        if (method !== "merge" && method !== "squash" && method !== "rebase") return fail("method must be merge, squash or rebase.");
        return propose({ kind: "effect.github_pr_merge", remote: pinned(found), github: found.github!, pullNumber: Number(args.pullNumber), headSha: String(args.headSha ?? ""), method });
      },
    },
    {
      name: effectToolNames["effect.deploy"],
      description: "Propose running an owner-named deploy target. Creates an approval card; nothing happens until the owner approves.",
      inputSchema: object({ target: nameSchema, ref: { type: "string", maxLength: 200 } }, ["target"]),
      execution: "exclusive", effect: "mutating",
      async execute(input): Promise<ToolExecutionResult> {
        const args = input as { target?: unknown; ref?: unknown };
        if (typeof args.target !== "string" || !NAME.test(args.target)) return fail("target must be the name of a deploy target the owner configured.");
        const target = store.read(tx => readDeployTarget(tx, request.projectId, args.target as string));
        if (!target) return fail(`No owner-configured deploy target named ${args.target}.`);
        const ref = args.ref === undefined ? null : args.ref;
        if (ref !== null && !(validBranch(ref) || (typeof ref === "string" && SHA.test(ref)))) return fail("ref must be a branch name or a full commit SHA.");
        return propose({ kind: "effect.deploy", target: { name: target.name, url: target.url, revision: target.revision }, ref: ref as string | null });
      },
    },
  ];
}
