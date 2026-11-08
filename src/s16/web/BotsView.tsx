import { useEffect, useRef, useState } from "react";
import type { Locale } from "../../i18n";
import { JitClientError, type JitClient } from "../client";
import type { ClientBot, ClientBotCommand, ClientBotDetail, ClientBotDraft, ClientBotProposal, ClientBotReceipt, ClientBotsView } from "../client/contracts";
import { BotProposalCard } from "./BotProposalCard";
import type { Copy } from "./copy";

/** Which Bots page is open. `new` may carry a proposal to edit (its draft prefills the form). */
export type BotsPage = { kind: "list" } | { kind: "bot"; id: string } | { kind: "new"; seed?: ClientBotDraft };
/** Props for the owner Bots surface (BOT16-01). Data comes only from the protected client. */
export interface BotsViewProps {
  client: JitClient; t: Copy; locale: Locale;
  /** Server capability. When false, no request is made and no control is shown. */
  available: boolean;
  page: BotsPage;
  onNavigate(page: BotsPage): void;
  onStartChat(botId: string): void;
  onOpenConversation(conversationId: string): void;
  /** The roster changed (created, renamed, archived, restored); navigation should refresh. */
  onChanged(): void;
  onFailure(error: unknown): void;
}
type Notice = { kind: "pending" } | { kind: "done"; text: string } | { kind: "error"; code: string } | { kind: "unknown"; command: ClientBotCommand };
const uid = () => crypto.randomUUID().replaceAll("-", "");
const code = (error: unknown) => error instanceof JitClientError ? error.code : "client_unavailable";
const privateFailure = (error: unknown) => error instanceof JitClientError && ([401, 403].includes(error.status ?? 0) || ["authentication_required", "authorization_required", "csrf_rejected"].includes(error.code));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Owner-facing Bot name: the main Bot's default name is localized; every other name is the owner's own text. */
export function botName(t: Copy, bot: Pick<ClientBot, "main" | "name"> | undefined | null): string { return !bot ? "" : bot.main && !bot.name ? t("s16.bots.mainName") : bot.name; }

/**
 * Owner Bots: roster, pending proposals, one Bot's profile and lifecycle (archive/restore/duplicate/export) and the
 * New Bot form. Every change is one explicit command that is never retried silently; creating a Bot always goes
 * through the reviewed proposal card.
 */
