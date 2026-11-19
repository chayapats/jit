import { useEffect, useId, useRef, useState } from 'react';
import { JitClientError, type JitClient, type VoiceCallConfirm, type VoiceCallView, type VoiceStatus } from '../client';
import { startVoiceRecording, type VoiceRecording } from '../client/voice-recording';
import type { Copy } from './copy';
import type { MessageKey } from '../../i18n';

type Phase = 'idle' | 'preparing' | 'listening' | 'transcribing' | 'review' | 'thinking' | 'attention' | 'speaking' | 'muted' | 'paused' | 'reconnecting' | 'ending' | 'ended';
interface Part { stop: AbortController; conversationId: string; id?: string; recorder?: VoiceRecording; audio?: HTMLAudioElement; url?: string; speech?: boolean }
interface Session {
  scope: string; conversationId: string; id: string | null; view: VoiceCallView | null; root: AbortController;
  consent: boolean; capture: Part | null; playback: Part | null; pending: VoiceCallConfirm | null; target: string | null;
  waiting: boolean; attention: boolean; skipReply: boolean; played: number; phase: Phase; mutations: number; epoch: number; checking: boolean;
  poll?: ReturnType<typeof setInterval>; deadline?: ReturnType<typeof setTimeout>; deadlineAt: number;
}
const code = (error: unknown) => error instanceof JitClientError ? error.code : error instanceof Error && /^[a-z][a-z0-9_]{0,127}$/.test(error.message) ? error.message : 'voice_unavailable';

/** One finite client call. Speech remains a reviewable draft; only explicit Send turn enters CHAT/steering.
 * Audio/capture have independent fences so barge-in stops playback synchronously without cancelling work. */
