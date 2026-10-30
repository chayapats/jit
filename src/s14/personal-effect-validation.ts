import { AppError } from "../errors";
import { validTimezone } from "../jobs/schedules";
import { containsCredential } from "../security/credentials";
import { canonical, exact } from "./validation";
import type { PersonalDraft, PersonalDraftContent, PersonalEventDraft, PersonalEventFields, PersonalMailDraft } from "./personal-effect-types";

function plain(value: unknown, max: number, single = false): asserts value is string {
  if (typeof value !== "string" || !value.isWellFormed() || Buffer.byteLength(value) > max || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value) || single && /[\r\n]/.test(value) || containsCredential(value)) throw new AppError("personal_invalid_draft");
}
function addresses(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 20 || value.some(email => typeof email !== "string" || email.length > 254 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email) || containsCredential(email)) || new Set(value.map(email => email.toLowerCase())).size !== value.length) throw new AppError("personal_invalid_recipients");
}
function time(value: unknown, zone: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new AppError("personal_invalid_event_time");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  if (`${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}` !== value.slice(0, 19)) throw new AppError("personal_timezone_offset_mismatch");
}
/** Validates the entire reviewed mail/event payload without normalizing content, recipients, timezone or recurrence. */
export function validatePersonalDraft(value: unknown): asserts value is PersonalDraftContent {
  canonical(value);
  const kind = (value as { kind?: unknown })?.kind;
  if (kind === "mail") {
    exact(value, ["kind", "to", "cc", "bcc", "subject", "body"]);
    addresses(value.to);
    addresses(value.cc);
    addresses(value.bcc);
    const recipients = [...value.to, ...value.cc, ...value.bcc];
    if (!recipients.length || recipients.length > 20 || new Set(recipients.map(r => r.toLowerCase())).size !== recipients.length) throw new AppError("personal_invalid_recipients");
    plain(value.subject, 512, true);
    plain(value.body, 16384);
    return;
  }
  exact(value, ["kind", "operation", "eventId", "etag", "timezone", "sendUpdates", "event"]);
  if (kind !== "event" || !["create", "update", "delete"].includes(value.operation as string) || !["all", "none"].includes(value.sendUpdates as string) || !validTimezone(value.timezone)) throw new AppError("personal_invalid_event");
  if (value.operation === "create") {
    if (value.etag !== null || value.eventId !== null && (typeof value.eventId !== "string" || !/^[a-v0-9]{5,128}$/.test(value.eventId))) throw new AppError("personal_invalid_event_identity");
  } else if (typeof value.eventId !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(value.eventId) || typeof value.etag !== "string" || !/^"[^"\u0000-\u0020]{1,200}"$/.test(value.etag)) throw new AppError("personal_invalid_event_identity");
  if (value.operation === "delete") {
    if (value.event !== null) throw new AppError("personal_invalid_event");
    return;
  }
  exact(value.event, ["summary", "description", "location", "start", "end", "recurrence", "attendees"]);
  const event = value.event;
  plain(event.summary, 512, true);
  plain(event.description, 8192);
  plain(event.location, 512, true);
  time(event.start, value.timezone as string);
  time(event.end, value.timezone as string);
  if (Date.parse(event.end) <= Date.parse(event.start)) throw new AppError("personal_invalid_event_time");
  addresses(event.attendees);
  if (!Array.isArray(event.recurrence) || event.recurrence.length > 8 || event.recurrence.some(rule => typeof rule !== "string" || rule.length > 512 || !/^(RRULE|RDATE|EXDATE)(:|;)[A-Z0-9;=,:+TZ\/_-]+$/.test(rule))) throw new AppError("personal_invalid_recurrence");
}

/** Produces precisely the reviewed Calendar fields; every array replaces the corresponding provider array explicitly. */
export function personalEventBody(content: PersonalEventDraft): Record<string, unknown> {
  const e = content.event as PersonalEventFields;
  return { ...(content.operation === "create" ? { id: content.eventId } : {}), summary: e.summary, description: e.description, location: e.location,
    start: { dateTime: e.start, timeZone: content.timezone }, end: { dateTime: e.end, timeZone: content.timezone }, recurrence: e.recurrence,
    attendees: e.attendees.map(email => ({ email })) };
}

/** Encodes reviewed Unicode subject/body and exact recipient headers as fixed plain-text MIME without header injection. */
export function personalMailRaw(draft: PersonalDraft): string {
  const content = draft.content as PersonalMailDraft;
  const headers = [`From: ${draft.account}`, `To: ${content.to.join(",\r\n ")}`, `Cc: ${content.cc.join(",\r\n ")}`, `Bcc: ${content.bcc.join(",\r\n ")}`,
    `Subject: =?UTF-8?B?${Buffer.from(content.subject).toString("base64")}?=`, `Message-ID: <${draft.id}.${draft.revision}@jit.invalid>`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"];
  return Buffer.from(headers.join("\r\n") + "\r\n\r\n" + (Buffer.from(content.body).toString("base64").match(/.{1,76}/g) ?? []).join("\r\n")).toString("base64url");
}

/** Verifies a returned sent copy against the exact selected headers and decoded body, allowing unrelated provider-added headers only. */
export function matchingPersonalMail(raw: unknown, draft: PersonalDraft): boolean {
  if (typeof raw !== "string" || raw.length > 131072 || !/^[a-zA-Z0-9_=-]+$/.test(raw)) return false;
  const parse = (value: string) => {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const split = decoded.indexOf("\r\n\r\n");
    if (split < 0) return null;
    const headers: Record<string, string> = {};
    for (const line of decoded.slice(0, split).replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
      const at = line.indexOf(":");
      if (at < 1) return null;
      const name = line.slice(0, at).toLowerCase();
      if (Object.hasOwn(headers, name)) return null;
      headers[name] = line.slice(at + 1).trim();
    }
    return { headers, body: decoded.slice(split + 4).replace(/\s/g, "") };
  };
  const expected = parse(personalMailRaw(draft)), actual = parse(raw);
  return !!expected && !!actual && Object.entries(expected.headers).every(([key, value]) => actual.headers[key] === value) && expected.body === actual.body;
}
