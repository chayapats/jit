import { deterministicChecklistIds, humanChecklistIds, safeEvidenceId, safeNote, safeOpsAlias, validateDrillRecord, validateProfileRecord, validateReleaseRecord,
  type ChecklistItem, type ChecklistState, type DeterministicChecklistId, type DrillAction,
  type HumanChecklistId, type LoadDrillRecord, type OpsProfile, type ReleaseChecklist } from "./contracts";

/** Profile inputs: a validated drill record plus operator-reviewed sample limitations. */
export interface ProfileInput {
  installationLabel: string;
  drill: LoadDrillRecord;
  sampleLimitations: string[];
  nextAction: DrillAction;
}

/**
 * Composes a sanitized operating profile. The function never declares SLOs or Pi
 * readiness: `piReadiness` is fixed to `not-claimed` and every sample bound stays visible.
 * Exhausted limits come only from the drill's typed limit events, never from
 * leg states; the result passes the exact profile validator before it is returned.
 */
export function composeProfile(input: ProfileInput): OpsProfile {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_ops_profile");
  if (Object.keys(input).some(k => !["installationLabel", "drill", "sampleLimitations", "nextAction"].includes(k))) {
    throw new Error("invalid_ops_profile");
  }
  const label = safeOpsAlias(input.installationLabel);
  try { validateDrillRecord(input.drill); } catch { throw new Error("invalid_ops_profile"); }
  if (!Array.isArray(input.sampleLimitations) || input.sampleLimitations.length > 32 ||
      input.sampleLimitations.some(l => safeNote(l) !== l)) throw new Error("invalid_ops_profile");
  const drill = input.drill;
  const profile: OpsProfile = { schema: "jit.ops.profile/v1", id: crypto.randomUUID(), observedAt: new Date(Date.now()).toISOString(),
    installationLabel: label, drillId: safeEvidenceId(drill.id), versions: structuredClone(drill.versions),
    config: { ...drill.config }, measurements: { ...drill.measurements },
    exhaustedLimits: [...drill.exhaustedLimits], sampleLimitations: [...input.sampleLimitations],
    piReadiness: "not-claimed", nextAction: input.nextAction };
  try { validateProfileRecord(profile); } catch { throw new Error("invalid_ops_profile"); }
  return profile;
}

/**
 * Which drill legs evidence each deterministic release row, and what the drill
 * cannot cover. A row whose coverage is partial never reads `passed` from the
 * drill alone: the remaining scope is deterministic suite evidence (`bun test`)
 * or human evidence, named in the note.
 */
export const deterministicCoverage: Readonly<Record<DeterministicChecklistId, { legs: readonly string[]; missing: string | null }>> = Object.freeze({
  J01: { legs: ["groups", "memory-queries"], missing: "team dispatch and coordinator synthesis are bun test evidence, not drilled" },
  J02: { legs: ["memory-queries", "schedules"], missing: "task acceptance and memory correction are bun test evidence, not drilled" },
  J03: { legs: ["pr-snapshots", "pr-alerts"], missing: null },
  J04: { legs: ["deliveries"], missing: "Telegram project commands are bun test evidence; no Bot API traffic was drilled" },
  J05: { legs: ["quota-wait", "cancel"], missing: "service restart and reboot reconciliation need OPS05 human evidence" },
  crash: { legs: ["backup", "quarantine", "upgrade-preflight"], missing: "crash-at-every-boundary matrices are bun test evidence, not drilled" },
  trust: { legs: ["network", "export"], missing: "GitHub-write, shell and forged-command refusals are bun test evidence, not drilled" },
});

const severity: Record<string, number> = { failed: 4, blocked: 3, "not-run": 2, scripted: 1, passed: 0 };

/**
 * Derives the deterministic J01–J05/crash/trust rows from the legs a drill
 * actually executed. Worst mapped leg wins (failed > blocked > not-run); a
 * missing leg is `not-run`; `scripted` legs count as executed fixtures; a row
 * with partial coverage is `blocked` with the uncovered scope named. Rows that
 * ran link the drill record ID as their evidence; nothing is caller-attested.
 */
