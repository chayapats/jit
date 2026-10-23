import { safeAlias } from "../../src/evidence/contract";

/** Trusted operator configuration for one service installation. No secret values exist here. */
export interface ServiceConfig {
  /** Dedicated service identity. Never root and never an interactive login user. */
  serviceUser: string;
  /** Absolute release checkout (replaceable). */
  executablePath: string;
  /** Absolute service working directory. */
  workingDirectory: string;
  /** Absolute managed state directory (durable, outside releases). */
  stateDirectory: string;
  /** Absolute deletion/suppression ledger the service must observe. */
  ledgerPath: string;
  /** Absolute directory for recovery backups and checkpoints. */
  backupDirectory: string;
  /** Non-secret route selection. Models are exact IDs or null when unconfigured. */
  routes: { route: string; model: string | null; configured: boolean }[];
  /** Opaque secret references. Values stay in the supported store boundary. */
  secretRefs: { name: string; store: "service-keyring" | "credential-file" | "environment-file"; key: string }[];
  network: { bindHost: string; port: number; vpnInterface: string | null };
  resources: { memoryMaxBytes: number; maxRestarts: number; restartWindowSeconds: number; logBytes: number; retentionDays: number };
}

const fail = (): never => { throw new Error("invalid_service_config"); };
const userPattern = /^[a-z][a-z0-9_-]{0,31}$/;
const refPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const ipv4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const ipv6 = /^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}$/i;

function absoluteDir(value: unknown, max = 4096): string {
  if (typeof value !== "string" || !value.length || value.length > max || value.includes("\0") || !value.startsWith("/") || value.endsWith("/")) fail();
  return value as string;
}

function positiveInt(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail();
  return value as number;
}

/**
 * Validates trusted installation configuration. Wildcard/public binds
 * (`0.0.0.0`, `::`), root service users, relative paths, state inside the
 * release directory, and any secret-value field all fail with a safe error.
 */
export function parseServiceConfig(raw: unknown): ServiceConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail();
  const c = raw as Record<string, unknown>;
  const keys = ["serviceUser", "executablePath", "workingDirectory", "stateDirectory", "ledgerPath", "backupDirectory",
    "routes", "secretRefs", "network", "resources"];
  if (Object.keys(c).length !== keys.length || keys.some(k => !Object.hasOwn(c, k))) fail();
  if (typeof c.serviceUser !== "string" || !userPattern.test(c.serviceUser) || c.serviceUser === "root") fail();
  const executablePath = absoluteDir(c.executablePath);
  const workingDirectory = absoluteDir(c.workingDirectory);
  const stateDirectory = absoluteDir(c.stateDirectory);
  const ledgerPath = absoluteDir(c.ledgerPath);
  const backupDirectory = absoluteDir(c.backupDirectory);
  for (const dir of [stateDirectory, backupDirectory]) {
    if (dir === executablePath || dir === workingDirectory || dir.startsWith(executablePath + "/") || dir.startsWith(workingDirectory + "/")) fail();
  }
  if (typeof ledgerPath !== "string" || ledgerPath === executablePath || ledgerPath.startsWith(executablePath + "/")) fail();
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
  const secretRefs = (c.secretRefs as unknown[]).map(r => {
    if (!r || typeof r !== "object" || Object.keys(r).sort().join(",") !== "key,name,store") fail();
    const row = r as { name: unknown; store: unknown; key: unknown };
    if (typeof row.name !== "string" || !refPattern.test(row.name) ||
        !["service-keyring", "credential-file", "environment-file"].includes(row.store as string) ||
        typeof row.key !== "string" || !row.key.length || row.key.length > 1024 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(row.key)) fail();
    return { name: row.name as string, store: row.store as ServiceConfig["secretRefs"][number]["store"], key: row.key as string };
  });
  const n = c.network as Record<string, unknown>;
  if (!n || typeof n !== "object" || Object.keys(n).sort().join(",") !== "bindHost,port,vpnInterface") fail();
  if (typeof n.bindHost !== "string" || n.bindHost === "0.0.0.0" || n.bindHost === "::" || !n.bindHost.length) fail();
  const bindHost = n.bindHost as string;
  const loopback = ["127.0.0.1", "::1"];
  if (!loopback.includes(bindHost) && !ipv4.test(bindHost) && !ipv6.test(bindHost)) fail();
  if (n.vpnInterface !== null && (typeof n.vpnInterface !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(n.vpnInterface))) fail();
  const r = c.resources as Record<string, unknown>;
  if (!r || typeof r !== "object") fail();
  const resources = { memoryMaxBytes: positiveInt(r.memoryMaxBytes, 16777216, 34359738368),
    maxRestarts: positiveInt(r.maxRestarts, 0, 20), restartWindowSeconds: positiveInt(r.restartWindowSeconds, 60, 3600),
    logBytes: positiveInt(r.logBytes, 65536, 1073741824), retentionDays: positiveInt(r.retentionDays, 1, 3650) };
  return { serviceUser: c.serviceUser as string, executablePath, workingDirectory, stateDirectory,
    ledgerPath: ledgerPath as string, backupDirectory, routes,
    secretRefs, network: { bindHost: n.bindHost as string, port: positiveInt(n.port, 1, 65535), vpnInterface: n.vpnInterface as string | null }, resources };
}

