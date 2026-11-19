import { useEffect, useRef, useState } from 'react';
import { JitClientError, type JitClient } from '../client';
import type { BrowserOwnerControl } from '../../s15/browser';
import type { ProtectedBrowserCommand, ProtectedBrowserView } from '../protected-browser';
import type { Copy } from './copy';
import type { MessageKey } from '../../i18n';

const uid = () => crypto.randomUUID().replaceAll('-', '');
type Command = Omit<Extract<ProtectedBrowserCommand, { kind: 'input' }>, 'contract' | 'requestId' | 'generation'> | { kind: 'takeover' | 'check_session' } | { kind: 'hand_back'; cancel: boolean } | { kind: 'reconcile'; action: NonNullable<ProtectedBrowserView['reconciliation']> };

/** The actual protected owner port, with transient field input and no conversation/draft persistence.
 * Closing or disconnecting covers the frame and keeps owner control; only Return to Bot hands it back. */
export function ProtectedBrowser({ client, t, onClose, onFailure }: { client: JitClient; t: Copy; onClose(): void; onFailure(error: unknown): void }) {
  const [view, setView] = useState<ProtectedBrowserView | null>(null), [controls, setControls] = useState<BrowserOwnerControl[]>([]), [draft, setDraft] = useState<Record<string, string>>({});
  const [frame, setFrame] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), current = useRef<ProtectedBrowserView | null>(null), image = useRef<string | null>(null), epoch = useRef(0), sending = useRef(false), alive = useRef(true);
  const clear = () => { if (image.current) URL.revokeObjectURL(image.current); image.current = null; setFrame(null); setControls([]); setDraft({}); };
  const fail = (failure: unknown) => {
    clear(); setError(failure instanceof JitClientError ? failure.code : 'client_unavailable');
    if (failure instanceof JitClientError && ([401, 403].includes(failure.status ?? 0) || ['authentication_required', 'authorization_required', 'csrf_rejected'].includes(failure.code))) onFailure(failure);
  };
  const refresh = async (full = true) => {
    const turn = ++epoch.current;
    try {
      const next = await client.protectedBrowser(); if (!alive.current || turn !== epoch.current) return;
      const changed = next.generation !== current.current?.generation || next.login !== current.current?.login;
      current.current = next; setView(next); setError(null);
      if (changed || next.login !== 'owner_control' || next.settling || document.visibilityState !== 'visible') clear();
      if ((full || changed) && next.login === 'owner_control' && !next.settling && document.visibilityState === 'visible') {
        const [blob, fields] = await Promise.all([client.protectedBrowserFrame(next.generation), client.protectedBrowserControls(next.generation)]);
        if (!alive.current || turn !== epoch.current) return;
        clear(); image.current = URL.createObjectURL(blob); setFrame(image.current); setControls(fields);
      }
    } catch (failure) { if (alive.current && turn === epoch.current) fail(failure); }
  };
  useEffect(() => {
    const element = dialog.current; alive.current = true; element?.showModal(); heading.current?.focus(); void refresh();
    const timer = setInterval(() => { if (!sending.current) void refresh(false); }, 3000);
    const visibility = () => { epoch.current++; clear(); if (document.visibilityState === 'visible' && !sending.current) void refresh(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { alive.current = false; epoch.current++; clearInterval(timer); document.removeEventListener('visibilitychange', visibility); if (image.current) URL.revokeObjectURL(image.current); element?.close(); };
  }, []);
  const send = async (command: Command) => {
    const previous = current.current; if (!previous || sending.current) return;
    sending.current = true; epoch.current++; setBusy(true); setError(null); clear();
    try {
      let result = await client.protectedBrowserCommand({ ...command, contract: 's16-protected-browser-command/v1', requestId: uid(), generation: previous.generation });
      if (!alive.current) return;
      current.current = result.view; setView(result.view);
      if (command.kind === 'hand_back' && !command.cancel && result.view.login === 'checking') {
        result = await client.protectedBrowserCommand({ contract: 's16-protected-browser-command/v1', requestId: uid(), generation: result.view.generation, kind: 'check_session' });
        if (!alive.current) return; current.current = result.view; setView(result.view);
      }
      await refresh();
    } catch (failure) { if (alive.current) fail(failure); }
    finally { sending.current = false; if (alive.current) setBusy(false); }
  };
  const driving = view?.login === 'owner_control' && !view.settling && !error;
  return <dialog className="protected-browser computer-screen" ref={dialog} aria-labelledby="protected-browser-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="screen-bar"><h2 id="protected-browser-title" tabIndex={-1} ref={heading}>{t('s16.protected.title')}</h2><button type="button" onClick={onClose}>{t('s16.protected.close')}</button></header>
    <p>{t('s16.protected.note')}</p>
    {view && !view.signIn && <p className="notice">{t('s16.protected.unsupported')}</p>}
    <p role="status" aria-live="polite">{busy ? t('s16.protected.working') : view ? t((`s16.protected.${view.settling ? 'settling' : view.login}`) as MessageKey) : t('s16.common.loading')}</p>
    {error && <div className="notice warn" role="alert"><p>{t('s16.protected.disconnected')}</p><details><summary>{t('s16.common.details')}</summary><code>{error}</code></details></div>}
    <div className="actions">
      {view?.signIn && !driving && <button type="button" disabled={busy || view.settling} onClick={() => void send({ kind: 'takeover' })}>{t('s16.protected.takeover')}</button>}
      {view?.login === 'owner_control' && <><button type="button" disabled={busy || view.settling} onClick={() => void send({ kind: 'hand_back', cancel: false })}>{t('s16.protected.return')}</button><button type="button" disabled={busy} onClick={() => void send({ kind: 'hand_back', cancel: true })}>{t('s16.protected.cancel')}</button></>}
      {view?.login === 'checking' && <button type="button" disabled={busy} onClick={() => void send({ kind: 'check_session' })}>{t('s16.protected.check')}</button>}
      {view?.reconciliation && <button type="button" disabled={busy} onClick={() => void send({ kind: 'reconcile', action: view.reconciliation! })}>{t('s16.protected.reconcile')}</button>}
      <button type="button" disabled={busy} onClick={() => void refresh()}>{t('s16.protected.refresh')}</button>
    </div>
    <div className="screen-frame">{driving && frame ? <img src={frame} alt={t('s16.protected.frame')} /> : <p>{t('s16.protected.covered')}</p>}</div>
    {driving && controls.map(control => control.kind === 'button' ? <button key={control.id} type="button" disabled={busy} onClick={() => void send({ kind: 'input', input: { kind: 'click', field: control.id } })}>{control.label}</button> : <form key={control.id} className="screen-type" onSubmit={event => {
      event.preventDefault(); const value = draft[control.id]; if (value) void send({ kind: 'input', input: { kind: 'type', field: control.id, value } });
    }}><label>{control.label}<input type="password" autoComplete="off" spellCheck={false} maxLength={2000} disabled={busy} value={draft[control.id] ?? ''} onChange={event => setDraft(previous => ({ ...previous, [control.id]: event.target.value }))} /></label><button type="submit" disabled={busy || !draft[control.id]}>{t('s16.protected.enter')}</button></form>)}
  </dialog>;
}
