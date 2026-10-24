/**
 * The single definition of OPS04 operating bounds. `readConfig` (installation
 * `JIT_OPS_*` knobs), `parseDrillConfig` (drill invocation), drill-record
 * validation and ops-evidence retention all read these values, so an
 * installation-valid setting is always a valid drill fallback. Every bound is
 * finite; nothing here means unlimited.
 */
export const opsBounds = Object.freeze({
  /** Managed-state growth ceiling (bytes). */
  diskWatermarkBytes: Object.freeze({ min: 4096, max: 10_737_418_240 }),
  /** Whole-drill wall-clock budget (ms). */
  drillDeadlineMs: Object.freeze({ min: 1000, max: 600_000 }),
  /** Ops-evidence retention age (days). */
  retentionDays: Object.freeze({ min: 1, max: 3650 }),
});

/** Drill workload sizes. Schedules start at 1: a drill that ticks no schedule cannot evidence the schedule path. */
export const drillWorkloadBounds = Object.freeze({
  groups: Object.freeze({ min: 1, max: 8 }),
  prSnapshots: Object.freeze({ min: 1, max: 64 }),
  memoryQueries: Object.freeze({ min: 1, max: 256 }),
  deliveries: Object.freeze({ min: 1, max: 32 }),
  schedules: Object.freeze({ min: 1, max: 16 }),
});

/**
 * Ops-evidence retention applied whenever a record is created: records older
 * than `JIT_OPS_RETENTION_DAYS` are removed, then the oldest beyond the count
 * or byte ceiling. The record being written is never a victim.
 */
export const opsEvidenceRetention = Object.freeze({ maxRecords: 256, maxBytes: 8 * 1024 * 1024 });

/** True when `value` is a safe integer within `bound`. */
export function withinBound(value: unknown, bound: { min: number; max: number }): value is number {
  return Number.isSafeInteger(value) && (value as number) >= bound.min && (value as number) <= bound.max;
}
