import type { ConversationReceipt, ConversationSteerReceipt } from '../../s15/conversation/types';
import type { VoicePlaybackCommand } from './contracts';

/** Hard finite local-call bounds; energy detection segments data and never establishes owner intent. */
export const voiceCallLimits = Object.freeze({ durationMs: 600000, turns: 32, retainedCalls: 128, activityRms: 0.015, onsetMs: 160, silenceMs: 900, noSpeechMs: 15000 });
/** Opaque service-owned speech binding. Only current live call revisions may borrow bounded duplex capacity. */
export interface VoiceCallBinding { id: string; revision: number }
/** One confirmed ordinary message/steer identity; acceptance never implies application, completion or effect success. */
export interface VoiceCallTurn {
  ordinal: number; requestId: string; kind: 'message' | 'steer'; target: string | null;
  state: 'unaccepted' | 'accepted' | 'unavailable'; receipt: ConversationReceipt | ConversationSteerReceipt | null;
}
/** Metadata-only current call facts; raw audio, drafts and reply text never enter this projection. */
export interface VoiceCallView {
  contract: 's16-voice-call/v1'; id: string; conversationId: string; revision: number;
  state: 'active' | 'muted' | 'ended'; reason: null | 'owner' | 'timeout' | 'turn_limit' | 'restart' | 'budget' | 'unavailable';
  serverTime: number; expiresAt: number; limits: typeof voiceCallLimits; turns: VoiceCallTurn[];
}
/** Explicit Call press reserves a lifecycle, not work or microphone permission. */
export interface VoiceCallBegin { contract: 's16-voice-call-begin/v1'; requestId: string }
/** Resume needs the exact current revision; mute/end only narrow voice custody. */
export interface VoiceCallControl { contract: 's16-voice-call-control/v1'; revision: number; kind: 'mute' | 'resume' | 'end' }
/** Exact owner Send turn; target null selects ordinary CHAT, otherwise existing same-conversation steering. */
export interface VoiceCallConfirm { contract: 's16-voice-call-turn/v1'; revision: number; ordinal: number; text: string; target: string | null }
/** One existing bounded draft capture belonging to a live call/revision. */
export interface VoiceCallCapture { contract: 's16-voice-call-capture/v1'; revision: number; requestId: string }
/** One existing guarded reply synthesis belonging to this live call/conversation. */
export interface VoiceCallPlayback { contract: 's16-voice-call-playback/v1'; revision: number; request: VoicePlaybackCommand }
