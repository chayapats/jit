import type { ExecutionBackend } from "schway/host";
import { AppError } from "../errors";
import { codingCommit, codingGit, codingGitOutput, codingPath, codingQuote } from "./coding-protocol";

const rawAttributes = "* -filter -text -ident -working-tree-encoding\n";

async function clone(backend: ExecutionBackend, source: string, target: string, signal?: AbortSignal): Promise<void> {
  codingGitOutput(await codingGit(backend, "/workspace", ["-c", "protocol.file.allow=always", "clone", "--template=", "--no-local", "--no-hardlinks", "--no-checkout", "--", source, target], signal));
  await codingPath(backend, target);
  codingGitOutput(await codingGit(backend, target, ["remote", "remove", "origin"], signal));
  codingGitOutput(await backend.spawn({ cwd: "/workspace", command: `mkdir -p -- ${codingQuote(`${target}/.git/info`)}`, timeoutMs: 10000, ...(signal ? { signal } : {}) }));
  // info/attributes outranks repository attributes, including nested files. No conversion may hide bytes.
  await backend.writeFileAtomically(`${target}/.git/info/attributes`, rawAttributes);
}

/** Replaces the editable draft with a fresh raw checkout of the recorded commit inside the same capped box. */
export async function codingEvidenceCheckout(backend: ExecutionBackend, path: string, head: string, branch: string, signal: AbortSignal): Promise<void> {
  codingCommit(head);
  await codingPath(backend, path);
  const draft = `${path}_draft`;
  if ((await backend.list("/workspace/coding")).some(entry => entry.name === draft.split("/").at(-1))) throw new AppError("coding_evidence_path_refused", 409);
  codingGitOutput(await backend.spawn({ cwd: "/workspace", command: `mv -- ${codingQuote(path)} ${codingQuote(draft)}`, timeoutMs: 10000, signal }));
  await clone(backend, draft, path, signal);
  codingGitOutput(await codingGit(backend, path, ["checkout", "--no-track", "-B", branch, head, "--"], signal));
}

/** Uses fresh Git metadata/index and raw bytes for evidence/export; never trusts the checked tree's index, config or filters. */
export async function codingSnapshot<T>(backend: ExecutionBackend, path: string, head: string,
  use: (git: (args: string[]) => Promise<string>, unchanged: boolean) => Promise<T>, signal?: AbortSignal): Promise<T> {
  codingCommit(head);
  await codingPath(backend, path);
  const scratch = `/workspace/coding/verify_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await clone(backend, path, scratch, signal);
    const git = async (args: string[]) => codingGitOutput(await codingGit(backend, scratch, args, signal));
    const current = (await git(["rev-parse", "HEAD"])).trim();
    await git(["read-tree", head]);
    await git(["--work-tree", path, "-c", "core.filemode=true", "-c", "core.ignorecase=false", "add", "--all"]);
    const tree = (await git(["write-tree"])).trim();
    const expected = (await git(["rev-parse", `${head}^{tree}`])).trim();
    return await use(git, current === head && tree === expected);
  } finally {
    codingGitOutput(await backend.spawn({ cwd: "/workspace", command: `rm -rf -- ${codingQuote(scratch)}`, timeoutMs: 10000 }));
  }
}
