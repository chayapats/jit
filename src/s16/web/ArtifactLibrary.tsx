import { useEffect, useRef, useState } from "react";
import type { Locale } from "../../i18n";
import { JitClientError, type JitClient } from "../client";
import type { ClientArtifactDetail, ClientArtifactItem, ClientArtifactQuery } from "../client/contracts";
import { downloadArtifact } from "./ArtifactFileCard";
import { ArtifactPreview } from "./ArtifactPreview";
import type { Copy } from "./copy";

/** Props for the owner artifact library. Every list/detail read is fresh; nothing private is cached. */
export interface ArtifactLibraryProps {
  client: JitClient; t: Copy; locale: Locale;
  /** Server offers revision inputs. Without it, Revise is not shown. */
  revisions: boolean;
  /** Server offers the sandboxed HTML viewer. */
  html: boolean;
  initialArtifact?: string | null;
  /** Shared private-content withholding for authentication/authorization failures. */
  onFailure(error: unknown): void;
  onOpenConversation(conversationId: string): void;
  /** Adopt the exact artifact as an input of its conversation and open the composer there. */
  onRevise(item: ClientArtifactItem): Promise<void>;
  onSelect?(artifactId: string | null): void;
}
type Load = "loading" | "ready" | "error";
const code = (error: unknown) => error instanceof JitClientError ? error.code : "client_unavailable";
const privateFailure = (error: unknown) => error instanceof JitClientError && ([401, 403].includes(error.status ?? 0) || ["authentication_required", "authorization_required", "csrf_rejected"].includes(error.code));
const initialQuery = (): ClientArtifactQuery => ({ q: "", type: "all", conversation: null, before: null });

/**
 * Durable artifact library across conversations: search/filter, exact provenance, revision history, a
 * current preview, verified download and an explicit "Revise this file" that starts no work by itself.
 * Withdrawn or no-longer-published artifacts disappear on the next read; a cursor never restores them.
 */
