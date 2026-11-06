import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DurableJournal } from '../../s15/durable-journal';
import type { DataClass, RecipientApproval } from '../../s15/disclosure';
import type { CatalogKind, PreparedAction, Ref } from '../../s15/policy';
import { PolicyError } from '../../s15/policy';
import { ownerInstructionText } from '../../s15/conversation/intent';

/** At most this many people and remembered recipients are kept (`recipient_list_full`). */
export const recipientDirectoryLimit = 400;
/** A remembered private-data recipient stays registered this long unless the owner forgets it sooner. */
export const rememberedRecipientLifetimeMs = 5 * 365 * 86_400_000;

/** One person the owner addressed: exact address, optional owner-written name, stable recipient ref. */
export interface DirectoryPerson { ref: Ref; address: string; label: string | null; addedAt: number }
/** One installation-wide registered private-data recipient (S16-D07 g), shown and revocable in settings. */
export interface RememberedRecipient { grantId: string; recipient: Ref; purpose: Ref; resource: Ref; dataClasses: DataClass[]; rememberedAt: number; expiresAt: number; revision: number }

/** `shadow`: a configured binding owns this address's ref; the directory only keeps the owner's written name. */
interface PersonRecord { kind: 'person'; key: string; address: string; label: string | null; active: boolean; addedAt: number; shadow?: boolean }
/** One grant per recipient, purpose and source resource, holding only the data classes approved for that resource. */
interface RememberedRecord { kind: 'remembered'; grantId: string; recipient: Ref; purpose: Ref; resource: Ref; dataClasses: DataClass[]; active: boolean; revision: number; rememberedAt: number; expiresAt: number }
interface MetaRecord { kind: 'meta'; epoch: string }
type Row = PersonRecord | RememberedRecord | MetaRecord;

const addressPattern = /[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}/g;
/** Case-insensitive address identity, the same rule the Google adapter applies to its bindings. */
const addressKey = (address: string) => address.toLowerCase();
const sha = (domain: string, value: string) => createHash('sha256').update(`${domain}\0${value}`).digest('hex');