export function useVoiceCall(options: { client: JitClient; enabled: boolean; canStart: boolean; conversationId: string; scope: string; steerTarget: string | null; beforeStart(): Promise<void>; onAccepted(): void; onFailure(error: unknown): void }) {
  const latest = useRef(options); latest.current = options;
  const session = useRef<Session | null>(null), mounted = useRef(true);
  const [phase, setPhase] = useState<Phase>('idle'), [view, setView] = useState<VoiceCallView | null>(null), [status, setStatus] = useState<VoiceStatus | null>(null);
  const [error, setError] = useState<string | null>(null), [draft, setDraft] = useState(''), [microphone, setMicrophone] = useState(false), [remaining, setRemaining] = useState(0);
  const alive = (s: Session) => mounted.current && session.current === s && latest.current.enabled && latest.current.scope === s.scope;
  const show = (s: Session, next: Phase) => { s.phase = next; if (alive(s)) setPhase(next); };
  const drop = async (part: Part | null, remote = true) => {
    if (!part) return;
    part.stop.abort(); part.audio?.pause();
    if (part.audio) { part.audio.onended = null; part.audio.onerror = null; part.audio.removeAttribute('src'); part.audio.load(); }
    if (part.url) URL.revokeObjectURL(part.url);
    await Promise.allSettled([part.recorder?.cancel(), remote && part.id ? latest.current.client.cancelVoice({ id: part.id, conversationId: part.conversationId }) : undefined]);
  };
  const quiet = (s: Session) => {
    const capture = s.capture, playback = s.playback; s.capture = null; s.playback = null;
    if (alive(s)) setMicrophone(false); void drop(capture); void drop(playback);
  };
  const dispose = (s: Session) => { s.consent = false; s.root.abort(); clearInterval(s.poll); clearTimeout(s.deadline); quiet(s); };
  const update = (s: Session, next: VoiceCallView) => {
    if (!alive(s) || next.conversationId !== s.conversationId) return;
    if (s.view && (next.revision < s.view.revision || next.revision === s.view.revision && next.turns.length < s.view.turns.length)) return;
    s.view = next; s.id = next.id; setView(next);
  };
  const end = async (s: Session, reason?: string) => {
    dispose(s); if (!alive(s)) return; if (reason) setError(reason); show(s, 'ending'); s.epoch++;
    if (!s.id) { show(s, 'ended'); return; }
    try {
      const next = await latest.current.client.controlVoiceCall(s.id, { contract: 's16-voice-call-control/v1', revision: s.view?.revision ?? 1, kind: 'end' }); update(s, next);
      if (alive(s)) { if (s.pending && next.turns.find(turn => turn.ordinal === s.pending!.ordinal)?.state === 'accepted') { s.pending = null; setDraft(''); latest.current.onAccepted(); } show(s, 'ended'); }
    }
    catch (failure) { fail(s, failure); }
  };
  const fail = (s: Session, failure: unknown) => {
    if (!alive(s)) return;
    s.consent = false; quiet(s); clearInterval(s.poll); setError(code(failure)); show(s, 'reconnecting');
    if (failure instanceof JitClientError && [401, 403].includes(failure.status ?? 0)) latest.current.onFailure(failure);
  };
  const arm = (s: Session, requested: number) => {
    if (!s.view) return;
    s.deadlineAt = Math.min(s.deadlineAt, requested + s.view.expiresAt - s.view.serverTime);
    clearTimeout(s.deadline); setRemaining(Math.max(0, s.deadlineAt - performance.now()));
    s.deadline = setTimeout(() => { if (alive(s)) void end(s, 'voice_call_time_limit'); }, Math.max(0, s.deadlineAt - performance.now()));
  };
  const interrupt = (s: Session) => { s.skipReply = true; const previous = s.playback; s.playback = null; void drop(previous); if (alive(s) && s.consent) show(s, s.capture?.recorder ? 'listening' : s.phase); };
  const mute = async (s: Session, reason?: string) => {
    s.consent = false; quiet(s); s.epoch++; s.mutations++; if (alive(s)) { if (!s.pending) setDraft(''); if (reason) setError(reason); show(s, 'muted'); }
    try { if (s.id) update(s, await latest.current.client.controlVoiceCall(s.id, { contract: 's16-voice-call-control/v1', revision: s.view?.revision ?? 1, kind: 'mute' })); }
    catch (failure) { fail(s, failure); } finally { s.mutations--; }
  };
  const listen = async (s: Session) => {
    if (!alive(s) || !s.consent || !s.view || s.view.state !== 'active' || s.capture || s.pending) return;
    const part: Part = { stop: new AbortController(), conversationId: s.conversationId }; s.capture = part;
    const current = () => alive(s) && s.consent && s.capture === part;
    try {
      const requested = performance.now(), health = await latest.current.client.voiceStatus(part.stop.signal); if (!current()) return;
      setStatus(health); if (!health.available) throw Error('voice_unavailable');
      const command = latest.current.client.prepareDictation(health.serverTime); part.id = command.requestId;
      const capture = await latest.current.client.captureVoiceCall(s.view.id, { contract: 's16-voice-call-capture/v1', revision: s.view.revision, requestId: part.id }, s.conversationId, part.stop.signal);
      if (!current()) return; if (capture.state !== 'capturing') throw Error('voice_capture_expired');
      part.recorder = await startVoiceRecording({ signal: part.stop.signal, durationMs: capture.maxDurationMs, deadline: requested + capture.recordingEndsAt - health.serverTime, progress() {}, segment: { onSpeech() { if (current()) { part.speech = true; interrupt(s); show(s, 'listening'); } } } });
      if (!current()) { await part.recorder.cancel(); return; } setMicrophone(true); show(s, s.playback?.audio && !s.playback.audio.paused ? 'speaking' : s.attention ? 'attention' : s.waiting ? 'thinking' : 'listening');
      const wav = await part.recorder.done; delete part.recorder; if (!current()) return;
      setMicrophone(false); show(s, 'transcribing');
      const result = await latest.current.client.transcribeDictation(capture, wav, part.stop.signal); if (!current()) return;
      s.capture = null; s.target = latest.current.steerTarget; setDraft(result.text); show(s, 'review'); void drop(part);
      setStatus(old => old ? { ...old, usage: result.usage } : old);
    } catch (failure) {
      if (!current()) return; s.capture = null; setMicrophone(false);
      if (['voice_no_speech', 'voice_audio_empty'].includes(code(failure))) { await drop(part); if (alive(s) && s.consent) { if (s.playback || s.waiting) void listen(s); else await mute(s, 'voice_no_speech'); } return; }
      void drop(part);
      if (['voice_permission_lost', 'voice_permission_denied', 'voice_microphone_unavailable'].includes(code(failure))) await mute(s, code(failure));
      else if (['voice_budget_exhausted', 'voice_unavailable', 'voice_call_time_limit'].includes(code(failure))) await end(s, code(failure));
      else fail(s, failure);
    }
  };
  const speak = async (s: Session) => {
    if (!alive(s) || !s.consent || !s.view || s.view.state !== 'active' || s.skipReply || s.playback || s.pending || ['review', 'transcribing'].includes(s.phase)) return;
    const turn = s.view.turns.at(-1); if (!turn?.receipt || turn.ordinal <= s.played) return;
    const receipt = turn.receipt, root = receipt.contract === 's15-conversation-receipt/v1' ? receipt.rootRequestId : receipt.state === 'resubmitted' ? receipt.followUp : receipt.state === 'applied' ? receipt.target : null;
    if (!root) { if (receipt.contract === 's16-conversation-steer-receipt/v1' && !['queued', 'sent'].includes(receipt.state) && !s.attention) { s.attention = true; s.waiting = false; show(s, 'attention'); latest.current.onAccepted(); } return; }
    const part: Part = { stop: new AbortController(), conversationId: s.conversationId }; s.playback = part;
    const current = () => alive(s) && s.consent && s.playback === part && !s.skipReply;
    try {
      const found = await latest.current.client.request(root, part.stop.signal); if (!current()) return;
      if (!found.row.result) {
        s.playback = null;
        if (!['received', 'understanding', 'inspecting', 'working'].includes(found.row.state) && !s.attention) { s.attention = true; s.waiting = false; show(s, 'attention'); latest.current.onAccepted(); }
        return;
      }
      s.attention = false; s.played = turn.ordinal;
      const request = await latest.current.client.preparePlayback(s.view.serverTime, s.conversationId, root, found.row.revision, found.row.result.text); if (!current()) return; part.id = request.requestId;
      const result = await latest.current.client.playVoiceCallReply(s.view.id, { contract: 's16-voice-call-playback/v1', revision: s.view.revision, request }, part.stop.signal); if (!current()) return;
      const bytes = Uint8Array.from(atob(result.wavBase64), c => c.charCodeAt(0)); part.url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })); part.audio = new Audio(part.url);
      part.audio.onended = () => { if (!current()) return; s.playback = null; s.waiting = false; show(s, 'listening'); void drop(part, false); };
      part.audio.onerror = () => { if (current()) { s.playback = null; setError('voice_playback_unavailable'); show(s, 'listening'); void drop(part); } };
      try { await part.audio.play(); } catch { throw Error('voice_playback_unavailable'); }
      if (!current()) { part.audio.pause(); return; } show(s, 'speaking'); setStatus(old => old ? { ...old, usage: result.usage } : old);
    } catch (failure) {
      if (!current()) return; s.playback = null; void drop(part);
      if (['voice_text_limit', 'voice_playback_unavailable'].includes(code(failure))) { setError(code(failure)); s.waiting = false; show(s, 'listening'); }
      else if (['voice_budget_exhausted', 'voice_unavailable'].includes(code(failure))) await end(s, code(failure));
      else fail(s, failure);
    }
  };
  const poll = async (s: Session) => {
    if (!alive(s) || !s.consent || !s.id || s.checking || s.mutations) return;
    s.checking = true; const epoch = s.epoch;
    try {
      const [health, next] = await Promise.all([latest.current.client.voiceStatus(s.root.signal), latest.current.client.voiceCall(s.id, s.root.signal)]);
      if (!alive(s) || epoch !== s.epoch) return;
      const changed = !!s.view && next.revision !== s.view.revision; update(s, next); setStatus(health); setRemaining(Math.max(0, s.deadlineAt - performance.now()));
      if (next.state !== 'active' || changed) { s.consent = false; quiet(s); show(s, next.state === 'ended' ? 'ended' : next.state === 'muted' ? 'muted' : 'reconnecting'); clearInterval(s.poll); return; }
      if (!health.available) { await end(s, 'voice_unavailable'); return; } void speak(s);
    } catch (failure) { if (alive(s) && epoch === s.epoch) fail(s, failure); } finally { s.checking = false; }
  };
  const watch = (s: Session) => { clearInterval(s.poll); s.poll = setInterval(() => { void poll(s); }, 2000); };
  const create = (existing: VoiceCallView | null = null): Session => ({ scope: latest.current.scope, conversationId: latest.current.conversationId, id: existing?.id ?? null, view: existing, root: new AbortController(), consent: false, capture: null, playback: null, pending: null, target: null, waiting: false, attention: false, skipReply: false, played: existing?.turns.length ?? 0, phase: 'preparing', mutations: 0, epoch: 0, checking: false, deadlineAt: Infinity });
  const start = async () => {
    if (!latest.current.enabled || !latest.current.canStart) return;
    if (session.current) dispose(session.current); const s = create(); session.current = s; s.consent = true; setDraft(''); setError(null); show(s, 'preparing');
    try {
      await latest.current.beforeStart(); if (!alive(s) || !s.consent) return;
      const requested = performance.now(), health = await latest.current.client.voiceStatus(s.root.signal); if (!alive(s) || !s.consent) return;
      setStatus(health); if (!health.available) throw Error('voice_unavailable'); const command = latest.current.client.prepareVoiceCall(health.serverTime); s.id = command.requestId;
      const next = await latest.current.client.beginVoiceCall(s.conversationId, command, s.root.signal); if (!alive(s) || !s.consent) return;
      update(s, next); if (next.state !== 'active') { s.consent = false; show(s, 'ended'); return; } arm(s, requested); watch(s); void listen(s);
    } catch (failure) { if (s.consent) fail(s, failure); }
  };
  const recover = async (resume: boolean) => {
    const s = session.current ?? create(view); if (!s.id) return; session.current = s; const epoch = ++s.epoch; s.mutations++; setError(null);
    const current = () => alive(s) && epoch === s.epoch && !s.root.signal.aborted;
    try {
      const requested = performance.now(); let next = await latest.current.client.voiceCall(s.id); if (!current()) return;
      update(s, next);
      if (s.pending && next.turns.find(turn => turn.ordinal === s.pending!.ordinal)?.state === 'accepted') { s.pending = null; setDraft(''); latest.current.onAccepted(); }
      if (next.state === 'ended') { show(s, 'ended'); return; }
      if (next.turns.some(turn => turn.state === 'unaccepted')) { setError('voice_turn_recovery_required'); show(s, 'reconnecting'); return; }
      if (!resume) { show(s, 'paused'); return; }
      if (performance.now() >= s.deadlineAt) { await end(s, 'voice_call_time_limit'); return; }
      next = await latest.current.client.controlVoiceCall(s.id, { contract: 's16-voice-call-control/v1', revision: next.revision, kind: 'resume' });
      if (!current()) return; update(s, next); if (next.state !== 'active') { show(s, 'ended'); return; }
      s.consent = true; s.played = next.turns.length; s.skipReply = true; arm(s, requested); watch(s); void listen(s);
    } catch (failure) { fail(s, failure); } finally { s.mutations--; }
  };
  const send = async () => {
    const s = session.current; if (!s?.view || !s.id || !alive(s) || s.mutations || !draft.trim() && !s.pending) return;
    let command: VoiceCallConfirm;
    try { command = s.pending ?? latest.current.client.prepareVoiceCallTurn(s.view, draft, s.target); } catch (failure) { setError(code(failure)); return; }
    s.pending = command; s.mutations++; s.epoch++; show(s, 'thinking');
    try {
      const next = await latest.current.client.sendVoiceCallTurn(s.id, command, s.root.signal); if (!alive(s)) return; update(s, next);
      if (next.turns.find(turn => turn.ordinal === command.ordinal)?.state !== 'accepted') { show(s, 'reconnecting'); return; }
      s.pending = null; setDraft(''); s.skipReply = false; s.waiting = true; s.attention = false; latest.current.onAccepted();
      if (s.view?.state === 'ended') { dispose(s); show(s, 'ended'); }
      else if (s.view?.state === 'muted') show(s, 'muted');
      else if (s.consent) { void listen(s); void speak(s); } else show(s, 'paused');
    } catch (failure) { if (!s.root.signal.aborted) fail(s, failure); } finally { s.mutations--; }
  };
  useEffect(() => {
    mounted.current = true; let fresh = true; const stop = new AbortController(); setPhase('idle'); setView(null); setStatus(null); setDraft(''); setError(null); setMicrophone(false);
    if (options.enabled) void Promise.all([options.client.voiceStatus(stop.signal), options.client.voiceCalls(options.conversationId, stop.signal)]).then(([health, calls]) => { if (!fresh || session.current) return; setStatus(health); const previous = calls[0]; if (previous) { setView(previous); setPhase(previous.state === 'ended' ? 'ended' : previous.state === 'muted' ? 'muted' : 'paused'); } }).catch(failure => { if (fresh && !session.current && !stop.signal.aborted) { setError(code(failure)); if (failure instanceof JitClientError && [401, 403].includes(failure.status ?? 0)) latest.current.onFailure(failure); } });
    const visibility = () => { const s = session.current; if (s && document.visibilityState !== 'visible') void mute(s); };
    document.addEventListener('visibilitychange', visibility);
    return () => { fresh = false; mounted.current = false; stop.abort(); document.removeEventListener('visibilitychange', visibility); const s = session.current; session.current = null; if (s) { dispose(s); if (s.id) void latest.current.client.controlVoiceCall(s.id, { contract: 's16-voice-call-control/v1', revision: s.view?.revision ?? 1, kind: 'end' }).catch(() => {}); } };
  }, [options.enabled, options.scope, options.client]);
  useEffect(() => { const s = session.current; if (!options.canStart && s?.consent) void end(s); }, [options.canStart]);
  const discardable = !!session.current?.pending && view?.state === 'ended' && !['accepted', 'unavailable'].includes(view.turns.find(turn => turn.ordinal === session.current!.pending!.ordinal)?.state ?? 'unaccepted');
  return { phase, view, status, error, draft, setDraft, microphone, remaining, start, send, target: session.current?.target ?? null, active: !['idle', 'ended'].includes(phase), pending: !!session.current?.pending, discardable,
    stop: () => session.current?.capture?.recorder?.stop(), mute: () => { if (session.current) void mute(session.current); }, interrupt: () => { if (session.current) interrupt(session.current); },
    end: () => { const s = session.current ?? create(view); session.current = s; void end(s); }, recover: () => void recover(false), resume: () => void recover(true),
    discard: () => { const s = session.current; if (!s || s.pending && !discardable) return; if (s.pending) { s.pending = null; setDraft(''); show(s, 'ended'); return; } setDraft(''); s.target = null; show(s, 'listening'); void listen(s); } };
}

