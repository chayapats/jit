import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertRootPath, assertRootTree, UnsafeRootPath, type RootPathPolicy } from "../../ops/package/trusted-paths";
import { serviceUnit, serviceJournal, type ServiceConfig } from "../../ops/package/service-config";
import type { OperatorHost } from "./service-package";

/** Exact copy command in the operator runbook; the destination must first be a fresh private root-owned directory. */
export const rootSnapshotCopyCommand = 'sudo cp -R --no-dereference -- "$newDir" "$snapshot/artifact"';

/** CLI-only refusal: names the unsafe path and the protected-copy procedure, never file contents. */
export function rootPathFailure(error: UnsafeRootPath): { error: string; path: string; nextAction: string } {
  return { error: error.message, path: error.path, nextAction: `Copy the release into a root-owned directory: ${rootSnapshotCopyCommand}. Follow docs/runbooks/ops-service.md section 1; use root-owned Bun, config and unit paths without symlinks or group/other write.` };
}

/** Recovers Linux's original script spelling before Bun realpaths argv[1]; unsupported wrappers fail closed. Raw cmdline/cwd are injectable fixtures. */
export function serviceInvocationPath(argv: string[], raw = readFileSync("/proc/self/cmdline", "utf8"), cwd = process.cwd()): string {
  const original = raw.split("\0");
  if (original.at(-1) === "") original.pop();
  const tail = argv.slice(2), entry = original.length - tail.length - 1;
  if (entry < 1 || !original[entry] || original[entry]!.startsWith("-") || tail.some((arg, i) => original[entry + 1 + i] !== arg)) {
    throw new UnsafeRootPath(argv[1] ?? "<service-entry>");
  }
  return resolve(cwd, original[entry]!);
}

/** Validates the running CLI before application imports, its invocation path, Bun and ancestor dependency/config lookup locations. */
export function assertServiceRuntime(runtimeDir: string, bunPath: string, policy: RootPathPolicy = {}, entryPath?: string): void {
  if (entryPath) {
    const activation = ["opt/jit/current", "opt/jit-s14/current"].map(path => join(resolve(policy.root ?? "/"), path)).find(path => resolve(entryPath) === join(path, "src/main.ts"));
    if (activation) {
      // This is the sole admitted alias. Check its parent/link before reading the direct protected target,
      // and bind it to the release whose bootstrap code is running, not an arbitrary root-owned tree.
      assertServiceRelease(activation, policy);
      const target = resolve(dirname(activation), readlinkSync(activation));
      if (target !== resolve(runtimeDir)) throw new UnsafeRootPath(entryPath);
      assertRootTree(join(target, "src/main.ts"), policy);
    } else assertRootTree(entryPath, policy);
  }
  assertRootPath(bunPath, policy);
  assertRootTree(runtimeDir, policy);
  const boundary = resolve(policy.root ?? "/");
  for (let parent = resolve(runtimeDir); parent !== boundary;) {
    parent = dirname(parent);
    for (const name of ["node_modules", "package.json", "tsconfig.json", "bunfig.toml"]) {
      const path = join(parent, name);
      assertRootPath(path, policy);
      try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      assertRootTree(path, policy);
    }
  }
}

/** Checks a managed root-owned activation link without following an unchecked link or mutable ancestor; validates the fixed target tree. */
export function assertServiceRelease(activePath: string, policy: RootPathPolicy): void {
  assertRootPath(dirname(activePath), policy);
  let stats;
  try { stats = (policy.lstat ?? lstatSync)(activePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!stats.isSymbolicLink()) { assertRootTree(activePath, policy); return; }
  // Symlink mode bits are always 0777 on Linux; only its owner and protected parent can replace it.
  if (stats.uid !== (policy.uid ?? 0)) throw new UnsafeRootPath(activePath);
  assertRootTree(resolve(dirname(activePath), readlinkSync(activePath)), policy);
}

/** Protects every package config/unit/release location before lifecycle reads or effects; service-owned state is outside this code boundary. */
export function assertServicePaths(service: ServiceConfig, host: OperatorHost, policy: RootPathPolicy): void {
  for (const path of [host.configDir, host.unitDir, host.journaldDir, join(host.configDir, "service-config.json"),
    join(host.unitDir, serviceUnit(service)), join(host.journaldDir, `journald@${serviceJournal(service)}.conf`), join(dirname(service.executablePath), "releases")]) assertRootPath(path, policy);
  const dropins = join(host.unitDir, `${serviceUnit(service)}.d`);
  assertRootPath(dropins, policy);
  let present = true;
  try { lstatSync(dropins); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; present = false; }
  if (present) assertRootTree(dropins, policy);
  assertServiceRelease(service.executablePath, policy);
}
