/** Labels are explicit non-sensitive local aliases, never addresses, credentials or executable paths. */
export function safeAlias(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(value) ||
      /(?:token|secret|password|bearer|header|\d+\.\d+\.\d+\.\d+)/i.test(value) || /[a-z0-9]{32}/i.test(value)) throw new Error("invalid_alias");
  return value;
}
/** Fixed route states do not imply fallback, provisioning, login or billing authorization. */
export const routeStates = ["not-configured", "configured-unverified", "observed-ready", "needs-login", "store-unavailable", "quota-waiting", "rejected", "failed"] as const;
export type RouteState = typeof routeStates[number];
/** The observation class distinguishes deterministic fixtures from actual route and lifecycle evidence. */
export const observations = ["inventory", "fixture", "live-request", "service-start", "credential-read", "renewal", "restart", "reboot"] as const;
export type Observation = typeof observations[number];
export const probeClasses = ["inventory", "preflight", "inference", "renewal", "restart", "reboot"] as const;
export const actions = ["none", "configure-route", "run-opt-in-probe", "owner-login", "check-secure-store", "wait-for-quota", "review-route-policy", "inspect-sanitized-failure", "check-runtime-path", "provide-writable-state-directory", "verify-dependencies-on-target", "check-local-evidence-directory"] as const;
export type NextAction = typeof actions[number];
const next: Record<RouteState, NextAction> = { "not-configured": "configure-route", "configured-unverified": "run-opt-in-probe", "observed-ready": "none", "needs-login": "owner-login", "store-unavailable": "check-secure-store", "quota-waiting": "wait-for-quota", rejected: "review-route-policy", failed: "inspect-sanitized-failure" };
/** One bounded, classified observation contains no raw transport data or environment. */
export interface RouteEvidence {
  route: string; model: string | null; observation: Observation; probeClass: typeof probeClasses[number];
  maxAttempts: number; attempts: number; deadlineMs: number; elapsedMs: number; state: RouteState; nextAction: NextAction;
}
/** Pure classifier for trusted future probe adapters; configured access and fixtures cannot prove live readiness. */
export function routeEvidence(input: Omit<RouteEvidence, "state" | "nextAction"> & {
  configured: boolean; event: "unobserved" | "success" | "login" | "store" | "quota" | "rejected" | "failed";
}): RouteEvidence {
  safeAlias(input.route); if (input.model !== null) safeAlias(input.model);
  if (!observations.includes(input.observation) || !probeClasses.includes(input.probeClass) ||
      !Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 10 ||
      !Number.isSafeInteger(input.attempts) || input.attempts < 0 || input.attempts > input.maxAttempts ||
      !Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1 || input.deadlineMs > 60000 ||
      !Number.isSafeInteger(input.elapsedMs) || input.elapsedMs < 0 || input.elapsedMs > 120000 ||
      typeof input.configured !== "boolean" || !["unobserved", "success", "login", "store", "quota", "rejected", "failed"].includes(input.event)) throw new Error("invalid_observation");
  if (input.event !== "unobserved" && input.attempts === 0) throw new Error("missing_attempt");
  let state: RouteState = !input.configured ? "not-configured" : "configured-unverified";
  if (input.configured) {
    const failure = { login: "needs-login", store: "store-unavailable", quota: "quota-waiting", rejected: "rejected", failed: "failed" } as const;
    if (input.event in failure) state = failure[input.event as keyof typeof failure];
    if (input.event === "success" && input.observation === "live-request" && input.probeClass === "inference" &&
        input.model !== null && input.elapsedMs <= input.deadlineMs) state = "observed-ready";
    if (input.elapsedMs > input.deadlineMs) state = "failed";
  }
  return { route: input.route, model: input.model, observation: input.observation, probeClass: input.probeClass,
    maxAttempts: input.maxAttempts, attempts: input.attempts, deadlineMs: input.deadlineMs, elapsedMs: input.elapsedMs,
    state, nextAction: next[state] };
}
/** Values admitted to persisted evidence are a small, allowlisted structured vocabulary. */
export interface Inventory {
  os: "linux" | "darwin" | "win32" | "unverified";
  architecture: "arm64" | "x64" | "arm" | "unverified";
  kernel: string | null; processBun: string | null;
  testedPathBun: { state: "installed" | "absent-on-tested-PATH" | "unverified"; version: string | null };
  dependencies: { name: string; declared: string; installed: string | null; compatibility: "unverified" }[];
  identity: { uid: number | null; effectiveUid: number | null };
  context: "interactive" | "service" | "ci" | "unspecified";
  workingDirectory: "ready" | "unavailable" | "unverified";
  testedPath: "nonempty" | "empty";
  persistentState: "writable" | "unavailable" | "unverified";
}
/** Versioned local evidence is descriptive and cannot grant authority to perform its next action. */
export interface HostEvidence {
  schema: "jit.host.evidence/v1"; id: string; observedAt: string; installationLabel: string;
  observation: Observation; maxAttempts: number; attempts: number; deadlineMs: number;
  inventory: Inventory; routes: RouteEvidence[]; outcome: "blocked" | "failed"; nextAction: NextAction;
}
const versionPattern = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-(?:canary|beta|rc)(?:\.\d{1,8})?)?$/;
/** Admits exact runtime/dependency versions without copying arbitrary process output. */
export function safeVersion(value: unknown): string | null {
  return typeof value === "string" && versionPattern.test(value) ? value : null;
}
/** Kernel observations preserve numeric/vendor releases without permitting arbitrary diagnostic text. */
export function safeKernel(value: unknown): string | null {
  return typeof value === "string" && /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-(?:\d{1,5}|generic|amd64|arm64|raspi|aws|azure|linuxkit)(?:[.-](?:\d{1,5}|generic|amd64|arm64|raspi|aws|azure|linuxkit))*)?$/.test(value) ? value : null;
}
const exact = (o: unknown, keys: string[]): o is Record<string, unknown> => !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));
const nullableVersion = (v: unknown) => v === null || safeVersion(v) === v;
const uid = (n: unknown) => n === null || typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 4294967295;
/** Rejects malformed, unknown-field and oversized evidence before any persistence or export. */
export function validateEvidence(value: unknown): asserts value is HostEvidence {
  const fail = () => { throw new Error("invalid_evidence"); };
  if (!exact(value, ["schema", "id", "observedAt", "installationLabel", "observation", "maxAttempts", "attempts", "deadlineMs", "inventory", "routes", "outcome", "nextAction"])) fail();
  const e = value as HostEvidence;
  if (e.schema !== "jit.host.evidence/v1" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(e.id) ||
      typeof e.observedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(e.observedAt) || !Number.isFinite(Date.parse(e.observedAt)) ||
      safeAlias(e.installationLabel) !== e.installationLabel || !observations.includes(e.observation) ||
      !Number.isSafeInteger(e.maxAttempts) || e.maxAttempts < 1 || e.maxAttempts > 10 ||
      !Number.isSafeInteger(e.attempts) || e.attempts < 0 || e.attempts > e.maxAttempts ||
      !Number.isSafeInteger(e.deadlineMs) || e.deadlineMs < 1 || e.deadlineMs > 60000 || !["blocked", "failed"].includes(e.outcome) || !actions.includes(e.nextAction)) fail();
  if (e.observation === "inventory" && (e.maxAttempts !== 1 || e.attempts !== 1 || e.deadlineMs < 100 || e.deadlineMs > 10000)) fail();
  const i = e.inventory;
  if (!exact(i, ["os", "architecture", "kernel", "processBun", "testedPathBun", "dependencies", "identity", "context", "workingDirectory", "testedPath", "persistentState"]) ||
      !["linux", "darwin", "win32", "unverified"].includes(i.os) || !["arm64", "x64", "arm", "unverified"].includes(i.architecture) ||
      !(i.kernel === null || safeKernel(i.kernel) === i.kernel) || !nullableVersion(i.processBun) ||
      !exact(i.testedPathBun, ["state", "version"]) || !["installed", "absent-on-tested-PATH", "unverified"].includes(i.testedPathBun.state) ||
      !nullableVersion(i.testedPathBun.version) || (i.testedPathBun.state === "installed") !== (i.testedPathBun.version !== null) ||
      !exact(i.identity, ["uid", "effectiveUid"]) || !uid(i.identity.uid) || !uid(i.identity.effectiveUid) ||
      !["interactive", "service", "ci", "unspecified"].includes(i.context) || !["ready", "unavailable", "unverified"].includes(i.workingDirectory) ||
      !["nonempty", "empty"].includes(i.testedPath) || !["writable", "unavailable", "unverified"].includes(i.persistentState) ||
      !Array.isArray(i.dependencies) || i.dependencies.length > 16 || !Array.isArray(e.routes) || e.routes.length > 8) fail();
  for (const d of i.dependencies) {
    if (!exact(d, ["name", "declared", "installed", "compatibility"]) || !["typescript", "@types/bun"].includes(d.name) ||
        safeVersion(d.declared) !== d.declared || !nullableVersion(d.installed) || d.compatibility !== "unverified") fail();
  }
  for (const r of e.routes) {
    if (!exact(r, ["route", "model", "observation", "probeClass", "maxAttempts", "attempts", "deadlineMs", "elapsedMs", "state", "nextAction"]) || !routeStates.includes(r.state)) fail();
    const event = ({ "not-configured": "unobserved", "configured-unverified": "unobserved", "observed-ready": "success", "needs-login": "login", "store-unavailable": "store", "quota-waiting": "quota", rejected: "rejected", failed: "failed" } as const)[r.state];
    const derived = routeEvidence({ ...r, configured: r.state !== "not-configured", event });
    if (derived.state !== r.state || derived.nextAction !== r.nextAction || r.observation !== e.observation || r.maxAttempts > e.maxAttempts || r.attempts > e.attempts || r.deadlineMs > e.deadlineMs) fail();
    if (e.observation === "inventory" && (r.probeClass !== "inventory" || r.attempts !== 0 || !["not-configured", "configured-unverified"].includes(r.state))) fail();
  }
  if (Buffer.byteLength(JSON.stringify(e)) > 32768) fail();
}
/** Export only allowlisted readiness facts; installation aliases, UID, route/model IDs and paths never leave local records. */
export function exportSummary(value: unknown) {
  validateEvidence(value);
  return { schema: value.schema, evidenceId: value.id, observedAt: value.observedAt, observation: value.observation,
    inventory: { os: value.inventory.os, architecture: value.inventory.architecture, kernel: value.inventory.kernel,
      processBun: value.inventory.processBun, testedPathBun: { ...value.inventory.testedPathBun },
      dependencies: value.inventory.dependencies.map(d => ({ ...d })), context: value.inventory.context,
      workingDirectory: value.inventory.workingDirectory, testedPath: value.inventory.testedPath, persistentState: value.inventory.persistentState },
    routes: value.routes.map((r, index) => ({ reference: `route-${index + 1}`, model: r.model === null ? "unselected" : "redacted", observation: r.observation,
      probeClass: r.probeClass, maxAttempts: r.maxAttempts, attempts: r.attempts, deadlineMs: r.deadlineMs, elapsedMs: r.elapsedMs, state: r.state, nextAction: r.nextAction })),
    outcome: value.outcome, nextAction: value.nextAction };
}
