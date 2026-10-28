import { createHmac, randomBytes } from "node:crypto";

/**
 * The connection redaction guard (app.connections/v1, EXE08, ADR 0037). Every stored connection secret is
 * fingerprinted when the service starts and when the owner sets or rotates it, so outgoing text that echoes the
 * secret — command output, a model answer, a delivery, an export, a log line — is redacted.
 *
 * The registry never holds a secret. For each registered value (and each line of 16+ characters of a multi-line
 * value, so one echoed line of a key file is caught) it keeps the value's length, a rolling hash and an HMAC under
 * a random per-process key. Scanning text is one rolling-hash pass per distinct registered length; a hash hit is
 * confirmed by the HMAC before anything is redacted. Fingerprints are never persisted and are never removed while the
 * process runs (a removed or rotated value is still sensitive).
 */
const key = randomBytes(32);
const modulus = 67_108_859, base = 131;
const minimumLength = 8;
/** length → rolling hash → HMAC hex digests */
const registry = new Map<number, { power: number; hashes: Map<number, Set<string>> }>();

const mac = (text: string) => createHmac("sha256", key).update(text, "utf8").digest("hex");
function rolling(text: string, start: number, length: number): number {
  let hash = 0;
  for (let i = start; i < start + length; i++) hash = (hash * base + text.charCodeAt(i)) % modulus;
  return hash;
}

function add(piece: string): void {
  if (piece.length < minimumLength) return;
  let entry = registry.get(piece.length);
  if (!entry) {
    let power = 1;
    for (let i = 1; i < piece.length; i++) power = (power * base) % modulus;
    entry = { power, hashes: new Map() };
    registry.set(piece.length, entry);
  }
  const hash = rolling(piece, 0, piece.length);
  const set = entry.hashes.get(hash) ?? new Set<string>();
  set.add(mac(piece));
  entry.hashes.set(hash, set);
}

/** Registers one secret value (values shorter than 8 characters are ignored). The value itself is not retained. */
export function registerSecretFingerprint(value: string): void {
  if (typeof value !== "string") return;
  add(value);
  if (value.includes("\n")) for (const line of value.split(/\r?\n/)) if (line.trim().length >= 16) add(line.trim());
}

/** The `[start, end)` spans of `text` that equal a registered secret. */
function spans(text: string): [number, number][] {
  const found: [number, number][] = [];
  for (const [length, entry] of registry) {
    if (text.length < length) continue;
    let hash = rolling(text, 0, length);
    for (let i = 0; ; i++) {
      const candidates = entry.hashes.get(hash);
      if (candidates && candidates.has(mac(text.slice(i, i + length)))) found.push([i, i + length]);
      if (i + length >= text.length) break;
      hash = (hash - (text.charCodeAt(i) * entry.power) % modulus + modulus) % modulus;
      hash = (hash * base + text.charCodeAt(i + length)) % modulus;
    }
  }
  return found;
}

/** True when `text` contains a registered connection secret. */
export function containsRegisteredSecret(text: string): boolean {
  return typeof text === "string" && registry.size > 0 && spans(text).length > 0;
}

/** Replaces every registered connection secret in `text` with `replacement`. */
export function redactRegisteredSecrets(text: string, replacement = "[credential-redacted]"): string {
  if (typeof text !== "string" || registry.size === 0 || text.length === 0) return text;
  const found = spans(text).sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  if (!found.length) return text;
  let out = "", at = 0;
  for (const [start, end] of found) {
    if (end <= at) continue;
    out += text.slice(at, Math.max(at, start)) + (start >= at ? replacement : "");
    at = end;
  }
  return out + text.slice(at);
}