export function deriveDeterministicRows(drill: LoadDrillRecord | null): ChecklistItem[] {
  return deterministicChecklistIds.map(id => {
    if (!drill) return { id, state: "not-run" as const, evidenceId: null, note: "no drill record linked" };
    const coverage = deterministicCoverage[id];
    const legs = coverage.legs.map(name => drill.legs.find(l => l.leg === name) ?? { leg: name, state: "not-run" as const });
    const worst = legs.reduce((a, b) => (severity[b.state]! > severity[a.state]! ? b : a));
    const summary = legs.map(l => `${l.leg}=${l.state}`).join(" ");
    if (worst.state === "failed" || worst.state === "blocked") {
      return { id, state: worst.state, evidenceId: drill.id, note: safeNote(`drill legs ${summary}`) };
    }
    // A not-run row never links evidence, matching the human-row invariant.
    if (worst.state === "not-run") return { id, state: "not-run" as const, evidenceId: null, note: safeNote(`drill legs ${summary}`) };
    if (coverage.missing) {
      return { id, state: "blocked" as const, evidenceId: drill.id, note: safeNote(`partial drill coverage (${summary}); ${coverage.missing}`) };
    }
    return { id, state: "passed" as const, evidenceId: drill.id, note: safeNote(`drill legs ${summary}`) };
  });
}

export interface ChecklistInput {
  installationLabel: string;
  /** Validated drill record whose executed legs derive the deterministic rows; null leaves them all `not-run`. */
  drill: LoadDrillRecord | null;
  /** Human FEAS/OPS gate rows, linked by sanitized evidence ID only. */
  human: Partial<Record<HumanChecklistId, { state: ChecklistState; evidenceId: string | null; note: string }>>;
}

const humanIds: readonly string[] = humanChecklistIds;

function composeHumanItems(rows: Record<string, { state: ChecklistState; evidenceId: string | null; note: string } | undefined>): ChecklistItem[] {
  return humanIds.map(id => {
    const row = rows[id];
    if (!row || typeof row !== "object") return { id, state: "not-run" as const, evidenceId: null, note: "human evidence not recorded" };
    if (!["passed", "failed", "blocked", "not-run"].includes(row.state)) throw new Error("invalid_release_checklist");
    // Human rows are linked by evidence ID only. A human gate in any recorded
    // state without an evidence reference is rejected instead of being auto-completed.
    if (row.state !== "not-run" && row.evidenceId === null) throw new Error("invalid_release_checklist");
    if (row.evidenceId !== null) safeEvidenceId(row.evidenceId);
    if (row.state === "not-run" && row.evidenceId !== null) throw new Error("invalid_release_checklist");
    return { id, state: row.state, evidenceId: row.evidenceId, note: safeNote(row.note) };
  });
}

/**
 * Composes the release gate checklist. Deterministic J01–J05/crash/trust rows are
 * derived from the linked drill's executed legs ({@link deriveDeterministicRows});
 * callers cannot type them. FEAS/OPS rows stay `not-run` unless the owner supplies
 * an explicit state plus a sanitized evidence ID. Nothing here auto-passes a gate.
 */
export function composeReleaseChecklist(input: ChecklistInput): ReleaseChecklist {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_release_checklist");
  const keys = Object.keys(input);
  if (keys.length !== 3 || !["installationLabel", "drill", "human"].every(k => keys.includes(k))) throw new Error("invalid_release_checklist");
  const label = safeOpsAlias(input.installationLabel);
  if (input.drill !== null) {
    try { validateDrillRecord(input.drill); } catch { throw new Error("invalid_release_checklist"); }
  }
  if (!input.human || typeof input.human !== "object" || Array.isArray(input.human) ||
      Object.keys(input.human).some(k => !humanIds.includes(k))) throw new Error("invalid_release_checklist");
  const deterministic = deriveDeterministicRows(input.drill);
  const human = composeHumanItems(input.human);
  const states = [...deterministic, ...human].map(i => i.state);
  const outcome = states.includes("failed") ? "failed" : states.includes("blocked") || states.includes("not-run") ? "blocked" : "passed";
  const nextAction: DrillAction = states.includes("failed") ? "inspect-sanitized-drill" : "resolve-blocked-work";
  const checklist: ReleaseChecklist = { schema: "jit.ops.release/v1", id: crypto.randomUUID(), observedAt: new Date(Date.now()).toISOString(),
    installationLabel: label, drillId: input.drill ? safeEvidenceId(input.drill.id) : null, deterministic, human,
    outcome, nextAction: outcome === "passed" ? "none" : nextAction };
  try { validateReleaseRecord(checklist); } catch { throw new Error("invalid_release_checklist"); }
  return checklist;
}
