import { expect, test } from "bun:test";
import { boxDoctor, parsePodmanInfo, parsePodmanVersion, type BoxDoctorDeps } from "../src/ops/box-doctor";
import type { AppConfig } from "../src/config";

const baseImage = "jit-box-base@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3";

function config(): AppConfig["execution"] {
  return {
    directory: "/var/lib/jit/boxes",
    secretsDirectory: "/var/lib/jit/box-secrets",
    images: { base: baseImage },
    maxBoxes: 2,
    memoryMb: 2048,
    cpus: 2,
    pidsLimit: 512,
    idleMinutes: 30,
    registryHosts: ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "proxy.golang.org", "crates.io"],
    fullAllowed: false,
  };
}

const infoJson = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  host: {
    security: { rootless: true },
    cgroupVersion: "v2",
    cgroupControllers: ["memory", "cpu", "pids"],
    ...overrides,
  },
});

function depsFor(scenario: string): BoxDoctorDeps {
  const statOk = (path: string) => ({ uid: 1000, mode: 0o700 });
  const run = (cmd: string[]): { exitCode: number; stdout: string } => {
    if (scenario === "missing") return { exitCode: 127, stdout: "" };
    if (cmd[0] === "podman" && cmd[1] === "--version") {
      if (scenario === "old-version") return { exitCode: 0, stdout: "podman version 4.3.1\n" };
      return { exitCode: 0, stdout: "podman version 4.9.3\n" };
    }
    if (cmd[0] === "podman" && cmd[1] === "info") {
      if (scenario === "rootless-false") return { exitCode: 0, stdout: infoJson({ security: { rootless: false } }) };
      if (scenario === "cgroup-v1") return { exitCode: 0, stdout: infoJson({ cgroupVersion: "v1" }) };
      if (scenario === "missing-controller") {
        return { exitCode: 0, stdout: infoJson({ cgroupControllers: ["memory", "cpu"] }) };
      }
      return { exitCode: 0, stdout: infoJson() };
    }
    if (cmd[0] === "podman" && cmd[1] === "image") {
      if (scenario === "image-missing") return { exitCode: 1, stdout: "" };
      return { exitCode: 0, stdout: "" };
    }
    return { exitCode: 0, stdout: "" };
  };
  const stat = (path: string) => {
    if (scenario === "bad-mode") return { uid: 1000, mode: 0o755, isDirectory: true };
    if (scenario === "file") return { uid: 1000, mode: 0o700, isDirectory: false };
    return statOk(path);
  };
  return { run, stat, uid: 1000 };
}

test("parsers read podman version and info", () => {
  expect(parsePodmanVersion("podman version 4.9.3\n")).toEqual({ major: 4, minor: 9 });
  expect(parsePodmanVersion("nope")).toBeNull();
  const info = parsePodmanInfo(infoJson());
  expect(info).toEqual({ rootless: true, cgroupVersion: "v2", controllers: ["memory", "cpu", "pids"] });
});

function assertShape(scenario: string, expectedOk: boolean, failingNames: string[]) {
  const report = boxDoctor(depsFor(scenario), config());
  expect(report.checks.map(c => c.name)).toEqual([
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
  ]);
  expect(report.ok).toBe(expectedOk);
  for (const check of report.checks) {
    if (failingNames.includes(check.name)) {
      expect(check.ok).toBe(false);
      expect(check.nextAction).not.toBeNull();
    }
  }
  for (const name of failingNames) {
    expect(report.checks.find(c => c.name === name)!.ok).toBe(false);
  }
}

test("podman missing fails installed and dependents", () => {
  assertShape("missing", false, ["podman-installed", "podman-version>=4.4", "rootless", "cgroup-v2", "controllers"]);
});

test("podman 4.3 fails version", () => {
  assertShape("old-version", false, ["podman-version>=4.4"]);
});

test("rootless false fails rootless", () => {
  assertShape("rootless-false", false, ["rootless"]);
});

test("cgroup v1 fails cgroup-v2", () => {
  assertShape("cgroup-v1", false, ["cgroup-v2"]);
});

test("missing pids controller fails controllers", () => {
  assertShape("missing-controller", false, ["controllers"]);
});

test("missing image fails image-base-present", () => {
  assertShape("image-missing", false, ["image-base-present"]);
});

test("directory mode 0755 fails execution-directory", () => {
  assertShape("bad-mode", false, ["execution-directory", "secrets-directory"]);
});

test("regular file fails directory checks", () => {
  assertShape("file", false, ["execution-directory", "secrets-directory"]);
});

test("all-ok passes", () => {
  const report = boxDoctor(depsFor("ok"), config());
  expect(report.ok).toBe(true);
  expect(report.checks.every(c => c.ok)).toBe(true);
  expect(report.checks.every(c => c.nextAction === null)).toBe(true);
});
