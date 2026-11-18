import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { JitClient, JitClientError } from '../client';
import { startVoiceRecording, type VoiceRecording } from '../client/voice-recording';
import type { VoiceStatus } from '../voice/contracts';
import type { Copy } from './copy';

type Phase = 'idle' | 'reserving' | 'permission' | 'recording' | 'transcribing' | 'draft' | 'loading' | 'playing' | 'error';
interface Slot { kind: 'capture' | 'playback'; scope: string; conversationId: string; stop: AbortController; id?: string; recorder?: VoiceRecording; audio?: HTMLAudioElement; url?: string; timer?: ReturnType<typeof setInterval>; target?: { requestId: string; revision: number; text: string } }
const code = (error: unknown) => error instanceof JitClientError ? error.code : error instanceof Error && /^[a-z][a-z0-9_]{0,127}$/.test(error.message) ? error.message : 'voice_unavailable';

/** One client voice lifecycle shared by the composer and reply buttons; it never sends a transcript or votes. */
export function useVoice(options: { client: JitClient; enabled: boolean; canCapture: boolean; conversationId: string; scope: string; onTranscript(text: string): void; onFailure(error: unknown): void }) {
  const latest = useRef(options); latest.current = options;
  const slot = useRef<Slot | null>(null), turn = useRef(0), mounted = useRef(true);
  const [phase, setPhase] = useState<Phase>('idle'), [status, setStatus] = useState<VoiceStatus | null>(null), [error, setError] = useState<string | null>(null), [elapsed, setElapsed] = useState(0), [draft, setDraft] = useState('');
  const alive = (value: Slot) => mounted.current && slot.current === value && latest.current.enabled && latest.current.scope === value.scope;
  const dispose = async (value: Slot | null, remote = true) => {
    if (!value) return;
    clearInterval(value.timer); value.stop.abort(); value.audio?.pause();
    if (value.audio) { value.audio.onended = null; value.audio.onerror = null; value.audio.removeAttribute('src'); value.audio.load(); }
    if (value.url) URL.revokeObjectURL(value.url);
    await Promise.allSettled([value.recorder?.cancel(), remote && value.id ? latest.current.client.cancelVoice({ id: value.id, conversationId: value.conversationId }) : undefined]);
  };
  const cancel = () => { turn.current++; const previous = slot.current; slot.current = null; setDraft(''); setElapsed(0); setError(null); setPhase('idle'); void dispose(previous); };
  const failed = async (value: Slot, failure: unknown) => {
    if (!alive(value)) return;
    slot.current = null; setDraft(''); setError(code(failure)); setPhase('error'); const cleanup = dispose(value);
    if (mounted.current && latest.current.scope === value.scope && failure instanceof JitClientError && ([401, 403].includes(failure.status ?? 0) || ['voice_result_changed', 'voice_result_unavailable'].includes(failure.code))) latest.current.onFailure(failure);
    await cleanup;
  };
  const inspect = async (value: Slot) => { const result = await latest.current.client.voiceStatus(value.stop.signal); if (!alive(value)) throw Error('voice_cancelled'); setStatus(result); if (!result.available) throw Error('voice_unavailable'); return result; };
  const monitor = (value: Slot) => { let checking = false; value.timer = setInterval(() => { if (!alive(value) || checking) return; checking = true; void inspect(value).catch(error => failed(value, error)).finally(() => { checking = false; }); }, 2000); };
  const begin = async (kind: Slot['kind']): Promise<Slot | null> => {
    const sequence = ++turn.current, scope = latest.current.scope, previous = slot.current; slot.current = null;
    setDraft(''); setError(null); setElapsed(0); setPhase(kind === 'capture' ? 'reserving' : 'loading'); await dispose(previous);
    if (!mounted.current || turn.current !== sequence || latest.current.scope !== scope || !latest.current.enabled || kind === 'capture' && !latest.current.canCapture) return null;
    const value: Slot = { kind, scope, conversationId: latest.current.conversationId, stop: new AbortController() }; slot.current = value; return value;
  };
  const record = async () => {
    const value = await begin('capture'); if (!value) return;
    try {
      const requested = performance.now(), status = await inspect(value), command = latest.current.client.prepareDictation(status.serverTime); value.id = command.requestId;
      const capture = await latest.current.client.beginDictation(value.conversationId, command, value.stop.signal);
      if (!alive(value)) return; if (capture.state !== 'capturing') throw Error('voice_capture_expired');
      setPhase('permission'); monitor(value);
      const recorder = await startVoiceRecording({ signal: value.stop.signal, durationMs: capture.maxDurationMs, deadline: requested + capture.expiresAt - status.serverTime, progress(ms) { if (alive(value)) setElapsed(old => Math.floor(old / 1000) === Math.floor(ms / 1000) ? old : ms); } });
      value.recorder = recorder;
      if (!alive(value)) { await recorder.cancel(); return; }
      setPhase('recording'); const wav = await recorder.done;
      delete value.recorder;
      if (!alive(value)) return; clearInterval(value.timer); setPhase('transcribing');
      const transcript = await latest.current.client.transcribeDictation(capture, wav, value.stop.signal);
      if (!alive(value)) return; setDraft(transcript.text); setPhase('draft'); setStatus(old => old ? { ...old, usage: transcript.usage } : old);
      void latest.current.client.voiceStatus(value.stop.signal).then(fresh => { if (alive(value)) setStatus(fresh); }).catch(error => { if (!alive(value)) return; if (error instanceof JitClientError && [401, 403].includes(error.status ?? 0)) void failed(value, error); else setError(code(error)); });
    } catch (error) { await failed(value, error); }
  };
  const play = async (target: { requestId: string; revision: number; text: string }) => {
    const value = await begin('playback'); if (!value) return; value.target = { ...target };
    try {
      const status = await inspect(value), command = await latest.current.client.preparePlayback(status.serverTime, value.conversationId, target.requestId, target.revision, target.text); value.id = command.requestId;
      const result = await latest.current.client.playReply(command, value.stop.signal); if (!alive(value)) return;
      const bytes = Uint8Array.from(atob(result.wavBase64), character => character.charCodeAt(0));
      value.url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })); value.audio = new Audio(value.url);
      value.audio.onended = () => { if (!alive(value)) return; slot.current = null; setPhase('idle'); void dispose(value, false); };
      value.audio.onerror = () => { void failed(value, Error('voice_playback_unavailable')); };
      await value.audio.play(); if (!alive(value)) { value.audio.pause(); return; }
      setStatus(old => old ? { ...old, usage: result.usage } : old); setPhase('playing');
    } catch (error) { await failed(value, error); }
  };
  const apply = () => { if (!draft.trim() || !slot.current || !alive(slot.current)) return; try { latest.current.onTranscript(draft); cancel(); } catch (error) { setError(code(error)); } };
  useLayoutEffect(() => {
    mounted.current = true; let fresh = true; const stop = new AbortController();
    setDraft(''); setError(null); setElapsed(0); setPhase('idle'); setStatus(null);
    if (options.enabled) void options.client.voiceStatus(stop.signal).then(status => { if (fresh) setStatus(status); }).catch(error => { if (fresh && !stop.signal.aborted) { setError(code(error)); if (error instanceof JitClientError && [401, 403].includes(error.status ?? 0)) latest.current.onFailure(error); } }); else setStatus(null);
    return () => { fresh = false; mounted.current = false; stop.abort(); turn.current++; const previous = slot.current; slot.current = null; void dispose(previous); };
  }, [options.enabled, options.scope, options.client]);
  useEffect(() => { if (!options.canCapture && slot.current?.kind === 'capture') cancel(); }, [options.canCapture]);
  return { phase, status, error, elapsed, draft, setDraft, record, play, cancel, apply, stop: () => slot.current?.recorder?.stop(), playing: slot.current?.kind === 'playback' ? slot.current.target?.requestId : null,
    currentReply: (rows: { requestId: string; revision: number; result: { text: string } | null }[]) => { const current = slot.current; if (current?.kind === 'playback' && current.target && !rows.some(row => row.requestId === current.target!.requestId && row.revision === current.target!.revision && row.result?.text === current.target!.text)) cancel(); } };
}

