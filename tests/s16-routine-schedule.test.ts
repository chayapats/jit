import { expect, test } from "bun:test";
import { dueInstants, nextInstant, upcoming, validateRecurrence } from "../src/s16/routines/schedule";

const at = (iso: string) => Date.parse(iso);
const ny = "America/New_York";

test("a daily 02:30 routine runs once on the spring-forward day, at the first valid minute", () => {
  const week = upcoming({ kind: "daily", time: "02:30" }, ny, 0, at("2026-03-05T00:00:00Z"), 7);
  expect(week.map(item => [item.local, item.resolution])).toEqual([
    ["2026-03-05 02:30", "exact"], ["2026-03-06 02:30", "exact"], ["2026-03-07 02:30", "exact"],
    ["2026-03-08 03:00", "gap_shifted"], ["2026-03-09 02:30", "exact"], ["2026-03-10 02:30", "exact"], ["2026-03-11 02:30", "exact"],
  ]);
  expect(new Date(week[3]!.at).toISOString()).toBe("2026-03-08T07:00:00.000Z");
  // Seven local days, seven runs: the gap neither drops nor duplicates the day.
  expect(dueInstants({ kind: "daily", time: "02:30" }, ny, 0, at("2026-03-05T00:00:00Z"), at("2026-03-12T00:00:00Z"))?.count).toBe(7);
});

test("a daily 01:30 routine runs once in the repeated fall-back hour, at its first occurrence", () => {
  const week = upcoming({ kind: "daily", time: "01:30" }, ny, 0, at("2026-10-29T00:00:00Z"), 7);
  expect(week.map(item => item.resolution)).toEqual(["exact", "exact", "exact", "overlap_first", "exact", "exact", "exact"]);
  expect(new Date(week[3]!.at).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  // The second 01:30 (EST, 06:30Z) is not a new occurrence, even when asked from inside the fold.
  expect(nextInstant({ kind: "daily", time: "01:30" }, ny, 0, at("2026-11-01T05:30:00Z"))!.local).toBe("2026-11-02 01:30");
  expect(nextInstant({ kind: "daily", time: "01:30" }, ny, 0, at("2026-11-01T06:00:00Z"))!.local).toBe("2026-11-02 01:30");
  expect(dueInstants({ kind: "daily", time: "01:30" }, ny, 0, at("2026-10-29T00:00:00Z"), at("2026-11-05T00:00:00Z"))?.count).toBe(7);
});

test("weekday and weekly schedules follow the local calendar day in their own timezone", () => {
  // 2026-11-06 is a Friday; weekdays skip the weekend in Bangkok, whatever the host zone is.
  expect(upcoming({ kind: "weekly", days: [1, 2, 3, 4, 5], time: "09:00" }, "Asia/Bangkok", 0, at("2026-11-06T00:00:00Z"), 3).map(item => item.local)).toEqual(["2026-11-06 09:00", "2026-11-09 09:00", "2026-11-10 09:00"]);
  expect(upcoming({ kind: "weekly", days: [0], time: "23:30" }, "Pacific/Auckland", 0, at("2026-11-06T00:00:00Z"), 2).map(item => item.local)).toEqual(["2026-11-08 23:30", "2026-11-15 23:30"]);
});

test("an interval counts absolute minutes from its anchor across DST", () => {
  const anchor = at("2026-11-01T04:00:00Z"), hours = upcoming({ kind: "interval", minutes: 60 }, ny, anchor, anchor, 4);
  expect(hours.map(item => item.local)).toEqual(["2026-11-01 01:00", "2026-11-01 01:00", "2026-11-01 02:00", "2026-11-01 03:00"]);
  expect(hours.map(item => item.at - anchor)).toEqual([3600000, 7200000, 10800000, 14400000]);
  expect(dueInstants({ kind: "interval", minutes: 60 }, ny, anchor, anchor, anchor + 24 * 3600000)?.count).toBe(24);
});

test("downtime coalesces into one due range with its count and latest instant", () => {
  const due = dueInstants({ kind: "daily", time: "09:00" }, "UTC", 0, at("2026-03-01T10:00:00Z"), at("2026-03-11T08:00:00Z"))!;
  expect(due).toMatchObject({ count: 9, truncated: false }); expect(due.first.local).toBe("2026-03-02 09:00"); expect(due.last.local).toBe("2026-03-10 09:00");
  expect(dueInstants({ kind: "daily", time: "09:00" }, "UTC", 0, at("2026-03-10T09:00:00Z"), at("2026-03-11T08:59:59Z"))).toBeNull();
  // A one-time schedule falls due once, then never again.
  const once = { kind: "once" as const, date: "2026-03-05", time: "12:00" };
  expect(dueInstants(once, "Asia/Bangkok", 0, at("2026-03-01T00:00:00Z"), at("2026-04-01T00:00:00Z"))?.count).toBe(1);
  expect(nextInstant(once, "Asia/Bangkok", 0, at("2026-03-05T05:00:00Z"))).toBeNull();
});

test("schedule validation refuses unknown zones, impossible times and loose shapes", () => {
  const refuse = (value: unknown, zone = "UTC") => expect(() => validateRecurrence(value, zone)).toThrow();
  refuse({ kind: "daily", time: "09:00" }, "Mars/Olympus"); refuse({ kind: "daily", time: "24:00" }); refuse({ kind: "daily", time: "9:00" });
  refuse({ kind: "once", date: "2026-02-30", time: "09:00" }); refuse({ kind: "weekly", days: [5, 1], time: "09:00" }); refuse({ kind: "weekly", days: [], time: "09:00" });
  refuse({ kind: "interval", minutes: 10 }); refuse({ kind: "daily", time: "09:00", extra: true }); refuse({ kind: "cron", expression: "* * * * *" });
  expect(() => validateRecurrence({ kind: "weekly", days: [1, 3, 5], time: "07:15" }, "Europe/London")).not.toThrow();
});
