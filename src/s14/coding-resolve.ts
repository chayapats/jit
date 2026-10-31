import { AppError } from "../errors";
import { codingBranch, codingCommit, codingOrigin } from "./coding-protocol";
import type { CodingRepositoryFetch } from "./coding-types";

const schedule = (expire: () => void, timeoutMs: number) => { const timer = setTimeout(expire, timeoutMs); return () => clearTimeout(timer); };

/** Resolves one owner-selected branch through fixed anonymous GitHub HTTPS, with no Git process, credentials or repository code. */
export async function repositoryCommit(url: string, branch: string, allowed: () => void, transport: CodingRepositoryFetch = fetch,
  limits = { bytes: 65536, timeoutMs: 15000, schedule }): Promise<string> {
  codingOrigin(url); codingBranch(branch);
  const controller = new AbortController();
  const clear = limits.schedule(() => controller.abort(), limits.timeoutMs);
  const wait = async <T>(promise: Promise<T>): Promise<T> => {
    if (controller.signal.aborted) throw new AppError("coding_resolve_timeout", 409);
    let abort!: () => void;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        abort = () => reject(new AppError("coding_resolve_timeout", 409));
        controller.signal.addEventListener("abort", abort, { once: true });
      })]);
    } finally { controller.signal.removeEventListener("abort", abort); }
  };
  try {
    allowed();
    const path = url.slice("https://github.com/".length, -4);
    const response = await wait(transport(`https://api.github.com/repos/${path}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, {
      method: "GET", redirect: "error", signal: controller.signal,
      headers: { accept: "application/vnd.github+json", "accept-encoding": "identity", "x-github-api-version": "2022-11-28", "user-agent": "jit-s14" },
    }));
    const reader = response.body?.getReader();
    try {
      allowed();
      if (response.status === 404) throw new AppError("coding_branch_unavailable", 409);
      if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
          ![null, "identity"].includes(response.headers.get("content-encoding")) || !reader) throw new AppError("coding_resolve_unavailable", 503);
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limits.bytes)) throw new AppError("coding_resolve_size_limit", 413);
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const chunk = await wait(reader.read()); allowed();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > limits.bytes) throw new AppError("coding_resolve_size_limit", 413);
        chunks.push(chunk.value);
      }
      if (declared !== null && Number(declared) !== size) throw new AppError("coding_resolve_unconfirmed", 409);
      const value = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
      if (value?.ref !== `refs/heads/${branch}` || value?.object?.type !== "commit") throw new AppError("coding_resolve_unconfirmed", 409);
      codingCommit(value.object.sha);
      allowed();
      return value.object.sha;
    } finally { void reader?.cancel().catch(() => {}); }
  } catch (error) {
    if (controller.signal.aborted) throw new AppError("coding_resolve_timeout", 409);
    if (error instanceof AppError) throw error;
    throw new AppError("coding_resolve_unavailable", 503);
  } finally { clear(); controller.abort(); }
}

/** Resolves an exact private branch only in the bounded trusted Git broker, never checking out repository code. */
export async function privateRepositoryCommit(url: string, branch: string, secret: string, allowed: () => void,
  limits?: import("./coding-git-limits").GitProcessLimits): Promise<string> {
  codingOrigin(url); codingBranch(branch);
  const { CodingGitMirror, brokerGit } = await import("./coding-git-mirror");
  const mirror = new CodingGitMirror(limits);
  try {
    allowed();
    const result = await brokerGit(mirror.directory, ["-c", "protocol.https.allow=always", "ls-remote", "--refs", "--", url, `refs/heads/${branch}`], secret, { limits: mirror.limits });
    allowed();
    const match = /^([a-f0-9]{40})\t([^\n]+)\n?$/.exec(result.stdout);
    if (result.code !== 0 || !match || match[2] !== `refs/heads/${branch}`) throw new AppError("coding_branch_unavailable", 409);
    codingCommit(match[1]);
    return match[1]!;
  } finally { mirror.close(); }
}
