// Shared policy must stay independent of the legacy Project scheduler at module load.
export { validTimezone, wallToUtc, nextDailyInstant, nextScheduledInstant, dueRange, normalizeSummaryOutcome, summaryReasonChars } from "./schedule-policy";
export type { SummaryOutcome } from "./schedule-policy";
export type { ScheduleRecurrence, ScheduleKind, WallResolution, JobSchedule, ScheduleOccurrence, ScheduleCommand, ScheduleReceipt, TickResult } from "./schedules-legacy";

/** Behavior contract for the retained legacy scheduler. */
export const scheduleContract = "jobs.configured_schedules/v1" as const;
/** Legacy queue work identities; reading these constants starts no scheduler. */
export const reminderWorkId = "schedule.reminder", summaryWorkId = "schedule.summary";
/** Legacy role-less scheduled summary sentinel. */
export const scheduleRunRoleId = "00000000-0000-0000-0000-000000000000";

// S14 also consumes this stable module path for pure recurrence/quiet-outcome policy.
// Load legacy persistence/worker dependencies only when a legacy operation is invoked.
const legacy = (): typeof import("./schedules-legacy") => require("./schedules-legacy");
/** Retained legacy readSchedule contract; loads its implementation only on invocation. */
export const readSchedule: typeof import("./schedules-legacy").readSchedule = (...args) => legacy().readSchedule(...args);
/** Retained legacy listSchedules contract; loads its implementation only on invocation. */
export const listSchedules: typeof import("./schedules-legacy").listSchedules = (...args) => legacy().listSchedules(...args);
/** Retained legacy listOccurrences contract; loads its implementation only on invocation. */
export const listOccurrences: typeof import("./schedules-legacy").listOccurrences = (...args) => legacy().listOccurrences(...args);
/** Retained legacy scheduleIdentity contract; loads its implementation only on invocation. */
export const scheduleIdentity: typeof import("./schedules-legacy").scheduleIdentity = (...args) => legacy().scheduleIdentity(...args);
/** Retained legacy executeScheduleCommand contract; loads its implementation only on invocation. */
export const executeScheduleCommand: typeof import("./schedules-legacy").executeScheduleCommand = (...args) => legacy().executeScheduleCommand(...args);
/** Retained legacy tickSchedules contract; loads its implementation only on invocation. */
export const tickSchedules: typeof import("./schedules-legacy").tickSchedules = (...args) => legacy().tickSchedules(...args);
/** Retained legacy scheduleReminderWork contract; loads its implementation only on invocation. */
export const scheduleReminderWork: typeof import("./schedules-legacy").scheduleReminderWork = (...args) => legacy().scheduleReminderWork(...args);
/** Retained legacy scheduleSummaryWork contract; loads its implementation only on invocation. */
export const scheduleSummaryWork: typeof import("./schedules-legacy").scheduleSummaryWork = (...args) => legacy().scheduleSummaryWork(...args);