/** Inline call controls retain the ordinary conversation, text composer and exact action cards on screen. */
export function VoiceCallControls({ call, t, canStart }: { call: ReturnType<typeof useVoiceCall>; t: Copy; canStart: boolean }) {
  const transcript = useRef<HTMLTextAreaElement>(null), transcriptId = useId();
  useEffect(() => { if (call.phase === 'review') transcript.current?.focus(); }, [call.phase]);
  const live = !['idle', 'ended'].includes(call.phase), seconds = Math.floor(call.remaining / 1000), usage = call.status?.usage;
  return <section className="voice-controls voice-call" aria-label={t('s16.call.title')}>
    <div className="voice-actions"><strong>{t('s16.call.title')}</strong>{!live ? <><button type="button" disabled={!canStart || !call.status?.available || call.pending} onClick={() => void call.start()}>{t('s16.call.start')}</button>{call.pending && <button type="button" onClick={call.recover}>{t('s16.call.recover')}</button>}</> : <>
      {call.microphone && <><span>{t('s16.call.microphone')}</span><button type="button" onClick={call.stop}>{t('s16.call.finish')}</button></>}
      {!['muted', 'paused', 'reconnecting', 'ending'].includes(call.phase) && <button type="button" onClick={call.mute}>{t('s16.call.mute')}</button>}
      {(call.phase === 'speaking' || call.phase === 'thinking') && <button type="button" onClick={call.interrupt}>{t('s16.call.interrupt')}</button>}
      {['muted', 'paused', 'reconnecting'].includes(call.phase) && <><button type="button" onClick={call.recover}>{t('s16.call.recover')}</button><button type="button" disabled={call.view?.turns.some(turn => turn.state === 'unaccepted')} onClick={call.resume}>{t('s16.call.resume')}</button></>}
      <button type="button" onClick={call.end}>{t('s16.call.end')}</button></>}</div>
    {call.phase !== 'idle' && <p role="status" aria-live="polite">{t(`s16.call.phase.${call.phase}` as MessageKey)}{live && call.view && Number.isFinite(call.remaining) && <> · {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</>}</p>}
    {(call.phase === 'review' || call.pending) && <p className="call-target"><small>{t(call.target ? 's16.call.targetWork' : 's16.call.targetMessage')}</small></p>}
    <div className="voice-call-body">
      {(call.phase === 'review' || call.pending) && <div className="voice-draft"><label htmlFor={transcriptId}>{t('s16.call.transcript')}</label><textarea id={transcriptId} ref={transcript} rows={3} value={call.draft} readOnly={call.pending} maxLength={16384} onChange={event => call.setDraft(event.target.value)} /><p>{t('s16.call.review')}</p></div>}
      {call.error && <div role="alert" className="voice-error"><p>{t(call.error === 'voice_no_speech' ? 's16.call.quiet' : call.error === 'voice_budget_exhausted' ? 's16.voice.budget' : 's16.call.failed')}</p><details><summary>{t('s16.common.details')}</summary><code>{call.error}</code></details></div>}
      {live && <small>{t('s16.call.note')}</small>}{(!live || !usage) && <small>{t('s16.call.limits')}</small>}
      {live && usage && <><details><summary>{t('s16.call.usageSummary', { used: (usage.chargedMs / 1000).toFixed(1), limit: (usage.limitMs / 1000).toFixed(0) })}</summary><small>{t('s16.call.limits')}</small><small>{t('s16.voice.usage', { used: (usage.chargedMs / 1000).toFixed(1), reserved: (usage.reservedMs / 1000).toFixed(1), limit: (usage.limitMs / 1000).toFixed(0) })}</small></details>{usage.conservativeMs > 0 && <small>{t('s16.voice.conservative', { seconds: (usage.conservativeMs / 1000).toFixed(1) })}</small>}</>}
      {call.view && !!call.view.turns.length && <details className="call-turns"><summary>{t('s16.call.turns', { count: call.view.turns.length })}</summary><ol>{call.view.turns.map(turn => <li key={turn.ordinal}>{t(`s16.call.turn.${turn.state}` as MessageKey)}{turn.receipt?.contract === 's16-conversation-steer-receipt/v1' && <> · {t(`s16.steer.${turn.receipt.state}` as MessageKey)}</>}</li>)}</ol></details>}
    </div>
    {(call.phase === 'review' || call.pending) && <div className="voice-actions call-confirm"><button type="button" className="primary" onClick={() => void call.send()} disabled={!call.draft.trim() || !['review', 'reconnecting'].includes(call.phase)}>{t(call.pending ? 's16.call.retry' : 's16.call.send')}</button><button type="button" disabled={call.pending && !call.discardable} onClick={call.discard}>{t(call.discardable ? 's16.call.discardUnsent' : 's16.call.discard')}</button></div>}
  </section>;
}
