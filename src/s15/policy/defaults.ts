import type { ActionClass, CatalogKind, OperatingBudget, PolicyInput, Ref, Rule, Selection } from './types';
import { contains, equal } from './validation';

/**
 * POLICY15-02 (ADR 0073) protected default catalog and first standing-policy proposal for an S15 installation.
 * Everything here is derived from what the installation actually composed; nothing is installed by this module,
 * no money is inferred and no personal GitHub exception is ever produced.
 */
const ref = (id: string): Ref => ({ id, revision: 1, generation: 1 });

/** Default standing-policy lifetime (orchestrator choice 2026-11-03): finite, visible and renewable. */
export const S15_DEFAULT_POLICY_LIFETIME_MS = 180 * 86_400_000;
/** The owner can renew from the rules page once this little time is left (or after expiry). */
export const S15_POLICY_RENEW_WINDOW_MS = 30 * 86_400_000;

/** Runtime-registered default refs. Revisions change only when their meaning changes in a later release. */
export const s15DefaultRefs = Object.freeze({
  /** The ordinary purpose: work the owner asked for in a conversation or channel. */
  work: Object.freeze(ref('owner_requested_work')),
  /** Pre-retrieval interpretation of an owner message; it has no resources, recipients or tools. */
  interpretation: Object.freeze(ref('conversation_interpretation')),
});

/** One catalog row as the runtime registers it. Explicit configuration rows always take precedence. */
export interface DefaultCatalogRow { kind: CatalogKind; ref: Ref; active: boolean }

/**
 * Protected default catalog rows: the two default purposes and the recipient of every approved model route. A
 * recipient already present in the explicit configuration keeps its configured row.
 */
export function s15DefaultCatalog(models: readonly { recipient: Ref }[]): DefaultCatalogRow[] {
  const rows: DefaultCatalogRow[] = [{ kind: 'purpose', ref: { ...s15DefaultRefs.work }, active: true }, { kind: 'purpose', ref: { ...s15DefaultRefs.interpretation }, active: true }];
  for (const model of models) if (!rows.some(row => row.kind === 'recipient' && row.ref.id === model.recipient.id)) rows.push({ kind: 'recipient', ref: structuredClone(model.recipient), active: true });
  return rows;
}

/** A composed resource the default rule may cover, with the trusted adapters that act on it. */
export interface DefaultResource { ref: Ref; kind: 'computer' | 'browser' | 'repository' | 'account'; label: string; adapters: { id: string; operations: string[] }[] }
/** An approved model route the proposal selects, with its provider recipient and charge. */
export interface DefaultSelection { selection: Selection; recipient: Ref; charge: 'subscription' | 'metered'; label: string }

/** Every class an adapter can derive. Only ordinary edits and guest administration run under the ordinary rule;
 * the rest are matched by it only so the owner can approve each exact action (POLICY's per-class human gates). */
export const s15DefaultRuleClasses: readonly ActionClass[] = Object.freeze(['ordinary_edit', 'guest_local_admin', 'guest_system_admin', 'new_egress', 'communication', 'financial', 'github_publish', 'github_merge', 'production', 'disclosure', 'major_change']);
/**
 * Classes that wait for the owner's exact approval under the product default (S16-D07, ADR 0084). `communication`
 * stays listed because a send the Bot starts itself, or to anyone the owner did not name, still waits; GitHub
 * publication and merge after required checks no longer do (a production consequence still does).
 */
export const s15HeldClasses: readonly ActionClass[] = Object.freeze(['communication', 'production', 'financial', 'disclosure', 'new_egress', 'major_change']);
/** Rule ids of the AUTH16-01 product defaults (contract revision 3). */
export const s16DefaultRuleIds = Object.freeze({ namedSends: 'owner_named_sends', github: 'github_after_checks' });
/** GitHub operations the product default publishes or merges without approval once its evidence holds. */
export const s16GithubDefaultOperations: readonly string[] = Object.freeze(['merge', 'pr_create', 'pr_update', 'push', 'review_reply']);

