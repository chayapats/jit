import type { LoadDrillConfig } from "./contracts";

/** Installation-level finite fallbacks for drill invocation ceilings. Never unlimited. */
export interface DrillFallbacks {
  diskWatermarkBytes: number;
  drillDeadlineMs: number;
}

const bounds: Record<string, { min: number; max: number }> = {
  groups: { min: 1, max: 8 },
  prSnapshots: { min: 1, max: 64 },
  memoryQueries: { min: 1, max: 256 },
  deliveries: { min: 1, max: 32 },
  schedules: { min: 0, max: 16 },
};

/**
 * Validates an explicit drill invocation. Workload sizes are always required;
 * only the deadline and disk watermark fall back to validated installation knobs.
 * Missing/invalid limits throw instead of silently becoming unlimited.
 */
export function parseDrillConfig(raw: unknown, fallback: DrillFallbacks): LoadDrillConfig {
  const fail = (): never => { throw new Error("invalid_drill_config"); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail();
  if (!fallback || typeof fallback !== "object" ||
      !Number.isSafeInteger(fallback.diskWatermarkBytes) || fallback.diskWatermarkBytes < 4096 || fallback.diskWatermarkBytes > 1073741824 ||
      !Number.isSafeInteger(fallback.drillDeadlineMs) || fallback.drillDeadlineMs < 1000 || fallback.drillDeadlineMs > 300000) fail();
  const c = raw as Record<string, unknown>;
  const keys = Object.keys(c);
  if (keys.some(k => !["groups", "prSnapshots", "memoryQueries", "deliveries", "schedules", "diskWatermarkBytes", "deadlineMs"].includes(k))) fail();
  const integer = (name: string, min: number, max: number): number => {
    const v = c[name];
    if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) fail();
    return v as number;
  };
  for (const [name, { min, max }] of Object.entries(bounds)) {
    if (!(name in c)) fail();
    integer(name, min, max);
  }
  const diskWatermarkBytes = c.diskWatermarkBytes === undefined ? fallback.diskWatermarkBytes : integer("diskWatermarkBytes", 4096, 1073741824);
  if (!Number.isSafeInteger(diskWatermarkBytes) || diskWatermarkBytes < 4096 || diskWatermarkBytes > 1073741824) fail();
  const deadlineMs = c.deadlineMs === undefined ? fallback.drillDeadlineMs : integer("deadlineMs", 1000, 300000);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 300000) fail();
  return { groups: c.groups as number, prSnapshots: c.prSnapshots as number, memoryQueries: c.memoryQueries as number,
    deliveries: c.deliveries as number, schedules: c.schedules as number, diskWatermarkBytes, deadlineMs };
}
