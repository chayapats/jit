import { useEffect, useRef, useState } from 'react';
import type { Locale, MessageKey } from '../../i18n';
import { JitClientError, type JitClient, type SearchItem, type SearchKind, type SearchLabelCommand, type SearchPage, type SearchQuery, type SearchSource } from '../client';
import type { Copy } from './copy';

const initial = (): SearchQuery => ({ q: '', kind: 'all', bot: null, label: null, from: null, to: null, after: null });
const kindKey = (kind: SearchKind | 'all') => `s16.search.kind.${kind}` as MessageKey;
const key = (item: SearchItem) => `${item.target.kind}:${item.target.id}`;
const code = (error: unknown) => error instanceof JitClientError ? error.code : 'client_unavailable';
/** Authored owner search over current projections. Only cursor positions and editable form values are
 * retained between reads; no response, snippet, query history or label command enters browser storage. */
export function SearchView(props: { client: JitClient; t: Copy; locale: Locale; kinds: SearchKind[]; bots: { id: string; name: string }[]; onOpen(source: SearchSource): void; onClose(): void; onFailure(error: unknown): void }) {
  const { client, t, locale } = props;
  const [query, setQuery] = useState(initial), [text, setText] = useState(''), [kind, setKind] = useState<SearchQuery['kind']>('all'), [bot, setBot] = useState(''), [label, setLabel] = useState(''), [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [page, setPage] = useState<SearchPage | null>(null), [error, setError] = useState<string | null>(null), [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(false), [positions, setPositions] = useState<(string | null)[]>([]);
  const [editing, setEditing] = useState<SearchItem | null>(null), [names, setNames] = useState(''), [pending, setPending] = useState<SearchLabelCommand | null>(null), [retry, setRetry] = useState(false);
  const input = useRef<HTMLInputElement>(null), epoch = useRef(0), latest = useRef(props); latest.current = props;
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const version = ++epoch.current, stop = new AbortController(); setPage(null); setError(null);
    void client.search(query, stop.signal).then(value => { if (epoch.current === version) setPage(value); }).catch(failure => {
      if (epoch.current !== version || stop.signal.aborted || code(failure) === 'client_response_stale') return;
      setPage(null); setError(code(failure)); setEditing(null);
      if (failure instanceof JitClientError && [401, 403].includes(failure.status ?? 0)) latest.current.onFailure(failure);
    });
    return () => { epoch.current++; stop.abort(); };
  }, [client, query, refresh]);
  useEffect(() => {
    const clear = () => { epoch.current++; setPage(null); setEditing(null); setError(null); setBusy(false); };
    const visibility = () => { if (document.visibilityState === 'hidden') clear(); else setRefresh(value => value + 1); };
    const offline = () => { clear(); setError('client_unavailable'); };
    window.addEventListener('offline', offline); window.addEventListener('online', visibility); document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('offline', offline); window.removeEventListener('online', visibility); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  const replace = () => { setEditing(null); setPositions([]); setQuery({ q: text, kind, bot: bot || null, label: label || null, from: from ? Date.parse(from + 'T00:00:00Z') : null, to: to ? Date.parse(to + 'T23:59:59.999Z') : null, after: null }); };
  async function open(item: SearchItem) {
    const version = epoch.current; setBusy(true); setError(null);
    try { const current = await client.searchObject(item.target); if (version === epoch.current) latest.current.onOpen(current.source); }
    catch (failure) { if (version === epoch.current) { setPage(null); setEditing(null); setError(code(failure)); if (failure instanceof JitClientError && [401, 403].includes(failure.status ?? 0)) latest.current.onFailure(failure); } }
    finally { if (version === epoch.current) setBusy(false); }
  }
  async function save(command: SearchLabelCommand) {
    const version = epoch.current; setBusy(true); setPending(command); setRetry(false); setError(null);
    try { await client.setSearchLabels(command); if (version === epoch.current) { setPending(null); setEditing(null); setRefresh(value => value + 1); } }
    catch (failure) { if (version === epoch.current) { setPage(null); setEditing(null); setError(code(failure)); if (!(failure instanceof JitClientError) || failure.outcome !== 'unknown') setPending(null); if (failure instanceof JitClientError && [401, 403].includes(failure.status ?? 0)) latest.current.onFailure(failure); } }
    finally { if (version === epoch.current) setBusy(false); }
  }
  async function recover() {
    if (!pending) return; const version = epoch.current; setBusy(true); setError(null);
    try { await client.searchLabelReceipt(pending.requestId); if (version === epoch.current) { setPending(null); setRetry(false); setRefresh(value => value + 1); } }
    catch (failure) { if (version === epoch.current) { setError(code(failure)); if (failure instanceof JitClientError && failure.status === 404) setRetry(true); else if (failure instanceof JitClientError && failure.code === 'search_object_unavailable') { setPending(null); setRetry(false); } else if (failure instanceof JitClientError && [401, 403].includes(failure.status ?? 0)) latest.current.onFailure(failure); } }
    finally { if (version === epoch.current) setBusy(false); }
  }
  const locked = busy || !!pending;
  return <section className="search-page" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); if (editing) setEditing(null); else if (!locked) props.onClose(); } }} aria-labelledby="search-heading">
    <header className="search-heading"><div><h2 id="search-heading">{t('s16.search.title')}</h2><p>{t('s16.search.lead')}</p></div><button type="button" disabled={locked} onClick={() => { setEditing(null); setRefresh(value => value + 1); }}>{t('s16.common.refresh')}</button></header>
    <form className="search-form" role="search" onSubmit={event => { event.preventDefault(); if (!locked) replace(); }}>
      <label className="search-query" htmlFor="installation-query">{t('s16.search.query')}<input ref={input} id="installation-query" type="search" maxLength={256} value={text} disabled={locked} placeholder={t('s16.search.placeholder')} onChange={event => setText(event.target.value)} /></label>
      <div className="search-filters">
        <label>{t('s16.search.type')}<select aria-label={t('s16.search.type')} value={kind} disabled={locked} onChange={event => setKind(event.target.value as SearchQuery['kind'])}><option value="all">{t(kindKey('all'))}</option>{props.kinds.map(kind => <option key={kind} value={kind}>{t(kindKey(kind))}</option>)}</select></label>
        <label>{t('s16.search.bot')}<select aria-label={t('s16.search.bot')} value={bot} disabled={locked} onChange={event => setBot(event.target.value)}><option value="">{t('s16.search.allBots')}</option>{props.bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
        <label>{t('s16.search.label')}<select aria-label={t('s16.search.label')} value={label} disabled={locked} onChange={event => setLabel(event.target.value)}><option value="">{t('s16.search.allLabels')}</option>{label && !page?.labels.some(item => item.name === label) && <option value={label}>{label}</option>}{page?.labels.map(item => <option key={item.name} value={item.name}>{item.name} ({item.count})</option>)}</select></label>
        <label>{t('s16.search.from')}<input type="date" value={from} disabled={locked} onChange={event => setFrom(event.target.value)} /></label><label>{t('s16.search.to')}<input type="date" value={to} disabled={locked} onChange={event => setTo(event.target.value)} /></label>
        <button className="primary" type="submit" disabled={locked}>{t('s16.search.submit')}</button>
      </div>
    </form>
    {error && <div role="alert" className="notice"><p>{t(error === 'search_object_unavailable' ? 's16.search.unavailable' : error === 'search_labels_changed' ? 's16.search.changed' : 's16.common.error')}</p><details><summary>{t('s16.common.details')}</summary><code>{error}</code></details></div>}
    {pending && <div role="status" className="notice"><p>{t('s16.search.unknown')}</p><button type="button" disabled={busy} onClick={() => void recover()}>{t('s16.search.check')}</button>{retry && <button type="button" disabled={busy} onClick={() => void save(pending)}>{t('s16.search.retry')}</button>}</div>}
    {!page && !error && !pending && <p role="status">{t('s16.common.loading')}</p>}
    {page && <><p className="search-count" role="status">{t('s16.search.count', { count: page.total })}</p>{page.total === 0 && <div className="search-empty"><h3>{t('s16.search.empty')}</h3><p>{t('s16.search.emptyHint')}</p></div>}
      <ol className="search-results">{page.items.map(item => <li key={key(item)} className="search-result">
        <div className="search-result-meta"><span className="search-kind">{t(kindKey(item.target.kind))}</span>{item.botId && <span>{props.bots.find(bot => bot.id === item.botId)?.name ?? item.botId}</span>}<time dateTime={new Date(item.at).toISOString()}>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(item.at)}</time></div>
        <h3><button type="button" className="search-open" disabled={locked} onClick={() => void open(item)}>{item.title}</button></h3><p className="search-snippet">{item.snippet}</p>
        <div className="search-result-actions">{item.organization.labels.map(name => <span className="search-label" key={name}>{name}</span>)}<button type="button" className="memory-link" disabled={locked} aria-label={t('s16.search.editFor', { title: item.title })} onClick={() => { setEditing(item); setNames(item.organization.labels.join(', ')); }}>{t('s16.search.edit')}</button><button type="button" className="memory-link" disabled={locked} onClick={() => void open(item)}>{t('s16.search.open')}</button></div>
        {editing && key(editing) === key(item) && <form className="search-label-editor" onSubmit={event => { event.preventDefault(); if (!locked) void save({ contract: 's16-search-labels/v1', requestId: crypto.randomUUID().replaceAll('-', ''), target: item.target, revision: editing.organization.revision, labels: names.split(',').map(name => name.trim()).filter(Boolean) }); }}><label>{t('s16.search.edit')}<input autoFocus value={names} maxLength={400} disabled={locked} onChange={event => setNames(event.target.value)} /></label><p>{t('s16.search.labelHint')}</p><button type="submit" disabled={locked}>{t('s16.search.save')}</button><button type="button" disabled={locked} onClick={() => setEditing(null)}>{t('s16.common.cancel')}</button></form>}
      </li>)}</ol>
      <nav className="search-pagination" aria-label={t('s16.search.pages')}><button type="button" disabled={locked || !positions.length} onClick={() => { setEditing(null); setQuery(current => ({ ...current, after: positions.at(-1) ?? null })); setPositions(current => current.slice(0, -1)); }}>{t('s16.search.previous')}</button><button type="button" disabled={locked || !page.next} onClick={() => { setEditing(null); setPositions(current => [...current, query.after]); setQuery(current => ({ ...current, after: page.next })); }}>{t('s16.search.next')}</button></nav>
    </>}
    <p className="limits">{t('s16.search.authority')}</p>
  </section>;
}
