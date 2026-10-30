import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [], children = new Set<ReturnType<typeof worker>>();
function worker(path: string) {
  const process = Bun.spawn([Bun.which("bun")!, "--no-env-file", join(import.meta.dir, "fixtures/s14-lock-worker.ts"), path], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = process.stdout.getReader(); let pending = "";
  return { process, async line(): Promise<string> {
    while (!pending.includes("\n")) { const chunk = await reader.read(); if (chunk.done) throw Error(`lock_worker_exited:${pending}`); pending += new TextDecoder().decode(chunk.value); }
    const newline = pending.indexOf("\n"), line = pending.slice(0, newline); pending = pending.slice(newline + 1); return line;
  }, start() { process.stdin.write("start"); process.stdin.end(); } };
}
afterEach(async () => {
  for (const child of children) { child.process.kill("SIGKILL"); await child.process.exited; }
  children.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("OS runtime lock admits only one crash-takeover contender and a loser cannot release the winner", async () => {
  const root = mkdtempSync(join(tmpdir(), "jit-s14-lock-")); roots.push(root);
  const path = join(root, "s14.sqlite"), lockPath = `${path}.runtime-lock.sqlite`;
  writeFileSync(`${path}.runtime-lock`, "2147483647"); // Obsolete PID marker is never removed or trusted.
  async function contender() { const child = worker(path); children.add(child); expect(await child.line()).toBe("ready"); return child; }
  const stale = await contender(); stale.start(); expect(await stale.line()).toBe("held");
  const inode = statSync(lockPath).ino;
  stale.process.kill("SIGKILL"); await stale.process.exited; children.delete(stale);
  const [a, b] = await Promise.all([contender(), contender()]); a.start(); b.start();
  const outcomes = await Promise.all([a.line(), b.line()]); expect([...outcomes].sort()).toEqual(["held", "s14_runtime_already_open"]);
  const winner = outcomes[0] === "held" ? a : b, loser = winner === a ? b : a;
  expect(await loser.process.exited).toBe(0); expect(await new Response(loser.process.stderr).text()).toBe(""); children.delete(loser);
  const third = await contender(); third.start(); expect(await third.line()).toBe("s14_runtime_already_open");
  expect(await third.process.exited).toBe(0); children.delete(third);
  expect(statSync(lockPath).ino).toBe(inode);
  expect(readFileSync(`${path}.runtime-lock`, "utf8")).toBe("2147483647");
  winner.process.kill("SIGKILL"); await winner.process.exited; children.delete(winner);
  const replacement = await contender(); replacement.start(); expect(await replacement.line()).toBe("held");
  expect(statSync(lockPath).ino).toBe(inode);
});
