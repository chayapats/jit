import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "../../../src/ops/supervisor";

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
        if (present.exitCode === 0 && !present.timedOut) { images[target] = existing; continue; }
      }
      const built = await run(asUser([...podman, "build", "--target", target, "-f", join(release, "ops/box/Containerfile"), "-t", `${name}:installed`, release]), { timeoutMs: 600_000 });
      if (built.exitCode !== 0 || built.timedOut) return;
      const inspected = await run(asUser([...podman, "image", "inspect", "--format", "{{.Digest}}", `${name}:installed`]), { timeoutMs: 10_000 });
      const digest = inspected.stdout.trim();
      if (inspected.exitCode !== 0 || inspected.timedOut || !/^sha256:[a-f0-9]{64}$/.test(digest)) return;
      const ref = `${name}@${digest}`;
      const verified = await run(asUser([...podman, "image", "exists", ref]), { timeoutMs: 10_000 });
      if (verified.exitCode !== 0 || verified.timedOut) return;
      images[target] = ref;
    }
    return { base: images.base!, browser: images.browser!, buildInputsHash: inputsHash };
  } catch { return; }
}
