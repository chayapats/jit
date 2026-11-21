import type { NoticeKind } from "../notifications/types";

/** Generic native notification only. No field contains private result data, a credential or an approval. */
export interface NativeNotice { v: 1; id: string; kind: NoticeKind; service: string; path: string }
/** Current registered-service navigation, never an executable command or an approval selection. */
export type NativeNoticeTarget = { kind: "home" } | { kind: "conversation"; id: string } | { kind: "routine"; id: string };
/** Canonical OS token. APNs bytes are hex; FCM remains opaque printable ASCII and never addresses a URL. */
export function nativeToken(provider: "apns" | "fcm", raw: unknown): string {
  if (typeof raw !== "string") throw Object.assign(new Error("native_push_token_invalid"), { code: "native_push_token_invalid" });
  const valid = provider === "apns" ? raw.length >= 64 && raw.length <= 512 && raw.length % 2 === 0 && !/[^a-fA-F0-9]/.test(raw) : provider === "fcm" && raw.length >= 32 && raw.length <= 4096 && !/[^\x21-\x7e]/.test(raw);
  if (!valid) throw Object.assign(new Error("native_push_token_invalid"), { code: "native_push_token_invalid" });
  return provider === "apns" ? raw.toLowerCase() : raw;
}
/** Refuse unknown/extra fields, normalization and encoded navigation tricks in an OS-supplied inner payload. */
export function nativeNotice(raw: unknown): Readonly<NativeNotice> | null {
  try {
    const value = typeof raw === "string" && raw.length <= 2048 ? JSON.parse(raw) : raw;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "id,kind,path,service,v" || value.v !== 1 || typeof value.id !== "string" || value.id.length !== 35 || !/^nt_[a-f0-9]{32}$/.test(value.id) || !["needs_you", "result", "routine"].includes(value.kind) || typeof value.service !== "string" || value.service.length !== 64 || !/^[a-f0-9]{64}$/.test(value.service) || typeof value.path !== "string") return null;
    if (!/^\/s16(?:\/(?:chat|routines)\/[A-Za-z0-9_-]{1,128})?$/.test(value.path) || /[\r\n]/.test(value.path)) return null;
    return Object.freeze({ v: 1, id: value.id, kind: value.kind, service: value.service, path: value.path });
  } catch { return null; }
}
/** Only a validated generic payload becomes a native navigation target; caller still reauthenticates and reads. */
export function nativeNoticeTarget(notice: Readonly<NativeNotice>): NativeNoticeTarget {
  const value = nativeNotice(notice); if (!value) throw new Error("native_notice_invalid");
  const parts = value.path.split("/");
  return parts.length === 2 ? { kind: "home" } : parts[2] === "chat" ? { kind: "conversation", id: parts[3]! } : { kind: "routine", id: parts[3]! };
}
