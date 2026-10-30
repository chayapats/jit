import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// External consumer installs the exact tarball rather than resolving workspace/private Schway sources.
test("packed public consumer proves concurrent renewal, cancellation, close and exact-route logout", async () => {
  const root = mkdtempSync(join(tmpdir(), "jit-s14-packed-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", dependencies: { schway: `file:${resolve("vendor/schway-1.0.0-rc.2-697bf40.tgz")}` } }));
    const fixture = readFileSync(join(import.meta.dir, "fixtures/s14-host-consumer.ts"), "utf8");
    expect([...fixture.matchAll(/from "([^"]+)"/g)].map(m => m[1])).toEqual(["schway/host"]);
    writeFileSync(join(root, "consumer.ts"), fixture);
    const install = Bun.spawn([process.execPath, "install", "--ignore-scripts"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, _out, error] = await Promise.all([install.exited, new Response(install.stdout).text(), new Response(install.stderr).text()]);
    expect(code, error).toBe(0);
    const run = Bun.spawn([process.execPath, "--no-env-file", "consumer.ts"], { cwd: root, stdin: new Blob([JSON.stringify({ root })]), stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
    expect(exit, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ refreshes: 1, calls: 2, sibling: "completed", cancelled: "cancelled", close: "safe", logout: "route_scoped" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);
