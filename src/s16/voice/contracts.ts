/** Finite owner-client voice support; audio seconds do not measure compute time or provider billing. */
export const voiceLimits = Object.freeze({ captureMs: 30000, permissionMs: 15000, submissionMs: 15000, synthesisMs: 60000, transcriptBytes: 16384, responseCacheBytes: 8 * 1024 * 1024, responseCacheMs: 300000, retentionMs: 7 * 86400000, requestAgeMs: 300000, operations: 4096 });
/** Original request identity embeds its issuance time, so a pruned old command cannot become a fresh capture. */
export function voiceRequestId(serverTime: number): string {
  if (!Number.isSafeInteger(serverTime) || serverTime < 0) throw Error('voice_time_invalid');
  return `v_${serverTime}_${crypto.randomUUID().replaceAll('-', '')}`;
}
/** Explicit local audio budget. Values can narrow, never exceed, published per-operation bounds. */
export interface VoiceQuotaConfig { dailyMs: number; captureMs: number }
/** Metadata-only local quota; unknown processing retains its conservative charge. All milliseconds round up. */
export interface VoiceUsage { day: string; unit: 'local_audio_ms'; limitMs: number; chargedMs: number; reservedMs: number; conservativeMs: number }
/** Capture is a private draft operation, never work/approval. Stop by recordingEndsAt; expiresAt separately bounds submission. */
export interface VoiceCapture { id: string; conversationId: string; state: 'capturing' | 'processing' | 'ready' | 'cancelled' | 'failed' | 'unknown' | 'expired'; recordingEndsAt: number; expiresAt: number; maxDurationMs: number }
/** Read-only configured capability and current local quota; paths, credentials and model data are absent. */
export interface VoiceStatus { contract: 's16-voice/v1'; available: boolean; serverTime: number; route: 'local'; limits: VoiceQuotaConfig; usage: VoiceUsage; calls?: typeof import('./call-contracts').voiceCallLimits }
/** The owner's explicit Mic intent. It starts no conversation request or model operation. */
export interface VoiceCaptureCommand { contract: 's16-voice-capture/v1'; requestId: string }
/** Only the exact currently published result can be synthesized; client text is never the source. */
export interface VoicePlaybackCommand { contract: 's16-voice-playback/v1'; requestId: string; conversationId: string; targetRequestId: string; targetRevision: number; textSha256: string }
/** Editable untrusted draft and its original capture identity. Ordinary Send remains a separate command. */
export interface VoiceTranscript { contract: 's16-voice-transcript/v1'; capture: VoiceCapture; text: string; usage: VoiceUsage }
/** Bounded audio for one currently guarded result; interruption never implies work/effect cancellation. */
export interface VoicePlayback { contract: 's16-voice-playback/v1'; id: string; conversationId: string; targetRequestId: string; wavBase64: string; durationMs: number; usage: VoiceUsage }
