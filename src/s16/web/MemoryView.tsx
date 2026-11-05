import { useEffect, useRef, useState } from "react";
import type { Locale } from "../../i18n";
import { JitClientError, type JitClient } from "../client";
import type { ClientMemoryCommand, ClientMemoryDetail, ClientMemoryImpact, ClientMemoryItem, ClientMemoryList, ClientMemoryQuery } from "../client/contracts";
import type { Copy } from "./copy";

/** Props for the owner memory surface. Data comes only from the protected client; nothing is cached. */
export interface MemoryViewProps {
  client: JitClient; t: Copy; locale: Locale;
  /** Server capability. When false, no memory request is made and no control is shown. */
  available: boolean;
  /** Item to open first, e.g. from a conversation's "Review memory" link. */
  initialClaim?: string | null;
  /** Shared private-content withholding for authentication/authorization failures. */
  onFailure(error: unknown): void;
  onOpenConversation(conversationId: string): void;
  onSelect?(claimId: string | null): void;
}
type Load = "loading" | "ready" | "error";
type Command = { command: ClientMemoryCommand; state: "pending" | "unknown" | "error"; code?: string } | { command: ClientMemoryCommand; state: "done" };
const uid = () => crypto.randomUUID().replaceAll("-", "");
const code = (error: unknown) => error instanceof JitClientError ? error.code : "client_unavailable";
const privateFailure = (error: unknown) => error instanceof JitClientError && ([401, 403].includes(error.status ?? 0) || ["authentication_required", "authorization_required", "csrf_rejected"].includes(error.code));
const initialQuery = (): ClientMemoryQuery => ({ q: "", kind: "all", category: "all", state: "active", bot: null, offset: 0 });

/**
 * Owner memory: search and filter retained items, inspect exact sources, correct by superseding and
 * forget after an impact preview. Commands are explicit, exact-revision and never retried silently;
 * an unknown outcome is rechecked with the same retained command identity.
 */