/**
 * Compose the exact default standing policy. Returns null when no route is approved or nothing to work on exists.
 * `carry` keeps rules the owner installed separately (personal GitHub, recurring payment) unchanged when every ref
 * they name is still in this proposal; they are never created here.
 */
export function s15DefaultPolicy(input: {
  now: number; bot: Ref; resources: readonly DefaultResource[]; selections: readonly DefaultSelection[];
  extraRecipients?: readonly Ref[]; budget: OperatingBudget | null; carry?: readonly Rule[]; lifetimeMs?: number;
}): PolicyInput | null {
  if (!input.selections.length || !input.resources.length) return null;
  const expiresAt = input.now + (input.lifetimeMs ?? S15_DEFAULT_POLICY_LIFETIME_MS);
  const unique = <T extends Ref>(items: readonly T[]) => items.filter((item, index) => items.findIndex(other => other.id === item.id) === index);
  const resources = unique(input.resources.map(r => structuredClone(r.ref)));
  const recipients = unique([...input.selections.map(s => structuredClone(s.recipient)), ...(input.extraRecipients ?? []).map(r => structuredClone(r))]);
  const selections = input.selections.map(s => structuredClone(s.selection)).filter((s, index, all) => all.findIndex(other => equal(other, s)) === index);
  const adapters = [...new Set(input.resources.flatMap(r => r.adapters.map(a => a.id)))].sort();
  const operations = [...new Set(input.resources.flatMap(r => r.adapters.flatMap(a => a.operations)))].sort();
  const purposes = [structuredClone(s15DefaultRefs.work), structuredClone(s15DefaultRefs.interpretation)];
  const ordinary: Rule = { id: 'owner_requested_work', mode: 'ordinary', purposes: [structuredClone(s15DefaultRefs.work)], bots: [structuredClone(input.bot)], resources, recipients, selections,
    adapters: adapters.length ? adapters : ['working_vm'], operations: operations.length ? operations : ['vm_write'], classes: [...s15DefaultRuleClasses], expiresAt, recurrence: null };
  // AUTH16-01 (S16-D07 b, d): owner-named sends and GitHub work after required checks run without approval.
  const named: Rule = { ...structuredClone(ordinary), id: s16DefaultRuleIds.namedSends, mode: 'owner_named_send', recipients: [], classes: ['ordinary_edit', 'communication'] };
  const repositories = input.resources.filter(r => r.kind === 'repository' && r.adapters.some(a => a.id === 's15_github'));
  const githubOps = [...new Set(repositories.flatMap(r => r.adapters.filter(a => a.id === 's15_github').flatMap(a => a.operations)))].filter(op => s16GithubDefaultOperations.includes(op)).sort();
  const rules: Rule[] = [ordinary, named];
  if (repositories.length && githubOps.length) rules.push({ id: s16DefaultRuleIds.github, mode: 'github_default', purposes: [structuredClone(s15DefaultRefs.work)], bots: [structuredClone(input.bot)], resources: unique(repositories.map(r => structuredClone(r.ref))), recipients: [], selections: selections.map(x => structuredClone(x)),
    adapters: ['s15_github'], operations: githubOps, classes: ['communication', 'github_merge', 'github_publish'], expiresAt, recurrence: null });
  const policy: PolicyInput = { purposes, interpretationPurpose: structuredClone(s15DefaultRefs.interpretation), bots: [structuredClone(input.bot)], resources, recipients, selections,
    budget: input.budget ? structuredClone(input.budget) : null, rules, expiresAt };
  for (const rule of input.carry ?? []) {
    if (rule.mode !== 'personal_github_publish' && rule.mode !== 'personal_github_merge' && rule.mode !== 'recurring_payment') continue;
    if (rule.expiresAt <= input.now || policy.rules.some(r => r.id === rule.id)) continue;
    const kept = rule.purposes.every(p => contains(purposes, p)) && rule.bots.every(b => contains(policy.bots, b)) && rule.resources.every(r => contains(resources, r)) && rule.recipients.every(r => contains(recipients, r)) && rule.selections.every(s => contains(selections, s));
    if (kept) policy.rules.push(structuredClone(rule));
  }
  return policy;
}

