import { resolve } from "node:path";
import type { JobPolicy } from "./jobs/types";

/** Finite local-development limits; operators must measure them before a pilot. */
export interface AppConfig {
  databasePath: string;
  origin: string;
  hostname: string;
  port: number;
  bodyBytes: number;
  queryBytes: number;
  pageSize: number;
  messageBytes: number;
  sessionSeconds: number;
  loginAttempts: number;
  loginWindowSeconds: number;
  jobs: JobPolicy;
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
  const jobConcurrency = positive("JIT_JOB_CONCURRENCY", 2, 32), jobRouteConcurrency = positive("JIT_JOB_ROUTE_CONCURRENCY", 1, 32);
  if (jobRouteConcurrency > jobConcurrency) throw new Error("Invalid JIT_JOB_ROUTE_CONCURRENCY");
  return {
    databasePath: resolve(env.JIT_DATABASE ?? ".local/jit.sqlite"),
    origin: origin.origin,
    hostname: env.JIT_HOST ?? "127.0.0.1",
    port: positive("JIT_PORT", 3000, 65535),
    bodyBytes: positive("JIT_BODY_BYTES", 16384, 1048576),
    queryBytes: positive("JIT_QUERY_BYTES", 2048, 16384),
    pageSize: positive("JIT_PAGE_SIZE", 50, 200),
    messageBytes: positive("JIT_MESSAGE_BYTES", 4096, 65536),
    sessionSeconds: positive("JIT_SESSION_SECONDS", 28800, 86400),
    loginAttempts: positive("JIT_LOGIN_ATTEMPTS", 8, 100),
    loginWindowSeconds: positive("JIT_LOGIN_WINDOW_SECONDS", 900, 86400),
    jobs: {
      revision: positive("JIT_JOB_CONFIG_REVISION", 1, 1_000_000),
      queueLimit: positive("JIT_JOB_QUEUE_LIMIT", 32, 10_000),
      concurrency: jobConcurrency,
      routeConcurrency: jobRouteConcurrency,
      inputBytes: positive("JIT_JOB_INPUT_BYTES", 16_384, 65_536),
      outputBytes: positive("JIT_JOB_OUTPUT_BYTES", 4096, 65_536),
      maximum: {
        roles: positive("JIT_JOB_ROLES", 16, 10_000), calls: positive("JIT_JOB_CALLS", 64, 10_000),
        rounds: positive("JIT_JOB_ROUNDS", 64, 10_000), hops: positive("JIT_JOB_HOPS", 16, 10_000),
        contextTokens: positive("JIT_JOB_CONTEXT_TOKENS", 64_000, 1_000_000_000),
        outputTokens: positive("JIT_JOB_OUTPUT_TOKENS", 16_000, 1_000_000_000),
        retries: positive("JIT_JOB_RETRIES", 3, 100), wallMs: positive("JIT_JOB_WALL_MS", 60_000, 3_600_000),
      },
    },
  };
}
