import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { parseServiceConfig, serviceEnvironment, type ServiceConfig } from "../ops/package/service-config";
import { readConfig } from "../src/config";

function baseService(dirs: { work: string; state: string; backup: string; opt: string }): ServiceConfig {
  return {
    serviceUser: "jit-service",
    executablePath: join(dirs.opt, "current"),
    workingDirectory: dirs.work,
    stateDirectory: dirs.state,
    ledgerPath: join(dirs.state, "ledger.json"),
    backupDirectory: dirs.backup,
    routes: [{ route: "codex-subscription", model: "gpt-fixture", configured: true }],
    secretRefs: [],
    network: { bindHost: "127.0.0.1", port: 3443, vpnInterface: null },
    resources: { memoryMaxBytes: 536870912, maxRestarts: 3, restartWindowSeconds: 300, logBytes: 1048576, retentionDays: 30 },
  };
}

function layout() {
  const root = mkdtempSync(join(tmpdir(), "jit-exe02-config-"));
  const dirs = {
    root,
    work: join(root, "work"),
    state: join(root, "state"),
    backup: join(root, "backup"),
    opt: join(root, "opt"),
    boxes: join(root, "boxes"),
    secrets: join(root, "box-secrets"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, dirs, cleanup };
}

const validImage = "jit-box-base@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3";

function validExecution(dirs: ReturnType<typeof layout>["dirs"]) {
  return {
    directory: dirs.boxes,
    secretsDirectory: dirs.secrets,
    images: { base: validImage },
  } as unknown as NonNullable<ServiceConfig["execution"]>;
}

test("valid minimal block fills defaults", () => {
  const l = layout();
  try {
    const parsed = parseServiceConfig({ ...baseService(l.dirs), execution: validExecution(l.dirs) } as unknown);
    expect(parsed.execution).toMatchObject({
      directory: l.dirs.boxes,
      secretsDirectory: l.dirs.secrets,
      maxBoxes: 2,
      memoryMb: 2048,
      cpus: 2,
      pidsLimit: 512,
      idleMinutes: 30,
      fullAllowed: false,
    });
    expect(parsed.execution!.images).toEqual({ base: validImage });
    expect(parsed.execution!.registryHosts).toEqual(
      ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "proxy.golang.org", "crates.io"]);
  } finally { l.cleanup(); }
});

test("images.base without a digest throws", () => {
  const l = layout();
  try {
    expect(() => parseServiceConfig({ ...baseService(l.dirs),
      execution: { ...validExecution(l.dirs), images: { base: "jit-box-base:latest" } } } as unknown)).toThrow("invalid_service_config");
  } finally { l.cleanup(); }
});

test("maxBoxes 9 throws", () => {
  const l = layout();
  try {
    expect(() => parseServiceConfig({ ...baseService(l.dirs),
      execution: { ...validExecution(l.dirs), maxBoxes: 9 } } as unknown)).toThrow("invalid_service_config");
  } finally { l.cleanup(); }
});

test("cpus 0.25 throws", () => {
  const l = layout();
  try {
    expect(() => parseServiceConfig({ ...baseService(l.dirs),
      execution: { ...validExecution(l.dirs), cpus: 0.25 } } as unknown)).toThrow("invalid_service_config");
  } finally { l.cleanup(); }
});

test("registryHosts with URL throws", () => {
  const l = layout();
  try {
    expect(() => parseServiceConfig({ ...baseService(l.dirs),
      execution: { ...validExecution(l.dirs), registryHosts: ["https://x"] } } as unknown)).toThrow("invalid_service_config");
  } finally { l.cleanup(); }
});

test("directory inside stateDirectory throws", () => {
  const l = layout();
  try {
    expect(() => parseServiceConfig({ ...baseService(l.dirs),
      execution: { ...validExecution(l.dirs), directory: join(l.dirs.state, "boxes") } } as unknown)).toThrow("invalid_service_config");
  } finally { l.cleanup(); }
});

test("secretsDirectory equal to directory throws", () => {
  const l = layout();
  try {
    expect(() => parseServiceConfig({ ...baseService(l.dirs),
      execution: { ...validExecution(l.dirs), secretsDirectory: l.dirs.boxes } } as unknown)).toThrow("invalid_service_config");
  } finally { l.cleanup(); }
});

test("unknown key under execution throws", () => {
  const l = layout();
  try {
    expect(() => parseServiceConfig({ ...baseService(l.dirs),
      execution: { ...validExecution(l.dirs), extra: true } } as unknown)).toThrow("invalid_service_config");
  } finally { l.cleanup(); }
});

test("serviceEnvironment with execution contains JIT_BOX_MAX and JIT_EXECUTION_FULL_ALLOWED in order", () => {
  const l = layout();
  try {
    const env = serviceEnvironment({ ...baseService(l.dirs), execution: validExecution(l.dirs) } as unknown as ServiceConfig);
    const keys = env.map(([k]) => k);
    expect(keys).toContain("JIT_BOX_MAX");
    expect(env.find(([k]) => k === "JIT_BOX_MAX")).toEqual(["JIT_BOX_MAX", "2"]);
    expect(env.find(([k]) => k === "JIT_EXECUTION_FULL_ALLOWED")).toEqual(["JIT_EXECUTION_FULL_ALLOWED", "0"]);
    const tail = keys.slice(keys.indexOf("JIT_EXECUTION_DIR"));
    expect(tail).toEqual([
      "JIT_EXECUTION_DIR",
      "JIT_EXECUTION_SECRETS_DIR",
      "JIT_BOX_IMAGE_BASE",
      "JIT_BOX_MAX",
      "JIT_BOX_MEMORY_MB",
      "JIT_BOX_CPUS",
      "JIT_BOX_PIDS",
      "JIT_BOX_IDLE_MINUTES",
      "JIT_BOX_REGISTRY_HOSTS",
      "JIT_EXECUTION_FULL_ALLOWED",
    ]);
  } finally { l.cleanup(); }
});

test("serviceEnvironment without execution contains no JIT_BOX_* variable", () => {
  const l = layout();
  try {
    const env = serviceEnvironment(baseService(l.dirs));
    expect(env.some(([k]) => k.startsWith("JIT_BOX_"))).toBe(false);
    expect(env.filter(([k]) => k.startsWith("JIT_EXECUTION_"))).toEqual([["JIT_EXECUTION_SECRETS_DIR", `${baseService(l.dirs).stateDirectory}.connections`]]);
  } finally { l.cleanup(); }
});

test("readConfig parses JIT_BOX_MAX and rejects zero; empty env means not configured", () => {
  expect(readConfig({ JIT_BOX_MAX: "3" }).execution.maxBoxes).toBe(3);
  expect(() => readConfig({ JIT_BOX_MAX: "0" })).toThrow();
  const empty = readConfig({});
  expect(empty.execution.directory).toBeNull();
  expect(empty.execution.images).toBeNull();
  expect(empty.execution.maxBoxes).toBe(2);
});
