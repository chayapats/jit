import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../application";
import type { AppConfig } from "../config";
import { AppError } from "../errors";
import { accessConfirmToken } from "../exec/access";
import type { BoxManager } from "../exec/box-manager";
import { boxName, type BoxRuntime } from "../exec/box-runtime";
import { TransactionStore } from "../store";
import { safeInstallationLabel } from "./contracts";

/** Runner calls each box serves in the drill (EXE06: 50 core-tool calls per box). */
export const boxDrillCalls = 50;

/** Host measurements the box drill reads; the live port uses `podman stats`, `/proc/meminfo` and `du`. */
export interface BoxDrillHost {
  /** Resident memory of one running box in bytes, or null when the runtime cannot report it. */
  boxMemoryBytes(name: string): Promise<number | null>;
  /** Memory available to new work on the host (`MemAvailable`), in bytes. */
  memoryAvailableBytes(): Promise<number>;
  /** Disk used by the box images and by the execution directory (workspaces), in bytes. */
  diskBytes(): Promise<{ images: number; workspaces: number }>;
  /** A sanitized hardware/OS line (no hostnames or addresses). */
  hardware(): Promise<string>;
}

/** Timing summary of one box's runner calls. */
export interface BoxDrillLatency { p50Ms: number; p95Ms: number; maxMs: number; samples: number; failures: number }

/** ops.execution_evidence/v1: the box drill's measurements and decision; no address, path or secret. */
export interface BoxDrillReport {
  schema: "jit.ops.box-drill/v1";
  installationLabel: string;
  observedAt: string;
  hardware: string;
  defaults: { maxBoxes: number; memoryMb: number; cpus: number; pidsLimit: number; idleMinutes: number };
  boxes: { box: number; latency: BoxDrillLatency; rssBytes: number | null }[];
  memoryAvailableBytes: { before: number; withBoxes: number };
  disk: { images: number; workspaces: number };
  capacityWait: { observed: boolean; code: string | null };
  idleStop: { observed: boolean; stopped: number };
  decision: string;
}

/** Inputs of {@link runBoxDrill}. `boxes` builds the manager over the drill's own disposable store. */
export interface BoxDrillInput {
  config: AppConfig;
  runtime: BoxRuntime;
  boxes: (store: TransactionStore, config: AppConfig, now: () => number) => BoxManager;
  host: BoxDrillHost;
  installationLabel?: string;
  calls?: number;
  /** Wall clock for latency; defaults to `performance.now`. */
  clock?: () => number;
}

function percentile(samples: number[], p: number): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}
const round = (value: number) => Math.round(value * 100) / 100;
const encode = (request: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify({ v: 1, ...request }));

/**
 * The decision line: `fullAllowed may be set` only when capacity wait and idle stop were both observed, every runner
 * call succeeded and `maxBoxes × memoryMb` fits in the memory the host had available before the drill. Otherwise it
 * names the limit or gate to change first.
 */
export function boxDrillDecision(report: Omit<BoxDrillReport, "decision">): string {
  if (report.boxes.some(box => box.latency.failures > 0)) return "blocked: runner calls failed; fix the box runtime before setting fullAllowed";
  if (!report.capacityWait.observed) return "blocked: capacity wait not observed; check execution.maxBoxes";
  if (!report.idleStop.observed) return "blocked: idle stop not observed; check execution.idleMinutes";
  const budget = report.defaults.maxBoxes * report.defaults.memoryMb * 1024 * 1024;
  if (budget > report.memoryAvailableBytes.before) return "change execution.memoryMb or execution.maxBoxes: their product exceeds available memory";
  return "fullAllowed may be set";
}

/**
 * ops.load_drill/v1 box scenario (EXE06). On a disposable store it creates three projects at the `workspace` level,
 * opens two boxes and runs `calls` runner calls (write, read, stat) in each, sampling latency, resident memory,
 * available memory and disk. It then opens a third box and expects `box_capacity`, sweeps past `idleMinutes` with
 * the manager's clock and expects both boxes stopped. Every box it made is reset with its workspace at the end.
 * No model, network or Jit service state is used.
 */
