import type { GithubReadiness, GithubService } from "../github";
import type { EffectDecisionCard } from "../effects";
import type { MemoryOwnerApi } from "../memory";
import type { TeamService } from "../team";
import type { AdoptionOwner, AdoptionService } from "../adoption";
import type { ActionRef, OwnerActor, S15PolicyService, WorkActor } from "../policy";
import type { RecurringRules } from "../policy/recurring";
import type { ResponsibilityPort, ResponsibilityProjection } from "../work";
import type { S15AdoptionStatus, S15DecisionCard, S15ReadinessReport, S15WebActions, S15WebDuties, S15WebGithub, S15WebMemory, S15WebRecurring, S15WebTeam } from "./types";

/**
 * Composition adapters from the real protected S15 modules to the Web consumer seams. Each adapter maps the
 * authenticated Web actor to the owning module's owner actor and forwards one exact call; none widens scope,
 * caches authority or turns a read into a command.
 */
export type S15OwnerOf<Actor> = (actor: Actor) => OwnerActor;

/** POLICY read-only reconcile and owner statement for unknown outcomes. */
export function s15ActionsPort<Actor>(policy: S15PolicyService, owner: S15OwnerOf<Actor>): S15WebActions<Actor> {
  return { reconcile: (actor, action, requestId) => policy.owner.reconcile(owner(actor), action, requestId), statement: (actor, action, requestId, outcome) => policy.owner.recordStatement(owner(actor), action, requestId, outcome) };
}
/** WORK15 owner list/project/stop. */
export function s15DutiesPort<Actor>(work: ResponsibilityPort & { list(owner: OwnerActor): ResponsibilityProjection[] }, owner: S15OwnerOf<Actor>): S15WebDuties<Actor> {
  return { list: actor => work.list(owner(actor)), project: (actor, id) => work.project(owner(actor), id), stop: (actor, id, requestId) => { work.stop(owner(actor), id, requestId); }, resume: (actor, id, sourceRequestId) => { work.resume(owner(actor), id, sourceRequestId); } };
}
/** F13 recurring-payment rules (`createRecurringRules`). */
export function s15RecurringPort<Actor>(rules: RecurringRules, owner: S15OwnerOf<Actor>): S15WebRecurring<Actor> {
  return { frequencies: () => rules.frequencies(), propose: (actor, input) => rules.propose(owner(actor), input), install: (actor, requestId, hash) => rules.install(owner(actor), requestId, hash), revoke: (actor, requestId, ruleId) => rules.revoke(owner(actor), requestId, ruleId) };
}
/** GIT15-02 personal profile. The capture/install calls need the protected repository work actor that composition binds. */
export function s15GithubPort<Actor>(github: Pick<GithubService, "personalCapture" | "installPersonal" | "revokePersonal">, owner: S15OwnerOf<Actor>, workActor: () => WorkActor): S15WebGithub<Actor> {
  return { capture: actor => github.personalCapture(owner(actor), workActor()), install: (actor, input) => github.installPersonal(owner(actor), workActor(), input), revoke: (actor, input) => github.revokePersonal(owner(actor), input) };
}
/** BIZ15 DecisionCard projection (`openFixtureRecordService().decisionCard` or a real record service with the same contract). */
export function s15DecisionCards<Actor>(source: { decisionCard(owner: OwnerActor, policy: S15PolicyService, action: ActionRef): EffectDecisionCard | null }, policy: S15PolicyService, owner: S15OwnerOf<Actor>): (actor: Actor, action: ActionRef) => S15DecisionCard | null {
  return (actor, action) => source.decisionCard(owner(actor), policy, action);
}
const factKind = (code: string): S15ReadinessReport["rows"][number]["facts"][number]["kind"] => code === "scope_defined" || code === "issue_open" ? "scope" : code === "acceptance_defined" ? "acceptance" : code === "ownership_clear" ? "assignee" : code === "branch_clear" || code === "pull_clear" ? "branch_pr" : "blockers";
/** GIT15-01 readiness rows mapped onto the UX15-01 ReadinessTable without re-sorting or picking. Evidence refs are links only when https. */
export function s15ReadinessFromGithub(repository: string, rows: readonly GithubReadiness[]): S15ReadinessReport {
  return { repository, rows: rows.map(row => ({ issue: row.issue, title: row.title, state: row.state === "has_pr" ? "open_pr" : row.state,
    facts: row.reasons.map(reason => ({ kind: factKind(reason.code), ok: reason.passed, detail: reason.code.startsWith("prerequisite_") ? `#${reason.code.slice(13)}` : reason.code, href: reason.evidence.map(source => source.ref).find(ref => /^https:\/\//.test(ref)) ?? null })) })) };
}
/** TEAM15 owner resources view (`TeamService.resources`). Restrictions stay the service's own codes. */
export function s15TeamPort<Actor>(team: Pick<TeamService, "resources">, owner: S15OwnerOf<Actor>): S15WebTeam<Actor> {
  return { view: actor => team.resources(owner(actor)) };
}
/** MEM15 owner API (`MemoryService.view`/`command`, `s15-memory-view/v1` and revision-bound `s15-memory-command/v1`). */
export function s15MemoryPort<Actor>(memory: MemoryOwnerApi, owner: S15OwnerOf<Actor>): S15WebMemory<Actor> {
  return { view: actor => memory.view(owner(actor)), command: (actor, input) => memory.command(owner(actor), input) };
}
/** MIG15 owner status for recovery. Composition authenticates the adoption owner; this port cannot adopt, install policy or release workers. */
export function s15AdoptionPort<Actor>(adoption: Pick<AdoptionService, "status">, owner: (actor: Actor) => AdoptionOwner): (actor: Actor) => S15AdoptionStatus | null {
  return actor => adoption.status(owner(actor));
}
