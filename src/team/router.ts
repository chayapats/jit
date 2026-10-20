import { AppError } from "../errors";
import type { JobLimits } from "../jobs/types";
import type { DiscussionRouter, RoleRoute, RouterStopReason } from "./types";

/** Candidate specialist for scripted routing; coordinators are never auto-selected. */
export interface RouterCandidate {
  id: string; name: string; responsibility: string; kind: "specialist" | "coordinator";
  enabled: boolean; route: RoleRoute | null;
}
/** One bounded router step; returning done stops further rounds under the call budget. */
export interface RouterStep { select: string[]; done: boolean }
/** Finite router input; source/purpose text cannot grant include authority beyond owner lists. */
export interface RouterInput {
  purpose: string;
  roles: readonly RouterCandidate[];
  include: readonly string[];
  exclude: readonly string[];
  limits: JobLimits;
  round: number;
  alreadySelected: readonly string[];
}
export type ScriptedRouter = (input: RouterInput) => RouterStep;

const hints: Record<string, string[]> = {
  tech: ["tech", "technology", "software", "code", "api", "architecture", "เทคโนโลยี", "ซอฟต์แวร์", "โค้ด"],
  design: ["design", "ux", "ui", "usable", "ออกแบบ", "ประสบการณ์"],
  marketing: ["marketing", "market", "audience", "brand", "การตลาด", "สื่อสาร", "คุณค่า"],
};

function familyOf(role: RouterCandidate): keyof typeof hints | null {
  const name = role.name.toLowerCase(), responsibility = role.responsibility.toLowerCase();
  for (const [key, words] of Object.entries(hints) as [keyof typeof hints, string[]][]) {
    if (words.some(word => name.includes(word))) return key;
  }
  for (const [key, words] of Object.entries(hints) as [keyof typeof hints, string[]][]) {
    if (words.some(word => responsibility.includes(word))) return key;
  }
  return null;
}

/** Default relevance: match purpose to role family hints; marketing stays silent unless mentioned. */
export function defaultScriptedRouter(input: RouterInput): RouterStep {
  const purposeText = input.purpose.toLowerCase();
  const selected: string[] = [];
  for (const role of input.roles) {
    if (role.kind !== "specialist" || !role.enabled || !role.route) continue;
    if (input.exclude.includes(role.id) || input.alreadySelected.includes(role.id)) continue;
    if (input.include.includes(role.id)) { selected.push(role.id); continue; }
    const family = familyOf(role);
    const words = family ? hints[family] : null;
    if (!words || !words.some(word => purposeText.includes(word))) continue;
    selected.push(role.id);
  }
  for (const id of input.include) {
    if (!selected.includes(id) && !input.alreadySelected.includes(id) && !input.exclude.includes(id)) selected.push(id);
  }
  return { select: selected, done: true };
}

let activeRouter: ScriptedRouter = defaultScriptedRouter;
/** Test seam for looping/malformed router fixtures; production serve leaves the default installed. */
export function setScriptedRouter(router: ScriptedRouter | null): void {
  activeRouter = router ?? defaultScriptedRouter;
}
export function getScriptedRouter(): ScriptedRouter { return activeRouter; }

/** Runs the scripted router under finite role/round budgets and validates every selected identity. */
export function planDiscussionRoles(input: Omit<RouterInput, "round" | "alreadySelected">): DiscussionRouter {
  const eligible = new Map<string, RouterCandidate>();
  for (const role of input.roles) {
    if (role.kind === "specialist" && role.enabled && role.route) eligible.set(role.id, role);
  }
  for (const id of [...input.include, ...input.exclude]) {
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new AppError("invalid_team_command");
  }
  for (const id of input.include) {
    const role = input.roles.find(item => item.id === id);
    if (!role) throw new AppError("unknown_role", 404);
    if (role.kind !== "specialist" || !role.enabled || !role.route) throw new AppError("role_dispatch_blocked", 409);
  }
  const selected: string[] = [];
  let rounds = 0;
  let stopReason: RouterStopReason = "complete";
  let sawDone = false;
  while (rounds < input.limits.rounds) {
    rounds++;
    let step: RouterStep;
    try { step = activeRouter({ ...input, round: rounds, alreadySelected: selected }); }
    catch { throw new AppError("invalid_router_output"); }
    if (!step || typeof step !== "object" || typeof step.done !== "boolean" || !Array.isArray(step.select) ||
        step.select.length > input.limits.roles || step.select.some(id => typeof id !== "string")) {
      throw new AppError("invalid_router_output");
    }
    for (const id of step.select) {
      if (!eligible.has(id)) throw new AppError("unknown_role", 404);
      if (input.exclude.includes(id) || selected.includes(id)) continue;
      if (selected.length >= input.limits.roles) { stopReason = "budget_exhausted"; sawDone = true; break; }
      selected.push(id);
    }
    if (sawDone) break;
    if (step.done) { sawDone = true; break; }
  }
  if (!sawDone) stopReason = stopReason === "budget_exhausted" ? stopReason : "max_rounds";
  const silent = [...eligible.keys()].filter(id => !selected.includes(id) && !input.exclude.includes(id));
  const evidence = `router rounds=${rounds} selected=${selected.length} silent=${silent.length} stop=${stopReason}`;
  return { rounds, selected, silent, stopReason, evidence };
}
