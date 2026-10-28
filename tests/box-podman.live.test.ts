// Opt-in live evidence for exec.box_runtime/v1 on a real rootless Podman (EXE03). Skipped unless JIT_LIVE_PODMAN=1.
//
//   JIT_LIVE_PODMAN=1 JIT_LIVE_BOX_IMAGE=<name>@sha256:<digest> bun test tests/box-podman.live.test.ts
//
// The image is the `base` target of ops/box/Containerfile (built with `bun ops/box/build.ts --target base --tag <tag>`,
// which prints the digest). The test needs outbound HTTPS to registry.npmjs.org from the host. It creates one box
// for a throwaway project id and removes it, its workspace and its network container at the end.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../src/config";
import { createBoxBackend } from "../src/exec/box-backend";
import { PodmanBoxRuntime, podmanCommandRunner } from "../src/exec/podman-runtime";
import { startRegistryProxy, type RegistryProxy } from "../src/exec/registry-proxy";

const live = process.env.JIT_LIVE_PODMAN === "1";
const image = process.env.JIT_LIVE_BOX_IMAGE ?? "";
const root = live ? realpathSync(mkdtempSync(join(tmpdir(), "jit-live-box-"))) : "";
const projectId = crypto.randomUUID();
let proxy: RegistryProxy | null = null;
const runtime = live ? new PodmanBoxRuntime({
  config: readConfig({ JIT_EXECUTION_DIR: join(root, "execution"), JIT_EXECUTION_SECRETS_DIR: join(root, "secrets"), JIT_BOX_IMAGE_BASE: image }).execution,
  registryProxy: async gateway => (proxy ??= await startRegistryProxy({ hostname: gateway, port: 0, hosts: ["registry.npmjs.org"] })).url,
}) : null;

afterAll(async () => {
  if (!live) return;
  await runtime!.reset({ projectId }, { wipeWorkspace: true }).catch(() => undefined);
  await proxy?.close();
  rmSync(root, { recursive: true, force: true });
});

test.skipIf(!live)("a real box mounts only the workspace, has no capabilities, no Jit environment, and the internal network allows only the registry", async () => {
  expect(image).toMatch(/@sha256:[a-f0-9]{64}$/);
  const handle = await runtime!.ensure(projectId, "workspace");
  const inspected = JSON.parse(new TextDecoder().decode((await podmanCommandRunner()(["container", "inspect", handle.name], { timeoutMs: 30_000 })).stdout));
  expect(inspected[0].Mounts.map((mount: { Destination: string }) => mount.Destination)).toEqual(["/workspace"]);
  const backend = createBoxBackend(runtime!, handle);
  const sh = (command: string, timeoutMs = 60_000) => backend.spawn({ command, cwd: "/workspace", timeoutMs });
  expect((await sh("grep CapEff /proc/self/status")).stdout).toMatch(/CapEff:\s+0000000000000000/);
  const env = (await sh("env")).stdout;
  expect(env).not.toMatch(/^JIT_/m);
  for (const path of [root, join(root, "secrets")]) expect((await sh(`test -e ${path} && echo present || echo absent`)).stdout.trim()).toBe("absent");
  expect((await sh("touch /etc/x 2>&1; echo $?")).stdout.trim()).not.toBe("0");
  // Direct egress has no route; the proxy refuses other hosts and tunnels the allowlisted registry.
  expect((await sh("curl -s -o /dev/null --noproxy '*' -m 5 https://example.com; echo $?")).stdout.trim()).not.toBe("0");
  expect((await sh("curl -s -o /dev/null -w '%{http_code}' -m 10 https://example.com; echo \" $?\"")).stdout).not.toMatch(/^200/);
  expect((await sh("curl -s -o /dev/null -w '%{http_code}' -m 20 https://registry.npmjs.org/")).stdout).toBe("200");
}, 180_000);
