import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// MODEL15-02 (#372): an external consumer installs the exact vendored tarball and proves dispatch
// authorization, exact provider requests, effort pins and output caps through `schway/host` only.
test("packed public consumer proves per-send authorization, exact HostDispatch and providerRequests, pins, caps and route renewal", async () => {
  const root = mkdtempSync(join(tmpdir(), "jit-s15-dispatch-packed-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", dependencies: { schway: `file:${resolve("vendor/schway-1.0.0-rc.2-39194f7.tgz")}` } }));
    const fixture = readFileSync(join(import.meta.dir, "fixtures/s15-model-dispatch-consumer.ts"), "utf8");
    expect([...fixture.matchAll(/from "([^"]+)"/g)].map(m => m[1]).filter(name => !name!.startsWith("node:"))).toEqual(["schway/host"]);
    writeFileSync(join(root, "consumer.ts"), fixture);
    const install = Bun.spawn([process.execPath, "install", "--ignore-scripts"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, _out, error] = await Promise.all([install.exited, new Response(install.stdout).text(), new Response(install.stderr).text()]);
    expect(code, error).toBe(0);
    for (const part of ["workspace", "home", "sessions"]) mkdirSync(join(root, "headless", part), { recursive: true });
    writeFileSync(join(root, "headless.ts"), `
      const loaded: string[] = [];
      Bun.plugin({name:"record-headless-loads",setup(build){build.onLoad({filter:new RegExp("schway/src/.*[.]tsx?$|@opentui/")},async args=>{loaded.push(args.path);return {contents:await Bun.file(args.path).text(),loader:args.path.endsWith(".tsx")?"tsx":args.path.endsWith(".ts")?"ts":"js"};});}});
      const {createHost} = await import("schway/host");
      const host=await createHost({workspaceRoot:${JSON.stringify(join(root, "headless/workspace"))},homeDirectory:${JSON.stringify(join(root, "headless/home"))},sessionDirectory:${JSON.stringify(join(root, "headless/sessions"))},
        context:{policy:"strict",systemPrompt:"Headless import fixture",sections:[],sources:[]},tools:{policy:"exact",definitions:[],hostedLookup:"off"},
        limits:{maxTurns:1,maxConcurrentTools:1,contextWindow:32768,maxInputChars:16384,deadlineMs:10000,maxAttempts:1}});
      await host.close();
      console.log(JSON.stringify(loaded));
    `);
    const headless = Bun.spawn([process.execPath, "--no-env-file", "headless.ts"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [headlessExit, headlessOut, headlessError] = await Promise.all([headless.exited, new Response(headless.stdout).text(), new Response(headless.stderr).text()]);
    expect(headlessExit, headlessError).toBe(0);
    const loaded = JSON.parse(headlessOut) as string[];
    expect(loaded.some(path => path.includes("schway/src/host/index.ts"))).toBe(true);
    expect(loaded.filter(path => /\/(?:tui|cli|model\/providers)\/|@opentui\//.test(path))).toEqual([]);
    const run = Bun.spawn([process.execPath, "--no-env-file", "consumer.ts"], { cwd: root, stdin: new Blob([JSON.stringify({ root })]), stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
    expect(exit, stderr).toBe(0);
    const send = (kind: string, sequence: number) => ({ route: "grok", provider: "xai", model: "grok-4.7", kind, sequence, hashMatches: true, effort: { requested: "low", sent: "low" }, outputCap: { sent: 2048 } });
    expect(JSON.parse(stdout)).toEqual({
      renewal: { beforeListing: "needs-login", outcome: "renewed", requests: 1, again: "fresh", againRequests: 0, afterListing: "listed", tokenRequests: 1, inference: 0 },
      dispatches: [send("initial", 1), send("auth-retry", 2)],
      providerRequests: { initialSends: 1, authRetrySends: 1, renewalRequests: 1 },
      attempt: { effort: { requested: "low", sent: "low", reported: null }, outputCap: { sent: 2048 } }, renewals: 1,
      choice: { effort: { levels: ["low", "high"], offSendable: false, default: null, evidence: "account-catalog" }, outputCap: { enforced: true, default: 16384, maximum: 16384 } },
      codexCap: { enforced: false, default: null, maximum: null }, codexCapRefused: true,
      refusal: { identity: true, cause: true, copiedWording: false, sent: 0 },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60000);
