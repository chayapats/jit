import { safeEvidenceId, safeNote, safeOpsAlias,
  type ChecklistItem, type ChecklistState, type DeterministicChecklistId, type DrillAction,
  type HumanChecklistId, type LoadDrillRecord, type OpsProfile, type ReleaseChecklist } from "./contracts";

/** Profile inputs are assembled by the caller from a validated drill record plus operator review. */
export interface ProfileInput {
  installationLabel: string;
  drill: LoadDrillRecord;
  exhaustedLimits: string[];
  sampleLimitations: string[];
  nextAction: DrillAction;
}

/**
 * Composes a sanitized operating profile. The function never declares SLOs or Pi
 * readiness: `piReadiness` is fixed to `not-claimed` and every sample bound stays visible.
 */
export function composeProfile(input: ProfileInput): OpsProfile {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_ops_profile");
  if (Object.keys(input).some(k => !["installationLabel", "drill", "exhaustedLimits", "sampleLimitations", "nextAction"].includes(k))) {
    throw new Error("invalid_ops_profile");
  }
  const label = safeOpsAlias(input.installationLabel);
  if (input.drill?.schema !== "jit.ops.drill/v1" || safeOpsAlias(input.drill.installationLabel) !== input.drill.installationLabel) {
    throw new Error("invalid_ops_profile");
  }
  if (!Array.isArray(input.exhaustedLimits) || input.exhaustedLimits.length > 32 ||
      input.exhaustedLimits.some(l => safeNote(l) !== l)) throw new Error("invalid_ops_profile");
  if (!Array.isArray(input.sampleLimitations) || input.sampleLimitations.length > 32 ||
      input.sampleLimitations.some(l => safeNote(l) !== l)) throw new Error("invalid_ops_profile");
  const drill = input.drill;
  return { schema: "jit.ops.profile/v1", id: crypto.randomUUID(), observedAt: new Date(Date.now()).toISOString(),
    installationLabel: label, drillId: safeEvidenceId(drill.id), versions: { ...drill.versions },
    config: { ...drill.config }, measurements: { ...drill.measurements },
    exhaustedLimits: [...input.exhaustedLimits], sampleLimitations: [...input.sampleLimitations],
    piReadiness: "not-claimed", nextAction: input.nextAction };
}

export interface ChecklistInput {
  installationLabel: string;
  drillId: string | null;
  deterministic: Partial<Record<DeterministicChecklistId, { state: ChecklistState; evidenceId: string | null; note: string }>>;
  human: Partial<Record<HumanChecklistId, { state: ChecklistState; evidenceId: string | null; note: string }>>;
}

const deterministicIds: readonly string[] = ["J01", "J02", "J03", "J04", "J05", "crash", "trust"];
const humanIds: readonly string[] = ["FEAS", "OPS"];

function composeItems(ids: readonly string[], rows: Record<string, { state: ChecklistState; evidenceId: string | null; note: string } | undefined>,
    human: boolean): ChecklistItem[] {
  return ids.map(id => {
    const row = rows[id];
    if (!row || typeof row !== "object") return { id, state: "not-run" as const, evidenceId: null, note: human ? "human evidence not recorded" : "deterministic evidence not recorded" };
    if (!["passed", "failed", "blocked", "not-run"].includes(row.state)) throw new Error("invalid_release_checklist");
    // Human rows are linked by evidence ID only. A passing human gate without an
    // evidence reference is rejected instead of being auto-completed.
    if (row.state !== "not-run" && human && row.evidenceId === null) throw new Error("invalid_release_checklist");
    if (row.evidenceId !== null) safeEvidenceId(row.evidenceId);
    if (row.state === "not-run" && row.evidenceId !== null) throw new Error("invalid_release_checklist");
    return { id, state: row.state, evidenceId: row.evidenceId, note: safeNote(row.note) };
  });
}

/**
 * Composes the release gate checklist. Deterministic J01–J05/crash/trust rows carry
 * caller-attested states; FEAS/OPS rows stay `not-run` unless the owner supplies an
 * explicit state plus a sanitized evidence ID. Nothing here auto-passes a human gate.
 */
export function composeReleaseChecklist(input: ChecklistInput): ReleaseChecklist {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_release_checklist");
  if (Object.keys(input).some(k => !["installationLabel", "drillId", "deterministic", "human"].includes(k))) {
    throw new Error("invalid_release_checklist");
  }
  const label = safeOpsAlias(input.installationLabel);
  if (input.drillId !== null) safeEvidenceId(input.drillId);
  if (!input.deterministic || typeof input.deterministic !== "object" || !input.human || typeof input.human !== "object") {
    throw new Error("invalid_release_checklist");
  }
  if (Object.keys(input.deterministic).some(k => !deterministicIds.includes(k)) ||
      Object.keys(input.human).some(k => !humanIds.includes(k))) throw new Error("invalid_release_checklist");
  const deterministic = composeItems(deterministicIds, input.deterministic, false);
  const human = composeItems(humanIds, input.human, true);
  const states = [...deterministic, ...human].map(i => i.state);
  const outcome = states.includes("failed") ? "failed" : states.includes("blocked") || states.includes("not-run") ? "blocked" : "passed";
  const nextAction: DrillAction = states.includes("failed") ? "inspect-sanitized-drill" : "resolve-blocked-work";
  return { schema: "jit.ops.release/v1", id: crypto.randomUUID(), observedAt: new Date(Date.now()).toISOString(),
    installationLabel: label, drillId: input.drillId, deterministic, human,
    outcome, nextAction: outcome === "passed" ? "none" : nextAction };
}
