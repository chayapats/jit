import { dirname, join, resolve } from "node:path";
import { lstatSync, readFileSync } from "node:fs";
import { safeAlias } from "../../src/evidence/contract";

/** Trusted operator configuration for one service installation. No secret values exist here. */
export interface ServiceConfig {
  /** Omitted selects the unchanged legacy service; S14 always uses a separate installation. */
  runtime?: "s14";
  /** Service-only S14 paths and locally built, digest-pinned Bot images. */
  s14?: { vaultDirectory: string; computerRoot: string; gitScratch: string; images?: { base: string; browser: string; buildInputsHash?: string } };
  /** Dedicated service identity. Never root and never an interactive login user. */
  serviceUser: string;
  /**
   * Absolute path of the active release (replaceable). Under the operator
   * commands it is a symlink to `<dirname>/releases/<artifactId>`, switched
   * atomically by install and upgrade.
   */
  executablePath: string;
  /** Absolute service working directory. */
  workingDirectory: string;
  /** Absolute managed state directory (durable, outside releases). Holds `app.sqlite`. */
  stateDirectory: string;
  /** Absolute deletion/suppression ledger checkpoint the service must observe (`jit.deletion.ledger/v1`). */
  ledgerPath: string;
  /** Absolute directory for recovery backups and checkpoints. */
  backupDirectory: string;
  /** Non-secret route selection. Models are exact IDs or null when unconfigured. */
  routes: { route: string; model: string | null; configured: boolean }[];
  /** Opaque secret references. Values stay in the supported store boundary. */
  secretRefs: { name: string; store: "service-keyring" | "credential-file" | "environment-file"; key: string }[];
  network: {
    bindHost: string; port: number; vpnInterface: string | null;
    /**
     * Owner-facing origin served through private ingress. Required and HTTPS
     * for any non-loopback bind; only a loopback bind defaults to
     * `http://<loopback bind>:<port>`.
     */
    origin?: string;
  };
  resources: {
    memoryMaxBytes: number; maxRestarts: number; restartWindowSeconds: number; logBytes: number; retentionDays: number;
    /** Cooperative drain budget on stop/upgrade (default 30). The supervisor waits 15 s longer before terminating. */
    stopTimeoutSeconds?: number;
  };
  /** Application run adapter rendered as `JIT_RUN_PORT` (default `scripted`). */
  runPort?: "scripted" | "schway";
  /** Managed keyless search defaults on; false here or JIT_SEARXNG_ENABLED=0 disables it. */
  searxngEnabled?: boolean;
  /** Chat attachment ingestion defaults on; an explicit value overrides the environment and renders as JIT_ATTACHMENTS. */
  attachmentsEnabled?: boolean;
  /**
   * Opt-in channels. `telegram: "enabled"` requires the `telegram-bot-token`
   * credential-file reference and a supported transport; otherwise startup
   * fails closed. Default disabled: no delivery worker or poller starts.
   */
  channels?: { telegram: "disabled" | "enabled" };
  /**
   * Operator execution-box configuration (`ops.execution_config/v1`).
   * Rendered as `JIT_EXECUTION_*` / `JIT_BOX_*` environment variables.
   */
  execution?: {
    directory: string; secretsDirectory: string;
    images: { base: string; browser?: string };
    maxBoxes: number; memoryMb: number; cpus: number; pidsLimit: number; idleMinutes: number;
    registryHosts: string[]; fullAllowed: boolean;
  };
}

/** Reads one bounded regular trusted config without importing an application or opening its state. */
export function readServiceConfigFile(path: string): ServiceConfig {
  const file = resolve(path), stats = lstatSync(file);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o022) !== 0 || stats.size > 16384) throw new Error("unsafe_service_config_file");
  return parseServiceConfig(JSON.parse(readFileSync(file, "utf8")));
}

/** Secret reference name the Telegram channel reads its bot token through. */
export const telegramSecretRef = "telegram-bot-token";
/** systemd unit name managed by the operator commands. */
export const serviceUnitName = "jit.service";
/** journald namespace that bounds Jit log size and retention. */
export const serviceLogNamespace = "jit";

