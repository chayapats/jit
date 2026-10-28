/**
 * ops.box_image/v1 build helper.
 * Builds the `base` or `browser` target from `ops/box/Containerfile` with Podman.
 */

export type BoxTarget = "base" | "browser";

const tagPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Returns the `podman` CLI arguments that build one box image target.
 * The tag is validated; anything else throws `invalid_box_tag`.
 */
export function buildArgs(target: BoxTarget, tag: string): string[] {
  if ((target !== "base" && target !== "browser") || !tagPattern.test(tag)) {
    throw new Error("invalid_box_tag");
  }
  return ["build", "--target", target, "-f", "ops/box/Containerfile", "-t", `jit-box-${target}:${tag}`, "."];
}

function parseBuildArgs(argv: string[]): { target: BoxTarget; tag: string } {
  let target: string | null = null;
  let tag: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") target = argv[++i] ?? null;
    else if (argv[i] === "--tag") tag = argv[++i] ?? null;
    else throw new Error("invalid_box_tag");
  }
  if ((target !== "base" && target !== "browser") || tag === null || !tagPattern.test(tag)) {
    throw new Error("invalid_box_tag");
  }
  return { target, tag };
}

function main(): void {
  const { target, tag } = parseBuildArgs(process.argv.slice(2));
  const image = `jit-box-${target}:${tag}`;
  const built = Bun.spawnSync(["podman", ...buildArgs(target, tag)], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (built.exitCode !== 0) process.exit(built.exitCode);
  const inspected = Bun.spawnSync(["podman", "image", "inspect", "--format", "{{.Digest}}", image], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (inspected.exitCode !== 0) {
    console.error(`podman image inspect failed for ${image}`);
    process.exit(inspected.exitCode);
  }
  const digest = new TextDecoder().decode(inspected.stdout).trim();
  console.log(JSON.stringify({ image, digest }));
}

if (import.meta.main) main();
