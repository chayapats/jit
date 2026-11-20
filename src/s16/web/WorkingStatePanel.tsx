import { useEffect, useRef, useState } from 'react';
import { JitClientError, type JitClient } from '../client';
import type { ComputerView } from '../computers/service';
import type { WorkingStateImport, WorkingStateManifest, WorkingStateView } from '../client/working-state';
import type { Copy } from './copy';

/** Exact ordinary-file review and original recovery receipts over the real protected owner client. */
export function WorkingStatePanel({ client, computers, t, onFailure }: { client: JitClient; computers: ComputerView[]; t: Copy; onFailure(error: unknown): void }) {
  const [view, setView] = useState<WorkingStateView | null>(null), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(true);
  const [workId, setWorkId] = useState(''), [paths, setPaths] = useState(''), [destination, setDestination] = useState('');
  const [manifest, setManifest] = useState<WorkingStateManifest | null>(null), [receipt, setReceipt] = useState<WorkingStateImport | null>(null), [captureId, setCaptureId] = useState<string | null>(null), [importId, setImportId] = useState<string | null>(null);
  const alive = useRef(false), review = useRef<HTMLHeadingElement>(null);
  const failure = (value: unknown) => {
    if (!alive.current) return; setError(value instanceof JitClientError ? value.code : 'client_unavailable');
    if (value instanceof JitClientError && ([401, 403].includes(value.status ?? 0) || ['lineage_withdrawn', 'payload_withdrawn'].includes(value.code))) { setView(null); setManifest(null); setReceipt(null); setPaths(''); if ([401, 403].includes(value.status ?? 0)) onFailure(value); }
  };
  const refresh = async (signal?: AbortSignal) => { try { const value = await client.workingState(signal); if (alive.current && !signal?.aborted) setView(value); } catch (error) { if (!signal?.aborted) failure(error); } };
  useEffect(() => { alive.current = true; setView(null); setManifest(null); setReceipt(null); setLoading(true); const controller = new AbortController(); void refresh(controller.signal).finally(() => { if (alive.current && !controller.signal.aborted) setLoading(false); }); return () => { alive.current = false; controller.abort(); }; }, [client]);
  useEffect(() => { if (manifest) review.current?.focus(); }, [manifest]);
  const run = async (operation: () => Promise<void>) => { if (loading) return; setLoading(true); setError(null); try { await operation(); } catch (error) { failure(error); } finally { if (alive.current) setLoading(false); } };
  const show = (value: WorkingStateManifest) => { if (!alive.current) return; setManifest(value); setDestination(''); setReceipt(null); setImportId(null); };
  const candidates = computers.filter(item => !item.retired && !item.drained && item.state === 'running' && item.activeSessions < item.capacity && (!manifest?.source.privateBotId || item.scope.kind === 'private' && item.scope.botId === manifest.source.privateBotId));
  const check = async (id: string) => { const value = await client.inspectWorkingState(id); if (alive.current) { setReceipt(value); setImportId(value.state === 'unknown' || value.state === 'dispatched' ? id : null); } await refresh(); };
  return <section aria-labelledby="working-state-title" className="computer-card working-state">
    <h2 id="working-state-title">{t('s16.workingState.title')}</h2><p>{t('s16.workingState.lead')}</p>
    <p className="limits">{t('s16.workingState.limits')}</p>
    {loading && <p role="status">{t('s16.common.loading')}</p>}
    {error && <p role="alert">{t('s16.workingState.failed', { reason: error })}</p>}
    {!view && !loading && <p>{t('s16.workingState.loadFailed')} <button type="button" onClick={() => void run(() => refresh())}>{t('s16.computers.retry')}</button></p>}
    {view && <>
      {!view.sources.length ? <p>{t('s16.workingState.empty')}</p> : <form style={{ display: 'grid', gap: 12 }} onSubmit={event => { event.preventDefault(); const id = crypto.randomUUID().replaceAll('-', ''); setCaptureId(id); void run(async () => { try { show(await client.captureWorkingState({ requestId: id, workId, paths: paths.split(/\r?\n/).map(p => p.trim()).filter(Boolean) })); setCaptureId(null); await refresh(); } catch (error) { if (error instanceof JitClientError && error.outcome !== 'unknown') setCaptureId(null); throw error; } }); }}>
        <label htmlFor="working-state-source">{t('s16.workingState.source')}</label><select id="working-state-source" style={{ width: '100%', minWidth: 0 }} required value={workId} disabled={loading} onChange={event => setWorkId(event.target.value)}><option value="">{t('s16.workingState.chooseSource')}</option>{view.sources.map(source => <option key={source.workId} value={source.workId}>{source.label}</option>)}</select>
        <label htmlFor="working-state-paths">{t('s16.workingState.paths')}</label><textarea id="working-state-paths" style={{ width: '100%', minWidth: 0 }} required rows={3} maxLength={15424} value={paths} disabled={loading} onChange={event => setPaths(event.target.value)} placeholder="result.txt&#10;src/note.md" aria-describedby="working-state-path-note" />
        <p id="working-state-path-note">{t('s16.workingState.pathNote')}</p><button disabled={loading || !workId || !paths.trim()} type="submit">{t('s16.workingState.capture')}</button>
      </form>}
      {captureId && <p>{t('s16.workingState.captureUnknown')} <button type="button" disabled={loading} onClick={() => void run(async () => { show(await client.workingStatePackage(captureId)); setCaptureId(null); await refresh(); })}>{t('s16.workingState.checkCapture')}</button></p>}
      {view.packages.length > 0 && <details><summary>{t('s16.workingState.saved')}</summary><ul>{view.packages.map(item => <li key={item.id}>{t('s16.workingState.fileCount', { n: item.files.length })} <button type="button" disabled={loading} onClick={() => void run(async () => show(await client.workingStatePackage(item.id)))}>{t('s16.workingState.review')}</button></li>)}</ul></details>}
      {manifest && <div>
        <h3 id="working-state-review" ref={review} tabIndex={-1}>{t('s16.workingState.review')}</h3><p>{t('s16.workingState.reviewNote')}</p>
        <ul>{manifest.files.map(file => <li key={file.path}><strong style={{ overflowWrap: 'anywhere' }}>{file.path}</strong> · {t('s16.workingState.bytes', { n: file.bytes })}<details><summary>SHA-256</summary><code style={{ overflowWrap: 'anywhere' }}>{file.sha256}</code></details></li>)}</ul>
        <p>{t('s16.workingState.sourceScope', { bot: manifest.source.bot.id })}</p>
        <label htmlFor="working-state-destination">{t('s16.workingState.destination')}</label><select id="working-state-destination" style={{ width: '100%', minWidth: 0 }} required value={destination} disabled={loading} onChange={event => setDestination(event.target.value)}><option value="">{t('s16.workingState.chooseDestination')}</option>{candidates.map(item => <option key={item.id} value={item.id}>{t(item.isDefault ? 's16.computers.shared' : item.scope.kind === 'private' ? 's16.workingState.privateDestination' : 's16.workingState.otherDestination', { id: item.id, bot: item.scope.kind === 'private' ? item.scope.botId : '' })}{item.backend ? ` · ${item.backend.provider}` : ''}</option>)}</select>
        {!candidates.length && <p>{t('s16.workingState.noDestination')}</p>}
        <button type="button" disabled={loading || !destination || !!importId} onClick={() => { const id = crypto.randomUUID().replaceAll('-', ''); setImportId(id); void run(async () => { try { const value = await client.importWorkingState({ requestId: id, packageId: manifest.id, manifestSha256: manifest.manifestSha256, vmId: destination }); if (alive.current) { setReceipt(value); setImportId(value.state === 'unknown' || value.state === 'dispatched' ? id : null); } await refresh(); } catch (error) { if (error instanceof JitClientError && error.outcome !== 'unknown') setImportId(null); throw error; } }); }}>{t('s16.workingState.recover')}</button>
      </div>}
      {importId && <p>{t('s16.workingState.unknown')} <button type="button" disabled={loading} onClick={() => void run(() => check(importId))}>{t('s16.workingState.checkImport')}</button></p>}
      {receipt && <div role="status"><p>{t(receipt.state === 'committed' ? 's16.workingState.complete' : receipt.state === 'not_sent' ? 's16.workingState.notSent' : 's16.workingState.unknown')}</p>{receipt.state === 'committed' && <details><summary>{t('s16.common.details')}</summary><code style={{ overflowWrap: 'anywhere' }}>{receipt.path}</code></details>}</div>}
      {view.imports.length > 0 && <details aria-label={t('s16.workingState.history')} open={view.imports.some(item => item.state === 'unknown' || item.state === 'dispatched')}><summary>{t('s16.workingState.history')}</summary><ul>{view.imports.filter(item => item.id !== importId).map(item => <li key={item.id}>
        <p>{t(item.state === 'committed' ? 's16.workingState.complete' : item.state === 'not_sent' ? 's16.workingState.notSent' : 's16.workingState.unknown')}</p>
        {item.state === 'committed' ? <code style={{ overflowWrap: 'anywhere' }}>{item.path}</code> : item.state !== 'not_sent' && <button disabled={loading} type="button" onClick={() => void run(() => check(item.id))}>{t('s16.workingState.checkImport')}</button>}
      </li>)}</ul></details>}

    </>}
  </section>;
}
