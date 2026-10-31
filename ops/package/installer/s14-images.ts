import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "../../../src/ops/supervisor";
import { botComputerUserNamespace } from "../../../src/s14/computer-types";
import { pinnedImagePattern } from "../../../src/exec/box-runtime";

/** Prepares cached ID-mapped layers as the service identity, without starting processes or mounting Bot data. */
export async function prepareS14Image(image: string, uid: number, run: CommandRunner, asUser: (args: string[]) => string[]): Promise<boolean> {
  if (!pinnedImagePattern.test(image)) return false;
  const podman = ["podman", "--remote", "--url", `unix:///run/user/${uid}/podman/podman.sock`];
  const name = `jit-s14-image-prepare-${crypto.randomUUID()}`;
  let prepared = false, removed = false;
  try {
    // create materializes Podman's MappedTopLayers cache. A plain image build/exists does not.
    // Keep the runtime mapping intact; slow disks do this work outside the 30-second admission window.
    const result = await run(asUser([...podman, "create", "--name", name, "--pull=never", "--http-proxy=false", "--unsetenv-all",
      `--userns=${botComputerUserNamespace}`, "--user=1000:1000", "--network=none", "--read-only", "--cap-drop=ALL",
      "--security-opt=no-new-privileges", "--log-driver=none", "--no-healthcheck", "--entrypoint", "/usr/bin/true", image]), { timeoutMs: 600_000 });
    prepared = result.exitCode === 0 && !result.timedOut;
  } catch { /* Cleanup also runs when the client throws or times out. */ }
  finally {
    try {
      const result = await run(asUser([...podman, "rm", "--force", "--ignore", name]), { timeoutMs: 30_000 });
      removed = result.exitCode === 0 && !result.timedOut;
    } catch { /* Unconfirmed cleanup cannot certify preparation. */ }
  }
  return prepared && removed;
}

function buildInputsHash(release: string): string {
  const root = join(release, "ops/box"), hash = createHash("sha256");
  const visit = (directory: string) => {
    for (const name of readdirSync(join(root, directory)).sort()) {
      const relative = join(directory, name), path = join(root, relative), stat = lstatSync(path);
      if (stat.isDirectory()) visit(relative);
      else if (stat.isFile()) hash.update(JSON.stringify([relative, stat.mode & 0o777,
        createHash("sha256").update(readFileSync(path)).digest("hex")]));
      else throw new Error("unsupported_image_build_input");
    }
  };
  visit("");
  return hash.digest("hex");
}

/** Builds both packaged Bot targets as the service identity and pins verified local manifest digests, never tags. Reuse requires the same packaged ops/box input hash. */
export async function provisionS14Images(release: string, uid: number, run: CommandRunner, asUser: (args: string[]) => string[],
  current?: { base: string; browser: string; buildInputsHash?: string }): Promise<{ base: string; browser: string; buildInputsHash: string } | undefined> {
  const images: Record<string, string> = {};
  try {
    const inputsHash = buildInputsHash(release);
    for (const target of ["base", "browser"]) {
      const name = `localhost/jit-s14-${target}`;
      const podman = ["podman", "--remote", "--url", `unix:///run/user/${uid}/podman/podman.sock`];
      const existing = current?.[target as "base" | "browser"];
      if (current?.buildInputsHash === inputsHash && existing && /^[a-z0-9][a-z0-9._/-]{0,127}@sha256:[a-f0-9]{64}$/.test(existing)) {
        const present = await run(asUser([...podman, "image", "exists", existing]), { timeoutMs: 10_000 });
        if (present.exitCode === 0 && !present.timedOut) {
          if (!await prepareS14Image(existing, uid, run, asUser)) return;
          images[target] = existing; continue;
        }
      }
      const built = await run(asUser([...podman, "build", "--target", target, "-f", join(release, "ops/box/Containerfile"), "-t", `${name}:installed`, release]), { timeoutMs: 600_000 });
      if (built.exitCode !== 0 || built.timedOut) return;
      const inspected = await run(asUser([...podman, "image", "inspect", "--format", "{{.Digest}}", `${name}:installed`]), { timeoutMs: 10_000 });
      const digest = inspected.stdout.trim();
      if (inspected.exitCode !== 0 || inspected.timedOut || !/^sha256:[a-f0-9]{64}$/.test(digest)) return;
      const ref = `${name}@${digest}`;
      const verified = await run(asUser([...podman, "image", "exists", ref]), { timeoutMs: 10_000 });
      if (verified.exitCode !== 0 || verified.timedOut) return;
      if (!await prepareS14Image(ref, uid, run, asUser)) return;
      images[target] = ref;
    }
    return { base: images.base!, browser: images.browser!, buildInputsHash: inputsHash };
  } catch { return; }
}
