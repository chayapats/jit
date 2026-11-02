import { createHash } from 'node:crypto';
import { containsCredential } from '../../security/credentials';
import { DurableJournal } from '../durable-journal';
import type { ActionAdapter, ActionDraft, DisclosureDetails, JsonValue, PreparedAction, Ref, S15PolicyService, WorkAuthority } from '../policy';
import { canonical, contains, digest, equal, exact, fail, id, nat, ref, refs, string, vector } from '../policy/validation';
import { requestPayload } from '../browser/types';
import type { DataClass, DisclosureOptions, DisclosureService, DisclosureSource } from './types';

const classes: DataClass[] = ['public', 'private', 'personal', 'business'];
const clone = <T>(value: T): T => JSON.parse(canonical(value)) as T;
type Record = { kind: 'work' | 'vm' | 'browser'; id: string; sources: Ref[] } | { kind: 'derived'; id: string; ref: Ref; workId: string; format: string; sources: Ref[] };
/** Credential screening is defense in depth, not private-data discovery. Inspect common encoded wire
 * fields before any payload is persisted; opaque/binary bodies need a protected registered validator. */
function screen(payload: unknown): void {
  canonical(payload);
  function visit(value: unknown): void {
    if (typeof value === 'string') {
      if (containsCredential(value)) fail('credential_content_refused');
      let decoded = value;
      for (let i = 0; i < 3; i++) { try { const next = decodeURIComponent(decoded.replaceAll('+', ' ')); if (next === decoded) break; canonical(next); if (containsCredential(next)) fail('credential_content_refused'); decoded = next; } catch (error) { if (error instanceof URIError) break; throw error; } }
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (/^(authorization|cookie|password|access_token|refresh_token|api_key)$/i.test(key)) fail('credential_content_refused');
      if (/base64$/i.test(key)) {
        if (typeof entry !== 'string' || Buffer.from(entry, 'base64').toString('base64') !== entry) fail('opaque_payload_unavailable');
        const bytes = Buffer.from(entry, 'base64');
        // Only credential-free UTF-8 wire fields are admitted by this generic emitter.
        const text = new TextDecoder('utf-8', { fatal: true });
        try { const decoded = text.decode(bytes); canonical(decoded); visit(decoded); } catch (error) { if (error instanceof TypeError) fail('opaque_payload_unavailable'); throw error; }
      } else visit(entry);
    }
  }
  visit(payload);
}

/** Protected service composition. Exact disclosure uses POLICY's immutable approval/claim/commit
 * path; there is no independent approval token or owner authority in this module. */
