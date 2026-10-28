import type { AppConfig } from "../config";

/** One `box-doctor` result row. `nextAction` is null only for passing checks. */
export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  nextAction: string | null;
}

/** `ops.box_doctor/v1` report: ten ordered checks, `ok` only when all pass. */
export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

/** Injected host access. Unit tests provide scripted `run`/`stat`. */
export interface BoxDoctorDeps {
  run(cmd: string[]): { exitCode: number; stdout: string };
  stat(path: string): { uid: number; mode: number } | null;
  uid: number;
}

/**
 * Parses `podman --version` output (for example `podman version 4.9.3`).
 * Returns the major/minor pair, or null when the version cannot be read.
 */
export function parsePodmanVersion(stdout: string): { major: number; minor: number } | null {
  const match = /(\d+)\.(\d+)\.\d+/.exec(stdout);
  if (!match) return null;
  const major = Number(match[1]), minor = Number(match[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return null;
  return { major, minor };
}

/**
 * Parses `podman info --format json` output.
 * Reads `host.security.rootless`, `host.cgroupVersion` and `host.cgroupControllers`.
 */
export function parsePodmanInfo(json: string): { rootless: boolean; cgroupVersion: string; controllers: string[] } {
  const parsed = JSON.parse(json) as {
    host?: { security?: { rootless?: unknown }; cgroupVersion?: unknown; cgroupControllers?: unknown };
  };
  const host = parsed?.host ?? {};
  const security = (host.security ?? {}) as { rootless?: unknown };
  const cgroupVersion = typeof host.cgroupVersion === "string" ? host.cgroupVersion : "";
  const rawControllers = Array.isArray(host.cgroupControllers) ? host.cgroupControllers : [];
  const controllers = (rawControllers as unknown[]).filter((c): c is string => typeof c === "string");
  return { rootless: security.rootless === true, cgroupVersion, controllers };
}

const checkNames = [
  "podman-installed",
  "podman-version>=4.4",
  "rootless",
  "cgroup-v2",
  "controllers",
  "execution-configured",
  "image-base-present",
  "image-browser-present",
  "execution-directory",
  "secrets-directory",
] as const;

/**
 * Checks host readiness for rootless Podman boxes.
 * Pure except for the injected `run`/`stat`; never calls Podman directly.
 */
export function boxDoctor(deps: BoxDoctorDeps, config: AppConfig["execution"]): DoctorReport {
  const checks: DoctorCheck[] = [];
  const fail = (name: string, detail: string, nextAction: string): DoctorCheck => ({ name, ok: false, detail, nextAction });
  const pass = (name: string, detail: string): DoctorCheck => ({ name, ok: true, detail, nextAction: null });

  const versionOut = deps.run(["podman", "--version"]);
  const installed = versionOut.exitCode !== 127 && versionOut.exitCode === 0;
  if (versionOut.exitCode === 127 || versionOut.exitCode !== 0) {
    checks.push(fail("podman-installed", "podman is not installed or not on PATH", "install-podman"));
  } else {
    checks.push(pass("podman-installed", "podman is installed"));
  }

  const parsedVersion = installed ? parsePodmanVersion(versionOut.stdout) : null;
  const versionOk = parsedVersion !== null && (parsedVersion.major > 4 || (parsedVersion.major === 4 && parsedVersion.minor >= 4));
  if (!installed) {
    checks.push(fail("podman-version>=4.4", "podman version is unknown because podman is not installed", "install-podman"));
  } else if (!versionOk) {
    checks.push(fail("podman-version>=4.4", `podman version is too old: ${versionOut.stdout.trim()}`, "upgrade-podman-to-4.4"));
  } else {
    checks.push(pass("podman-version>=4.4", `podman version ${parsedVersion!.major}.${parsedVersion!.minor} meets 4.4`));
  }

  let info: { rootless: boolean; cgroupVersion: string; controllers: string[] } | null = null;
  if (installed) {
    const infoOut = deps.run(["podman", "info", "--format", "json"]);
    if (infoOut.exitCode === 0) {
      try {
        info = parsePodmanInfo(infoOut.stdout);
      } catch {
        info = null;
      }
    }
  }

  if (info === null) {
    checks.push(fail("rootless", "cannot determine rootless mode from podman info", "check-podman-info"));
  } else if (!info.rootless) {
    checks.push(fail("rootless", "podman is not running rootless", "enable-rootless-podman"));
  } else {
    checks.push(pass("rootless", "podman runs rootless"));
  }

  if (info === null) {
    checks.push(fail("cgroup-v2", "cannot determine cgroup version from podman info", "check-podman-info"));
  } else if (info.cgroupVersion !== "v2") {
    checks.push(fail("cgroup-v2", `cgroup version is ${info.cgroupVersion || "unknown"}, want v2`, "enable-cgroup-v2"));
  } else {
    checks.push(pass("cgroup-v2", "cgroup v2 is active"));
  }

  const required = ["memory", "cpu", "pids"];
  if (info === null) {
    checks.push(fail("controllers", "cannot determine cgroup controllers from podman info", "check-podman-info"));
  } else {
    const missing = required.filter(c => !info.controllers.includes(c));
    if (missing.length > 0) {
      checks.push(fail("controllers", `missing cgroup controllers: ${missing.join(", ")}`, "enable-cgroup-controllers"));
    } else {
      checks.push(pass("controllers", "memory, cpu and pids controllers are available"));
    }
  }

  const executionOk = config.directory !== null && config.secretsDirectory !== null && config.images !== null;
  if (!executionOk) {
    checks.push(fail("execution-configured", "execution is not configured", "configure-execution-block"));
  } else {
    checks.push(pass("execution-configured", "execution directory, secrets directory and images are configured"));
  }

  if (config.images === null) {
    checks.push(fail("image-base-present", "no base image is configured", "configure-execution-block"));
  } else {
    const probe = deps.run(["podman", "image", "exists", config.images.base]);
    if (probe.exitCode === 0) checks.push(pass("image-base-present", `base image ${config.images.base} is present`));
    else checks.push(fail("image-base-present", `base image ${config.images.base} is missing`, "build-box-images"));
  }

  if (config.images === null || config.images.browser === undefined) {
    checks.push({ name: "image-browser-present", ok: true, detail: "browser image is not configured; skipped", nextAction: null });
  } else {
    const probe = deps.run(["podman", "image", "exists", config.images.browser]);
    if (probe.exitCode === 0) checks.push(pass("image-browser-present", `browser image ${config.images.browser} is present`));
    else checks.push(fail("image-browser-present", `browser image ${config.images.browser} is missing`, "build-box-images"));
  }

  const dirCheck = (name: "execution-directory" | "secrets-directory", path: string | null): DoctorCheck => {
    if (path === null) return fail(name, `${name} is not configured`, "configure-execution-block");
    const stats = deps.stat(path);
    if (stats === null) return fail(name, `${path} does not exist`, "create-execution-directory");
    if (stats.uid !== deps.uid) return fail(name, `${path} is not owned by the service uid`, "chown-execution-directory");
    if (stats.mode !== 0o700) return fail(name, `${path} has mode ${stats.mode.toString(8)}, want 700`, "restrict-execution-directory");
    return pass(name, `${path} exists with owner ${stats.uid} and mode 700`);
  };
  checks.push(dirCheck("execution-directory", config.directory));
  checks.push(dirCheck("secrets-directory", config.secretsDirectory));

  if (checks.length !== checkNames.length || !checks.every((c, i) => c.name === checkNames[i])) {
    throw new Error("invalid_box_doctor");
  }
  return { ok: checks.every(c => c.ok), checks };
}