export function ArtifactLibrary({ client, t, locale, revisions, html, initialArtifact = null, onFailure, onOpenConversation, onRevise, onSelect }: ArtifactLibraryProps) {
  const [query, setQuery] = useState(initialQuery), [text, setText] = useState("");
  const [items, setItems] = useState<ClientArtifactItem[] | null>(null), [next, setNext] = useState<string | null>(null), [listState, setListState] = useState<Load>("loading"), [listError, setListError] = useState<string | null>(null), [more, setMore] = useState(false);
  const [selected, setSelected] = useState<string | null>(initialArtifact), [detail, setDetail] = useState<ClientArtifactDetail | null>(null), [detailState, setDetailState] = useState<Load | "gone">("loading");
  const [reload, setReload] = useState(0), [action, setAction] = useState<{ state: "pending" | "error"; code?: string } | null>(null);
  const inspector = useRef<HTMLElement>(null), heading = useRef<HTMLHeadingElement>(null), returnFocus = useRef<HTMLElement | null>(null), listTurn = useRef(0);
  const date = (value: number) => new Intl.DateTimeFormat(locale === "th" ? "th-TH" : "en-GB", { dateStyle: "medium", timeStyle: "short" }).format(value);
  const fail = (error: unknown) => { if (code(error) === "client_response_stale") return true; if (privateFailure(error)) { onFailure(error); return true; } return false; };

  useEffect(() => { const timer = setTimeout(() => setQuery(current => current.q === text.trim() ? current : { ...current, q: text.trim() }), 250); return () => clearTimeout(timer); }, [text]);
  useEffect(() => {
    const stop = new AbortController(), turn = ++listTurn.current; setListState("loading");
    client.artifacts(query, stop.signal).then(page => { if (!stop.signal.aborted && turn === listTurn.current) { setItems(page.items); setNext(page.next); setListState("ready"); setListError(null); } })
      .catch(error => { if (stop.signal.aborted || fail(error)) return; setListState("error"); setListError(code(error)); });
    return () => stop.abort();
  }, [query, reload]);
  useEffect(() => {
    onSelect?.(selected); setAction(null);
    if (!selected) { setDetail(null); return; }
    const stop = new AbortController(); setDetailState("loading"); setDetail(null);
    client.artifact(selected, stop.signal).then(data => { if (!stop.signal.aborted) { setDetail(data); setDetailState("ready"); } })
      .catch(error => { if (stop.signal.aborted || fail(error)) return; setDetailState(code(error) === "artifact_unavailable" ? "gone" : "error"); });
    requestAnimationFrame(() => heading.current?.focus());
    return () => stop.abort();
  }, [selected, reload]);
  useEffect(() => {
    if (!selected) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key !== "Tab" || !matchMedia("(max-width: 900px)").matches) return;
      const controls = [...(inspector.current?.querySelectorAll<HTMLElement>("button:not(:disabled),a[href],iframe,[tabindex='-1']") ?? [])], first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key);
  }, [selected]);

  /** Appends the next page from the last returned position; the server refilters under current access. */
  async function loadMore() {
    if (!next || more) return; setMore(true); const turn = listTurn.current;
    try { const page = await client.artifacts({ ...query, before: next }); if (turn !== listTurn.current) return; setItems(current => [...(current ?? []), ...page.items.filter(item => !current?.some(existing => existing.artifact.id === item.artifact.id))]); setNext(page.next); }
    catch (error) { if (!fail(error)) { setListState("error"); setListError(code(error)); } } finally { setMore(false); }
  }
  function open(id: string, origin: HTMLElement | null) { if (origin) returnFocus.current = origin; setSelected(id); }
  function close() { const id = selected; setSelected(null); requestAnimationFrame(() => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); else if (id) document.querySelector<HTMLElement>(`[data-artifact-id="${id}"]`)?.focus(); }); }
  /** A preview/download failure for a withdrawn file closes only this inspector and refreshes the list. */
  function previewFailure(error: unknown) { if (fail(error)) return; setSelected(null); setDetailState("gone"); setReload(value => value + 1); }
  async function revise(item: ClientArtifactItem) {
    setAction({ state: "pending" });
    try { await onRevise(item); } catch (error) { if (fail(error)) return; setAction({ state: "error", code: code(error) }); }
  }
  const typeLabel = (mime: string) => t(mime === "text/markdown" ? "s16.artifact.typeMarkdown" : mime === "text/csv" ? "s16.artifact.typeCsv" : mime === "text/html" ? "s16.artifact.typeHtml" : "s16.artifact.typeText");
  const meta = (item: ClientArtifactItem) => `${typeLabel(item.artifact.mime)} · ${item.artifact.bytes.toLocaleString()} bytes · ${t("s16.artifact.revision", { n: item.revision })} · ${date(item.artifact.createdAt)}`;
  const filtered = !!(query.q || query.type !== "all");
  const item = detail?.item;
  return <section className={`memory library ${selected ? "memory-has-detail" : ""}`} aria-labelledby="library-title">
    <header className="memory-header"><h2 id="library-title">{t("s16.artifact.library")}</h2><p>{t("s16.artifact.libraryLead")}</p></header>
    <form className="memory-search" role="search" onSubmit={event => { event.preventDefault(); setQuery(current => ({ ...current, q: text.trim() })); }}>
      <label htmlFor="library-q">{t("s16.artifact.search")}</label>
      <input id="library-q" type="search" maxLength={128} value={text} placeholder={t("s16.artifact.searchPlaceholder")} onChange={event => setText(event.target.value)} />
      <fieldset className="memory-filters"><legend className="visually-hidden">{t("s16.artifact.filters")}</legend>
        <label>{t("s16.artifact.filterType")}<select value={query.type} onChange={event => setQuery(current => ({ ...current, type: event.target.value as ClientArtifactQuery["type"] }))}><option value="all">{t("s16.artifact.anyType")}</option><option value="markdown">{t("s16.artifact.typeMarkdown")}</option><option value="text">{t("s16.artifact.typeText")}</option><option value="csv">{t("s16.artifact.typeCsv")}</option><option value="html">{t("s16.artifact.typeHtml")}</option></select></label>
      </fieldset>
    </form>
    <div className="memory-results" aria-busy={listState === "loading"}>
      {listState === "loading" && !items && <p role="status">{t("s16.common.loading")}</p>}
      {listState === "error" && <div className="notice" role="alert"><p>{t("s16.common.error")}</p><button type="button" onClick={() => setReload(value => value + 1)}>{t("s16.common.refresh")}</button><details><summary>{t("s16.common.details")}</summary><code>{listError}</code></details></div>}
      {items && listState !== "error" && (!items.length ? <p className="memory-empty">{t(filtered ? "s16.artifact.noResults" : "s16.artifact.libraryEmpty")}</p> : <>
        <p className="memory-count" role="status">{t("s16.artifact.count", { count: items.length })}</p>
        <ul className="memory-list">{items.map(entry => <li key={entry.artifact.id}><button type="button" className="memory-row" data-artifact-id={entry.artifact.id} aria-current={entry.artifact.id === selected ? "true" : undefined} aria-label={t("s16.artifact.open", { name: entry.artifact.name })} onClick={event => open(entry.artifact.id, event.currentTarget)}>
          <span className="memory-snippet"><span className="file-icon" aria-hidden="true">≡</span> {entry.artifact.name}</span>
          <small className="memory-labels"><span className="memory-badge">{typeLabel(entry.artifact.mime)}</span><span>{t("s16.artifact.revision", { n: entry.revision })}</span><span>{date(entry.artifact.createdAt)}</span></small>
          <small>{t("s16.artifact.fromConversation", { label: entry.label || t("s16.chat.receivedFiles") })}</small>
        </button></li>)}</ul>
        {next && <nav className="memory-pages"><button type="button" disabled={more} onClick={() => void loadMore()}>{t(more ? "s16.common.loading" : "s16.artifact.loadMore")}</button></nav>}
      </>)}
    </div>
    {selected && <aside ref={inspector} className="inspector memory-detail" role="dialog" aria-modal={matchMedia("(max-width: 900px)").matches} aria-labelledby="library-detail-title">
      <header><h2 id="library-detail-title" ref={heading} tabIndex={-1}>{item?.artifact.name ?? t("s16.artifact.detail")}</h2><button type="button" aria-label={t("s16.common.close")} onClick={close}>×</button></header>
      {detailState === "loading" && <p role="status">{t("s16.common.loading")}</p>}
      {detailState === "gone" && <div className="notice" role="alert"><p>{t("s16.artifact.gone")}</p></div>}
      {detailState === "error" && <div className="notice" role="alert"><p>{t("s16.common.error")}</p><button type="button" onClick={() => setReload(value => value + 1)}>{t("s16.common.refresh")}</button></div>}
      {item && detail && <>
        <p className="memory-labels">{meta(item)}</p>
        <ArtifactPreview key={item.artifact.id} artifact={item.artifact} client={client} t={t} html={html && detail.preview === "sandboxed_html"} onFailure={previewFailure} />
        <div className="memory-actions">
          <button type="button" onClick={() => void downloadArtifact(client, item.artifact).catch(previewFailure)} aria-label={t("s16.artifact.download", { name: item.artifact.name })}>↓ {t("s16.artifact.downloadShort")}</button>
          {revisions && <button type="button" className="primary" disabled={action?.state === "pending"} onClick={() => void revise(item)}>{t(action?.state === "pending" ? "s16.artifact.revising" : "s16.artifact.revise")}</button>}
          <button type="button" className="memory-link" onClick={() => onOpenConversation(item.conversationId)}>{t("s16.artifact.openConversation")}</button>
        </div>
        {revisions && <p className="limits">{t("s16.artifact.reviseHelp")}</p>}
        {action?.state === "error" && <div className="notice" role="alert"><p>{t(action.code === "lineage_withdrawn" || action.code === "artifact_unavailable" ? "s16.artifact.gone" : "s16.artifact.reviseFailed")}</p><details><summary>{t("s16.common.details")}</summary><code>{action.code}</code></details></div>}
        <h3>{t("s16.artifact.sources")}</h3>
        <ul className="memory-facts">{detail.inputs.map(input => <li key={input.id}>{input.name} · {input.bytes.toLocaleString()} bytes{input.origin && <> · <button type="button" className="memory-link" onClick={() => open(input.origin!, null)}>{t("s16.artifact.revisionOf")}</button></>}<details className="source-details"><summary>{t("s16.common.details")}</summary><code>{input.sha256}</code></details></li>)}</ul>
        <h3>{t("s16.artifact.history")}</h3>
        <ol className="memory-chain">{detail.revisions.map(entry => <li key={entry.artifact.id}>{entry.artifact.id === item.artifact.id ? <strong aria-current="true">{t("s16.artifact.revision", { n: entry.revision })} · {entry.artifact.name} · {t("s16.artifact.viewing")}</strong> : <button type="button" className="memory-link" onClick={() => open(entry.artifact.id, null)}>{t("s16.artifact.revision", { n: entry.revision })} · {entry.artifact.name} · {date(entry.artifact.createdAt)}</button>}</li>)}</ol>
        <details className="memory-files"><summary>{t("s16.common.details")}</summary><p>{t("s16.artifact.immutable")}</p><code>{item.artifact.sha256}</code></details>
      </>}
    </aside>}
  </section>;
}