/** A forwarded or pasted message starts at its first separator or header line; everything after it is inert. */
const forwardedStart = /^[ \t]*(?:-{2,}[^\n]*(?:forward|original|ข้อความ)[^\n]*-*|begin forwarded message:?|(?:from|to|cc|bcc|sent|date|subject|reply-to|จาก|ถึง|เรื่อง|วันที่)[ \t]*:.*|on .{1,200} wrote:|เมื่อ.{1,200}เขียนว่า:?)[ \t]*$/imu;
/** The owner's own instruction: quotes, fenced code, `>` lines and any forwarded or pasted message are removed. */
function ownerOwnText(text: string): string {
  const cut = forwardedStart.exec(text);
  return ownerInstructionText(cut ? text.slice(0, cut.index) : text);
}
/** Instruction words written before a name (`Email Carol <…>`) are not part of the name. */
const leadingWords = /^(?:(?:please|pls|can|could|you|email|e-mail|mail|send|message|write|reply|forward|it|this|that|the|summary|report|to|cc|bcc|and|also|then|ช่วย|กรุณา|ส่ง|ส่งเมล|ส่งอีเมล|เมล|อีเมล|ข้อความ|หา|ถึง|ให้|และ|กับ)[ \t]+)+/iu;
function writtenName(raw: string): string | null {
  const name = raw.replace(leadingWords, '').replace(/^(?:to|cc|bcc|หา|ถึง)$/iu, '').trim();
  return name && /^[\p{L}\p{M}][\p{L}\p{M}\p{N} .'-]{0,62}$/u.test(name) ? name : null;
}

/**
 * Who the owner's own message names (AUTH16-01, owner decision 2026-11-06): every exact address, plus a
 * name written before an address as `Name <address>`, plus a known person whose name appears in the text when
 * exactly one known person has that name. Quotes, fenced code, `>` lines and everything from a forwarded or pasted
 * message's first separator or header line (`From:`, `---- Forwarded message ----`, `On … wrote:`) are inert, so a
 * pasted email or page cannot name anyone. Returns lowercase-keyed unique addresses with their written names.
 */
export function namedInOwnerText(text: string, people: readonly { address: string; label: string | null }[]): { address: string; label: string | null }[] {
  const instruction = ownerOwnText(text), found = new Map<string, { address: string; label: string | null }>();
  for (const match of instruction.matchAll(addressPattern)) {
    const address = match[0], line = instruction.slice(instruction.lastIndexOf('\n', match.index!) + 1, match.index!);
    const labelled = /([^\s<>,;:]+(?:[ \t]+[^\s<>,;:]+){0,3})[ \t]*<$/u.exec(line);
    if (!found.has(addressKey(address))) found.set(addressKey(address), { address, label: labelled ? writtenName(labelled[1]!) : null });
  }
  const lower = instruction.toLowerCase();
  const byLabel = new Map<string, { address: string; label: string | null }[]>();
  for (const person of people) if (person.label) { const key = person.label.toLowerCase(); byLabel.set(key, [...(byLabel.get(key) ?? []), person]); }
  for (const [label, matches] of byLabel) {
    if (matches.length !== 1) continue; // Two people with the same name are ambiguous: the send waits for a card.
    const at = lower.indexOf(label);
    if (at < 0) continue;
    const prev = lower[at - 1], next = lower[at + label.length];
    if (/[a-z0-9]/.test(prev ?? '') || /[a-z0-9]/.test(next ?? '')) continue; // "Al" never matches inside "Alice".
    const person = matches[0]!; if (!found.has(addressKey(person.address))) found.set(addressKey(person.address), { address: person.address, label: person.label });
  }
  return [...found.values()];
}

/**
 * Protected installation-wide recipient directory (AUTH16-01). It holds two owner-derived lists in its own
 * durable journal: people the owner's own messages addressed (each gets a stable `person_…` recipient ref so
 * an owner-requested send can be bound to it), and private-data recipients the owner approved once (S16-D07 g),
 * which DATA15 then treats as registered for every Bot until the owner forgets them. Nothing here is written
 * from model output, page content or a working VM; a missing journal opens empty, which only narrows access.
 */
export class RecipientDirectory {
  readonly #journal: DurableJournal;
  readonly #epoch: string;
  readonly #now: () => number;
  #people = new Map<string, PersonRecord>();
  #remembered = new Map<string, RememberedRecord>();
  constructor(path: string, installationId: string, options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#journal = new DurableJournal(path, installationId, !existsSync(path), 0x4a523136, { records: 1024, bytes: 16 * 1_048_576 });
    try {
      const rows = this.#journal.all<Row>();
      let meta = rows.find((row): row is MetaRecord => row.kind === 'meta');
      if (!meta && !rows.length) { meta = { kind: 'meta', epoch: randomBytes(8).toString('hex') }; const record = meta; this.#journal.tx(() => this.#journal.put('meta', record)); }
      if (!meta || !/^[a-f0-9]{16}$/.test(meta.epoch)) throw new PolicyError('continuity_unavailable');
      this.#epoch = meta.epoch;
      for (const row of rows) { if (row.kind === 'person') this.#people.set(row.key, row); if (row.kind === 'remembered') this.#remembered.set(row.grantId, row); }
    } catch (error) { this.#journal.close(); throw error; }
  }
  #ref(key: string): Ref { return { id: `person_${this.#epoch}_${sha('s16.recipient.person.v1', key).slice(0, 24)}`, revision: 1, generation: 1 }; }
  /** People the owner addressed, sorted by address. */
  people(): DirectoryPerson[] {
    return [...this.#people.values()].filter(p => p.active).sort((a, b) => a.key.localeCompare(b.key)).map(p => ({ ref: this.#ref(p.key), address: p.address, label: p.label, addedAt: p.addedAt }));
  }
  /** Address bindings for the Google adapter and DATA15 route resolution. */
  bindings(): { ref: Ref; address: string }[] { return [...this.#people.values()].filter(p => p.active && !p.shadow).sort((a, b) => a.key.localeCompare(b.key)).map(p => ({ ref: this.#ref(p.key), address: p.address })); }
  /**
   * Binds the people one authenticated owner message names and returns their refs. `known` are protected
   * configured bindings (they keep their configured refs and may be named by address). Called only by the
   * protected conversation admission for live owner text, never for a routine, steer or resume.
   */
  named(text: string, known: readonly { ref: Ref; address: string }[] = []): Ref[] {
    const people = [...this.#people.values()].filter(p => p.active).map(p => ({ address: p.address, label: p.label }));
    const names = namedInOwnerText(text, people);
    if (!names.length) return [];
    const refs: Ref[] = [];
    this.#journal.tx(() => {
      for (const name of names) {
        // Configured bindings keep their refs; this directory's own bindings are not "configured".
        const configured = known.filter(k => addressKey(k.address) === addressKey(name.address) && !k.ref.id.startsWith(`person_${this.#epoch}_`));
        if (configured.length > 1) continue;
        const key = addressKey(name.address), old = this.#people.get(key), shadow = configured.length === 1;
        // The owner's written name is saved for every named address, so a later name-only request resolves it.
        if (!old || !old.active || (name.label && name.label !== old.label) || !!old.shadow !== shadow) {
          if (!old && this.#people.size + this.#remembered.size >= recipientDirectoryLimit) { if (shadow) refs.push(structuredClone(configured[0]!.ref)); continue; } // A full list only narrows.
          const next: PersonRecord = { kind: 'person', key, address: old?.address ?? name.address, label: name.label ?? old?.label ?? null, active: true, addedAt: old?.addedAt ?? this.#now(), ...(shadow ? { shadow: true } : {}) };
          this.#journal.put(`p_${sha('s16.recipient.key.v1', key).slice(0, 40)}`, next); this.#people.set(key, next);
        }
        refs.push(shadow ? structuredClone(configured[0]!.ref) : this.#ref(key));
      }
    });
    return refs.filter((r, i) => refs.findIndex(o => o.id === r.id) === i);
  }
  /**
   * Gives one address a recipient identity without naming it (a Bot-proposed send to someone new). The ref is not
   * owner-named, so the send waits for an exact card. A full list refuses with `recipient_list_full`.
   */
  bind(address: string): void {
    if (!new RegExp(`^${addressPattern.source}$`).test(address)) throw new PolicyError('recipient_binding_required');
    const key = addressKey(address); const existing = this.#people.get(key); if (existing?.active && !existing.shadow) return;
    if (!this.#people.has(key) && this.#people.size + this.#remembered.size >= recipientDirectoryLimit) throw new PolicyError('recipient_list_full');
    const old = this.#people.get(key);
    // A shadowed address already has a configured binding; the adapter never asks to bind it.
    if (old?.shadow && old.active) return;
    const next: PersonRecord = { kind: 'person', key, address: old?.address ?? address, label: old?.label ?? null, active: true, addedAt: old?.addedAt ?? this.#now() };
    this.#journal.tx(() => this.#journal.put(`p_${sha('s16.recipient.key.v1', key).slice(0, 40)}`, next)); this.#people.set(key, next);
  }
  /** Removes one person; later sends to that address need a new owner message or card. */
  forgetPerson(address: string): void {
    const key = addressKey(address), old = this.#people.get(key); if (!old?.active) throw new PolicyError('recipient_changed');
    const next = { ...old, active: false }; this.#journal.tx(() => this.#journal.put(`p_${sha('s16.recipient.key.v1', key).slice(0, 40)}`, next)); this.#people.set(key, next);
  }
  /**
   * Registers each recipient of an owner-approved disclosure (S16-D07 g): one grant per recipient, purpose and source
   * resource, holding exactly the data classes that resource contributed, so approvals never combine into a scope the
   * owner did not see. Only the protected decision path calls this, after POLICY recorded the exact approval.
   */
  remember(action: Pick<PreparedAction, 'disclosure' | 'classes'>): void {
    const d = action.disclosure; if (!d || !action.classes.includes('disclosure')) return;
    const scopes = new Map<string, { resource: Ref; dataClasses: Set<DataClass> }>();
    for (const source of d.sources) {
      if (source.classification === 'public') continue;
      const id = `${source.resource.id}@${source.resource.revision}`, scope = scopes.get(id) ?? { resource: source.resource, dataClasses: new Set<DataClass>() };
      scope.dataClasses.add(source.classification); scopes.set(id, scope);
    }
    if (!scopes.size) return;
    // The cache changes only after the whole journal transaction committed.
    const written: RememberedRecord[] = [];
    this.#journal.tx(() => {
      for (const recipient of d.recipients) for (const scope of scopes.values()) {
        const grantId = sha('s16.recipient.grant.v1', JSON.stringify([recipient.id, recipient.revision, d.purpose.id, d.purpose.revision, scope.resource.id, scope.resource.revision])).slice(0, 32);
        const old = this.#remembered.get(grantId), keep = old?.active ? old.dataClasses : [];
        if (!old && this.#people.size + this.#remembered.size + written.length >= recipientDirectoryLimit) throw new PolicyError('recipient_list_full');
        const now = this.#now(), next: RememberedRecord = { kind: 'remembered', grantId, recipient: structuredClone(recipient), purpose: structuredClone(d.purpose), resource: structuredClone(scope.resource),
          dataClasses: [...new Set([...keep, ...scope.dataClasses])].sort() as DataClass[], active: true, revision: (old?.revision ?? 0) + 1, rememberedAt: now, expiresAt: now + rememberedRecipientLifetimeMs };
        this.#journal.put(`r_${grantId}`, next); written.push(next);
      }
    });
    for (const record of written) this.#remembered.set(record.grantId, record);
  }
  /** Current registered grants for the owner's settings list. */
  remembered(): RememberedRecipient[] {
    const now = this.#now();
    return [...this.#remembered.values()].filter(r => r.active && r.expiresAt > now).sort((a, b) => a.recipient.id.localeCompare(b.recipient.id) || a.grantId.localeCompare(b.grantId))
      .map(r => ({ grantId: r.grantId, recipient: structuredClone(r.recipient), purpose: structuredClone(r.purpose), resource: structuredClone(r.resource), dataClasses: [...r.dataClasses], rememberedAt: r.rememberedAt, expiresAt: r.expiresAt, revision: r.revision }));
  }
  /** DATA15 approvals: each grant covers its one resource and its own data classes (all current source revisions). */
  approvals(): RecipientApproval[] { return this.remembered().map(r => ({ recipient: r.recipient, purpose: r.purpose, resources: [r.resource], dataClasses: r.dataClasses, sources: null, expiresAt: r.expiresAt })); }
  /** Forgets exactly the grant revision the owner saw (`recipient_changed` otherwise). */
  forget(grantId: string, revision: number): void {
    const old = this.#remembered.get(grantId); if (!old?.active || old.revision !== revision) throw new PolicyError('recipient_changed');
    const next = { ...old, active: false }; this.#journal.tx(() => this.#journal.put(`r_${grantId}`, next)); this.#remembered.set(grantId, next);
  }
  /** Owner-readable name of a recipient ref: a person's address, otherwise the protected id. */
  label(recipientId: string): string { for (const p of this.#people.values()) if (this.#ref(p.key).id === recipientId) return p.label ? `${p.label} (${p.address})` : p.address; return recipientId; }
  /** Policy/disclosure catalog lookup for `person_…` refs; unknown ids are null. */
  catalog(kind: CatalogKind, id: string): { ref: Ref; active: boolean } | null {
    if (kind !== 'recipient' || !id.startsWith(`person_${this.#epoch}_`)) return null;
    for (const p of this.#people.values()) if (!p.shadow && this.#ref(p.key).id === id) return { ref: this.#ref(p.key), active: p.active };
    return null;
  }
  close(): void { this.#journal.close(); }
}
