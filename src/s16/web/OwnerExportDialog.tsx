import { useEffect, useRef, useState } from 'react';
import { JitClient, JitClientError } from '../client';
import type { ClientBootstrap, ClientCapabilities } from '../client/contracts';
import type { OwnerExportSection } from '../export/contracts';
import type { Copy } from './copy';

/** Explicit fresh download over the existing owner transport; response bytes never enter UI state/storage. */
export function OwnerExportDialog({ client, capability, conversations, t, onClose, onFailure }: {
  client: JitClient; capability: NonNullable<ClientCapabilities['dataExport']>; conversations: ClientBootstrap['conversations']; t: Copy;
  onClose(): void; onFailure(error: unknown): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), alive = useRef(true), epoch = useRef(0), pending = useRef<AbortController | null>(null), objectUrl = useRef<string | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sections, setSections] = useState<OwnerExportSection[]>(capability.sections), [conversationId, setConversationId] = useState(''), [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [busy, setBusy] = useState(false), [status, setStatus] = useState<'idle' | 'empty' | 'ready'>('idle'), [error, setError] = useState<'selection' | 'dates' | 'capacity' | 'changed' | 'failed' | 'secure' | 'restricted' | null>(null);
  const labels: Record<OwnerExportSection, Parameters<Copy>[0]> = { history: 's16.export.history', memory: 's16.export.memory', work: 's16.export.work', routine: 's16.export.routine', artifact: 's16.export.artifact', file: 's16.export.file', bot: 's16.export.bot', connection: 's16.export.connection', skill: 's16.export.skill' };
  const errors: Record<NonNullable<typeof error>, Parameters<Copy>[0]> = { selection: 's16.export.selection', dates: 's16.export.dates', capacity: 's16.export.capacity', changed: 's16.export.changed', failed: 's16.export.failed', secure: 's16.export.secure', restricted: 's16.export.restricted' };
  const releaseUrl = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; };
  useEffect(() => {
    alive.current = true; dialog.current?.showModal(); heading.current?.focus();
    return () => { alive.current = false; epoch.current++; pending.current?.abort(); releaseUrl(); dialog.current?.close(); };
  }, []);
  async function download(event: React.FormEvent) {
    event.preventDefault(); if (busy || pending.current) return; setError(null); setStatus('idle');
    if (!sections.length) { setError('selection'); dialog.current?.querySelector<HTMLInputElement>('input[type=checkbox]')?.focus(); return; }
    const start = from ? new Date(from + 'T00:00:00').getTime() : null, endDate = to ? new Date(to + 'T00:00:00') : null;
    if (endDate) endDate.setDate(endDate.getDate() + 1); const end = endDate ? endDate.getTime() - 1 : null;
    if (start !== null && (!Number.isSafeInteger(start) || start < 0) || end !== null && (!Number.isSafeInteger(end) || end < 0) || start !== null && end !== null && start > end) { setError('dates'); return; }
    const turn = ++epoch.current, stop = new AbortController(); pending.current = stop; setBusy(true); releaseUrl();
    try {
      const output = await client.exportData({ contract: 's16-owner-export-request/v1', sections, conversationId: conversationId || null, from: start, to: end }, stop.signal);
      if (!alive.current || turn !== epoch.current || stop.signal.aborted) return;
      if (!output.value.records.length) { setStatus('empty'); return; }
      const url = URL.createObjectURL(new Blob([new Uint8Array(output.bytes).buffer], { type: 'application/json' })); objectUrl.current = url;
      const link = document.createElement('a'); link.href = url; link.download = 'jit-export.json'; document.body.append(link); link.click(); link.remove(); timer.current = setTimeout(releaseUrl, 1000); setStatus('ready');
    } catch (failure) {
      if (!alive.current || turn !== epoch.current || stop.signal.aborted) return;
      if (failure instanceof JitClientError && [401, 403].includes(failure.status ?? 0)) { onFailure(failure); return; }
      const code = failure instanceof JitClientError ? failure.code : '';
      setError(code === 'owner_export_capacity' ? 'capacity' : code === 'owner_export_source_changed' ? 'changed' : code === 'client_crypto_unavailable' ? 'secure' : code === 'owner_export_credential_refused' ? 'restricted' : 'failed');
    } finally { if (alive.current && turn === epoch.current) { setBusy(false); pending.current = null; } }
  }
  return <dialog className="export-dialog" ref={dialog} aria-labelledby="export-title" aria-describedby="export-lead" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2 id="export-title" ref={heading} tabIndex={-1}>{t('s16.export.title')}</h2><button type="button" aria-label={t('s16.common.close')} onClick={onClose}>×</button></header>
    <p id="export-lead">{t('s16.export.lead')}</p><p className="muted">{t('s16.export.filesNote')}</p>
    <form onSubmit={event => void download(event)}>
      <fieldset disabled={busy}><legend>{t('s16.export.include')}</legend><div className="export-sections">{capability.sections.map(section => <label key={section}><input type="checkbox" checked={sections.includes(section)} onChange={event => { setStatus('idle'); setSections(current => event.target.checked ? [...current, section] : current.filter(value => value !== section)); }} />{t(labels[section])}</label>)}</div></fieldset>
      <fieldset disabled={busy} className="export-filters"><legend>{t('s16.export.scope')}</legend><label>{t('s16.export.conversation')}<select value={conversationId} onChange={event => { setStatus('idle'); setConversationId(event.target.value); }}><option value="">{t('s16.export.allConversations')}</option>{conversations.map(conversation => <option key={conversation.conversationId} value={conversation.conversationId}>{conversation.firstMessage.slice(0, 100) || conversation.conversationId}</option>)}</select></label>
        <div className="export-dates"><label>{t('s16.export.from')}<input type="date" min="1970-01-01" value={from} aria-invalid={error === 'dates'} onChange={event => { setStatus('idle'); setFrom(event.target.value); }} /></label><label>{t('s16.export.to')}<input type="date" min="1970-01-01" value={to} aria-invalid={error === 'dates'} onChange={event => { setStatus('idle'); setTo(event.target.value); }} /></label></div>
      </fieldset>
      {error && <p className="notice" role="alert">{t(errors[error])}</p>}
      <p role="status" aria-live="polite">{busy ? t('s16.export.preparing') : status === 'empty' ? t('s16.export.empty') : status === 'ready' ? t('s16.export.ready') : ''}</p>
      <footer><button type="button" onClick={onClose}>{t('s16.common.close')}</button><button type="submit" disabled={busy}>{t(busy ? 's16.export.preparing' : 's16.export.download')}</button></footer>
    </form>
  </dialog>;
}