const fail = (): never => { throw new Error("invalid_service_config"); };
const userPattern = /^[a-z][a-z0-9_-]{0,31}$/;
const refPattern = /^[a-z][a-z0-9_-]{0,63}$/;
/** Box image reference: lowercase name plus a pinned `sha256` digest. */
const imagePattern = /^[a-z0-9][a-z0-9._/-]{0,127}@sha256:[a-f0-9]{64}$/;
/** Lowercase dotted hostname for an allowed package registry. */
const registryHostPattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** Default registry egress allowlist for `workspace` boxes (ADR 0036). */
export const defaultRegistryHosts = ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "proxy.golang.org", "crates.io"];
/** Rendered into unit lines: no whitespace, `%` specifiers, quotes or control characters. */
const pathPattern = /^\/[A-Za-z0-9._@+\/-]{0,4095}$/;
const ipv4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const ipv6 = /^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}$/i;
const loopbackHosts = ["127.0.0.1", "::1"];
/**
 * Interactive home trees on the Linux target: exactly what `ProtectHome=true`
 * hides from the unit, so they are never a durable service location.
 */
const homeRoots = ["/home", "/root", "/run/user"];

/**
 * Private, VPN or loopback address ranges: RFC 1918, CGNAT 100.64/10 (used by
 * mesh VPNs), 127/8, IPv6 unique-local fc00::/7 and loopback. Public
 * addresses are rejected even when explicitly configured.
 */
export function privateAddress(host: string): boolean {
  if (ipv4.test(host)) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (ipv6.test(host)) return host === "::1" || /^f[cd][0-9a-f]{0,2}:/i.test(host);
  return false;
}

function absolutePath(value: unknown): string {
  if (typeof value !== "string" || !pathPattern.test(value) || value.endsWith("/") || /(^|\/)\.\.?(\/|$)/.test(value)) fail();
  return value as string;
}

/**
 * True when `path` collides with state the application derives from the
 * installation database `<state>/app.sqlite`: the database, its `-wal`,
 * `-shm` and `-journal` sidecars, every `<db>.<suffix>` control path
 * (`.backups`, `.upgrades`, `.restores`, `.restore-pending`,
 * `.upgrade-fence`, swaps and pre-migration snapshots) and the managed
 * `.jit-host` and `pr-cache` trees. The ledger alone may use the OPS02
 * default `<db>.lifecycle-ledger.json`.
 */
export function managedCollision(path: string, stateDirectory: string, role: "ledger" | "backup"): boolean {
  const db = join(stateDirectory, "app.sqlite");
  if (role === "ledger" && path === `${db}.lifecycle-ledger.json`) return false;
  if (path === db || path.startsWith(`${db}-`) || path.startsWith(`${db}.`) || inside(db, path)) return true;
  return inside(path, join(stateDirectory, ".jit-host")) || inside(path, join(stateDirectory, "pr-cache"));
}

function underHome(path: string): boolean {
  return homeRoots.some(root => path === root || path.startsWith(root + "/"));
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + "/");
}

function positiveInt(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail();
  return value as number;
}

function keysWithin(value: Record<string, unknown>, required: string[], optional: string[]): void {
  const keys = Object.keys(value);
  if (required.some(k => !Object.hasOwn(value, k)) || keys.some(k => !required.includes(k) && !optional.includes(k))) fail();
}

