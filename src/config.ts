import { dirname, resolve } from "node:path";
import { attachmentHost, attachmentLimits, type AttachmentHost, type AttachmentLimits } from "./attachments/limits";
import type { JobPolicy } from "./jobs/types";
import type { TeamPolicy } from "./team/types";
import { noRouteModels, type RouteModels } from "./team/route-options";
import { opsBounds } from "./ops/limits";

/**
 * Smallest accepted `JIT_MESSAGE_BYTES`. Message ceilings also bound PR alert payloads, so this must
 * fit the worst-case mandatory alert skeleton (maximum repository/PR/revision/finding identities,
 * report link and partial warning) plus `ALERT_FIELD_RESERVE_BYTES` for each untrusted field;
 * `tests/pr-alerts.test.ts` proves it. Smaller values are rejected at config load.
 */
export const MIN_MESSAGE_BYTES = 1024;

/** Finite Telegram companion limits; bot credentials stay outside this projection. */
export interface TelegramPolicy {  /** Path to the bot token file inside the trusted secret boundary; never logged or exported. */
  botTokenPath: string;
  challengeSeconds: number;
  retentionHours: number;
  pollBackoffMs: number;
  maxPollBackoffMs: number;
  processAttempts: number;
  inboxBytes: number;
}

/** Finite operating limits; drill invocation ceilings and local evidence retention. */
export interface OpsPolicy {
  /** Managed-state growth ceiling that turns drill disk pressure into a blocked result. */
  diskWatermarkBytes: number;
  /** Ops-evidence retention age in days, enforced whenever an ops record is written (`writeOpsRecord`). */
  retentionDays: number;
  /** Default wall-clock budget for one fixture drill invocation. */
  drillDeadlineMs: number;
}

/**
 * Operator execution-box settings (`ops.execution_config/v1`).
 * `directory`/`secretsDirectory`/`images` are null when no execution
 * variable is set, so callers can tell that execution is not configured.
 * Numeric fields always carry defaults.
 */
export interface ExecutionConfig {
  directory: string | null;
  secretsDirectory: string | null;
  images: { base: string; browser?: string } | null;
  maxBoxes: number;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  idleMinutes: number;
  registryHosts: string[];
  fullAllowed: boolean;
  /**
   * exec.browser/v1 (ADR 0039): the operator's confirm vocabulary, Thai and English. A browser click on an element
   * whose accessible name contains one of these words is a confirm action and waits for a card.
   * `JIT_BROWSER_CONFIRM_WORDS` (comma-separated) replaces the defaults; absent means the defaults.
   */
  confirmWords?: string[];
}

/** Default confirm vocabulary (ADR 0039 § Pause before submit or confirm). */
export const defaultConfirmWords: readonly string[] = Object.freeze(["submit", "send", "pay", "buy", "confirm", "delete", "ส่ง", "ยืนยัน", "ชำระ", "ซื้อ", "ลบ"]);

/** Default registry egress allowlist for `workspace` boxes (ADR 0036). */
const defaultExecutionRegistryHosts = ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "proxy.golang.org", "crates.io"];

const executionImagePattern = /^[a-z0-9][a-z0-9._/-]{0,127}@sha256:[a-f0-9]{64}$/;
const executionRegistryPattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const executionPathPattern = /^\/[A-Za-z0-9._@+\/-]{0,4095}$/;