export function BotsView({ client, t, locale, available, page, onNavigate, onStartChat, onOpenConversation, onChanged, onFailure }: BotsViewProps) {
  const [data, setData] = useState<ClientBotsView | null>(null), [detail, setDetail] = useState<ClientBotDetail | null>(null), [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null), [reload, setReload] = useState(0), [proposal, setProposal] = useState<ClientBotProposal | null>(null), [confirm, setConfirm] = useState(false);
  const noticeRef = useRef<HTMLDivElement>(null), heading = useRef<HTMLHeadingElement>(null), importer = useRef<HTMLInputElement>(null), commands = useRef(0);
  const date = (value: number) => new Intl.DateTimeFormat(locale === "th" ? "th-TH" : "en-GB", { dateStyle: "medium" }).format(value);
  const fail = (error: unknown) => { if (privateFailure(error)) { onFailure(error); return true; } return false; };

  useEffect(() => {
    if (!available) return;
    const stop = new AbortController(), turn = ++commands.current;
    setDetail(null); setProposal(null); setConfirm(false);
    (async () => {
      try {
        const next = await client.bots(stop.signal); if (turn !== commands.current) return;
        setData(next); setLoadError(null);
        if (page.kind === "bot") { const one = await client.bot(page.id, stop.signal); if (turn === commands.current) setDetail(one); }
      } catch (error) { if (stop.signal.aborted || code(error) === "client_response_stale" || fail(error)) return; setLoadError(code(error)); }
    })();
    return () => stop.abort();
  }, [available, reload, page.kind, page.kind === "bot" ? page.id : ""]);
  useEffect(() => { heading.current?.focus(); }, [page.kind, page.kind === "bot" ? page.id : ""]);
  useEffect(() => { if (notice && notice.kind !== "pending") noticeRef.current?.focus(); }, [notice]);

  async function send(command: ClientBotCommand, done: (receipt: ClientBotReceipt) => string) {
    setNotice({ kind: "pending" });
    try { const receipt = await client.botCommand(command); setNotice({ kind: "done", text: done(receipt) }); onChanged(); setReload(value => value + 1); }
    catch (error) { if (fail(error)) return; setNotice(error instanceof JitClientError && error.outcome === "unknown" ? { kind: "unknown", command } : { kind: "error", code: code(error) }); }
  }
  async function review(draft: ClientBotDraft) {
    setNotice({ kind: "pending" });
    try { setProposal(await client.proposeBot(draft)); setNotice(null); }
    catch (error) { if (fail(error)) return; setNotice({ kind: "error", code: code(error) }); }
  }
  async function duplicate(bot: ClientBot) {
    setNotice({ kind: "pending" });
    try { setProposal(await client.duplicateBot(bot.id, t("s16.bots.copyName", { name: botName(t, bot) }).slice(0, 60))); setNotice(null); }
    catch (error) { if (fail(error)) return; setNotice({ kind: "error", code: code(error) }); }
  }
  async function exportBot(bot: ClientBot) {
    try {
      const file = await client.botExport(bot.id);
      const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" })), link = document.createElement("a");
      link.href = url; link.download = `${(botName(t, bot) || "bot").replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 40)}.jit-bot.json`; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    } catch (error) { if (fail(error)) return; setNotice({ kind: "error", code: code(error) }); }
  }
  async function importFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 16384) { setNotice({ kind: "error", code: "body_too_large" }); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(await file.text()); } catch { setNotice({ kind: "error", code: "invalid_bot_export" }); return; }
    setNotice({ kind: "pending" });
    try { setProposal(await client.importBot(parsed)); setNotice(null); }
    catch (error) { if (fail(error)) return; setNotice({ kind: "error", code: code(error) }); }
  }
  const accepted = (receipt: ClientBotReceipt) => { setProposal(null); onChanged(); setNotice({ kind: "done", text: t("s16.bots.created", { name: receipt.bot ? botName(t, receipt.bot) : "" }) }); if (receipt.bot) onNavigate({ kind: "bot", id: receipt.bot.id }); else setReload(value => value + 1); };

  if (!available) return <section className="bots" aria-labelledby="bots-title"><h1 id="bots-title" ref={heading} tabIndex={-1}>{t("s16.bots.title")}</h1><p>{t("s16.bots.unavailable")}</p></section>;
  const busy = notice?.kind === "pending";
  const status = <div ref={noticeRef} tabIndex={-1} role={notice?.kind === "error" || notice?.kind === "unknown" ? "alert" : "status"} aria-live="polite">
    {notice?.kind === "done" && <p className="notice ok">{notice.text}</p>}
    {notice?.kind === "error" && <p className="notice warn">{notice.code === "stale_proposal" ? t("s16.bots.stale") : t("s16.bots.failed", { reason: notice.code })}</p>}
    {notice?.kind === "unknown" && <p className="notice warn">{t("s16.bots.unknown")} <button type="button" onClick={() => void send(notice.command, () => t("s16.bots.saved"))}>{t("s16.bots.checkAgain")}</button></p>}
  </div>;
  const proposalCard = (item: ClientBotProposal) => <BotProposalCard key={item.id} client={client} t={t} proposal={item} choices={data} onAccepted={accepted} onEdit={value => { setProposal(null); onNavigate({ kind: "new", seed: value.draft }); }} onDismissed={() => { setProposal(null); setReload(value => value + 1); }} onFailure={onFailure} />;
  const loading = <>{!data && !loadError && <p role="status">{t("s16.common.loading")}</p>}
    {loadError && <p role="alert">{t("s16.bots.loadFailed", { reason: loadError })} <button type="button" onClick={() => setReload(value => value + 1)}>{t("s16.bots.retry")}</button></p>}</>;

  if (page.kind === "new") return <section className="bots" aria-labelledby="bots-title">
    <button type="button" className="memory-link" onClick={() => onNavigate({ kind: "list" })}>← {t("s16.bots.back")}</button>
    <h1 id="bots-title" ref={heading} tabIndex={-1}>{t("s16.bots.new")}</h1>
    {loading}{status}
    {data && <BotForm key={JSON.stringify(page.seed ?? null)} t={t} data={data} initial={page.seed ?? null} busy={busy} submit={t("s16.bots.review")} creating onSubmit={draft => void review(draft)} />}
    {proposal && proposalCard(proposal)}
  </section>;

  if (page.kind === "bot") {
    const bot = detail?.bot;
    return <section className="bots" aria-labelledby="bots-title">
      <button type="button" className="memory-link" onClick={() => onNavigate({ kind: "list" })}>← {t("s16.bots.back")}</button>
      <h1 id="bots-title" ref={heading} tabIndex={-1}>{bot ? botName(t, bot) : t("s16.bots.title")}</h1>
      {loading}{status}
      {data && !detail && !loadError && <p role="status">{t("s16.common.loading")}</p>}
      {bot && data && <>
        <p className="meta">{bot.main && <span className="pill ok">{t("s16.bots.mainBadge")}</span>} {bot.state === "archived" && <span className="pill idle">{t("s16.bots.archived")}</span>}</p>
        {bot.selectionUnavailable && <p className="notice warn">{t("s16.bots.modelUnavailable")}</p>}
        {bot.state === "active" ? <BotForm key={`${bot.id}:${bot.revision}`} t={t} data={data} main={bot.main} initial={{ contract: "s16-bot-draft/v1", name: botName(t, bot), responsibility: bot.responsibility, selection: bot.selection, excluded: bot.excluded, assignments: bot.assignments }} busy={busy} submit={t("s16.bots.save")}
          onSubmit={draft => void send({ contract: "s16-bot-command/v1", requestId: uid(), kind: "bot.update", botId: bot.id, expectedRevision: bot.revision, name: draft.name, responsibility: draft.responsibility, selection: draft.selection, assignments: draft.assignments, excluded: draft.excluded }, () => t("s16.bots.saved"))} />
          : bot.responsibility && <p className="owner-text">{bot.responsibility}</p>}
        <div className="actions">
          {bot.state === "active" && <button type="button" className="primary" onClick={() => onStartChat(bot.id)}>{t("s16.bots.chat")}</button>}
          {data.creation.available && <button type="button" disabled={busy} onClick={() => void duplicate(bot)}>{t("s16.bots.duplicate")}</button>}
          <button type="button" disabled={busy} onClick={() => void exportBot(bot)}>{t("s16.bots.export")}</button>
          {!bot.main && bot.state === "active" && <button type="button" disabled={busy} onClick={() => setConfirm(true)}>{t("s16.bots.archive")}</button>}
          {bot.state === "archived" && <button type="button" disabled={busy} onClick={() => void send({ contract: "s16-bot-command/v1", requestId: uid(), kind: "bot.restore", botId: bot.id, expectedRevision: bot.revision }, () => t("s16.bots.restored"))}>{t("s16.bots.restore")}</button>}
        </div>
        {bot.main && <p className="limits">{t("s16.bots.mainFixed")}</p>}
        {confirm && <div className="notice confirm" role="group" aria-labelledby="bot-archive-title" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setConfirm(false); } }}>
          <h3 id="bot-archive-title">{t("s16.bots.archiveTitle", { name: botName(t, bot) })}</h3>
          <p>{t("s16.bots.archiveBody", { name: botName(t, bot) })}</p>
          {!!detail.impact.running.length && <p>{t("s16.bots.archiveRunning", { n: detail.impact.running.length })}</p>}
          {!!detail.impact.routines.length && <p>{t("s16.bots.archiveRoutines", { names: detail.impact.routines.map(item => item.name).join(", ") })}</p>}
          <button type="button" className="primary" autoFocus disabled={busy} onClick={() => { setConfirm(false); void send({ contract: "s16-bot-command/v1", requestId: uid(), kind: "bot.archive", botId: bot.id, expectedRevision: bot.revision }, receipt => t("s16.bots.archiveDone", { stopped: receipt.stopped, paused: receipt.paused })); }}>{t("s16.bots.archive")}</button>
          <button type="button" onClick={() => setConfirm(false)}>{t("s16.bots.cancel")}</button>
        </div>}
        {proposal && proposalCard(proposal)}
        <h2>{t("s16.bots.conversations")}</h2>
        {!detail.conversations.length && <p>{bot.main ? t("s16.bots.noConversations") : t("s16.bots.noConversations")}</p>}
        <ul className="bot-conversations">{detail.conversations.map(item => <li key={item.conversationId}><button type="button" className="memory-link" onClick={() => onOpenConversation(item.conversationId)}>{item.assignment && <span className="pill idle">{t("s16.bots.assignment")}</span>} {item.firstMessage.slice(0, 120)}</button> <span className="meta">{date(item.latestAt)}</span></li>)}</ul>
      </>}
    </section>;
  }

  return <section className="bots" aria-labelledby="bots-title">
    <h1 id="bots-title" ref={heading} tabIndex={-1}>{t("s16.bots.title")}</h1>
    <p className="lead">{t("s16.bots.lead")}</p>
    {loading}{status}
    {data && <>
      <div className="actions">
        {data.creation.available ? <button type="button" className="primary" onClick={() => onNavigate({ kind: "new" })}>＋ {t("s16.bots.new")}</button> : <p className="limits">{t("s16.bots.creationUnavailable", { reason: data.creation.code })}</p>}
        {data.creation.available && <><button type="button" disabled={busy} onClick={() => importer.current?.click()}>{t("s16.bots.import")}</button>
          <input ref={importer} type="file" accept=".json,application/json" className="visually-hidden" tabIndex={-1} onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ""; }} /></>}
      </div>
      {proposal && proposalCard(proposal)}
      {!!data.proposals.length && <><h2>{t("s16.bots.pending")}</h2>{data.proposals.filter(item => item.id !== proposal?.id).map(proposalCard)}</>}
      <ul className="bot-list" aria-label={t("s16.bots.title")}>{data.bots.map(bot => <li key={bot.id}>
        <button type="button" className="bot-card" onClick={() => onNavigate({ kind: "bot", id: bot.id })}>
          <span className="avatar" aria-hidden="true">{[...botName(t, bot)][0] ?? "?"}</span>
          <span className="body"><strong>{botName(t, bot)}</strong>{bot.main && <span className="pill ok">{t("s16.bots.mainBadge")}</span>}{bot.state === "archived" && <span className="pill idle">{t("s16.bots.archived")}</span>}
            {bot.responsibility && <span className="snippet">{bot.responsibility}</span>}
            <span className="meta">{bot.selectionLabel ?? t(bot.main ? "s16.bots.modelInstallation" : "s16.bots.modelDefault")}</span></span>
        </button>
      </li>)}</ul>
    </>}
  </section>;
}