function parseOrigin(raw: unknown, bindHost: string, port: number): string | undefined {
  // Only a loopback bind may default to a synthesized http://127.0.0.1 origin; any private/VPN bind names its HTTPS origin.
  if (raw === undefined) return loopbackHosts.includes(bindHost) ? undefined : fail();
  if (typeof raw !== "string" || raw.length > 256) fail();
  let url: URL;
  try { url = new URL(raw as string); } catch { return fail(); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) fail();
  // Unencrypted owner credentials are permitted only for a loopback origin on a loopback bind.
  if (url.protocol === "http:" && (!["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) || !loopbackHosts.includes(bindHost))) fail();
  void port;
  return url.origin;
}

/**
 * Validates trusted installation configuration. Wildcard/public binds
 * (`0.0.0.0`, `::`), root service users, relative or home-directory paths,
 * state inside the release directory, unknown fields and any secret-value
 * field all fail with a safe error.
 */
export function parseServiceConfig(raw: unknown): ServiceConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail();
  const c = raw as Record<string, unknown>;
  keysWithin(c, ["serviceUser", "executablePath", "workingDirectory", "stateDirectory", "ledgerPath", "backupDirectory",
    "routes", "secretRefs", "network", "resources"], ["runtime", "s14", "runPort", "channels", "execution", "searxngEnabled", "attachmentsEnabled"]);
  if (typeof c.serviceUser !== "string" || !userPattern.test(c.serviceUser) || c.serviceUser === "root") fail();
  const executablePath = absolutePath(c.executablePath);
  const workingDirectory = absolutePath(c.workingDirectory);
  const stateDirectory = absolutePath(c.stateDirectory);
  const ledgerPath = absolutePath(c.ledgerPath);
  const backupDirectory = absolutePath(c.backupDirectory);
  const releases = join(dirname(executablePath), "releases");
  for (const dir of [stateDirectory, backupDirectory]) {
    if (inside(dir, executablePath) || inside(dir, workingDirectory) || inside(dir, releases) || inside(executablePath, dir)) fail();
  }
  if (inside(ledgerPath, executablePath) || inside(ledgerPath, releases)) fail();
  // Managed-path collisions: the ledger and backups may not occupy the database, its SQLite sidecars,
  // any database-derived control path (backups, upgrades, restores, fences, swaps), the engine host
  // tree, the PR cache or each other.
  if (managedCollision(ledgerPath, stateDirectory, "ledger") || inside(ledgerPath, backupDirectory) ||
      [stateDirectory, workingDirectory, backupDirectory].includes(ledgerPath)) fail();
  if (managedCollision(backupDirectory, stateDirectory, "backup") || backupDirectory === stateDirectory || inside(stateDirectory, backupDirectory)) fail();
  for (const path of [stateDirectory, backupDirectory, ledgerPath, workingDirectory]) if (underHome(path)) fail();
  if (!Array.isArray(c.routes) || c.routes.length > 8) fail();
  const seen = new Set<string>();
  const routes = (c.routes as unknown[]).map(r => {
    if (!r || typeof r !== "object" || Object.keys(r).sort().join(",") !== "configured,model,route" || typeof (r as { configured?: unknown }).configured !== "boolean") fail();
    const row = r as { route: unknown; model: unknown; configured: boolean };
    const route = safeAlias(row.route);
    const model = row.model === null ? null : safeAlias(row.model);
    if (seen.has(route)) fail();
    seen.add(route);
    if (row.configured && model === null) fail();
    return { route, model, configured: row.configured };
  });
  if (!Array.isArray(c.secretRefs) || c.secretRefs.length > 8) fail();
  const refNames = new Set<string>();
  const secretRefs = (c.secretRefs as unknown[]).map(r => {
    if (!r || typeof r !== "object" || Object.keys(r).sort().join(",") !== "key,name,store") fail();
    const row = r as { name: unknown; store: unknown; key: unknown };
    if (typeof row.name !== "string" || !refPattern.test(row.name) || refNames.has(row.name) ||
        !["service-keyring", "credential-file", "environment-file"].includes(row.store as string) ||
        typeof row.key !== "string" || !row.key.length || row.key.length > 1024 || /[\x00-\x1f\x7f]/.test(row.key)) fail();
    // File references are rendered into unit lines and stat-checked by preflight: absolute and specifier-free only.
    if (row.store !== "service-keyring") absolutePath(row.key);
    refNames.add(row.name as string);
    return { name: row.name as string, store: row.store as ServiceConfig["secretRefs"][number]["store"], key: row.key as string };
  });
  const n = c.network as Record<string, unknown>;
  if (!n || typeof n !== "object" || Array.isArray(n)) fail();
  keysWithin(n, ["bindHost", "port", "vpnInterface"], ["origin"]);
  if (typeof n.bindHost !== "string" || n.bindHost === "0.0.0.0" || n.bindHost === "::" || !n.bindHost.length) fail();
  const bindHost = n.bindHost as string;
  if (!loopbackHosts.includes(bindHost) && !ipv4.test(bindHost) && !ipv6.test(bindHost)) fail();
  if (n.vpnInterface !== null && (typeof n.vpnInterface !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(n.vpnInterface))) fail();
  // Private deployment profile: a non-loopback bind must be a private/VPN address on a named interface.
  if (!loopbackHosts.includes(bindHost) && (n.vpnInterface === null || !privateAddress(bindHost))) fail();
  const port = positiveInt(n.port, 1, 65535);
  const origin = parseOrigin(n.origin, bindHost, port);
  const r = c.resources as Record<string, unknown>;
  if (!r || typeof r !== "object" || Array.isArray(r)) fail();
  keysWithin(r, ["memoryMaxBytes", "maxRestarts", "restartWindowSeconds", "logBytes", "retentionDays"], ["stopTimeoutSeconds"]);
  const resources: ServiceConfig["resources"] = { memoryMaxBytes: positiveInt(r.memoryMaxBytes, 16777216, 34359738368),
    maxRestarts: positiveInt(r.maxRestarts, 0, 20), restartWindowSeconds: positiveInt(r.restartWindowSeconds, 60, 3600),
    logBytes: positiveInt(r.logBytes, 65536, 1073741824), retentionDays: positiveInt(r.retentionDays, 1, 3650) };
  if (r.stopTimeoutSeconds !== undefined) resources.stopTimeoutSeconds = positiveInt(r.stopTimeoutSeconds, 1, 280);
  const parsed: ServiceConfig = { serviceUser: c.serviceUser as string, executablePath, workingDirectory, stateDirectory,
    ledgerPath, backupDirectory, routes, secretRefs,
    network: { bindHost, port, vpnInterface: n.vpnInterface as string | null, ...(origin !== undefined ? { origin } : {}) }, resources };
  if (c.searxngEnabled !== undefined) {
    if (typeof c.searxngEnabled !== "boolean") fail();
    parsed.searxngEnabled = c.searxngEnabled as boolean;
  }
  if (c.attachmentsEnabled !== undefined) {
    if (typeof c.attachmentsEnabled !== "boolean") fail();
    parsed.attachmentsEnabled = c.attachmentsEnabled as boolean;
  }
  if (c.runPort !== undefined) {
    if (c.runPort !== "scripted" && c.runPort !== "schway") fail();
    parsed.runPort = c.runPort as "scripted" | "schway";
  }
  if (c.channels !== undefined) {
    const ch = c.channels as Record<string, unknown>;
    if (!ch || typeof ch !== "object" || Array.isArray(ch)) fail();
    keysWithin(ch, ["telegram"], []);
    if (ch.telegram !== "disabled" && ch.telegram !== "enabled") fail();
    // An enabled channel must name its credential reference up front; there is no plaintext or prompt fallback.
    if (ch.telegram === "enabled" && !secretRefs.some(ref => ref.name === telegramSecretRef && ref.store === "credential-file")) fail();
    parsed.channels = { telegram: ch.telegram as "disabled" | "enabled" };
  }
  if (c.execution !== undefined) {
    const e = c.execution as Record<string, unknown>;
    if (!e || typeof e !== "object" || Array.isArray(e)) fail();
    keysWithin(e, ["directory", "secretsDirectory", "images"],
      ["maxBoxes", "memoryMb", "cpus", "pidsLimit", "idleMinutes", "registryHosts", "fullAllowed"]);
    const directory = absolutePath(e.directory);
    const secretsDirectory = absolutePath(e.secretsDirectory);
    const images = e.images as Record<string, unknown>;
    if (!images || typeof images !== "object" || Array.isArray(images)) fail();
    keysWithin(images, ["base"], ["browser"]);
    if (typeof images.base !== "string" || !imagePattern.test(images.base)) fail();
    if (images.browser !== undefined && (typeof images.browser !== "string" || !imagePattern.test(images.browser))) fail();
    const maxBoxes = e.maxBoxes === undefined ? 2 : positiveInt(e.maxBoxes, 1, 8);
    const memoryMb = e.memoryMb === undefined ? 2048 : positiveInt(e.memoryMb, 256, 8192);
    let cpus = 2;
    if (e.cpus !== undefined) {
      if (typeof e.cpus !== "number" || Number.isNaN(e.cpus) || e.cpus < 0.5 || e.cpus > 4) fail();
      cpus = e.cpus as number;
    }
    const pidsLimit = e.pidsLimit === undefined ? 512 : positiveInt(e.pidsLimit, 64, 4096);
    const idleMinutes = e.idleMinutes === undefined ? 30 : positiveInt(e.idleMinutes, 5, 240);
    let registryHosts = [...defaultRegistryHosts];
    if (e.registryHosts !== undefined) {
      if (!Array.isArray(e.registryHosts) || (e.registryHosts as unknown[]).length > 32) fail();
      for (const host of e.registryHosts as unknown[]) {
        if (typeof host !== "string" || !registryHostPattern.test(host)) fail();
      }
      registryHosts = [...(e.registryHosts as string[])];
    }
    let fullAllowed = false;
    if (e.fullAllowed !== undefined) {
      if (typeof e.fullAllowed !== "boolean") fail();
      fullAllowed = e.fullAllowed as boolean;
    }
    const protectedDirs = [stateDirectory, backupDirectory, dirname(ledgerPath), workingDirectory, releases];
    for (const dir of [directory, secretsDirectory]) {
      for (const other of protectedDirs) {
        if (inside(dir, other) || inside(other, dir)) fail();
      }
    }
    if (inside(directory, secretsDirectory) || inside(secretsDirectory, directory)) fail();
    parsed.execution = { directory, secretsDirectory,
      images: images.browser === undefined
        ? { base: images.base as string }
        : { base: images.base as string, browser: images.browser as string },
      maxBoxes, memoryMb, cpus, pidsLimit, idleMinutes, registryHosts, fullAllowed };
  }
  if (c.runtime !== undefined || c.s14 !== undefined) {
    if (c.runtime !== "s14" || !c.s14 || typeof c.s14 !== "object" || Array.isArray(c.s14) || c.execution !== undefined || c.channels && parsed.channels?.telegram !== "disabled") fail();
    const s = c.s14 as Record<string, unknown>;
    keysWithin(s, ["vaultDirectory", "computerRoot", "gitScratch"], ["images"]);
    const paths = [s.vaultDirectory, s.computerRoot, s.gitScratch].map(absolutePath);
    const protectedPaths = [stateDirectory, backupDirectory, workingDirectory, dirname(ledgerPath), dirname(executablePath)];
    for (const path of paths) {
      if (underHome(path) || [...protectedPaths, ...paths.filter(other => other !== path)].some(other => inside(path, other) || inside(other, path))) fail();
    }
    if (new Set(paths).size !== 3 || parsed.runPort !== "schway") fail();
    // S14's listener is derived from its origin, not the legacy bind configuration.
    const browser = new URL(origin ?? `http://127.0.0.1:${port}`);
    if (bindHost !== "127.0.0.1" || (browser.protocol === "https:" ? port !== 3001
      : browser.hostname !== "127.0.0.1" || Number(browser.port || 80) !== port)) fail();
    parsed.runtime = "s14";
    parsed.s14 = { vaultDirectory: paths[0]!, computerRoot: paths[1]!, gitScratch: paths[2]! };
    if (s.images !== undefined) {
      const images = s.images as Record<string, unknown>;
      if (!images || typeof images !== "object" || Array.isArray(images)) fail();
      keysWithin(images, ["base", "browser"], ["buildInputsHash"]);
      if (images.buildInputsHash !== undefined && (typeof images.buildInputsHash !== "string" || !/^[a-f0-9]{64}$/.test(images.buildInputsHash))) fail();
      if (![images.base, images.browser].every(image => typeof image === "string" && imagePattern.test(image))) fail();
      parsed.s14.images = { base: images.base as string, browser: images.browser as string,
        ...(images.buildInputsHash !== undefined ? { buildInputsHash: images.buildInputsHash as string } : {}) };
    }
  }
  return parsed;
}

/** Unit and journal namespace are selected only by trusted installation configuration. */
export function serviceUnit(config: ServiceConfig): string { return config.runtime === "s14" ? "jit-s14.service" : serviceUnitName; }
/** S14 logs have their own bounded namespace beside the legacy namespace. */
export function serviceJournal(config: ServiceConfig): string { return config.runtime === "s14" ? "jit-s14" : serviceLogNamespace; }
/** Public sign-in route used for local health and existing-owner entry, without creating authority. */
export function serviceLoginPath(config: ServiceConfig): string { return config.runtime === "s14" ? "/s14/login" : "/login"; }

/** Installation database inside the managed state directory. */
export function serviceDatabasePath(config: ServiceConfig): string {
  return join(config.stateDirectory, config.runtime === "s14" ? "application.sqlite" : "app.sqlite");
}

/** Immutable releases live beside the active-release path, never under state. */
export function serviceReleasesDirectory(config: ServiceConfig): string {
  return join(dirname(config.executablePath), "releases");
}

/** Owner origin served by this installation. */
export function serviceOrigin(config: ServiceConfig): string {
  if (config.network.origin) return config.network.origin;
  if (!loopbackHosts.includes(config.network.bindHost)) throw new Error("invalid_service_config");
  const host = config.network.bindHost.includes(":") ? `[${config.network.bindHost}]` : config.network.bindHost;
  return `http://${host}:${config.network.port}`;
}

/** Credential-file path of the Telegram bot token reference, or null when absent. */
export function telegramTokenPath(config: ServiceConfig): string | null {
  return config.secretRefs.find(ref => ref.name === telegramSecretRef && ref.store === "credential-file")?.key ?? null;
}

/** True when the operator explicitly opted the Telegram channel in. */
export function telegramEnabled(config: ServiceConfig): boolean {
  return config.channels?.telegram === "enabled";
}

/** Cooperative drain budget for stop and upgrade, in milliseconds. */
export function serviceDrainTimeoutMs(config: ServiceConfig): number {
  return (config.resources.stopTimeoutSeconds ?? 30) * 1000;
}

/**
 * Process environment the supervised unit sets. Values are paths, binds and
 * fixed enums only; the bot token appears as its file reference, never its value.
 */
export function serviceEnvironment(config: ServiceConfig): [string, string][] {
  const parsed = parseServiceConfig(config);
  if (parsed.runtime === "s14") {
    const s = parsed.s14!;
    return [["JIT_S14_DATABASE", serviceDatabasePath(parsed)], ["JIT_S14_ORIGIN", serviceOrigin(parsed)],
      ["JIT_S14_VAULT_DIRECTORY", s.vaultDirectory], ["JIT_S14_GIT_SCRATCH", s.gitScratch],
      ...(s.images ? [["JIT_S14_COMPUTER_ROOT", s.computerRoot], ["JIT_BOX_IMAGE_BASE", s.images.base], ["JIT_BOX_IMAGE_BROWSER", s.images.browser]] as [string, string][] : [])];
  }
  const env: [string, string][] = [
    ["JIT_DATABASE", serviceDatabasePath(parsed)],
    ["JIT_HOST", parsed.network.bindHost],
    ["JIT_PORT", String(parsed.network.port)],
    ["JIT_ORIGIN", serviceOrigin(parsed)],
    ["JIT_RUN_PORT", parsed.runPort ?? "scripted"],
  ];
  if (parsed.searxngEnabled !== undefined) env.push(["JIT_SEARXNG_ENABLED", parsed.searxngEnabled ? "1" : "0"]);
  if (parsed.attachmentsEnabled !== undefined) env.push(["JIT_ATTACHMENTS", parsed.attachmentsEnabled ? "1" : "0"]);
  if (!parsed.execution) env.push(["JIT_EXECUTION_SECRETS_DIR", `${parsed.stateDirectory}.connections`]);
  const token = telegramTokenPath(parsed);
  if (token) env.push(["JIT_TELEGRAM_BOT_TOKEN_PATH", token]);
  if (parsed.execution) {
    const e = parsed.execution;
    env.push(["JIT_EXECUTION_DIR", e.directory]);
    env.push(["JIT_EXECUTION_SECRETS_DIR", e.secretsDirectory]);
    env.push(["JIT_BOX_IMAGE_BASE", e.images.base]);
    if (e.images.browser !== undefined) env.push(["JIT_BOX_IMAGE_BROWSER", e.images.browser]);
    env.push(["JIT_BOX_MAX", String(e.maxBoxes)]);
    env.push(["JIT_BOX_MEMORY_MB", String(e.memoryMb)]);
    env.push(["JIT_BOX_CPUS", String(e.cpus)]);
    env.push(["JIT_BOX_PIDS", String(e.pidsLimit)]);
    env.push(["JIT_BOX_IDLE_MINUTES", String(e.idleMinutes)]);
    env.push(["JIT_BOX_REGISTRY_HOSTS", e.registryHosts.join(",")]);
    env.push(["JIT_EXECUTION_FULL_ALLOWED", e.fullAllowed ? "1" : "0"]);
  }
  return env;
}

/** One allowlisted configuration change. Secret references compare opaquely, never by value. */
export interface ServicePlanChange {
  field: string;
  before: unknown;
  after: unknown;
}

const planFields = ["runtime", "s14", "serviceUser", "executablePath", "workingDirectory", "stateDirectory", "ledgerPath",
  "backupDirectory", "routes", "network", "resources", "runPort", "channels", "execution", "searxngEnabled", "attachmentsEnabled"] as const;

/**
 * Plan/validate mode: prints only allowlisted non-secret differences between two
 * validated configurations. Secret references appear as counts plus names;
 * their stores and keys never enter the diff. `current` may be null for a
 * first install, in which case every allowlisted field is reported as added.
 */
export function planServiceConfig(current: unknown, desired: unknown): ServicePlanChange[] {
  const before = current === null ? null : parseServiceConfig(current), after = parseServiceConfig(desired);
  const changes: ServicePlanChange[] = [];
  for (const field of planFields) {
    const a = before ? JSON.stringify(before[field] ?? null) : "null", b = JSON.stringify(after[field] ?? null);
    if (a !== b) changes.push({ field, before: JSON.parse(a), after: JSON.parse(b) });
  }
  const refSummary = (refs: ServiceConfig["secretRefs"]) => ({ count: refs.length, names: refs.map(r => r.name).sort() });
  const rb = before ? JSON.stringify(refSummary(before.secretRefs)) : "null", ra = JSON.stringify(refSummary(after.secretRefs));
  if (rb !== ra) changes.push({ field: "secretRefs", before: JSON.parse(rb), after: JSON.parse(ra) });
  return changes;
}

const templateUrl = new URL("./systemd/jit.service", import.meta.url);
const journaldTemplateUrl = new URL("./systemd/journald@jit.conf", import.meta.url);

function memoryMax(bytes: number): string {
  if (bytes >= 1073741824 && bytes % 1073741824 === 0) return `${bytes / 1073741824}G`;
  return `${Math.floor(bytes / 1048576)}M`;
}

/** Paths the sandboxed unit may write: managed state, backups and the ledger checkpoint directory. */
export function serviceWritablePaths(config: ServiceConfig): string[] {
  const parsed = parseServiceConfig(config);
  const paths = [parsed.stateDirectory, parsed.backupDirectory, dirname(parsed.ledgerPath)];
  if (parsed.runtime === "s14") return [...new Set([...paths, parsed.s14!.vaultDirectory, parsed.s14!.computerRoot])];
  if (parsed.execution) paths.push(parsed.execution.directory, parsed.execution.secretsDirectory);
  else paths.push(`${parsed.stateDirectory}.connections`);
  return [...new Set(paths)];
}

/** The service identity's user-session bus socket (Secret Service for Schway's native credential store). */
export function serviceSessionBusPath(uid: number): string {
  return `/run/user/${uid}/bus`;
}

/**
 * Exposes only the identity's rootless Podman socket directory through otherwise empty home trees.
 * Every installed unit selects the remote client and orders after its lingering user manager.
 * Schway additionally receives its existing Secret Service session-bus bind; scripted mode does not.
 */
function sessionBusUnit(parsed: ServiceConfig, uid: number | undefined): { ordering: string; protection: string; environment: [string, string][] } {
  if (uid === undefined) return { ordering: "", protection: "ProtectHome=true", environment: [] };
  const bus = serviceSessionBusPath(uid);
  return {
    ordering: `After=user@${uid}.service\nWants=user@${uid}.service\n`,
    protection: `ProtectHome=tmpfs\nBindPaths=-/run/user/${uid}/podman${parsed.runPort === "schway" ? `\nBindPaths=${bus}` : ""}`,
    environment: [["JIT_PODMAN_MODE", "remote"], ["JIT_SERVICE_USER", parsed.serviceUser], ["XDG_RUNTIME_DIR", `/run/user/${uid}`],
      ...(parsed.runPort === "schway" ? [["DBUS_SESSION_BUS_ADDRESS", `unix:path=${bus}`] as [string, string]] : [])],
  };
}

/**
 * Renders the supervised unit from the checked-in template. Rejects wildcard
 * binds again at render time; the unit carries opaque secret references only
 * as file paths, never values. `appDir` defaults to the active-release path so
 * code-only activation can switch releases. Install resolves the identity's UID, primary GID and home.
 * Only the user API directory and existing Schway bus are bound back; default container storage
 * stays inaccessible. An unresolved-UID plan is blocked and receives no socket exception or remote environment.
 */
export async function renderServiceUnit(config: ServiceConfig, exec: { bunPath: string; appDir?: string; configPath?: string; gid?: number; uid?: number; home?: string }): Promise<string> {
  const parsed = parseServiceConfig(config);
  const appDir = exec?.appDir ?? parsed.executablePath;
  const configPath = exec?.configPath ?? join(parsed.stateDirectory, "service-config.json");
  for (const path of [exec?.bunPath, appDir, configPath, exec.home ?? "/var/lib/jit"]) absolutePath(path);
  for (const id of [exec.gid, exec.uid]) {
    if (id !== undefined && (!Number.isSafeInteger(id) || id < 1 || id > 4294967294)) throw new Error("invalid_service_config");
  }
  const template = await Bun.file(templateUrl).text();
  const stopSeconds = serviceDrainTimeoutMs(parsed) / 1000;
  const bus = sessionBusUnit(parsed, exec.uid);
  // Schway's cross-process credential-store lock lives in the identity's ~/.schway. Under ProtectSystem=strict a
  // read-only home turns every Web sign-in and token refresh into a store error.
  const schwayHome = parsed.runPort === "schway" && exec.uid !== undefined ? [`-${join(exec.home ?? "/var/lib/jit", ".schway")}`] : [];
  return template
    .replaceAll("{{RUNTIME_ARGS}}", parsed.runtime === "s14" ? "--s14 --no-refusal-page" : `--service-config ${configPath}`)
    .replaceAll("{{RUNTIME_FILESYSTEM}}", parsed.runtime === "s14" && exec.uid !== undefined && exec.gid !== undefined
      ? `TemporaryFileSystem=${parsed.s14!.gitScratch}:rw,nosuid,nodev,noexec,size=128M,mode=0700,uid=${exec.uid},gid=${exec.gid}\nEnvironment=HOME=${exec.home ?? "/var/lib/jit-s14"}` : "")
    .replaceAll("{{UNIT_ORDERING}}", bus.ordering)
    .replaceAll("{{HOME_PROTECTION}}", bus.protection)
    .replaceAll("{{SERVICE_USER}}", parsed.serviceUser)
    .replaceAll("{{SERVICE_HOME}}", exec.home ?? "/var/lib/jit")
    .replaceAll("{{SERVICE_GROUP}}", exec.gid !== undefined ? String(exec.gid) : parsed.serviceUser)
    .replaceAll("{{BUN_PATH}}", exec.bunPath)
    .replaceAll("{{APP_DIR}}", appDir)
    .replaceAll("{{CONFIG_PATH}}", configPath)
    .replaceAll("{{WORKING_DIR}}", parsed.workingDirectory)
    .replaceAll("{{ENVIRONMENT}}", [...serviceEnvironment(parsed), ...bus.environment].map(([k, v]) => `Environment=${k}=${v}`).join("\n"))
    .replaceAll("{{WRITABLE_PATHS}}", [...serviceWritablePaths(parsed), ...schwayHome, ...(exec.uid === undefined ? [] : [`-/run/user/${exec.uid}/podman`])].join(" "))
    .replaceAll("{{MEMORY_MAX}}", memoryMax(parsed.resources.memoryMaxBytes))
    .replaceAll("{{STOP_TIMEOUT}}", String(stopSeconds + 15))
    .replaceAll("{{LOG_NAMESPACE}}", serviceJournal(parsed))
    .replaceAll("{{RESTART_BURST}}", String(parsed.resources.maxRestarts))
    .replaceAll("{{RESTART_WINDOW}}", String(parsed.resources.restartWindowSeconds));
}

/** Renders the journald namespace configuration that bounds log size and retention. */
export async function renderJournaldConfig(config: ServiceConfig): Promise<string> {
  const parsed = parseServiceConfig(config);
  const template = await Bun.file(journaldTemplateUrl).text();
  return template
    .replaceAll("{{LOG_BYTES}}", String(parsed.resources.logBytes))
    .replaceAll("{{LOG_FILE_BYTES}}", String(Math.max(65536, Math.floor(parsed.resources.logBytes / 8))))
    .replaceAll("{{RETENTION_DAYS}}", String(parsed.resources.retentionDays));
}

/** Guards rendered configuration text: no secret-value field may survive rendering. */
export function assertNoSecretValues(rendered: string): void {
  if (/bot[_-]?token\s*=\s*[^/\s]|authorization\s*:\s*bearer|BEGIN [A-Z ]*PRIVATE KEY|[0-9]{5,}:[A-Za-z0-9_-]{8,}|password\s*[=:]|sk-[A-Za-z0-9_-]{16,}/i.test(rendered)) {
    throw new Error("invalid_service_rendering");
  }
}
