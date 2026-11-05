import { AppError } from "../../errors";
import { containsCredential } from "../../security/credentials";
import { canonical, digest, exact, identity, integer } from "../../s14/validation";
import type { ConversationCommand } from "./types";

export { canonical, digest, exact, identity, integer };
/** Exact bounded Unicode; refuse credential content before hashing/persistence rather than rewriting it. */
export function content(value: unknown, max = 16384): asserts value is string {
  if (typeof value !== "string" || !value.trim() || !value.isWellFormed() || Buffer.byteLength(value) > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new AppError("invalid_text");
  if (containsCredential(value)) throw new AppError("credential_content_refused", 403);
}
/** Reject authority-bearing extra keys; exact command bytes remain the dedupe identity. */
export function command(value: unknown): asserts value is ConversationCommand {
  canonical(value);
  exact(value, Object.keys(value && typeof value === "object" ? value : {}));
  const files = value.contract === "s16-conversation/v2";
  exact(value, ["contract", "requestId", "conversationId", "text", "continuation", ...(files ? ["files"] : [])]);
  if (!files && value.contract !== "s15-conversation/v1") throw new AppError("invalid_contract");
  identity(value.requestId); identity(value.conversationId);
  if (!files || value.text !== "") content(value.text);
  if (files) {
    if (value.continuation !== null || !Array.isArray(value.files) || !value.files.length || value.files.length > 8) throw new AppError("invalid_body");
    for (const file of value.files) { exact(file, ["id", "sha256"]); identity(file.id); if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new AppError("invalid_body"); }
  }
  if (value.continuation !== null) { exact(value.continuation, ["requestId", "revision"]); identity(value.continuation.requestId); integer(value.continuation.revision, 1); }
}
/** Strict JSON body parser rejects duplicate keys before JSON.parse discards their provenance. */
export function parseCommandJson(raw: string): unknown {
  if (Buffer.byteLength(raw) > 32768) throw new AppError("body_too_large", 413);
  let index = 0;
  const ws = () => { while (/\s/.test(raw[index] ?? "") && index < raw.length) index++; };
  const string = (): string => {
    const start = index++;
    while (index < raw.length) { const char = raw[index++]; if (char === "\\") index++; else if (char === '"') return JSON.parse(raw.slice(start, index)) as string; }
    throw new AppError("invalid_body");
  };
  const value = (depth: number): void => {
    if (depth > 16) throw new AppError("invalid_body");
    ws(); const char = raw[index];
    if (char === '"') { string(); return; }
    if (char === "{" || char === "[") {
      const object = char === "{", end = object ? "}" : "]", keys = new Set<string>(); index++; ws();
      if (raw[index] === end) { index++; return; }
      for (let count = 0; count < 256; count++) {
        ws();
        if (object) { if (raw[index] !== '"') throw new AppError("invalid_body"); const key = string(); if (keys.has(key)) throw new AppError("invalid_body"); keys.add(key); ws(); if (raw[index++] !== ":") throw new AppError("invalid_body"); }
        value(depth + 1); ws(); if (raw[index] === end) { index++; return; } if (raw[index++] !== ",") throw new AppError("invalid_body");
      }
      throw new AppError("invalid_body");
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(index));
    if (!literal) throw new AppError("invalid_body"); index += literal[0].length;
  };
  try { value(0); ws(); if (index !== raw.length) throw new AppError("invalid_body"); return JSON.parse(raw) as unknown; }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError("invalid_body"); }
}