export async function runBoxDrill(input: BoxDrillInput): Promise<BoxDrillReport> {
  const label = safeInstallationLabel(input.installationLabel ?? "box-drill");
  const calls = input.calls ?? boxDrillCalls;
  const clock = input.clock ?? (() => performance.now());
  const execution = input.config.execution;
  if (!execution.directory || !execution.images) throw new AppError("execution_not_configured");
  const root = mkdtempSync(join(tmpdir(), "jit-box-drill-"));
  let managerNow = Date.now();
  const store = new TransactionStore(join(root, "drill.sqlite"));
  const config: AppConfig = { ...input.config, databasePath: join(root, "drill.sqlite") };
  const manager = input.boxes(store, config, () => managerNow);
  const projects: string[] = [];
  try {
    const app = new Application(store, config, { now: () => managerNow, boxes: manager });
    const password = crypto.randomUUID();
    await app.setupOwner(password);
    const actor = app.authenticate(await app.login(password)).actor;
    for (let index = 0; index < 3; index++) {
      const revision = store.read(tx => tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision);
      const project = app.execute(actor, { kind: "project.create", projectId: null, requestId: crypto.randomUUID(), expectedRevision: revision,
        payload: { name: `box drill ${index + 1}` } }).project;
      const access = app.projectAccess(actor, project.id);
      app.execute(actor, { kind: "access.level.set", requestId: crypto.randomUUID(), projectId: project.id, expectedRevision: access.revision,
        payload: { level: "workspace", confirmToken: accessConfirmToken(project.id, access.level, "workspace", access.revision) } });
      projects.push(project.id);
    }
    const before = await input.host.memoryAvailableBytes();
    const boxes: BoxDrillReport["boxes"] = [];
    const sessions = [];
    for (const [index, projectId] of projects.slice(0, 2).entries()) {
      const session = await manager.open(projectId, null);
      sessions.push(session);
      const samples: number[] = [];
      let failures = 0;
      const path = `${session.handle.workspaceRoot}/drill.txt`;
      for (let call = 0; call < calls; call++) {
        const request = call % 3 === 0 ? { op: "write", path, data: Buffer.from(`drill ${call}`).toString("base64"), createParents: false }
          : call % 3 === 1 ? { op: "read", path, offset: 0, length: 64 } : { op: "stat", path };
        const started = clock();
        try {
          const result = await input.runtime.exec(session.handle, { input: encode(request), timeoutMs: 30_000 });
          const response = JSON.parse(new TextDecoder().decode(result.stdout)) as { ok?: boolean };
          if (result.exitCode !== 0 || response.ok !== true) failures++;
        } catch { failures++; }
        samples.push(clock() - started);
      }
      boxes.push({ box: index + 1, rssBytes: await input.host.boxMemoryBytes(boxName(projectId)),
        latency: { p50Ms: round(percentile(samples, 0.5)), p95Ms: round(percentile(samples, 0.95)), maxMs: round(Math.max(0, ...samples)), samples: samples.length, failures } });
    }
    const withBoxes = await input.host.memoryAvailableBytes();
    const disk = await input.host.diskBytes();
    let capacityCode: string | null = null;
    try { (await manager.open(projects[2]!, null)).release(); } catch (error) { capacityCode = error instanceof AppError ? error.code : "unexpected"; }
    for (const session of sessions) session.release();
    managerNow += execution.idleMinutes * 60_000 + 1;
    const stopped = await manager.sweep(managerNow);
    const states = await Promise.all(projects.slice(0, 2).map(id => input.runtime.status(id)));
    const report: Omit<BoxDrillReport, "decision"> = {
      schema: "jit.ops.box-drill/v1", installationLabel: label, observedAt: new Date().toISOString(), hardware: await input.host.hardware(),
      defaults: { maxBoxes: execution.maxBoxes, memoryMb: execution.memoryMb, cpus: execution.cpus, pidsLimit: execution.pidsLimit, idleMinutes: execution.idleMinutes },
      boxes, memoryAvailableBytes: { before, withBoxes }, disk,
      capacityWait: { observed: capacityCode === "box_capacity", code: capacityCode },
      idleStop: { observed: stopped.length === 2 && states.every(state => state.state !== "running"), stopped: stopped.length },
    };
    return { ...report, decision: boxDrillDecision(report) };
  } finally {
    for (const projectId of projects) await input.runtime.reset({ projectId }, { wipeWorkspace: true }).catch(() => undefined);
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}
