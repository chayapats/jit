import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "../errors";
import { ConnectionVault } from "../exec/connections";
import { registerSecretFingerprint } from "../security/secret-fingerprints";

const keyId = "00000000-0000-4000-8000-000000000259";
/** AES-GCM sealing over the existing mode/ownership/symlink-safe vault; keys and ciphertext stay outside state. */
export class PersonalVault {
  constructor(readonly files: ConnectionVault) {}

  private key(create: boolean): Buffer {
    if (this.files.inspect(keyId) === "missing" && create) this.files.write(keyId, randomBytes(32).toString("base64url"));
    const value = this.files.read(keyId);
    const key = Buffer.from(value, "base64url");
    if (key.length !== 32) throw new AppError("personal_vault_unavailable", 503);
    return key;
  }

  /** Seals one broker-only JSON value atomically with identity-bound authenticated encryption. */
  write(id: string, value: unknown): void {
    const plaintext = JSON.stringify(value);
    if (Buffer.byteLength(plaintext) > 4800) throw new AppError("personal_secret_too_large");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(true), iv);
    cipher.setAAD(Buffer.from(`jit.personal.v1:${id}`));
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    this.files.write(id, `v1.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")}`);
    this.fingerprint(value);
  }

  /** Opens one value only for broker code, rejecting missing keys or authentication failures without leaking details. */
  read<T>(id: string): T {
    try {
      const sealed = this.files.read(id);
      if (!sealed.startsWith("v1.")) throw new Error();
      const raw = Buffer.from(sealed.slice(3), "base64url");
      if (raw.length < 29) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.key(false), raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(`jit.personal.v1:${id}`));
      decipher.setAuthTag(raw.subarray(12, 28));
      const value = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as T;
      this.fingerprint(value);
      return value;
    } catch { throw new AppError("personal_vault_unavailable", 503); }
  }

  private fingerprint(value: unknown): void {
    if (typeof value === "string" && value.length >= 8) registerSecretFingerprint(value);
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
      if (!["clientId", "redirectUri", "scopes", "expiresAt"].includes(key)) this.fingerprint(item);
    }
  }

  /** Erases a sealed value; the key is retained so unrelated connections remain usable. */
  remove(id: string): void { this.files.remove(id); }
}