/** The exact editable Bot configuration; submitting creates a proposal (new Bot) or saves the profile (existing Bot). */
function BotForm({ t, data, initial, busy, submit, creating = false, main = false, onSubmit }: { t: Copy; data: ClientBotsView; initial: ClientBotDraft | null; busy: boolean; submit: string; creating?: boolean; main?: boolean; onSubmit(draft: ClientBotDraft): void }) {
  const [name, setName] = useState(initial?.name ?? ""), [responsibility, setResponsibility] = useState(initial?.responsibility ?? "");
  const [selection, setSelection] = useState(() => initial?.selection ? data.selections.findIndex(choice => same(choice.selection, initial.selection)) : -1);
  const [excluded, setExcluded] = useState<string[]>(initial?.excluded ?? []), [assignments, setAssignments] = useState(initial?.assignments ?? true), [invalid, setInvalid] = useState(false);
  return <form className="bot-form" onSubmit={event => {
    event.preventDefault();
    if (!name.trim()) { setInvalid(true); return; }
    onSubmit({ contract: "s16-bot-draft/v1", name: name.trim(), responsibility: responsibility.trim(), selection: selection >= 0 ? data.selections[selection]!.selection : null, excluded: excluded.filter(id => data.resources.some(resource => resource.id === id)).sort(), assignments });
  }}>
    <label htmlFor="bot-name">{t("s16.bots.name")}</label>
    <input id="bot-name" value={name} maxLength={60} aria-invalid={invalid && !name.trim()} aria-describedby={invalid && !name.trim() ? "bot-name-error" : undefined} onChange={event => setName(event.target.value)} />
    {invalid && !name.trim() && <p id="bot-name-error" className="field-error">{t("s16.bots.nameRequired")}</p>}
    <label htmlFor="bot-responsibility">{t("s16.bots.responsibility")}</label>
    <textarea id="bot-responsibility" rows={4} maxLength={2000} value={responsibility} aria-describedby="bot-responsibility-hint" onChange={event => setResponsibility(event.target.value)} />
    <p id="bot-responsibility-hint" className="limits">{t("s16.bots.responsibilityHint")}</p>
    <label htmlFor="bot-model">{t("s16.bots.model")}</label>
    <select id="bot-model" value={selection} onChange={event => setSelection(Number(event.target.value))}>
      <option value={-1}>{t(main ? "s16.bots.modelInstallation" : "s16.bots.modelDefault")}</option>
      {data.selections.map((choice, index) => <option key={index} value={index}>{choice.label}</option>)}
    </select>
    {(creating || data.resources.length > 0) && <fieldset><legend>{t("s16.bots.resources")}</legend><p className="limits">{t("s16.bots.resourcesHint")}</p>
      {!data.resources.length && <p>{t("s16.bots.noResources")}</p>}
      {data.resources.map(resource => <label key={resource.id} className="check"><input type="checkbox" checked={!excluded.includes(resource.id)} onChange={event => setExcluded(current => event.target.checked ? current.filter(id => id !== resource.id) : [...current, resource.id])} /> {resource.label}</label>)}
    </fieldset>}
    <label className="check"><input type="checkbox" checked={assignments} onChange={event => setAssignments(event.target.checked)} /> {t("s16.bots.assignments")}</label>
    <div className="actions"><button type="submit" className="primary" disabled={busy}>{submit}</button></div>
  </form>;
}