/** True when the proposal needs the owner's finite budget: any selected route is metered. */
export const s15NeedsBudget = (selections: readonly DefaultSelection[]): boolean => selections.some(s => s.charge !== 'subscription');

/** Same scope as `current`, ignoring only the expiry instants: a renewal, not a change of rules. */
export function s15SamePolicyScope(a: PolicyInput, b: PolicyInput): boolean {
  // Only PolicyInput fields count: an installed StandingPolicy also carries its contract, revision and generation.
  const strip = (p: PolicyInput) => ({ purposes: p.purposes, bots: p.bots, resources: p.resources, recipients: p.recipients, selections: p.selections, interpretationPurpose: p.interpretationPurpose ?? null,
    budget: p.budget ? { ...p.budget, startsAt: 0, expiresAt: 0 } : null, rules: p.rules.map(r => ({ ...r, expiresAt: 0 })) });
  return equal(strip(a), strip(b));
}

/** Owner-selectable budget periods for a metered route; the budget never outlives the policy it belongs to. */
export const s15BudgetPeriods: readonly { id: string; days: number }[] = Object.freeze([{ id: 'days_30', days: 30 }, { id: 'days_90', days: 90 }, { id: 'days_180', days: 180 }]);
/** Non-money technical ceilings per budget day (ADR 0073). Money comes only from the owner's typed amount. */
export const s15MeteredTechnicalPerDay = Object.freeze({ attempts: 2_000, steps: 2_000, calls: 20_000, reads: 20_000, outputBytes: 2 * 1_073_741_824, activeMs: 86_400_000 });

/**
 * The finite operating budget for an owner-typed amount. `spendMinor`, currency and period are the owner's; the
 * technical ceilings scale the documented per-day profile by the period (active time also by concurrency).
 */
export function s15MeteredBudget(input: { now: number; policyExpiresAt: number; currency: string; spendMinor: string; periodId: string; concurrency: number }): OperatingBudget | null {
  const period = s15BudgetPeriods.find(p => p.id === input.periodId);
  if (!period || !/^[A-Z]{3}$/.test(input.currency) || !/^[1-9][0-9]{0,29}$/.test(input.spendMinor) || !Number.isSafeInteger(input.concurrency) || input.concurrency < 1) return null;
  const t = s15MeteredTechnicalPerDay, days = period.days;
  return { currency: input.currency, startsAt: input.now, expiresAt: Math.min(input.policyExpiresAt, input.now + days * 86_400_000), concurrency: input.concurrency,
    ceiling: { attempts: t.attempts * days, steps: t.steps * days, calls: t.calls * days, reads: t.reads * days, outputBytes: t.outputBytes * days, activeMs: t.activeMs * days * input.concurrency, spendMinor: input.spendMinor } };
}

/**
 * Protected subscription registry profile (orchestrator decision 2026-11-03, ADR 0070/0075): finite per-work model
 * bounds plus zero-spend tool bounds, used only while no monetary budget is installed. Large enough for one GitHub
 * implementation work (24 turns plus its VM commands), small enough that a runaway work stops on its own.
 */
export const s15SubscriptionProfile = Object.freeze({
  perWork: Object.freeze({ calls: 64, steps: 64, activeMs: 4 * 3_600_000 }),
  tools: Object.freeze({ attempts: 256, steps: 256, calls: 512, reads: 512, outputBytes: 512 * 1_048_576, activeMs: 8 * 3_600_000 }),
});

/** Build the protected registry over the approved routes: a selection is admitted only while its route is a
 * subscription route that is currently available. `concurrency` is the installation's finite parallel charge bound. */
export function s15SubscriptionModels(routes: () => readonly { selection: Selection; charge: 'subscription' | 'metered'; availability: string }[], concurrency: number): import('./types').SubscriptionModels {
  return { current: selection => routes().some(r => r.charge === 'subscription' && r.availability === 'available' && equal(r.selection, selection)), concurrency, perWork: { ...s15SubscriptionProfile.perWork }, tools: { ...s15SubscriptionProfile.tools } };
}
