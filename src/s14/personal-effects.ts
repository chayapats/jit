import type { ToolDefinition } from "schway/host";
import { AppError } from "../errors";
import { containsCredential } from "../security/credentials";
import type { AppTransaction } from "../store";
import { record } from "./application";
import type { Attempt, Effect, EffectAction } from "./authority-types";
import type { OwnerActor } from "./types";
import type { S14Personal } from "./personal";
import type { PersonalConnection } from "./personal-types";
import type { PersonalDraft, PersonalDraftContent, PersonalEffectCommand, PersonalEffectObservation, PersonalEffectReceipt, PersonalEffectView, PersonalEventDraft } from "./personal-effect-types";
import { matchingPersonalMail, personalEventBody, personalMailRaw, validatePersonalDraft } from "./personal-effect-validation";
import { GoogleFailure, googleObject } from "./personal-protocol";
import { canonical, digest, exact, identity, integer } from "./validation";

const contract = "app.personal-effects/v1";
const eventPath = (draft: PersonalDraft) => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(draft.calendarId!)}/events`;
function load(tx: AppTransaction, id: string): PersonalDraft {
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM personal_drafts WHERE id=?", id);
  if (!row) throw new AppError("personal_draft_not_found", 404);
  return JSON.parse(row.record_json);
}
function persist(tx: AppTransaction, draft: PersonalDraft): void {
  tx.run("UPDATE personal_drafts SET record_json=? WHERE id=?", canonical(draft), draft.id);
  tx.run("INSERT OR REPLACE INTO personal_draft_versions VALUES (?,?,?)", draft.id, draft.revision, canonical(draft));
}
function action(draft: PersonalDraft): EffectAction {
  return { kind: draft.content?.kind === "mail" ? "send" : "calendar", destination: `google-personal/${draft.connectionId}/${draft.scope.id}`,
    content: canonical({ contract, draftId: draft.id, revision: draft.revision, attemptId: draft.attemptId, scope: draft.scope, connectionId: draft.connectionId, connectionRevision: draft.connectionRevision,
      account: draft.account, calendarId: draft.calendarId, ...(draft.eventSource ? { eventSource: draft.eventSource } : {}), content: draft.content, expiresAt: draft.expiresAt }) };
}
function draftHash(draft: PersonalDraft): string { return digest(canonical(action(draft))); }

/** Exact Google effect drafts over the existing single-use ledger; all uncertain writes remain reconcile-only. */
export class PersonalEffects {
  #draining: Promise<void> | null = null;
  constructor(readonly broker: S14Personal) {}
  private get app() { return this.broker.app; }

  private guard(tx: AppTransaction, draft: PersonalDraft): PersonalConnection {
    if (!draft.content || draft.payloadState !== "present" || draft.hash !== draftHash(draft)) throw new AppError("personal_draft_changed", 409);
    const mail = draft.content.kind === "mail";
    const result = this.broker.guard(tx, draft.attemptId, draft.scope, mail ? "effect_send" : "effect_calendar", mail ? "gmail.send" : "calendar.events", draft.effectId);
    if (result.connection.id !== draft.connectionId || result.connection.revision !== draft.connectionRevision || result.connection.account !== draft.account || result.connection.calendarId !== draft.calendarId || result.connection.service !== (mail ? "gmail" : "calendar")) throw new AppError("personal_account_changed", 403);
    if (draft.content.kind === "event" && draft.content.operation !== "create") {
      if (!draft.eventSource) throw new AppError("personal_event_revision_required", 403);
      const verified = this.broker.reads.eventRevision(tx, draft.attemptId, result.connection, draft.content.eventId!, draft.eventSource);
      if (verified.etag !== draft.content.etag) throw new AppError("personal_event_revision_changed", 409);
    }
    return result.connection;
  }

  private bindEvent(tx: AppTransaction, attemptId: string, connection: PersonalConnection, content: PersonalDraftContent): PersonalDraft["eventSource"] {
    if (content.kind !== "event" || content.operation === "create") return null;
    const verified = this.broker.reads.eventRevision(tx, attemptId, connection, content.eventId!);
    if (content.etag !== null && content.etag !== verified.etag) throw new AppError("personal_event_revision_changed", 409);
    content.etag = verified.etag;
    return verified.source;
  }

  /** Creates one immutable exact draft/card under live write scope; source/model suggestions can never approve it. */
  propose(attemptId: string, requestId: string, scope: PersonalDraft["scope"], content: PersonalDraftContent, expiresAt: number): PersonalEffectView {
    identity(requestId);
    validatePersonalDraft(content);
    integer(expiresAt, 1, Number.MAX_SAFE_INTEGER);
    const inputHash = digest(canonical({ scope, content, expiresAt }));
    return this.app.store.transaction(tx => {
      this.broker.guard(tx, attemptId, scope, content.kind === "mail" ? "effect_send" : "effect_calendar", content.kind === "mail" ? "gmail.send" : "calendar.events");
      const previous = tx.get<{ id: string; input_hash: string }>("SELECT id,input_hash FROM personal_drafts WHERE attempt_id=? AND request_id=?", attemptId, requestId);
      if (previous) {
        if (previous.input_hash !== inputHash) throw new AppError("request_id_conflict", 409);
        return this.viewIn(tx, previous.id);
      }
      const mail = content.kind === "mail";
      const { attempt, connection } = this.broker.guard(tx, attemptId, scope, mail ? "effect_send" : "effect_calendar", mail ? "gmail.send" : "calendar.events");
      if (connection.service !== (mail ? "gmail" : "calendar")) throw new AppError("personal_consent_required", 403);
      const selected = structuredClone(content);
      const eventSource = this.bindEvent(tx, attemptId, connection, selected);
      if (selected.kind === "event" && selected.operation === "create") {
        if (selected.eventId !== null) throw new AppError("personal_create_identity_owned_by_broker");
        selected.eventId = crypto.randomUUID().replaceAll("-", "");
      }
      const draft: PersonalDraft = { id: crypto.randomUUID().replaceAll("-", ""), revision: 1, attemptId, workId: attempt.workId, botId: attempt.snapshot.bot.id, scope: structuredClone(scope),
        connectionId: connection.id, connectionRevision: connection.revision, account: connection.account, calendarId: connection.calendarId,
        content: selected, eventSource, expiresAt, hash: "", effectId: "", payloadState: "present" };
      draft.hash = draftHash(draft);
      tx.run("INSERT INTO personal_drafts VALUES (?,?,?,?,?)", draft.id, attemptId, requestId, inputHash, canonical(draft));
      const effect = this.app.authority.proposeEffect(attemptId, draft.id, action(draft), expiresAt);
      draft.effectId = effect.id;
      persist(tx, draft);
      return { draft, effect, history: [draft], observation: null };
    });
  }

  /** Replaces exact content with a new unapproved card revision; previous recipient/event/timezone decisions cannot follow edits. */
  apply(tx: AppTransaction, command: PersonalEffectCommand): PersonalEffectReceipt {
    if (command.kind !== "personal.draft.revise") throw new AppError("unknown_command");
    const p = command.payload;
    exact(p, ["draftId", "draftHash", "content", "expiresAt"]);
    identity(p.draftId);
    validatePersonalDraft(p.content);
    const draft = load(tx, p.draftId);
    if (draft.revision !== command.expectedRevision || draft.hash !== p.draftHash || !draft.content || draft.content.kind !== p.content.kind) throw new AppError("personal_draft_changed", 409);
    const connection = this.guard(tx, draft);
    if (p.content.kind === "event" && p.content.operation === "create" && p.content.eventId !== (draft.content.kind === "event" ? draft.content.eventId : null)) throw new AppError("personal_create_identity_owned_by_broker");
    draft.content = structuredClone(p.content);
    draft.eventSource = this.bindEvent(tx, draft.attemptId, connection, draft.content);
    draft.expiresAt = p.expiresAt;
    draft.revision++;
    draft.hash = draftHash(draft);
    const effect = this.app.authority.reviseEffect(draft.attemptId, draft.effectId, command.expectedRevision, action(draft), p.expiresAt);
    persist(tx, draft);
    return { kind: command.kind, requestId: command.requestId, draft, effect };
  }

  private viewIn(tx: AppTransaction, draftId: string): PersonalEffectView {
    const draft = load(tx, draftId);
    const row = tx.get<{ record_json: string }>("SELECT record_json FROM personal_effect_observations WHERE effect_id=?", draft.effectId);
    const effect = record<Effect>(tx, "effects", draft.effectId);
    return { draft, effect: ["pending", "approved"].includes(effect.state) && effect.expiresAt <= this.app.now() ? { ...effect, state: "expired" } : effect,
      history: tx.all<{ record_json: string }>("SELECT record_json FROM personal_draft_versions WHERE id=? ORDER BY revision", draft.id).map(r => JSON.parse(r.record_json)), observation: row ? JSON.parse(row.record_json) : null };
  }

  /** Reads exact owner-reviewable draft/card revisions and provider evidence without starting an effect. */
  view(actor: OwnerActor, draftId: string): PersonalEffectView {
    identity(draftId);
    return this.app.store.read(tx => { this.app.requireOwner(tx, actor); return this.viewIn(tx, draftId); });
  }

  /** Lists one work's exact drafts; no query grants or performs a write. */
  list(actor: OwnerActor, workId: string): PersonalEffectView[] {
    identity(workId);
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      return tx.all<{ id: string }>("SELECT id FROM personal_drafts WHERE json_extract(record_json,'$.workId')=?", workId).map(row => this.viewIn(tx, row.id));
    });
  }

  private fromAction(selected: EffectAction): PersonalDraft {
    let data: Record<string, unknown>;
    try { data = googleObject(JSON.parse(selected.content)); } catch { throw new AppError("personal_effect_requires_exact_draft", 403); }
    if (data.contract !== contract || typeof data.draftId !== "string") throw new AppError("personal_effect_requires_exact_draft", 403);
    const draft = this.app.store.read(tx => load(tx, data.draftId as string));
    if (canonical(action(draft)) !== canonical(selected)) throw new AppError("personal_draft_changed", 409);
    return draft;
  }

  private observe(draft: PersonalDraft, state: PersonalEffectObservation["state"], providerId: string | null, meaning: PersonalEffectObservation["meaning"], etag: string | null = null): PersonalEffectObservation {
    if (containsCredential(providerId ?? "") || containsCredential(etag ?? "")) {
      state = "unknown";
      providerId = null;
      etag = null;
      meaning = "reconcile_only_no_retry";
    }
    const observation: PersonalEffectObservation = { effectId: draft.effectId, actionHash: draft.hash, state, providerId, etag, checkedAt: this.app.now(), meaning };
    this.app.store.transaction(tx => tx.run("INSERT OR REPLACE INTO personal_effect_observations VALUES (?,?)", draft.effectId, canonical(observation)));
    return observation;
  }

  private async evidenceGuard(draft: PersonalDraft, connection: PersonalConnection, get: (url: string) => Promise<Record<string, unknown>>): Promise<void> {
    if (!this.broker.options.evidenceGuard) return;
    if (draft.content?.kind === "mail") {
      if (!connection.scopes.includes("gmail.readonly")) throw new AppError("personal_evidence_requires_read_consent", 403);
      const profile = await get("https://gmail.googleapis.com/gmail/v1/users/me/profile");
      const self = typeof profile.emailAddress === "string" ? profile.emailAddress.toLowerCase() : "";
      const recipients = [...draft.content.to, ...draft.content.cc, ...draft.content.bcc];
      if (!self || draft.account.toLowerCase() !== self || recipients.some(email => email.toLowerCase() !== self)) throw new AppError("personal_evidence_self_send_only", 403);
    } else {
      if (!connection.scopes.includes("calendar.readonly")) throw new AppError("personal_evidence_requires_read_consent", 403);
      const metadata = await get(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(draft.calendarId!)}`);
      if (metadata.summary !== "Jit test") throw new AppError("personal_evidence_test_calendar_only", 403);
    }
  }

  /** Performs a claimed exact draft once with final authority/evidence guards; timeout/crash/ambiguous outcomes never retry writes. */
  async perform(selected: EffectAction, allowed: () => void): Promise<"succeeded" | "failed" | "unknown"> {
    let draft: PersonalDraft;
    try { draft = this.fromAction(selected); } catch { return "failed"; }
    let dispatched = false;
    const check = () => {
      allowed();
      this.app.store.read(tx => {
        const current = load(tx, draft.id), effect = record<Effect>(tx, "effects", draft.effectId);
        if (canonical(action(current)) !== canonical(selected) || effect.state !== "executing" || effect.actionHash !== draft.hash) throw new AppError("personal_draft_changed", 409);
        this.guard(tx, draft);
      });
    };
    try {
      const connection = this.app.store.read(tx => this.guard(tx, draft));
      const token = await this.broker.token(connection, check);
      const request = async (url: string, init: RequestInit = {}, mutating = false): Promise<Record<string, unknown>> => {
        const value = await this.broker.google.request(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } }, () => {
        check();
        this.app.authority.reserveEffectTool(draft.effectId, draft.content!.kind === "mail" ? "effect_send" : "effect_calendar", draft.scope);
        if (mutating) dispatched = true;
      });
        check();
        return googleObject(value);
      };
      await this.evidenceGuard(draft, connection, url => request(url));
      const content = draft.content!;
      let providerId: string | null = null;
      try {
        if (content.kind === "mail") {
          const sent = await request("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw: personalMailRaw(draft) }) }, true);
          providerId = typeof sent.id === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(sent.id) ? sent.id : null;
        } else {
          providerId = content.eventId;
          const base = eventPath(draft);
          const item = `${base}/${encodeURIComponent(content.eventId!)}`;
          if (content.operation !== "create") {
            const before = await request(item);
            const deleteTimezoneMatches = content.operation !== "delete" ||
              before.start && googleObject(before.start).timeZone === content.timezone;
            if (before.etag !== content.etag || before.id !== content.eventId || !deleteTimezoneMatches) {
              this.observe(draft, "not_applied", providerId, "provider_rejected");
              return "failed";
            }
          }
          await request((content.operation === "create" ? base : item) + `?sendUpdates=${content.sendUpdates}`, {
            method: content.operation === "create" ? "POST" : content.operation === "update" ? "PATCH" : "DELETE",
            headers: { ...(content.etag ? { "If-Match": content.etag } : {}), ...(content.operation !== "delete" ? { "Content-Type": "application/json" } : {}) },
            ...(content.operation !== "delete" ? { body: JSON.stringify(personalEventBody(content)) } : {}),
          }, true);
        }
      } catch (error) {
        if (!dispatched) throw error;
        if (error instanceof GoogleFailure && [400, 401, 403, 404, 412, 422].includes(error.providerStatus)) {
          if (error.providerStatus === 401) this.broker.invalidate(connection.id);
          this.observe(draft, "not_applied", providerId, "provider_rejected");
          return "failed";
        }
        // Read back only: no second POST/PATCH/DELETE, even after a timeout, conflict or transport exception.
      }
      const observation = await this.readBack(draft, connection, request, providerId);
      return observation.state === "verified" ? "succeeded" : "unknown";
    } catch {
      this.observe(draft, dispatched ? "unknown" : "not_applied", null, dispatched ? "reconcile_only_no_retry" : "provider_rejected");
      return dispatched ? "unknown" : "failed";
    }
  }

  private async readBack(draft: PersonalDraft, connection: PersonalConnection, request: (url: string) => Promise<Record<string, unknown>>, providerId: string | null): Promise<PersonalEffectObservation> {
    try {
      if (draft.content!.kind === "mail") {
        if (!connection.scopes.includes("gmail.readonly")) return this.observe(draft, providerId ? "accepted_unverified" : "unknown", providerId, "reconcile_only_no_retry");
        if (!providerId) {
          const query = new URLSearchParams({ q: `rfc822msgid:${draft.id}.${draft.revision}@jit.invalid`, labelIds: "SENT", maxResults: "2" });
          const list = await request(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${query}`);
          if (!Array.isArray(list.messages) || list.messages.length !== 1 || list.nextPageToken) return this.observe(draft, "unknown", null, "reconcile_only_no_retry");
          const id = googleObject(list.messages[0]).id;
          if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(id)) throw new Error();
          providerId = id;
        }
        const returned = await request(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(providerId)}?format=raw`);
        if (returned.id === providerId && matchingPersonalMail(returned.raw, draft)) return this.observe(draft, "verified", providerId, "matching_sent_copy");
      } else {
        const content = draft.content as PersonalEventDraft;
        providerId = content.eventId;
        let returned: Record<string, unknown>;
        try { returned = await request(`${eventPath(draft)}/${encodeURIComponent(content.eventId!)}`); }
        catch (error) {
          if (content.operation === "delete" && error instanceof GoogleFailure && [404, 410].includes(error.providerStatus)) return this.observe(draft, "verified", providerId, "event_absent");
          throw error;
        }
        if (content.operation === "delete") {
          if (returned.id === content.eventId && returned.status === "cancelled") return this.observe(draft, "verified", providerId, "event_absent");
        } else if (returned.id === content.eventId && returned.status !== "cancelled" && typeof returned.etag === "string" && (content.operation === "create" || returned.etag !== content.etag) && this.matchEvent(content, returned)) {
          return this.observe(draft, "verified", providerId, "matching_event", returned.etag);
        }
      }
    } catch { /* Missing permission, nonmatching state and uncertain reads cannot prove a write outcome. */ }
    return this.observe(draft, "unknown", providerId, "reconcile_only_no_retry");
  }

  private matchEvent(content: PersonalEventDraft, returned: Record<string, unknown>): boolean {
    const expected = content.event!;
    const start = googleObject(returned.start), end = googleObject(returned.end);
    const attendees = Array.isArray(returned.attendees) ? returned.attendees.map(a => googleObject(a).email) : [];
    return returned.summary === expected.summary && (returned.description ?? "") === expected.description && (returned.location ?? "") === expected.location &&
      typeof start.dateTime === "string" && Date.parse(start.dateTime) === Date.parse(expected.start) && start.timeZone === content.timezone &&
      typeof end.dateTime === "string" && Date.parse(end.dateTime) === Date.parse(expected.end) && end.timeZone === content.timezone &&
      canonical(returned.recurrence ?? []) === canonical(expected.recurrence) && canonical(attendees) === canonical(expected.attendees);
  }

  /** Performs an owner-requested read-back of an unknown action, without consuming or reissuing any write. */
  async reconcile(actor: OwnerActor, draftId: string, expectedRevision: number, actionHash: string): Promise<PersonalEffectView> {
    const view = this.view(actor, draftId);
    const draft = view.draft;
    if (draft.revision !== expectedRevision || draft.hash !== actionHash || view.effect.state !== "unknown" || !draft.content) throw new AppError("stale_approval", 409);
    const allowed = () => this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      const current = load(tx, draft.id), effect = record<Effect>(tx, "effects", draft.effectId);
      if (current.hash !== draft.hash || current.revision !== draft.revision || effect.state !== "unknown" || effect.actionHash !== actionHash) throw new AppError("stale_approval", 409);
      const scope = this.broker.scope(tx, draft.scope);
      if (!scope || scope.snapshot.id !== draft.connectionId || scope.snapshot.revision !== draft.connectionRevision) throw new AppError("personal_connection_unavailable", 403);
      return this.broker.connection(tx, draft.connectionId, draft.connectionRevision);
    });
    const connection = allowed();
    const token = await this.broker.token(connection, allowed);
    await this.readBack(draft, connection, async url => {
      const result = await this.broker.google.request(url, { headers: { Authorization: `Bearer ${token}` } }, allowed);
      allowed();
      return googleObject(result);
    }, view.observation?.providerId ?? null);
    return this.view(actor, draftId);
  }

  /** Consumes only already-approved personal cards; repeated drains never claim a terminal or unknown action again. */
  async drain(): Promise<void> {
    if (this.#draining) return this.#draining;
    this.#draining = (async () => {
      const drafts = this.app.store.read(tx => tx.all<{ id: string }>("SELECT id FROM personal_drafts").map(r => load(tx, r.id)));
      for (const draft of drafts) {
        const effect = this.app.store.read(tx => record<Effect>(tx, "effects", draft.effectId));
        if (effect.state !== "approved") continue;
        try { await this.app.authority.runEffect(effect.id, effect.revision, effect.actionHash); }
        catch { /* Expired/revoked cards remain fenced; there is no alternate execution path. */ }
      }
    })();
    try { await this.#draining; } finally { this.#draining = null; }
  }

  /** Removes deleted Bot/derived-attempt draft payloads while preserving original action hashes and unknown observations. */
  scrub(tx: AppTransaction): void {
    for (const row of tx.all<{ id: string }>("SELECT d.id FROM personal_drafts d JOIN attempt_payload_deletions a ON a.attempt_id=d.attempt_id")) {
      const draft = load(tx, row.id);
      if (draft.payloadState === "deleted") continue;
      draft.content = null; draft.account = "[deleted]"; draft.calendarId = null; draft.payloadState = "deleted";
      persist(tx, draft);
      tx.run("UPDATE personal_draft_versions SET record_json=json_set(record_json,'$.content',null,'$.account','[deleted]','$.calendarId',null,'$.payloadState','deleted') WHERE id=?", draft.id);
      for (const receipt of tx.all<{ request_id: string; result_json: string }>("SELECT request_id,result_json FROM command_receipts WHERE json_extract(result_json,'$.draft.id')=?", draft.id)) {
        const result = JSON.parse(receipt.result_json);
        result.draft = draft;
        if (result.effect) result.effect = record<Effect>(tx, "effects", draft.effectId);
        tx.run("UPDATE command_receipts SET result_json=? WHERE request_id=?", canonical(result), receipt.request_id);
      }
    }
  }

  /** Offers draft proposal only under captured write tools; the returned card remains pending exact owner approval. */
  definitions(attempt: Attempt): ToolDefinition[] {
    if (!this.broker.options.vault) return [];
    const available = this.app.store.read(tx => attempt.snapshot.scopes.some(scope => {
      for (const [tool, consent] of [["effect_send", "gmail.send"], ["effect_calendar", "calendar.events"]] as const) {
        if (!attempt.snapshot.tools.includes(tool)) continue;
        try {
          this.broker.guard(tx, attempt.id, scope.ref, tool, consent);
          return true;
        } catch { /* Generic effect ceilings never imply a personal account tool or write consent. */ }
      }
      return false;
    }));
    if (!available) return [];
    return [{ name: "personal_draft", description: "Propose one exact Gmail send or Calendar change for owner approval. A proposal never executes or grants consent. Quote recipients, text, timezone and recurrence exactly. For update/delete select an event from personal_read; pass etag:null so the service binds its verified revision.",
      inputSchema: { type: "object", properties: { requestId: { type: "string" }, scope: { type: "object" }, content: { type: "object" }, expiresAt: { type: "integer" } }, required: ["requestId", "scope", "content", "expiresAt"], additionalProperties: false },
      effect: "read-only", execution: "exclusive", execute: async input => {
        exact(input, ["requestId", "scope", "content", "expiresAt"]);
        const view = this.propose(attempt.id, input.requestId as string, input.scope as PersonalDraft["scope"], input.content as PersonalDraftContent, input.expiresAt as number);
        const encoded = JSON.stringify({ draft: view.draft, effectId: view.effect.id, state: view.effect.state });
        if (Buffer.byteLength(encoded) > Math.min(32768, attempt.snapshot.outputBytes)) return { content: "personal_draft_output_limit", isError: true };
        return { content: encoded };
      } }];
  }
}
