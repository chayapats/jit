import { createHash } from "node:crypto";
import { AppError } from "../../errors";
import type { VmEndpoint, VmLimits } from "./types";

/** Raises only a safe public code; no host/guest diagnostics escape this boundary. */
export function vmFail(code: string, status = 409): never { throw new AppError(code, status); }
/** Canonical closed record helper, also rejecting accessors and unusual prototypes. */
export function vmRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) vmFail("vm_protocol_invalid");
  const r = value as Record<string, unknown>, keys = Reflect.ownKeys(r);
  if (keys.some(k => typeof k !== "string" || ![...required, ...optional].includes(k) || !Object.getOwnPropertyDescriptor(r, k)?.enumerable || !("value" in Object.getOwnPropertyDescriptor(r, k)!)) || required.some(k => !Object.hasOwn(r, k))) vmFail("vm_protocol_invalid");
  return r;
}
/** Validates a service-issued opaque identifier, never an address/path. */
export function vmId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) vmFail("vm_invalid_setup", 400);
}
/** Positive finite integral bounds with overflow/negative-zero refusal. */
export function vmInteger(value: unknown, max = Number.MAX_SAFE_INTEGER, min = 1): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) vmFail("vm_limit_invalid", 400);
}
/** Validates transport ceilings before allocating memory or a VM lease. */
export function vmLimits(value: VmLimits): VmLimits {
  vmRecord(value, ["maxSessions", "sessionMs", "commandMs", "outputBytes", "fileBytes", "calls", "networkProbeMs"]);
  vmInteger(value.maxSessions, 16); vmInteger(value.sessionMs, 86_400_000); vmInteger(value.commandMs, value.sessionMs);
  vmInteger(value.outputBytes, 8_388_608); vmInteger(value.fileBytes, 8_388_608); vmInteger(value.calls, 100_000); vmInteger(value.networkProbeMs, 300_000);
  return Object.freeze({ ...value });
}
/** Exact canonical JSON for bounded protocol bytes. No normalization or authority is implied by its hash. */
export function vmCanonical(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isSafeInteger(value) || Object.is(value, -0)) vmFail("vm_protocol_invalid"); return JSON.stringify(value); }
  if (typeof value === "string") { if (!value.isWellFormed() || value.includes("\0")) vmFail("vm_protocol_invalid"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${Array.from(value, v => vmCanonical(v)).join(",")}]`;
  if (!value || typeof value !== "object") vmFail("vm_protocol_invalid");
  vmRecord(value, Object.keys(value));
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${vmCanonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}
/** SHA-256 of exact received or canonical request bytes, never a guest attestation. */
export function vmHash(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
/** Direct file tools stay within work roots; shell administration has the separate VM boundary. */
export function vmPath(path: string, roots: readonly string[]): string {
  if (typeof path !== "string" || Buffer.byteLength(path) > 4096 || !path.isWellFormed() || /[\x00-\x1f\x7f]/.test(path) || path.includes("//") || path.split("/").some(s => s === "." || s === "..") || !roots.some(root => path === root || path.startsWith(`${root}/`))) vmFail("vm_path_denied", 403);
  return path;
}
/** Refuses SSH option injection. Host configuration is always bypassed, including ambient agent/proxy options. */
export function vmEndpoint(endpoint: VmEndpoint): VmEndpoint {
  vmRecord(endpoint, ["host", "port", "user", "identityFile", "knownHostsFile"]);
  if (typeof endpoint.host !== "string" || typeof endpoint.user !== "string" || !/^(?:[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}|[a-fA-F0-9:]+)$/.test(endpoint.host) || !/^[a-z_][a-z0-9_-]{0,31}$/.test(endpoint.user)) vmFail("vm_invalid_setup", 400);
  vmInteger(endpoint.port, 65535);
  for (const path of [endpoint.identityFile, endpoint.knownHostsFile]) if (typeof path !== "string" || !path.startsWith("/") || /[\x00-\x1f\x7f]/.test(path)) vmFail("vm_invalid_setup", 400);
  return Object.freeze({ ...endpoint });
}
/** Binary payload decoder with canonical base64 and an exact finite byte bound. */
export function vmBytes(value: unknown, max: number): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil(max / 3) * 4) vmFail("vm_protocol_invalid");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > max || bytes.toString("base64") !== value) vmFail("vm_protocol_invalid");
  return bytes;
}