/** Visible recording/transcription/playback states; transcript editing precedes ordinary composer Send. */
export function VoiceControls({ voice, t, canCapture }: { voice: ReturnType<typeof useVoice>; t: Copy; canCapture: boolean }) {
  const transcript = useRef<HTMLTextAreaElement>(null), transcriptId = useId();
  useEffect(() => { if (voice.phase === 'draft') transcript.current?.focus(); }, [voice.phase]);
  const busy = !['idle', 'error', 'draft'].includes(voice.phase), seconds = Math.floor(voice.elapsed / 1000), usage = voice.status?.usage;
  return <section className={`voice-controls voice-${voice.phase}`} aria-label={t('s16.voice.title')}>
    <div className="voice-actions"><button type="button" disabled={!canCapture || !voice.status?.available || busy} onClick={() => void voice.record()}>{t('s16.voice.dictate')}</button>
      {voice.phase === 'recording' && <><output aria-live="off">{String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</output><button type="button" onClick={voice.stop}>{t('s16.voice.stop')}</button></>}
      {(busy || voice.phase === 'draft') && <button type="button" onClick={voice.cancel}>{t(voice.phase === 'playing' || voice.phase === 'loading' ? 's16.voice.interrupt' : 's16.voice.cancel')}</button>}
      {busy && <span role="status">{t(voice.phase === 'reserving' ? 's16.voice.preparing' : voice.phase === 'permission' ? 's16.voice.permission' : voice.phase === 'recording' ? 's16.voice.recording' : voice.phase === 'transcribing' ? 's16.voice.transcribing' : voice.phase === 'loading' ? 's16.voice.loading' : 's16.voice.playing')}</span>}
    </div>
    <small>{!voice.status ? t('s16.voice.checking') : !voice.status.available ? t('s16.voice.unavailable') : t('s16.voice.local')}</small>
    {usage && <small>{t('s16.voice.usage', { used: (usage.chargedMs / 1000).toFixed(1), reserved: (usage.reservedMs / 1000).toFixed(1), limit: (usage.limitMs / 1000).toFixed(0) })}{usage.conservativeMs > 0 && <> {t('s16.voice.conservative', { seconds: (usage.conservativeMs / 1000).toFixed(1) })}</>}</small>}
    {voice.phase === 'draft' && <div className="voice-draft"><label htmlFor={transcriptId}>{t('s16.voice.transcript')}</label><textarea id={transcriptId} ref={transcript} rows={3} value={voice.draft} onChange={event => voice.setDraft(event.target.value)} /><p>{t('s16.voice.review')}</p><button type="button" disabled={!voice.draft.trim() || !canCapture} onClick={voice.apply}>{t('s16.voice.useText')}</button></div>}
    {voice.error && <div role="alert" className="voice-error"><p>{t(voice.error === 'voice_permission_denied' || voice.error === 'voice_permission_lost' ? 's16.voice.permissionDenied' : voice.error === 'voice_budget_exhausted' ? 's16.voice.budget' : 's16.voice.failed')}</p><details><summary>{t('s16.common.details')}</summary><code>{voice.error}</code></details></div>}
  </section>;
}
