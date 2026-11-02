import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coreToolDefinitions } from "schway/host";
import { createBoxBackend } from "../src/exec/box-backend";
import { createGithubVmWorkspace, ProtectedGithubPush, type GithubEffect } from "../src/s15/github";
import type { BotComputer, ComputerHandle } from "../src/s14/computer-types";
import { CodingRuntimeFixture, codingScript } from "./fixtures/s14-coding";
import { githubFixture, type GithubFixture } from "./fixtures/s15-github";
import { ref } from "./fixtures/s15-policy";
const fixtures: GithubFixture[] = [], roots: string[] = [];
afterEach(() => { fixtures.splice(0).forEach(f => f.cleanup()); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });

test.each([true, false])("real VM-protocol files, Bun tests and immutable bundle (execution settled=%s)", async executionSettled => {
  const f = githubFixture("personal"); fixtures.push(f);
  const runtime = new CodingRuntimeFixture(); roots.push(runtime.root); const initial = await runtime.seed();
  writeFileSync(runtime.local("/workspace/repositories/repo/behavior.test.ts"), 'import {test,expect} from "bun:test"; test("selected behavior",()=>expect(Bun.file("answer.txt").text()).resolves.toBe("fixed\\n"));\n');
  await runtime.git("add", "."); await runtime.git("commit", "-qm", "Add actual Bun acceptance check"); const base = await runtime.git("rev-parse", "HEAD");
  f.protocol.value.base = base; const report = await f.service.discover(f.inspect.actor!, "repo"), selected = await f.service.select(f.work.actor!, { requestId: "actual_selection", reportId: report.id, issue: 42, base, issueVersion: "issue_1" });
  const actor = f.work.actor!, authority = f.f.service.work.guard(actor), handle = { computerId: "fixture", generation: 1 } as ComputerHandle;
  runtime.handles.set(handle, {} as BotComputer);
  const backend = createBoxBackend({ exec: (_h, request) => runtime.exec(handle, request, () => f.f.service.work.guard(actor)) }, { projectId: "fixture", name: "fixture", mode: "workspace", profile: false, workspaceRoot: "/workspace", temporaryDirectory: "/tmp" });
  const path = `/workspace/coding/${selected.id}`; let closed = 0, captured: Uint8Array | null = null;
  const script = codingScript(() => path, true, p => `printf 'fixed\\n' > '${p}/answer.txt' && git -C '${p}' -c core.hooksPath=/dev/null -c user.name=Fixture -c user.email=fixture@invalid add answer.txt && git -C '${p}' -c core.hooksPath=/dev/null -c user.name=Fixture -c user.email=fixture@invalid commit -qm 'Fix selected behavior'`);
  const workspace = createGithubVmWorkspace({ vm: { async openAttempt() { return { backend, definitions: coreToolDefinitions(backend), evidence: () => [{ transport: "closed", execution: closed && executionSettled ? "guest_scope_empty" : "unsettled" }], async cancel() {}, async close() { closed++; } }; } }, vmId: "vm", policy: f.f.service, nativeDirectory: join(f.f.dir, "native"), route: { provider: "codex", model: "scripted" }, scripted: { ...script, provider: "codex", id: "scripted" }, modelCallUpperBound: f.limits.actionUpperBound, maxTurns: 4, activeMs: 30000, maxBundleBytes: 1024 * 1024, tests: [{ command: "bun test", timeoutMs: 10000 }],
    async preload(b) { const r = await b.spawn({ cwd: "/workspace", command: `mkdir -p /workspace/coding && git -c core.hooksPath=/dev/null -c protocol.file.allow=always clone --no-local --template= /workspace/repositories/repo '${path}'`, timeoutMs: 10000 }); if (r.exitCode !== 0) throw new Error("preload failed"); return path; },
    capture(bytes) { captured = bytes; return ref("bundle"); }, verifyCriteria({ criteria, evidence }) { return criteria.map(c => ({ id: c.id, passed: evidence.tests.every(t => t.exitCode === 0), evidence: [evidence.source] })); },
  });
  const evidence = await workspace.implement({ selection: selected, issue: f.protocol.value.issues[0]!, authority, findings: [], guard() { f.f.service.work.guard(actor); } });
  expect(closed).toBe(1); expect(evidence.tests[0]!.exitCode).toBe(0); expect(evidence.criteria[0]!.passed).toBe(true);
  expect(evidence.head).not.toBe(base); expect(evidence.diffHash).toMatch(/^[a-f0-9]{64}$/); expect(captured!.length).toBeGreaterThan(100);
  expect(evidence.settlement.executionSettled).toBe(executionSettled); expect(readFileSync(runtime.local(`${path}/answer.txt`), "utf8")).toBe("fixed\n"); expect(existsSync(join(runtime.root, "hook-ran"))).toBe(false);
  expect(f.protocol.calls).toHaveLength(0); expect(initial).not.toBe(base);
  if (executionSettled) {
    let finalArgv: string[] = [], sends = 0;
    const push = new ProtectedGithubPush({ bundle: () => captured!, limits: { createDirectory() { return mkdtempSync(join(runtime.root, "protected-")); }, async command(_directory, argv) { if (argv.includes("push")) { finalArgv = argv; return ["/bin/sh", "-c", "exit 0"]; } return argv; } } });
    const effect: GithubEffect = { contract: "s15-github-effect/v1", key: "actual_push", repository: selected.repository.name, target: "main", issue: 42, head: evidence.head, base, branch: selected.branch, evidenceHash: evidence.diffHash, snapshotVersion: "v1", operation: { kind: "push", branch: selected.branch, previous: null }, bundle: evidence.bundle, diffHash: evidence.diffHash, mergeRequirements: null };
    const dispatch = async (send: () => Promise<import("../src/s15/github").GithubEffectResult>) => { sends++; const r = await send(); return { outcome: r.outcome === "rejected" ? "failed" as const : r.outcome, actual: { attempts: null, steps: null, calls: null, reads: null, outputBytes: null, activeMs: null, spendMinor: null }, transportSettled: true }; };
    expect((await push.push(effect, "protected_fixture_identity", dispatch)).outcome).toBe("succeeded");
    expect(finalArgv).toContain(`--force-with-lease=refs/heads/${selected.branch}:`); expect(sends).toBe(1);
    await expect(push.push({ ...effect, diffHash: "f".repeat(64) }, "protected_fixture_identity", dispatch)).rejects.toThrow("github_diff_changed"); expect(sends).toBe(1);
  }
}, 30000);
