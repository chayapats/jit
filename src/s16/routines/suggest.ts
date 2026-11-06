import type { RoutineRecurrence } from "./schedule";

/**
 * Conservative English/Thai schedule prefill for the review sheet. It reads only the owner's own composer
 * text, ignores quoted and fenced passages, and returns a suggestion the owner must still review and save.
 * The service never parses message text into a routine; this helper creates no authority.
 */
export function suggestSchedule(text: string): RoutineRecurrence | null {
  const plain = text.replace(/```[\s\S]*?```/g, " ").replace(/"[^"]*"|“[^”]*”|'[^'\n]*'|`[^`]*`/g, " ").replace(/^\s*>.*$/gm, " ").toLowerCase();
  const time = clock(plain) ?? "09:00";
  if (/\bevery\s+(?:hour|60\s*minutes)\b|\bhourly\b|ทุก\s*(?:1\s*)?ชั่วโมง/u.test(plain)) return { kind: "interval", minutes: 60 };
  const minutes = /\bevery\s+(\d{2,4})\s*minutes\b|ทุก\s*(\d{2,4})\s*นาที/u.exec(plain);
  if (minutes) { const value = Number(minutes[1] ?? minutes[2]); if (value >= 15 && value <= 10080) return { kind: "interval", minutes: value }; }
  if (/\bweekdays?\b|\bmonday\s+(?:to|through|-)\s+friday\b|วันธรรมดา|จันทร์\s*(?:ถึง|-)\s*ศุกร์/u.test(plain)) return { kind: "weekly", days: [1, 2, 3, 4, 5], time };
  const days: [RegExp, number][] = [[/\b(?:every\s+)?sundays?\b|วันอาทิตย์/u, 0], [/\b(?:every\s+)?mondays?\b|วันจันทร์/u, 1], [/\b(?:every\s+)?tuesdays?\b|วันอังคาร/u, 2], [/\b(?:every\s+)?wednesdays?\b|วันพุธ/u, 3], [/\b(?:every\s+)?thursdays?\b|วันพฤหัส(?:บดี)?/u, 4], [/\b(?:every\s+)?fridays?\b|วันศุกร์/u, 5], [/\b(?:every\s+)?saturdays?\b|วันเสาร์/u, 6]];
  if (/\bevery\b|\bweekly\b|ทุก/u.test(plain)) {
    const selected = days.filter(([pattern]) => pattern.test(plain)).map(([, day]) => day);
    if (selected.length) return { kind: "weekly", days: selected, time };
  }
  if (/\bevery\s+(?:day|morning|evening|night)\b|\bdaily\b|ทุก\s*(?:วัน|เช้า|เย็น|คืน)/u.test(plain)) return { kind: "daily", time };
  return null;
}

/** First explicit clock time: 24-hour `HH:MM`, `9am`/`9:30 pm`, or Thai `9 โมง`/`เวลา 9.30`. */
function clock(text: string): string | null {
  const pad = (n: number) => String(n).padStart(2, "0");
  const meridiem = /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/.exec(text);
  if (meridiem) { const hour = Number(meridiem[1]) % 12 + (meridiem[3] === "pm" ? 12 : 0); return `${pad(hour)}:${meridiem[2] ?? "00"}`; }
  const plain = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(text);
  if (plain) return `${pad(Number(plain[1]))}:${plain[2]}`;
  const thai = /(?:เวลา\s*)?([01]?\d|2[0-3])\s*(?:โมง|นาฬิกา)/u.exec(text);
  if (thai) return `${pad(Number(thai[1]))}:00`;
  return null;
}