export function openDisclosureService(options: DisclosureOptions): DisclosureService {
  if (options.runtime !== 's15') fail('s15_opt_in_required');
  const routes = new Map(options.routes.map(route => { id(route.id); return [route.id, route] as const; }));
  if (routes.size !== options.routes.length || routes.size > 64) fail('route_unknown');
  const journal = new DurableJournal(options.path, options.installationId, options.create, 0x4a445135), now = options.now ?? Date.now;
  let policy: S15PolicyService | null = null;
  const modelRecipients = new Map<string, Ref>();
  const service = () => policy ?? fail('policy_unavailable');
  const workKey = (work: WorkAuthority) => 'work_' + work.id;
  const derivedKey = (value: Ref) => 'derived_' + digest('s15.disclosure.derived.v1', value);
  const loaded = (work: WorkAuthority): Ref[] => journal.all<Record>().find(row => row.kind === 'work' && row.id === workKey(work))?.sources ?? [];
  function source(work: WorkAuthority, value: Ref): DisclosureSource {
    ref(value); const s = options.catalogs.source(clone(value));
    if (!s || !s.active || !equal(s.ref, value)) fail('lineage_withdrawn');
    ref(s.resource); if (!classes.includes(s.classification)) fail('classification_unknown');
    if (typeof s.ownerReleasable !== 'boolean' || !contains(work.request.resources, s.resource)) fail('outside_scope');
    return clone(s);
  }
  function sources(work: WorkAuthority): DisclosureSource[] {
    // Original owner/context lineage cannot be omitted merely by forgetting to stamp a later read.
    const values = [...loaded(work), ...(work.request.fences ?? []).filter(f => f.kind === 'lineage').map(f => f.ref)];
    const unique = [...new Map(values.map(r => [canonical(r), r])).values()];
    if (unique.length > 64) fail('lineage_capacity');
    return unique.map(r => source(work, r)).sort((a, b) => canonical(a.ref).localeCompare(canonical(b.ref)));
  }
  function recipients(values: readonly Ref[]): Ref[] {
    refs(values); if (!values.length) fail('recipient_unknown');
    return values.map(value => { const current = options.catalogs.recipient(clone(value)); if (!current?.active || !equal(current.ref, value)) fail('recipient_unknown'); return clone(value); }).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  }
  function approved(work: WorkAuthority, recipient: Ref, lineage: DisclosureSource[]): boolean {
    return lineage.filter(s => s.classification !== 'public').every(s => options.catalogs.approvals().some(a => {
      ref(a.recipient); ref(a.purpose); refs(a.resources); if (a.sources !== null) refs(a.sources); nat(a.expiresAt);
      if (!Array.isArray(a.dataClasses) || a.dataClasses.some(c => !classes.includes(c))) fail('classification_unknown');
      return now() < a.expiresAt && equal(a.recipient, recipient) && equal(a.purpose, work.request.purpose) && contains(a.resources, s.resource) && a.dataClasses.includes(s.classification) && (a.sources === null || contains(a.sources, s.ref));
    }));
  }
  function inspect(work: WorkAuthority, routeId: string, payload: JsonValue) {
    screen(payload); const route = routes.get(routeId); if (!route) fail('route_unknown');
    const resolved = route.resolve(clone(work), clone(payload)); if (!resolved) fail('recipient_unknown');
    const targets = recipients(resolved), lineage = sources(work), unapproved = targets.some(r => !approved(work, r, lineage));
    if (unapproved && lineage.some(s => s.classification !== 'public' && !s.ownerReleasable)) fail('disclosure_nonreleasable');
    const bytes = canonical(payload);
    const disclosure: DisclosureDetails = { recipients: targets, purpose: clone(work.request.purpose), sources: lineage.map(({ ref, resource, classification }) => ({ ref, resource, classification })), dataClasses: [...new Set(lineage.map(s => s.classification))].sort(), exactBytes: { length: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') } };
    return { classes: unapproved ? ['disclosure', 'new_egress'] as ActionDraft['classes'] : [], recipients: targets, fences: lineage.map(s => ({ kind: 'lineage' as const, ref: s.ref })), disclosure };
  }
  function enrich(work: WorkAuthority, route: string, draft: ActionDraft): ActionDraft {
    const d = inspect(work, route, draft.payload);
    // An adapter cannot hide one of its real recipients behind a separate disclosure destination.
    if (draft.recipients.some(r => !contains(d.recipients, r))) fail('recipient_changed');
    return { ...draft, classes: [...new Set([...draft.classes, ...d.classes])], recipients: d.recipients, resources: [...new Map([...draft.resources, ...d.disclosure.sources.map(s => s.resource)].map(r => [canonical(r), r])).values()], fences: [...new Map([...draft.fences, ...d.fences].map(f => [canonical(f), f])).values()], disclosure: d.disclosure };
  }
  function guardAction(work: WorkAuthority, route: string, action: PreparedAction): void {
    const current = inspect(work, route, action.payload);
    if (!action.disclosure || !equal(action.disclosure, current.disclosure) || current.classes.some(c => !action.classes.includes(c))) fail('disclosure_changed');
  }
  const adapter: ActionAdapter = {
    id: 'private_disclosure', version: 1,
    prepare(proposal, { work }) {
      exact(proposal, ['route', 'payload', 'upperBound', 'expiresAt']); id(proposal.route); vector(proposal.upperBound); nat(proposal.expiresAt, true);
      const route = routes.get(proposal.route); if (!route) fail('route_unknown'); if (!route.send || route.kind === 'model') fail('route_unavailable');
      screen(proposal.payload);
      const meaning = route.classify?.(clone(work), clone(proposal.payload as JsonValue)); if (!meaning) fail('effect_semantics_unknown');
      // The outer envelope is exact too; consumers send only its unmodified payload.
      const payload: JsonValue = { route: proposal.route, exact: proposal.payload as JsonValue };
      const draft: ActionDraft = { operation: 'disclose', ...clone(meaning), resources: [], recipients: [], payload, fences: [], upperBound: clone(proposal.upperBound), expiresAt: proposal.expiresAt };
      // Route resolvers see the actual emitter payload, not an envelope selected by the model.
      const d = inspect(work, proposal.route, proposal.payload as JsonValue), bytes = canonical(payload);
      return { ...draft, classes: [...new Set([...draft.classes, ...d.classes])], recipients: d.recipients, resources: [...new Map(d.disclosure.sources.map(s => [canonical(s.resource), s.resource])).values()], fences: d.fences, disclosure: { ...d.disclosure, exactBytes: { length: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') } } };
    },
    async perform(action, context) {
      const { route: routeId, exact: payload } = action.payload as { route: string; exact: JsonValue }, route = routes.get(routeId);
      if (!route?.send) fail('route_unavailable');
      return context.commit(action.payload, () => {
        const work = service().work.guard(service().control.bindWork(action.workId));
        const current = adapter.prepare({ route: routeId, payload, upperBound: action.upperBound, expiresAt: action.expiresAt }, { work, now: now() });
        if (!equal(current.disclosure, action.disclosure) || current.classes.some(c => !action.classes.includes(c)) || !equal([current.transaction, current.github, current.impact], [action.transaction, action.github, action.impact])) fail('disclosure_changed');
        return route.send!(clone(payload));
      });
    },
  };
  const result: DisclosureService = {
    adapter,
    attach(value) { if (policy) fail('policy_already_attached'); policy = value; },
    read(actor, value) { const work = service().work.guard(actor); journal.tx(() => {
      source(work, value); const all = sources(work).map(s => s.ref); if (!contains(all, value)) all.push(clone(value)); if (all.length > 64) fail('lineage_capacity');
      journal.put(workKey(work), { kind: 'work', id: workKey(work), sources: all });
    }); },
    derive(actor, derived, kind) { ref(derived); if (!['text', 'screenshot', 'artifact'].includes(kind)) fail('invalid_shape'); const work = service().work.guard(actor); journal.tx(() => {
      const value: Record = { kind: 'derived', id: derivedKey(derived), ref: clone(derived), workId: work.id, format: kind, sources: sources(work).map(s => s.ref) };
      const prior = journal.all<Record>().find(r => r.id === value.id); if (prior && !equal(prior, value)) fail('lineage_changed'); journal.put(value.id, value);
    }); },
    inherit(actor, derived) { ref(derived); const work = service().work.guard(actor); journal.tx(() => {
      const record = journal.get<Record>(derivedKey(derived)); if (record.kind !== 'derived') fail('lineage_unknown');
      const merged = [...new Map([...sources(work).map(s => s.ref), ...record.sources.map(r => source(work, r).ref)].map(r => [canonical(r), r])).values()];
      if (merged.length > 64) fail('lineage_capacity'); journal.put(workKey(work), { kind: 'work', id: workKey(work), sources: merged });
    }); },
    prepare(actor, input) { return service().work.prepare(actor, { slot: input.slot, adapter: adapter.id, proposal: { route: input.route, payload: input.payload, upperBound: input.upperBound, expiresAt: input.expiresAt } }); },
    dispatch: (actor, action) => service().work.dispatch(actor, action),
    protectAdapter(original, route) {
      if (routes.get(route)?.kind !== 'adapter') fail('route_unknown');
      return { ...original, prepare: (proposal, context) => enrich(context.work, route, original.prepare(proposal, context)),
        async perform(action, context) {
          const guard = () => guardAction(service().work.guard(service().control.bindWork(action.workId)), route, action);
          guard(); return original.perform(action, { guard() { context.guard(); guard(); }, commit(payload, send) { guard(); return context.commit(payload, () => { guard(); return send(); }); } });
        } };
    },
    guardRead(work, route, payload) { if (inspect(work, route, payload).classes.length) fail('recipient_unapproved'); },
    acquisition(route) {
      if (routes.get(route)?.kind !== 'artifact') fail('route_unknown');
      return { prepare: (work, draft) => enrich(work, route, { ...draft, classes: draft.classes.filter(c => c !== 'new_egress').concat('guest_local_admin') }), guard: (work, action) => guardAction(work, route, action) };
    },
    registryLease(actor, destination, vmId) {
      const recipient = options.registryRecipient?.(destination); if (!recipient) fail('recipient_unknown');
      result.registryDestination(actor as import('../policy').WorkActor, recipient, destination);
      if (vmId !== undefined) {
        id(vmId); const work = service().work.guard(actor as import('../policy').WorkActor);
        const inherited = journal.all<Record>().find(row => row.kind === 'vm' && row.id === 'vm_' + vmId)?.sources ?? [];
        if (!approved(work, recipient, inherited.map(r => source(work, r)))) fail('opaque_egress_unavailable');
      }
    },
    vmInput(actor, vmId) {
      id(vmId); const work = service().work.guard(actor as import('../policy').WorkActor);
      journal.tx(() => {
        const key = 'vm_' + vmId, prior = journal.all<Record>().find(row => row.kind === 'vm' && row.id === key)?.sources ?? [];
        const merged = [...new Map([...prior, ...sources(work).map(s => s.ref)].map(r => [canonical(r), r])).values()];
        if (merged.length > 64) fail('lineage_capacity'); journal.put(key, { kind: 'vm', id: key, sources: merged });
      });
    },
    vmOutput(actor, vmId) {
      id(vmId); const work = service().work.guard(actor as import('../policy').WorkActor);
      journal.tx(() => {
        const inherited = journal.all<Record>().find(row => row.kind === 'vm' && row.id === 'vm_' + vmId)?.sources ?? [];
        const merged = [...new Map([...sources(work).map(s => s.ref), ...inherited.map(r => source(work, r).ref)].map(r => [canonical(r), r])).values()];
        if (merged.length > 64) fail('lineage_capacity'); journal.put(workKey(work), { kind: 'work', id: workKey(work), sources: merged });
      });
    },
    catalogs(base) { return { current: (kind, key) => base.current(kind, key), allowsModel(work, selection) {
      if (base.allowsModel && !base.allowsModel(work, selection)) return false;
      try {
        const lineage = sources(work); if (!lineage.some(s => s.classification !== 'public')) return true;
        const recipient = modelRecipients.get(canonical(selection)); if (!recipient) return false;
        recipients([recipient]); return approved(work, recipient, lineage);
      } catch { return false; }
    }, allows(work, action) {
      if (!base.allows(work, action)) return false;
      try {
        const lineage = sources(work);
        if (!action) return true;
        if (!action.disclosure) {
          const contract = action.payload && typeof action.payload === 'object' && !Array.isArray(action.payload) ? action.payload.contract : null;
          // Solo Calendar edits still disclose their fields to Google, even with no attendees.
          const outbound = action.recipients.length > 0 || contract === 's15-google-effect/v1' || contract === 's15-browser-request/v1';
          return !lineage.some(s => s.classification !== 'public') || !outbound;
        }
        const d = action.disclosure;
        if (!equal(d.purpose, work.request.purpose) || !equal(d.sources, lineage.map(({ ref, resource, classification }) => ({ ref, resource, classification }))) || !equal(d.recipients, action.recipients)) return false;
        return recipients(action.recipients).every(r => approved(work, r, lineage) || action.classes.includes('disclosure') && lineage.every(s => s.classification === 'public' || s.ownerReleasable));
      } catch { return false; }
    } }; },
    browser(route, profile) {
      if (routes.get(route)?.kind !== 'browser') fail('route_unknown');
      if (profile !== undefined) ref(profile);
      // Omitting a profile key conservatively shares ancestry across this protected route.
      const key = 'browser_' + digest('s15.disclosure.browser.v1', { route, profile: profile ?? null });
      const input = (work: WorkAuthority) => journal.tx(() => {
        const inherited = journal.all<Record>().find(row => row.kind === 'browser' && row.id === key)?.sources ?? [];
        const merged = [...new Map([...sources(work).map(s => s.ref), ...inherited.map(r => source(work, r).ref)].map(r => [canonical(r), r])).values()];
        if (merged.length > 64) fail('lineage_capacity');
        journal.put(workKey(work), { kind: 'work', id: workKey(work), sources: merged });
        journal.put(key, { kind: 'browser', id: key, sources: merged });
      });
      return {
        input,
        inspect(work, request) { input(work); return inspect(work, route, requestPayload(request)); },
        guard(work, request, expected) { input(work); const d = inspect(work, route, requestPayload(request)); if (expected ? !equal(d.disclosure, expected) : d.classes.length) fail('disclosure_changed'); },
        record(work, url, format) { input(work); const s = options.browserSource?.(clone(work), url, format); if (!s) fail('classification_unknown'); result.read(service().control.bindWork(work.id), s); input(work); },
      };
    },
    model(routeFor) {
      const check = (work: WorkAuthority, candidate: Parameters<typeof routeFor>[0]) => {
        const route = routes.get(routeFor(candidate)); if (route?.kind !== 'model') fail('route_unknown');
        const resolved = route.resolve(clone(work), { selection: clone(candidate.selection) as unknown as JsonValue, account: clone(candidate.account) as unknown as JsonValue, recipient: clone(candidate.recipient) as unknown as JsonValue });
        if (!resolved) fail('recipient_unknown'); const targets = recipients(resolved);
        if (targets.length !== 1 || !equal(targets[0], candidate.recipient)) fail('recipient_changed');
        modelRecipients.set(canonical(candidate.selection), targets[0]!);
        return approved(work, targets[0]!, sources(work));
      };
      return { allows(work, candidate) { try { return check(work, candidate); } catch { return false; } }, guard(work, candidate, request) { screen(request); if (!check(work, candidate)) fail('recipient_unapproved'); } };
    },
    registryDestination(actor, recipient, destination) {
      const work = service().work.guard(actor); string(destination, 253);
      if (!/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(destination)) fail('route_unknown');
      const mapped = options.registryRecipient?.(destination); if (!mapped || !equal(mapped, recipient)) fail('recipient_unknown');
      recipients([recipient]); if (!approved(work, recipient, sources(work))) fail('opaque_egress_unavailable');
    },
    close: () => journal.close(),
  };
  return result;
}