function parseExecutionConfig(env: Record<string, string | undefined>): ExecutionConfig {
  const intIn = (key: string, fallback: number, min: number, max: number): number => {
    const raw = env[key];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${key}`);
    return n;
  };
  const dir = (key: string): string | null => {
    const raw = env[key];
    if (raw === undefined) return null;
    if (!executionPathPattern.test(raw) || raw.endsWith("/") || /(^\/|\/)\.\.?(\/|$)/.test(raw)) throw new Error(`Invalid ${key}`);
    return raw;
  };
  const image = (key: string): string | null => {
    const raw = env[key];
    if (raw === undefined) return null;
    if (!executionImagePattern.test(raw)) throw new Error(`Invalid ${key}`);
    return raw;
  };
  const directory = dir("JIT_EXECUTION_DIR");
  const secretsDirectory = dir("JIT_EXECUTION_SECRETS_DIR");
  const base = image("JIT_BOX_IMAGE_BASE");
  const browser = image("JIT_BOX_IMAGE_BROWSER");
  const maxBoxes = intIn("JIT_BOX_MAX", 2, 1, 8);
  const memoryMb = intIn("JIT_BOX_MEMORY_MB", 2048, 256, 8192);
  let cpus = 2;
  {
    const raw = env["JIT_BOX_CPUS"];
    if (raw !== undefined) {
      const n = Number(raw);
      if (typeof raw !== "string" || raw.length === 0 || Number.isNaN(n) || n < 0.5 || n > 4) throw new Error("Invalid JIT_BOX_CPUS");
      cpus = n;
    }
  }
  const pidsLimit = intIn("JIT_BOX_PIDS", 512, 64, 4096);
  const idleMinutes = intIn("JIT_BOX_IDLE_MINUTES", 30, 5, 240);
  let registryHosts = [...defaultExecutionRegistryHosts];
  {
    const raw = env["JIT_BOX_REGISTRY_HOSTS"];
    if (raw !== undefined) {
      if (raw === "") registryHosts = [];
      else {
        const hosts = raw.split(",");
        if (hosts.length > 32) throw new Error("Invalid JIT_BOX_REGISTRY_HOSTS");
        for (const host of hosts) if (!executionRegistryPattern.test(host)) throw new Error("Invalid JIT_BOX_REGISTRY_HOSTS");
        registryHosts = hosts;
      }
    }
  }
  let fullAllowed = false;
  {
    const raw = env["JIT_EXECUTION_FULL_ALLOWED"];
    if (raw !== undefined) {
      if (raw !== "0" && raw !== "1") throw new Error("Invalid JIT_EXECUTION_FULL_ALLOWED");
      fullAllowed = raw === "1";
    }
  }
  let confirmWords = [...defaultConfirmWords];
  {
    const raw = env["JIT_BROWSER_CONFIRM_WORDS"];
    if (raw !== undefined) {
      const words = raw.split(",").map(word => word.trim().toLowerCase()).filter(Boolean);
      if (!words.length || words.length > 64 || words.some(word => word.length > 64 || !word.isWellFormed() || /[\u0000-\u001f]/.test(word))) throw new Error("Invalid JIT_BROWSER_CONFIRM_WORDS");
      confirmWords = [...new Set(words)];
    }
  }
  return {
    directory,
    secretsDirectory,
    images: base === null ? null : browser === null ? { base } : { base, browser },
    maxBoxes,
    memoryMb,
    cpus,
    pidsLimit,
    idleMinutes,
    registryHosts,
    fullAllowed,
    confirmWords,
  };
}

/** Private deployment profile: wildcard/public binds are rejected by default. */
function validatedHostname(value: string | undefined): string {
  const hostname = value ?? "127.0.0.1";
  if (!hostname.length || hostname === "0.0.0.0" || hostname === "::") throw new Error("Invalid JIT_HOST");
  return hostname;
}

/** Finite local-development limits; operators must measure them before a pilot. */
export interface AppConfig {
  databasePath: string;
  /** Managed search defaults on; environment or service-config opt-out wins, independently of execution boxes. */
  searxngEnabled: boolean;
  /** app.attachments/v1: ingestion gate and host-scaled storage/sanitizer limits. */
  attachments: AttachmentLimits;
  origin: string;
  hostname: string;
  port: number;
  /** Application run adapter: scripted fixture (default) or the pinned Schway host bridge. */
  runPort: "scripted" | "schway";
  bodyBytes: number;
  queryBytes: number;
  pageSize: number;
  messageBytes: number;
  sessionSeconds: number;
  loginAttempts: number;
  loginWindowSeconds: number;
  jobs: JobPolicy;
  team: TeamPolicy;
  telegram: TelegramPolicy;
  ops: OpsPolicy;
  /** Operator execution-box settings; null paths mean execution is not configured. */
  execution: ExecutionConfig;
  /** Operator-configured model per provider (service config `routes[].model`); route forms recommend it (#167). */
  routeModels: RouteModels;
}

/** Reads only Jit's declared settings and rejects malformed or unbounded values. */
export function readConfig(env: Record<string, string | undefined> = process.env, host?: AttachmentHost): AppConfig {
  const positive = (key: string, fallback: number, maximum: number) => {
    const raw = env[key];
    const n = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(n) || n < 1 || n > maximum) throw new Error(`Invalid ${key}`);
    return n;
  };
  const atLeast = (key: string, value: number, minimum: number) => {
    if (value < minimum) throw new Error(`Invalid ${key}`);
    return value;
  };
  const origin = new URL(env.JIT_ORIGIN ?? "http://localhost:3000");
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Invalid JIT_ORIGIN");
  const runPort = env.JIT_RUN_PORT ?? "scripted";
  if (runPort !== "scripted" && runPort !== "schway") throw new Error("Invalid JIT_RUN_PORT");
  // Unencrypted credentials are permitted only for loopback development.
  if (origin.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) {
    throw new Error("JIT_ORIGIN requires HTTPS outside loopback development");
  }
  const jobConcurrency = positive("JIT_JOB_CONCURRENCY", 2, 32), jobRouteConcurrency = positive("JIT_JOB_ROUTE_CONCURRENCY", 1, 32);
  if (jobRouteConcurrency > jobConcurrency) throw new Error("Invalid JIT_JOB_ROUTE_CONCURRENCY");
  // The pinned Schway host keys credential-renewal single-flight per store
  // handle and Jit opens one runtime per run, so concurrent same-route runs
  // could race refresh-token rotation. Schway mode stays single-route until
  // a process-stable public store handle exists.
  if (runPort === "schway" && jobRouteConcurrency !== 1) throw new Error("Invalid JIT_JOB_ROUTE_CONCURRENCY");
  const pollBackoffMs = positive("JIT_TELEGRAM_POLL_BACKOFF_MS", 1_000, 60_000);
  const maxPollBackoffMs = positive("JIT_TELEGRAM_MAX_POLL_BACKOFF_MS", 30_000, 300_000);
  if (maxPollBackoffMs < pollBackoffMs) throw new Error("Invalid JIT_TELEGRAM_MAX_POLL_BACKOFF_MS");
  if (env.JIT_SEARXNG_ENABLED !== undefined && !["0", "1"].includes(env.JIT_SEARXNG_ENABLED)) throw new Error("Invalid JIT_SEARXNG_ENABLED");
  const databasePath = resolve(env.JIT_DATABASE ?? ".local/jit.sqlite");
  return {
    databasePath,
    searxngEnabled: env.JIT_SEARXNG_ENABLED !== "0",
    attachments: attachmentLimits(env, host ?? attachmentHost(dirname(databasePath), `${databasePath}.backups`)),
    runPort,
    origin: origin.origin,
    hostname: validatedHostname(env.JIT_HOST),
    port: positive("JIT_PORT", 3000, 65535),
    bodyBytes: positive("JIT_BODY_BYTES", 16384, 1048576),
    queryBytes: positive("JIT_QUERY_BYTES", 2048, 16384),
    pageSize: positive("JIT_PAGE_SIZE", 50, 200),
    messageBytes: atLeast("JIT_MESSAGE_BYTES", positive("JIT_MESSAGE_BYTES", 4096, 65536), MIN_MESSAGE_BYTES),
    sessionSeconds: positive("JIT_SESSION_SECONDS", 28800, 86400),
    loginAttempts: positive("JIT_LOGIN_ATTEMPTS", 8, 100),
    loginWindowSeconds: positive("JIT_LOGIN_WINDOW_SECONDS", 900, 86400),
    team: {
      roleLimit: positive("JIT_ROLE_LIMIT", 24, 100), responsibilityBytes: positive("JIT_ROLE_BYTES", 2048, 8192),
      sourceLimit: positive("JIT_PREVIEW_SOURCES", 8, 32), contextBytes: positive("JIT_PREVIEW_CONTEXT_BYTES", 32768, 65536),
    },
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
    telegram: {
      botTokenPath: resolve(env.JIT_TELEGRAM_BOT_TOKEN_PATH ?? ".local/telegram-bot.token"),
      challengeSeconds: positive("JIT_TELEGRAM_CHALLENGE_SECONDS", 900, 86_400),
      retentionHours: positive("JIT_TELEGRAM_RETENTION_HOURS", 24, 24),
      pollBackoffMs,
      maxPollBackoffMs,
      processAttempts: positive("JIT_TELEGRAM_PROCESS_ATTEMPTS", 3, 20),
      inboxBytes: positive("JIT_TELEGRAM_INBOX_BYTES", 16_384, 65_536),
    },
    // One bound definition (src/ops/limits.ts) shared with drill fallbacks and record validation.
    ops: {
      diskWatermarkBytes: atLeast("JIT_OPS_DISK_WATERMARK_BYTES", positive("JIT_OPS_DISK_WATERMARK_BYTES", 104_857_600, opsBounds.diskWatermarkBytes.max), opsBounds.diskWatermarkBytes.min),
      retentionDays: atLeast("JIT_OPS_RETENTION_DAYS", positive("JIT_OPS_RETENTION_DAYS", 30, opsBounds.retentionDays.max), opsBounds.retentionDays.min),
      drillDeadlineMs: atLeast("JIT_OPS_DRILL_DEADLINE_MS", positive("JIT_OPS_DRILL_DEADLINE_MS", 120_000, opsBounds.drillDeadlineMs.max), opsBounds.drillDeadlineMs.min),
    },
    execution: parseExecutionConfig(env),
    routeModels: noRouteModels,
  };
}
