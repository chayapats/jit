import { resolve } from "node:path";

/** Finite local-development limits; operators must measure them before a pilot. */
export interface AppConfig {
  databasePath: string;
  origin: string;
  hostname: string;
  port: number;
  bodyBytes: number;
  queryBytes: number;
  pageSize: number;
  sessionSeconds: number;
  loginAttempts: number;
  loginWindowSeconds: number;
}

/** Reads only Jit's declared settings and rejects malformed or unbounded values. */
export function readConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const positive = (key: string, fallback: number, maximum: number) => {
    const raw = env[key];
    const n = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(n) || n < 1 || n > maximum) throw new Error(`Invalid ${key}`);
    return n;
  };
  const origin = new URL(env.JIT_ORIGIN ?? "http://localhost:3000");
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Invalid JIT_ORIGIN");
  // Unencrypted credentials are permitted only for loopback development.
  if (origin.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) {
    throw new Error("JIT_ORIGIN requires HTTPS outside loopback development");
  }
  return {
    databasePath: resolve(env.JIT_DATABASE ?? ".local/jit.sqlite"),
    origin: origin.origin,
    hostname: env.JIT_HOST ?? "127.0.0.1",
    port: positive("JIT_PORT", 3000, 65535),
    bodyBytes: positive("JIT_BODY_BYTES", 16384, 1048576),
    queryBytes: positive("JIT_QUERY_BYTES", 2048, 16384),
    pageSize: positive("JIT_PAGE_SIZE", 50, 200),
    sessionSeconds: positive("JIT_SESSION_SECONDS", 28800, 86400),
    loginAttempts: positive("JIT_LOGIN_ATTEMPTS", 8, 100),
    loginWindowSeconds: positive("JIT_LOGIN_WINDOW_SECONDS", 900, 86400),
  };
}