export function MemoryView({ client, t, locale, available, initialClaim = null, onFailure, onOpenConversation, onSelect }: MemoryViewProps) {
  const [query, setQuery] = useState(initialQuery), [text, setText] = useState("");
  const [list, setList] = useState<ClientMemoryList | null>(null), [listState, setListState] = useState<Load>("loading"), [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initialClaim), [detail, setDetail] = useState<ClientMemoryDetail | null>(null), [detailState, setDetailState] = useState<Load>("loading");
  const [editing, setEditing] = useState<string | null>(null), [forgetting, setForgetting] = useState<{ claim: { id: string; revision: number }; state: Load; impact: ClientMemoryImpact | null } | null>(null);
  const [command, setCommand] = useState<Command | null>(null), [reload, setReload] = useState(0);
  const current = useRef<string | null>(initialClaim), inspector = useRef<HTMLElement>(null), returnFocus = useRef<HTMLElement | null>(null), heading = useRef<HTMLHeadingElement>(null), notice = useRef<HTMLDivElement>(null);
  const date = (value: number) => new Intl.DateTimeFormat(locale === "th" ? "th-TH" : "en-GB", { dateStyle: "medium", timeStyle: "short" }).format(value);
  const fail = (error: unknown) => { if (code(error) === "client_response_stale") return true; if (privateFailure(error)) { onFailure(error); return true; } return false; };

  useEffect(() => { const timer = setTimeout(() => setQuery(current => current.q === text.trim() ? current : { ...current, q: text.trim(), offset: 0 }), 250); return () => clearTimeout(timer); }, [text]);
  useEffect(() => {
    if (!available) return;
    const stop = new AbortController(); setListState("loading");
    client.memory(query, stop.signal).then(data => { if (!stop.signal.aborted) { setList(data); setListState("ready"); setListError(null); } })
      .catch(error => { if (stop.signal.aborted || fail(error)) return; setListState("error"); setListError(code(error)); });
    return () => stop.abort();
  }, [available, query, reload]);
  useEffect(() => {
    current.current = selected; onSelect?.(selected); setEditing(null); setForgetting(null);
    if (!selected || !available) { setDetail(null); return; }
    const stop = new AbortController(); setDetailState("loading"); setDetail(null);
    client.memoryDetail(selected, stop.signal).then(data => { if (!stop.signal.aborted) { setDetail(data); setDetailState("ready"); } })
      .catch(error => { if (!stop.signal.aborted && !fail(error)) setDetailState("error"); });
    requestAnimationFrame(() => heading.current?.focus());
    return () => stop.abort();
  }, [selected, available, reload]);
  useEffect(() => {
    if (!selected) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key !== "Tab" || !matchMedia("(max-width: 900px)").matches) return;
      const controls = [...(inspector.current?.querySelectorAll<HTMLElement>("button:not(:disabled),a[href],textarea,[tabindex='-1']") ?? [])].filter(element => element.tabIndex >= 0 || element === heading.current), first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key);
  }, [selected]);

  /** Clears only settled notices. A pending or unknown command keeps its identity and "Check again" until resolved. */
  function settle() { setCommand(value => value?.state === "pending" || value?.state === "unknown" ? value : null); }
  function open(item: ClientMemoryItem, origin: HTMLElement) { returnFocus.current = origin; settle(); setSelected(item.id); }
  function close() { const id = selected; setSelected(null); settle(); requestAnimationFrame(() => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); else if (id) document.querySelector<HTMLElement>(`[data-memory-id="${id}"]`)?.focus(); }); }
  async function run(next: ClientMemoryCommand) {
    setCommand({ command: next, state: "pending" });
    try {
      const result = await client.memoryCommand(next);
      setCommand({ command: next, state: "done" }); setEditing(null); setForgetting(null);
      if (result.contract === "s15-memory-receipt/v1" && result.kind === "memory.correct" && result.claim) setSelected(result.claim.id);
      setReload(value => value + 1);
    } catch (error) {
      if (fail(error)) { setCommand(null); return; }
      const outcome = error instanceof JitClientError ? error.outcome : "unknown";
      setCommand({ command: next, state: outcome === "response" || outcome === "not_sent" ? "error" : "unknown", code: code(error) });
    }
    requestAnimationFrame(() => notice.current?.focus());
  }
  /** The preview is bound to one exact claim revision; a late response for another selection is dropped. */
  async function previewForget(item: ClientMemoryItem) {
    const claim = { id: item.id, revision: item.revision }, still = () => current.current === claim.id;
    setEditing(null); setForgetting({ claim, state: "loading", impact: null });
    const command: ClientMemoryCommand = { contract: "s15-memory-command/v1", requestId: uid(), kind: "memory.impact", claim };
    try { const result = await client.memoryCommand(command); if (still()) setForgetting(value => value?.claim.id === claim.id && value.claim.revision === claim.revision ? result.contract === "s15-memory-impact/v1" && result.claim.id === claim.id && result.claim.revision === claim.revision ? { claim, state: "ready", impact: result.impact } : { claim, state: "error", impact: null } : value); }
    catch (error) { if (fail(error) || !still()) return; setForgetting(value => value?.claim.id === claim.id ? { claim, state: "error", impact: null } : value); setCommand(value => value?.state === "pending" || value?.state === "unknown" ? value : { command, state: "error", code: code(error) }); }
  }

  const kindLabel = (item: ClientMemoryItem) => `${t(item.kind === "fact" ? "s16.memory.kindFact" : "s16.memory.kindInference")} · ${t(item.confirmation === "owner_stated" ? "s16.memory.confirmationOwner" : item.confirmation === "observed" ? "s16.memory.confirmationObserved" : "s16.memory.confirmationUnconfirmed")}`;
  const categoryLabel = (item: ClientMemoryItem) => t(item.category === "preference" ? "s16.memory.categoryPreference" : item.category === "working_knowledge" ? "s16.memory.categoryKnowledge" : "s16.memory.categoryFact");
  const scopeLabel = (item: ClientMemoryItem) => item.scope.kind === "team" ? t("s16.memory.scopeTeam") : t("s16.memory.scopeBot", { bot: item.scope.botId });
  const sourceLabel = (item: ClientMemoryItem) => t(item.source.kind === "owner_message" ? "s16.memory.sourceOwner" : item.source.kind === "work" ? "s16.memory.sourceWork" : "s16.memory.sourceHistorical", { date: date(item.source.at) });
  const stateBadge = (item: ClientMemoryItem) => item.state === "active" ? null : <span className={`memory-badge memory-state-${item.state}`}>{t(item.state === "superseded" ? "s16.memory.stateSuperseded" : item.state === "forgotten" ? "s16.memory.stateForgotten" : "s16.memory.stateWithdrawn")}</span>;
  const labels = (item: ClientMemoryItem) => <p className="memory-labels"><span className={`memory-badge memory-kind-${item.kind}`}>{kindLabel(item)}</span><span>{categoryLabel(item)}</span><span>{scopeLabel(item)}</span>{stateBadge(item)}</p>;
  const pending = command?.state === "pending" || command?.state === "unknown";
  const lastUse = (entry: ClientMemoryItem) => entry.lastUsedAt !== null ? t("s16.memory.lastUsed", { date: date(entry.lastUsedAt) }) : t(entry.contexts > 0 ? "s16.memory.lastUseUnknown" : "s16.memory.neverUsed");
  const commandNotice = command && <div ref={notice} tabIndex={-1} className={`notice memory-notice ${command.state === "done" ? "memory-ok" : ""}`} role={command.state === "done" ? "status" : "alert"}>
    {command.state === "pending" && <p>{t("s16.memory.saving")}</p>}
    {command.state === "done" && <p>{t(command.command.kind === "memory.correct" ? "s16.memory.corrected" : "s16.memory.forgotten")}</p>}
    {command.state === "unknown" && <><p>{t("s16.memory.unknown")}</p><button type="button" onClick={() => void run(command.command)}>{t("s16.memory.checkAgain")}</button></>}
    {command.state === "error" && <><p>{t(command.code === "stale_revision" ? "s16.memory.stale" : "s16.memory.failed")}</p>{command.code === "stale_revision" && <button type="button" onClick={() => { setCommand(null); setReload(value => value + 1); }}>{t("s16.memory.reopen")}</button>}<details><summary>{t("s16.common.details")}</summary><code>{command.code}</code></details></>}
  </div>;

  if (!available) return <section className="memory" aria-labelledby="memory-title"><h2 id="memory-title">{t("s16.memory.title")}</h2><p className="memory-empty">{t("s16.memory.unavailable")}</p></section>;
  const from = list && list.total ? list.query.offset + 1 : 0, to = list ? list.query.offset + list.items.length : 0;
  const item = detail?.item;
  return <section className={`memory ${selected ? "memory-has-detail" : ""}`} aria-labelledby="memory-title">
    <header className="memory-header"><h2 id="memory-title">{t("s16.memory.title")}</h2><p>{t("s16.memory.lead")}</p></header>
    <form className="memory-search" role="search" onSubmit={event => { event.preventDefault(); setQuery(current => ({ ...current, q: text.trim(), offset: 0 })); }}>
      <label htmlFor="memory-q">{t("s16.memory.search")}</label>
      <input id="memory-q" type="search" maxLength={256} value={text} placeholder={t("s16.memory.searchPlaceholder")} onChange={event => setText(event.target.value)} />
      <fieldset className="memory-filters"><legend className="visually-hidden">{t("s16.memory.filters")}</legend>
        <label>{t("s16.memory.filterState")}<select value={query.state} onChange={event => setQuery(current => ({ ...current, state: event.target.value as ClientMemoryQuery["state"], offset: 0 }))}><option value="active">{t("s16.memory.stateActive")}</option><option value="inactive">{t("s16.memory.stateInactive")}</option><option value="all">{t("s16.memory.stateAll")}</option></select></label>
        <label>{t("s16.memory.filterKind")}<select value={query.kind} onChange={event => setQuery(current => ({ ...current, kind: event.target.value as ClientMemoryQuery["kind"], offset: 0 }))}><option value="all">{t("s16.memory.anyKind")}</option><option value="fact">{t("s16.memory.kindFact")}</option><option value="inference">{t("s16.memory.kindInference")}</option></select></label>
        <label>{t("s16.memory.filterCategory")}<select value={query.category} onChange={event => setQuery(current => ({ ...current, category: event.target.value as ClientMemoryQuery["category"], offset: 0 }))}><option value="all">{t("s16.memory.anyCategory")}</option><option value="preference">{t("s16.memory.categoryPreference")}</option><option value="fact">{t("s16.memory.categoryFact")}</option><option value="working_knowledge">{t("s16.memory.categoryKnowledge")}</option></select></label>
        <label>{t("s16.memory.filterBot")}<select value={query.bot ?? ""} onChange={event => setQuery(current => ({ ...current, bot: event.target.value || null, offset: 0 }))}><option value="">{t("s16.memory.anyBot")}</option>{(list?.bots ?? (query.bot ? [query.bot] : [])).map(bot => <option key={bot} value={bot}>{t("s16.memory.botOption", { bot })}</option>)}</select></label>
      </fieldset>
    </form>
    {!selected && commandNotice}
    <div className="memory-results" aria-busy={listState === "loading"}>
      {listState === "loading" && !list && <p role="status">{t("s16.common.loading")}</p>}
      {listState === "error" && <div className="notice" role="alert"><p>{t("s16.common.error")}</p><button type="button" onClick={() => setReload(value => value + 1)}>{t("s16.common.refresh")}</button><details><summary>{t("s16.common.details")}</summary><code>{listError}</code></details></div>}
      {list && listState !== "error" && (list.total === 0 ? <p className="memory-empty">{t(query.q || query.kind !== "all" || query.category !== "all" || query.state !== "active" || query.bot ? "s16.memory.noResults" : "s16.memory.empty")}</p> : <>
        <p className="memory-count" role="status">{t("s16.memory.count", { from, to, total: list.total })}</p>
        <ul className="memory-list">{list.items.map(entry => <li key={entry.id}><button type="button" className="memory-row" data-memory-id={entry.id} aria-current={entry.id === selected ? "true" : undefined} aria-label={entry.snippet ? t("s16.memory.open", { text: entry.snippet }) : t("s16.memory.openErased")} onClick={event => open(entry, event.currentTarget)}>
          {entry.snippet ? <span className="memory-snippet">{entry.snippet}</span> : <span className="memory-snippet memory-erased">{t("s16.memory.erased")}</span>}
          {labels(entry)}
          <small>{sourceLabel(entry)} · {lastUse(entry)}</small>
        </button></li>)}</ul>
        {list.total > list.limit && <nav className="memory-pages" aria-label={t("s16.memory.count", { from, to, total: list.total })}><button type="button" disabled={list.query.offset === 0} onClick={() => setQuery(current => ({ ...current, offset: Math.max(0, current.offset - list.limit) }))}>{t("s16.memory.previous")}</button><button type="button" disabled={to >= list.total} onClick={() => setQuery(current => ({ ...current, offset: current.offset + list.limit }))}>{t("s16.memory.next")}</button></nav>}
      </>)}
    </div>
    {selected && <aside ref={inspector} className="inspector memory-detail" role="dialog" aria-modal={matchMedia("(max-width: 900px)").matches} aria-labelledby="memory-detail-title">
      <header><h2 id="memory-detail-title" ref={heading} tabIndex={-1}>{t("s16.memory.detail")}</h2><button type="button" aria-label={t("s16.common.close")} onClick={close}>×</button></header>
      {commandNotice}
      {detailState === "loading" && <p role="status">{t("s16.common.loading")}</p>}
      {detailState === "error" && <div className="notice" role="alert"><p>{t("s16.common.error")}</p><button type="button" onClick={() => setReload(value => value + 1)}>{t("s16.common.refresh")}</button></div>}
      {item && detail && <>
        {labels(item)}
        <h3>{t("s16.memory.text")}</h3>
        {item.text ? <blockquote className="memory-text">{item.text}</blockquote> : <p className="memory-erased">{t("s16.memory.erased")}</p>}
        {item.kind === "inference" && <p className="limits">{t("s16.memory.inferenceNote")}</p>}
        {item.quote && item.quote !== item.text && <><h3>{t("s16.memory.quote")}</h3><blockquote className="memory-quote">{item.quote}</blockquote></>}
        <h3>{t("s16.memory.about")}</h3>
        <ul className="memory-facts"><li>{sourceLabel(item)}{item.source.conversationId && <> · <button type="button" className="memory-link" onClick={() => onOpenConversation(item.source.conversationId!)}>{t("s16.memory.sourceConversation")}</button></>}</li><li>{t("s16.memory.created", { date: date(item.createdAt) })}</li><li>{lastUse(item)}</li><li>{t("s16.memory.uses", { contexts: detail.uses.contexts, summaries: detail.uses.summaries, artifacts: detail.uses.artifacts, work: detail.uses.workItems })}</li></ul>
        {!!detail.files.length && <details className="memory-files"><summary>{t("s16.memory.fileSources")}</summary>{detail.files.map(file => <div key={file.sourceId + file.sha256}><p><span className="memory-badge">{t(file.current ? "s16.memory.fileCurrent" : "s16.memory.fileWithdrawn")}</span></p><p>{t("s16.memory.fileOriginal")}</p><code>{file.sha256}</code>{file.representationSha256 && <><p>{t("s16.memory.fileDerived")}</p><code>{file.representationSha256}</code></>}</div>)}</details>}
        {!!detail.chain.length && <><h3>{t("s16.memory.chain")}</h3><ol className="memory-chain">{detail.chain.map(entry => <li key={entry.id}><button type="button" className="memory-link" onClick={() => { settle(); setSelected(entry.id); }}>{entry.snippet || t("s16.memory.openErased")}</button> {stateBadge(entry)}</li>)}</ol></>}
        {item.state === "active" && !editing && !forgetting && <div className="memory-actions"><button type="button" disabled={pending} onClick={() => { settle(); setEditing(item.text); }}>{t("s16.memory.correct")}</button><button type="button" className="memory-danger" disabled={pending} onClick={() => { settle(); void previewForget(item); }}>{t("s16.memory.forget")}</button></div>}
        {editing !== null && <form className="memory-edit" onSubmit={event => { event.preventDefault(); if (editing.trim()) void run({ contract: "s15-memory-command/v1", requestId: uid(), kind: "memory.correct", claim: { id: item.id, revision: item.revision }, text: editing.trim() }); }}>
          <label htmlFor="memory-correction">{t("s16.memory.correctLabel")}</label>
          <textarea id="memory-correction" maxLength={2048} value={editing} aria-describedby="memory-correction-help" onChange={event => setEditing(event.target.value)} autoFocus />
          <p id="memory-correction-help" className="limits">{t("s16.memory.correctHelp")} <span aria-live="polite">{t("s16.memory.correctCount", { count: editing.length })}</span></p>
          <div className="memory-actions"><button type="submit" className="primary" disabled={pending || !editing.trim() || editing.trim() === item.text}>{t(command?.state === "pending" ? "s16.memory.saving" : "s16.memory.saveCorrection")}</button><button type="button" disabled={command?.state === "pending"} onClick={() => setEditing(null)}>{t("s16.memory.cancel")}</button></div>
        </form>}
        {forgetting && forgetting.claim.id === item.id && <div className="memory-forget" role="group" aria-labelledby="memory-forget-title"><h3 id="memory-forget-title">{t("s16.memory.forgetTitle")}</h3>
          {forgetting.state === "loading" && <p role="status">{t("s16.memory.forgetLoading")}</p>}
          {forgetting.impact && <p>{t("s16.memory.forgetImpact", { claims: forgetting.impact.claims, sources: forgetting.impact.sources, contexts: forgetting.impact.contexts, summaries: forgetting.impact.summaries, artifacts: forgetting.impact.artifacts, native: forgetting.impact.nativeSessions, work: forgetting.impact.workItems })}</p>}
          <p className="limits">{t("s16.memory.forgetLimits")}</p>
          <div className="memory-actions"><button type="button" className="memory-danger" disabled={pending || forgetting.state !== "ready"} onClick={() => { if (forgetting.claim.id === item.id && forgetting.claim.revision === item.revision) void run({ contract: "s15-memory-command/v1", requestId: uid(), kind: "memory.forget", claim: forgetting.claim }); }}>{t(command?.state === "pending" ? "s16.memory.saving" : "s16.memory.forgetConfirm")}</button><button type="button" disabled={command?.state === "pending"} onClick={() => setForgetting(null)}>{t("s16.memory.cancel")}</button></div>
        </div>}
      </>}
    </aside>}
  </section>;
}