/** One allowlisted configuration change. Secret references compare opaquely, never by value. */
export interface ServicePlanChange {
  field: string;
  before: unknown;
  after: unknown;
}

const planFields = ["serviceUser", "executablePath", "workingDirectory", "stateDirectory", "ledgerPath",
  "backupDirectory", "routes", "network", "resources"] as const;

/**
 * Plan/validate mode: prints only allowlisted non-secret differences between two
 * validated configurations. Secret references appear as counts plus a changed
 * flag; their stores and keys never enter the diff.
 */
export function planServiceConfig(current: unknown, desired: unknown): ServicePlanChange[] {
  const before = parseServiceConfig(current), after = parseServiceConfig(desired);
  const changes: ServicePlanChange[] = [];
  for (const field of planFields) {
    const a = JSON.stringify(before[field]), b = JSON.stringify(after[field]);
    if (a !== b) changes.push({ field, before: JSON.parse(a), after: JSON.parse(b) });
  }
  const refSummary = (refs: ServiceConfig["secretRefs"]) => ({ count: refs.length, names: refs.map(r => r.name).sort() });
  const rb = JSON.stringify(refSummary(before.secretRefs)), ra = JSON.stringify(refSummary(after.secretRefs));
  if (rb !== ra) changes.push({ field: "secretRefs", before: JSON.parse(rb), after: JSON.parse(ra) });
  return changes;
}

const templateUrl = new URL("./systemd/jit.service", import.meta.url);

function memoryMax(systemd: number): string {
  if (systemd >= 1073741824 && systemd % 1073741824 === 0) return `${systemd / 1073741824}G`;
  return `${Math.floor(systemd / 1048576)}M`;
}

/**
 * Renders the supervised unit from the checked-in template. Rejects wildcard
 * binds again at render time; the unit carries opaque secret references only
 * through EnvironmentFile paths, never values.
 */
export async function renderServiceUnit(config: ServiceConfig, exec: { bunPath: string; appDir: string }): Promise<string> {
  const parsed = parseServiceConfig(config);
  if (typeof exec?.bunPath !== "string" || !exec.bunPath.startsWith("/") || typeof exec?.appDir !== "string" || !exec.appDir.startsWith("/")) {
    throw new Error("invalid_service_config");
  }
  const template = await Bun.file(templateUrl).text();
  return template
    .replaceAll("{{SERVICE_USER}}", parsed.serviceUser)
    .replaceAll("{{BUN_PATH}}", exec.bunPath)
    .replaceAll("{{APP_DIR}}", exec.appDir)
    .replaceAll("{{WORKING_DIR}}", parsed.workingDirectory)
    .replaceAll("{{STATE_DIR}}", parsed.stateDirectory)
    .replaceAll("{{BIND_HOST}}", parsed.network.bindHost)
    .replaceAll("{{PORT}}", String(parsed.network.port))
    .replaceAll("{{MEMORY_MAX}}", memoryMax(parsed.resources.memoryMaxBytes))
    .replaceAll("{{RESTART_BURST}}", String(parsed.resources.maxRestarts))
    .replaceAll("{{RESTART_WINDOW}}", String(parsed.resources.restartWindowSeconds));
}

/** Guards rendered configuration text: no secret-value field may survive rendering. */
export function assertNoSecretValues(rendered: string): void {
  if (/bot[_-]?token\s*=\s*\S|authorization\s*:\s*bearer|BEGIN [A-Z ]*PRIVATE KEY|[0-9]{5,}:[A-Za-z0-9_-]{8,}/i.test(rendered)) {
    throw new Error("invalid_service_rendering");
  }
}

