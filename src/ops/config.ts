import type { LoadDrillConfig } from "./contracts";
import { drillWorkloadBounds, opsBounds, withinBound } from "./limits";

/** Installation-level finite fallbacks for drill invocation ceilings. Never unlimited. */
export interface DrillFallbacks {
  diskWatermarkBytes: number;
  drillDeadlineMs: number;
}

/**
 * Validates an explicit drill invocation. Workload sizes are always required;
 * only the deadline and disk watermark fall back to validated installation knobs,
 * under the same bounds `readConfig` applies (src/ops/limits.ts), so any
 * installation-valid knob is a valid fallback. Missing/invalid limits throw
 * instead of silently becoming unlimited.
 */
export function parseDrillConfig(raw: unknown, fallback: DrillFallbacks): LoadDrillConfig {
  const fail = (): never => { throw new Error("invalid_drill_config"); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail();
  if (!fallback || typeof fallback !== "object" || !withinBound(fallback.diskWatermarkBytes, opsBounds.diskWatermarkBytes) ||
      !withinBound(fallback.drillDeadlineMs, opsBounds.drillDeadlineMs)) fail();
  const c = raw as Record<string, unknown>;
  if (Object.keys(c).some(k => !["groups", "prSnapshots", "memoryQueries", "deliveries", "schedules", "diskWatermarkBytes", "deadlineMs"].includes(k))) fail();
  for (const [name, bound] of Object.entries(drillWorkloadBounds)) {
    if (!(name in c) || !withinBound(c[name], bound)) fail();
  }
  const diskWatermarkBytes = c.diskWatermarkBytes === undefined ? fallback.diskWatermarkBytes : c.diskWatermarkBytes;
  const deadlineMs = c.deadlineMs === undefined ? fallback.drillDeadlineMs : c.deadlineMs;
  if (!withinBound(diskWatermarkBytes, opsBounds.diskWatermarkBytes) || !withinBound(deadlineMs, opsBounds.drillDeadlineMs)) fail();
  return { groups: c.groups as number, prSnapshots: c.prSnapshots as number, memoryQueries: c.memoryQueries as number,
    deliveries: c.deliveries as number, schedules: c.schedules as number, diskWatermarkBytes: diskWatermarkBytes as number, deadlineMs: deadlineMs as number };
}
