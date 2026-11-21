import { ownerExportLimits, ownerExportSections, parseOwnerExportRequest, validateOwnerExport, type OwnerExport, type OwnerExportRequest } from '../export/contracts';
import { workingStateManifest, workingStateImport, workingStateView, type WorkingStateManifest, type WorkingStateImport, type WorkingStateView } from "./working-state";
import { isVmBackendDescriptor } from "./computer-backend";
import type { SkillCommand, SkillCommandStatus, SkillDependencyBinding, SkillFile, SkillReceipt } from "../skills/types";
import type { SearchItem, SearchKind, SearchLabelCommand, SearchLabelReceipt, SearchPage, SearchQuery, SearchTarget } from '../search/contracts';
import { voiceRequestId, type VoiceCapture, type VoiceCaptureCommand, type VoicePlayback, type VoicePlaybackCommand, type VoiceStatus, type VoiceTranscript } from "../voice/contracts";
import { captureWavInfo, VoiceAudioError } from "../voice/wav";
import { voiceCallLimits, type VoiceCallBegin, type VoiceCallCapture, type VoiceCallConfirm, type VoiceCallControl, type VoiceCallPlayback, type VoiceCallView } from '../voice/call-contracts';
import type { SkillDetail, SkillsView } from "../skills/owner-view";
import type { ComputerNeedsYouCard, ComputerNeedsYouCommand, ComputerNeedsYouResult } from "../computers/needs-you-types";
import type { ClientModelsView } from "./contracts";
import type { BrowserActionCard } from "../computers/browser-cards";
import { clientResponseBytes, type ClientConnectionsView, type ClientConnectionCommand, type ClientConnectionReceipt, type ClientSource, type ClientBotsView, type ClientBotDetail, type ClientBot, type ClientBotProposal, type ClientBotDraft, type ClientBotExport, type ClientBotCommand, type ClientBotReceipt, type ClientNotificationDevice, type ClientNotificationSettings, type ClientNotificationSubscribeCommand, type ClientSteer, type ClientSteerReceipt, type ClientRoutineDetail, type ClientRoutineDraft, type ClientRoutineList, type ClientRoutineOptions, type ClientRoutineProposal, type ClientRoutineReceipt, type ClientArtifactDetail, type ClientArtifactInputCommand, type ClientArtifactItem, type ClientArtifactList, type ClientArtifactQuery, type ClientMemoryCommand, type ClientMemoryDetail, type ClientMemoryList, type ClientMemoryQuery, type ClientMemoryResult, type ClientBootstrap, type ClientDecision, type ClientEvents, type ClientMessage, type ClientReceipt, type ClientRequest, type ClientSnapshot } from "./contracts";
import type { FileArtifact, FileReference, FileUpload, FileUploadCommand } from "../files/types";
import type { ScreenCommand, ScreenCommandResult, ScreenView } from "../computers/screen";
import type { ComputerCommand, ComputerCommandResult, ComputersView } from "../computers/service";
import type { BrowserOwnerControl } from '../../s15/browser';
import type { ProtectedBrowserCommand, ProtectedBrowserResult, ProtectedBrowserView } from '../protected-browser';
import type { NativeNotificationSettings, NativeNotificationDevice, NativeProviderKind } from "../native-notifications/types";
import { nativeToken } from "../mobile/notices";

/** Safe transport failure. An unknown mutation outcome is recovered by its original request identity. */
export class JitClientError extends Error {
  constructor(readonly code: string, readonly status: number | null, readonly outcome: "not_sent" | "unknown" | "response", readonly requestId: string | null = null) { super(code); this.name = "JitClientError"; }
}
/** Fetch injection supports native session adapters and deterministic tests. Native adapters add the
 * authenticated cookie and exact configured Origin on POST; browsers supply Origin themselves. */
export interface JitClientOptions {
  origin: string;
  fetch?: (request: Request) => Promise<Response>;
  /** Native ArrayBuffer-safe binary POST port. Same request/session/redirect guards; bytes are an immutable snapshot. */
  fetchBytes?: (request: Request, bytes: Uint8Array<ArrayBuffer>) => Promise<Response>;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[^A-Za-z0-9_-]/.test(value);
const safeCode = (value: unknown) => typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(value) ? value : "client_unavailable";
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const nullableCount = (value: unknown) => value === null || count(value);
const modelRef = (value: unknown) => record(value) && identifier(value.id) && count(value.revision) && count(value.generation);
const modelChoice = (value: unknown) => record(value) && modelRef(value.route) && modelRef(value.model) && typeof value.effort === "string";
const quantity = (value: unknown) => nullableCount(value) || typeof value === "string" && /^[0-9]+$/.test(value);
const sha256 = (value: unknown) => typeof value === "string" && value.length === 64 && !/[^a-f0-9]/.test(value);
const invalid = (): never => { throw new JitClientError("client_protocol_invalid", null, "response"); };
const id = (value: string) => { if (!identifier(value)) throw new JitClientError("invalid_identity", null, "not_sent"); return value; };
const callLimits = (value: unknown): boolean => record(value) && Object.keys(value).length === Object.keys(voiceCallLimits).length && Object.entries(voiceCallLimits).every(([key, bound]) => value[key] === bound);
const callView = (value: unknown): value is VoiceCallView => {
  if (!record(value) || value.contract !== 's16-voice-call/v1' || !identifier(value.id) || !identifier(value.conversationId) || !count(value.revision) || !value.revision || !count(value.serverTime) || !count(value.expiresAt) || !['active', 'muted', 'ended'].includes(String(value.state)) || !callLimits(value.limits)) return false;
  if (value.state === 'ended' ? !['owner', 'timeout', 'turn_limit', 'restart', 'budget', 'unavailable'].includes(String(value.reason)) : value.reason !== null) return false;
  return Array.isArray(value.turns) && value.turns.length <= voiceCallLimits.turns && value.turns.every((turn, index) => {
    if (!record(turn) || turn.ordinal !== index + 1 || turn.requestId !== `${value.id}_t${index + 1}` || !['message', 'steer'].includes(String(turn.kind)) || (turn.kind === 'message' ? turn.target !== null : !identifier(turn.target)) || !['unaccepted', 'accepted', 'unavailable'].includes(String(turn.state))) return false;
    if (turn.state !== 'accepted') return turn.receipt === null;
    const receipt = turn.receipt;
    if (!record(receipt) || receipt.requestId !== turn.requestId || receipt.conversationId !== value.conversationId) return false;
    return turn.kind === 'message' ? receipt.contract === 's15-conversation-receipt/v1' && identifier(receipt.rootRequestId) && count(receipt.receivedAt)
      : receipt.contract === 's16-conversation-steer-receipt/v1' && receipt.target === turn.target && ['queued', 'sent', 'applied', 'resubmitted', 'unapplied', 'uncertain'].includes(String(receipt.state)) && (receipt.followUp === null || identifier(receipt.followUp));
  });
};

/**
 * Shared Web/native client over the protected Jit service. Sends never auto-retry, redirects are refused,
 * and snapshot/event reads never submit work. CSRF/session material is not part of returned UI state.
 */
export class JitClient {
  readonly origin: string;
  readonly #fetch: (request: Request) => Promise<Response>;
  readonly #fetchBytes: JitClientOptions["fetchBytes"];
  #csrf: string | null = null;
  #sessionGeneration = 0;
  #authenticatedBefore = false;
  #authenticationRevision = 0;
  #authenticationScope: string | null = null;
  constructor(options: JitClientOptions) {
    const url = new URL(options.origin);
    if (!["https:", "http:"].includes(url.protocol) || url.origin !== options.origin || url.username || url.password) throw new JitClientError("client_origin_invalid", null, "not_sent");
    this.origin = url.origin; this.#fetch = options.fetch ?? (request => fetch(request)); this.#fetchBytes = options.fetchBytes;
  }
  /** Read current capabilities/navigation and establish CSRF for explicit subsequent commands. */
  async bootstrap(signal?: AbortSignal): Promise<Omit<ClientBootstrap, "csrf">> {
    const previous = this.#csrf;
    this.clear(); const generation = this.#sessionGeneration;
    const data = await this.call("/bootstrap", "GET", undefined, signal);
    if (generation !== this.#sessionGeneration) throw new JitClientError("client_response_stale", null, "response");
    if (!record(data) || data.contract !== "s16-client-bootstrap/v1" || typeof data.csrf !== "string" || !data.csrf || data.csrf.length > 4096 || !record(data.capabilities) || data.capabilities.contract !== "s16-client-capabilities/v1" || !Array.isArray(data.conversations) || data.conversations.length > 64 || !Array.isArray(data.needsYou) || data.needsYou.length > 1024) return invalid();
    if (data.capabilities.dataExport !== undefined) {
      const capability = data.capabilities.dataExport;
      if (!record(capability) || capability.available !== true || capability.contract !== 's16-owner-export/v1' || !Array.isArray(capability.sections) || !capability.sections.length || new Set(capability.sections).size !== capability.sections.length || !capability.sections.every(section => ownerExportSections.some(known => known === section)) || !record(capability.limits) || Object.keys(capability.limits).length !== Object.keys(ownerExportLimits).length || !Object.entries(ownerExportLimits).every(([key, value]) => (capability.limits as Record<string, unknown>)[key] === value)) return invalid();
    }
    for (const entry of data.conversations) if (!record(entry) || !identifier(entry.conversationId) || typeof entry.firstMessage !== "string" || !Number.isSafeInteger(entry.latestAt)) return invalid();
    if (data.sessionScope !== undefined && (typeof data.sessionScope !== "string" || !/^[a-f0-9]{64}$/.test(data.sessionScope))) return invalid();
    const scope = typeof data.sessionScope === "string" ? data.sessionScope : null;
    if (this.#authenticatedBefore && (scope ? scope !== this.#authenticationScope : previous !== data.csrf)) this.#authenticationRevision++;
    this.#authenticationScope = scope;
    this.#authenticatedBefore = true; this.#csrf = data.csrf;
    const { csrf: _csrf, ...projection } = data as unknown as ClientBootstrap;
    return projection;
  }
  /** Local continuity marker only. A change/lost binding requires private UI revalidation; this conveys no authority or secret. */
  get authenticationRevision(): number { return this.#authenticationRevision; }
  /** Fresh bounded owner download. Auth/source failure is never retried or restored from local storage. */
  async exportData(input: OwnerExportRequest, signal?: AbortSignal): Promise<{ bytes: Uint8Array; value: OwnerExport }> {
    if (!this.#csrf) throw new JitClientError('client_not_initialized', null, 'not_sent');
    if (signal?.aborted) throw new JitClientError('aborted', null, 'not_sent');
    if (!globalThis.crypto?.subtle) throw new JitClientError('client_crypto_unavailable', null, 'not_sent');
    let scope: OwnerExportRequest;
    try { scope = parseOwnerExportRequest(structuredClone(input), ownerExportSections); } catch { throw new JitClientError('invalid_owner_export', null, 'not_sent'); }
    const generation = this.#sessionGeneration; let response: Response;
    try { response = await this.#fetch(new Request(`${this.origin}/api/s16/client/export`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': this.#csrf }, credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', body: JSON.stringify(scope), ...(signal ? { signal } : {}) })); }
    catch { throw new JitClientError(signal?.aborted ? 'aborted' : 'connection_lost', null, 'not_sent'); }
    if (generation !== this.#sessionGeneration) { await response.body?.cancel().catch(() => {}); throw new JitClientError('client_response_stale', response.status, 'response'); }
    if (response.status === 401 || response.status === 403) this.clear();
    if (!response.ok) { const value = await this.json(response, 'GET', null); throw new JitClientError(safeCode(record(value) ? value.error : null), response.status, 'response'); }
    const size = response.headers.get('content-length'), digest = response.headers.get('x-content-sha256');
    if (response.redirected || response.headers.get('content-type') !== 'application/json; charset=utf-8' || response.headers.get('content-disposition') !== 'attachment; filename="jit-export.json"' || !response.headers.get('cache-control')?.includes('no-store') || response.headers.get('x-content-type-options') !== 'nosniff' || !size || !/^[1-9][0-9]{0,7}$/.test(size) || Number(size) > ownerExportLimits.bytes || !sha256(digest)) { await response.body?.cancel().catch(() => {}); return invalid(); }
    const reader = response.body?.getReader(); if (!reader) return invalid(); const bytes = new Uint8Array(Number(size)); let offset = 0;
    try { for (;;) { const chunk = await reader.read();
      if (generation !== this.#sessionGeneration || signal?.aborted) { await reader.cancel().catch(() => {}); throw new JitClientError(signal?.aborted ? 'aborted' : 'client_response_stale', response.status, 'response'); }
      if (chunk.done) break; if (offset + chunk.value.length > bytes.length) { await reader.cancel().catch(() => {}); return invalid(); } bytes.set(chunk.value, offset); offset += chunk.value.length;
    } } finally { reader.releaseLock(); }
    const observed = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (generation !== this.#sessionGeneration || signal?.aborted) throw new JitClientError(signal?.aborted ? 'aborted' : 'client_response_stale', response.status, 'response');
    if (offset !== bytes.length || observed !== digest) return invalid();
    let value: unknown; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); validateOwnerExport(value, scope); } catch { return invalid(); }
    for (const item of value.records) if (item.kind === 'file' || item.kind === 'artifact') {
      const content = item.representation === 'base64' ? Uint8Array.from(atob(item.text!), character => character.charCodeAt(0)) : new TextEncoder().encode(item.text!);
      const checksum = [...new Uint8Array(await crypto.subtle.digest('SHA-256', content))].map(part => part.toString(16).padStart(2, '0')).join('');
      if (checksum !== item.sha256 || content.length !== item.bytes) return invalid();
      if (generation !== this.#sessionGeneration || signal?.aborted) throw new JitClientError(signal?.aborted ? 'aborted' : 'client_response_stale', response.status, 'response');
    }
    return { bytes, value };
  }
  /** Reads current protected-browser custody and sign-in capability; starts no Bot work. */
  async protectedBrowser(signal?: AbortSignal): Promise<ProtectedBrowserView> {
    const data = await this.call('/protected-browser', 'GET', undefined, signal);
    if (!protectedBrowserView(data)) return invalid(); return data;
  }
  /** Visible owner controls contain no entered values. IDs are valid only for this document/takeover. */
  async protectedBrowserControls(generation: number, signal?: AbortSignal): Promise<BrowserOwnerControl[]> {
    if (!count(generation) || !generation) return invalid();
    const data = await this.call(`/protected-browser/controls?generation=${generation}`, 'GET', undefined, signal);
    if (!record(data) || data.contract !== 's16-protected-browser-controls/v1' || data.generation !== generation || !Array.isArray(data.controls) || data.controls.length > 32 || data.controls.some(control => !record(control) || typeof control.id !== 'string' || !/^o[0-9]+_[0-9]+$/.test(control.id) || typeof control.label !== 'string' || control.label.length > 160 || !['text', 'password', 'button'].includes(String(control.kind)))) return invalid();
    return data.controls as BrowserOwnerControl[];
  }
  /** One owner input/control attempt, never automatically retried or stored by the transport. */
  async protectedBrowserCommand(command: ProtectedBrowserCommand, signal?: AbortSignal): Promise<ProtectedBrowserResult> {
    const input = structuredClone(command); id(input.requestId);
    const data = await this.call('/protected-browser/commands', 'POST', input, signal, input.requestId);
    if (!record(data) || data.contract !== 's16-protected-browser-result/v1' || data.requestId !== input.requestId || !protectedBrowserView(data.view)) return invalid();
    return data as unknown as ProtectedBrowserResult;
  }
  /** Owner-only frame. Authentication changes withhold a response that started under an old session. */
  async protectedBrowserFrame(generation: number, signal?: AbortSignal): Promise<Blob> {
    if (!count(generation) || !generation) return invalid();
    const session = this.#sessionGeneration; let response: Response;
    try { response = await this.#fetch(new Request(`${this.origin}/api/s16/client/protected-browser/frame?generation=${generation}`, { credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', ...(signal ? { signal } : {}) })); }
    catch { throw new JitClientError('client_unavailable', null, 'not_sent'); }
    if (session !== this.#sessionGeneration) { await response.body?.cancel().catch(() => {}); throw new JitClientError('client_response_stale', response.status, 'response'); }
    if (response.status === 401 || response.status === 403) this.clear();
    if (!response.ok) { const data = await this.json(response, 'GET', null); throw new JitClientError(safeCode(record(data) ? data.error : null), response.status, 'response'); }
    if (response.headers.get('content-type')?.split(';')[0] !== 'image/png') return invalid();
    const blob = await response.blob();
    if (session !== this.#sessionGeneration) throw new JitClientError('client_response_stale', response.status, 'response');
    if (blob.size < 33 || blob.size > 8 * 1048576) return invalid(); return new Blob([blob], { type: 'image/png' });
  }
  async models(signal?: AbortSignal): Promise<ClientModelsView> {
    const data = await this.call("/models", "GET", undefined, signal);
    if (!record(data) || data.contract !== "s16-client-models/v1" || !Array.isArray(data.routes) || data.routes.length > 64 || !record(data.budget) || !Array.isArray(data.budget.ceilings)) return invalid();
    for (const route of data.routes) if (!record(route) || !modelChoice(route.selection) || !["codex", "grok"].includes(String(route.provider)) || typeof route.modelId !== "string" || typeof route.approved !== "boolean" || !modelRef(route.account) || !modelRef(route.billing) || !modelRef(route.recipient) || !["subscription", "metered"].includes(String(route.charge)) || !["available", "unavailable", "quota"].includes(String(route.availability)) || route.holdCode !== null && typeof route.holdCode !== "string") return invalid();
    for (const ceiling of data.budget.ceilings) if (!record(ceiling) || typeof ceiling.dimension !== "string" || !quantity(ceiling.charged) || !quantity(ceiling.measured) || !quantity(ceiling.ceiling) || typeof ceiling.unknown !== "boolean") return invalid();
    const limits = data.budget.subscriptionLimits;
    if (limits !== null && (!record(limits) || !count(limits.concurrency) || !record(limits.perWork) || ![limits.perWork.calls, limits.perWork.steps, limits.perWork.activeMs].every(count))) return invalid();
    if (!count(data.budget.unsettled)) return invalid();
    return data as unknown as ClientModelsView;
  }
  /** Read configured local speech health/quota without microphone, model or process activity. */
  async voiceStatus(signal?: AbortSignal): Promise<VoiceStatus> {
    const data = await this.call('/voice', 'GET', undefined, signal);
    if (!record(data) || data.contract !== 's16-voice/v1' || typeof data.available !== 'boolean' || data.route !== 'local' || !count(data.serverTime) || !record(data.limits) || !count(data.limits.captureMs) || !count(data.limits.dailyMs) || !this.voiceUsage(data.usage) || data.calls !== undefined && !callLimits(data.calls)) return invalid();
    return data as unknown as VoiceStatus;
  }
  /** Freeze one intentional Mic identity using the service's clock sample, retained through uncertain responses. */
  prepareDictation(serverTime: number): VoiceCaptureCommand { return Object.freeze({ contract: 's16-voice-capture/v1', requestId: voiceRequestId(serverTime) }); }
  /** Explicit reserve only; the caller requests microphone permission separately after seeing this receipt. */
  async beginDictation(conversationId: string, command: VoiceCaptureCommand, signal?: AbortSignal): Promise<VoiceCapture> {
    const input = structuredClone(command); id(conversationId); id(input.requestId);
    const data = await this.call(`/conversations/${conversationId}/voice/captures`, 'POST', input, signal, input.requestId);
    if (!this.voiceCapture(data, input.requestId, conversationId)) return invalid(); return data as unknown as VoiceCapture;
  }
  /** Inspect an original draft; no microphone capture or transcription is reconstructed. */
  async dictationStatus(capture: Pick<VoiceCapture, 'id' | 'conversationId'>, signal?: AbortSignal): Promise<VoiceCapture> {
    const input = structuredClone(capture); id(input.id); id(input.conversationId);
    const data = await this.call(`/voice/${input.id}`, 'GET', undefined, signal);
    if (!this.voiceCapture(data, input.id, input.conversationId)) return invalid(); return data as unknown as VoiceCapture;
  }
  /** Submit strict snapshotted PCM once. The transcript remains editable data; this never calls Send or Decide. */
  async transcribeDictation(capture: Pick<VoiceCapture, 'id' | 'conversationId'>, bytes: Uint8Array, signal?: AbortSignal): Promise<VoiceTranscript> {
    const input = structuredClone(capture), wav = new Uint8Array(bytes); id(input.id); id(input.conversationId);
    try { captureWavInfo(wav); } catch (error) { throw new JitClientError(error instanceof VoiceAudioError ? error.code : 'voice_audio_invalid', null, 'not_sent', input.id); }
    const data = await this.call(`/voice/${input.id}/transcribe`, 'POST', undefined, signal, input.id, wav);
    if (!record(data) || data.contract !== 's16-voice-transcript/v1' || !this.voiceCapture(data.capture, input.id, input.conversationId) || data.capture.state !== 'ready' || typeof data.text !== 'string' || new TextEncoder().encode(data.text).length > 16384 || !this.voiceUsage(data.usage)) return invalid();
    return data as unknown as VoiceTranscript;
  }
  /** Stop only voice; underlying conversation work and exact approval state remain unchanged. */
  async cancelVoice(operation: { id: string; conversationId: string }, signal?: AbortSignal): Promise<VoiceCapture> {
    const input = structuredClone(operation); id(input.id); id(input.conversationId);
    const data = await this.call(`/voice/${input.id}/cancel`, 'POST', {}, signal, input.id);
    if (!this.voiceCapture(data, input.id, input.conversationId) || data.state !== 'cancelled') return invalid(); return data as unknown as VoiceCapture;
  }
  /** Freeze a specific currently displayed reply; hashing is local and does not start synthesis or work. */
  async preparePlayback(serverTime: number, conversationId: string, requestId: string, revision: number, text: string): Promise<VoicePlaybackCommand> {
    const generation = this.#sessionGeneration; id(conversationId); id(requestId);
    if (!count(revision) || !revision || typeof text !== 'string' || !text.trim() || text.length > 2000 || new TextEncoder().encode(text).length > 8192) throw new JitClientError('voice_text_limit', null, 'not_sent');
    const textSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('');
    if (generation !== this.#sessionGeneration) throw new JitClientError('client_response_stale', null, 'not_sent');
    return Object.freeze({ contract: 's16-voice-playback/v1', requestId: voiceRequestId(serverTime), conversationId, targetRequestId: requestId, targetRevision: revision, textSha256 });
  }
  /** Synthesize once; late/stale replies use the same transport generation fences as ordinary owner projections. */
  async playReply(command: VoicePlaybackCommand, signal?: AbortSignal): Promise<VoicePlayback> {
    const input = structuredClone(command); id(input.requestId); id(input.conversationId); id(input.targetRequestId);
    const data = await this.call('/voice/playback', 'POST', input, signal, input.requestId);
    return this.playbackResult(data, input);
  }
  private playbackResult(data: unknown, input: VoicePlaybackCommand): VoicePlayback {
    if (!record(data) || data.contract !== 's16-voice-playback/v1' || data.id !== input.requestId || data.conversationId !== input.conversationId || data.targetRequestId !== input.targetRequestId || !count(data.durationMs) || (data.durationMs as number) > 60000 || typeof data.wavBase64 !== 'string' || data.wavBase64.length > 5592408 || !this.voiceUsage(data.usage)) return invalid();
    try { const decoded = atob(data.wavBase64); if (!decoded.length || decoded.length > 4 * 1024 * 1024 || btoa(decoded) !== data.wavBase64 || decoded.slice(0, 4) !== 'RIFF' || decoded.slice(8, 12) !== 'WAVE') return invalid(); }
    catch { return invalid(); }
    return data as unknown as VoicePlayback;
  }
  /** Freeze one explicit finite Call intent; this starts neither microphone capture nor CHAT work. */
  prepareVoiceCall(serverTime: number): VoiceCallBegin { return Object.freeze({ contract: 's16-voice-call-begin/v1', requestId: voiceRequestId(serverTime) }); }
  /** Current call metadata only; reading never resumes the microphone, sends a turn or synthesizes a reply. */
  async voiceCalls(conversationId: string, signal?: AbortSignal): Promise<VoiceCallView[]> {
    const data = await this.call(`/conversations/${id(conversationId)}/voice/calls`, 'GET', undefined, signal);
    if (!record(data) || data.contract !== 's16-voice-calls/v1' || !Array.isArray(data.calls) || data.calls.length > 8 || !data.calls.every(view => callView(view) && view.conversationId === conversationId)) return invalid();
    return data.calls as VoiceCallView[];
  }
  /** Begin once from an owner gesture; retain the original begin identity through response loss. */
  async beginVoiceCall(conversationId: string, command: VoiceCallBegin, signal?: AbortSignal): Promise<VoiceCallView> {
    const input = structuredClone(command); id(input.requestId); id(conversationId);
    const data = await this.call(`/conversations/${conversationId}/voice/calls`, 'POST', input, signal, input.requestId);
    if (!callView(data) || data.id !== input.requestId || data.conversationId !== conversationId) return invalid(); return data;
  }
  /** Recover the original accepted/unaccepted turn identities without resending audio/text. */
  async voiceCall(callId: string, signal?: AbortSignal): Promise<VoiceCallView> {
    const data = await this.call(`/voice/calls/${id(callId)}`, 'GET', undefined, signal);
    if (!callView(data) || data.id !== callId) return invalid(); return data;
  }
  /** Mute/end narrow voice only. Resume uses the exact displayed revision and never changes CHAT work. */
  async controlVoiceCall(callId: string, command: VoiceCallControl, signal?: AbortSignal): Promise<VoiceCallView> {
    const input = structuredClone(command); id(callId);
    const data = await this.call(`/voice/calls/${callId}/control`, 'POST', input, signal, `${callId}_c${input.revision}_${input.kind}`);
    if (!callView(data) || data.id !== callId) return invalid(); return data;
  }
  /** Freeze the owner's confirmed text/target. The original ordinal stays fixed after an uncertain send. */
  prepareVoiceCallTurn(view: VoiceCallView, text: string, target: string | null): VoiceCallConfirm {
    id(view.id); if (target !== null) id(target);
    if (typeof text !== 'string' || !text.trim() || new TextEncoder().encode(text).length > 16384 || view.turns.length >= voiceCallLimits.turns) throw new JitClientError('invalid_text', null, 'not_sent');
    return Object.freeze({ contract: 's16-voice-call-turn/v1', revision: view.revision, ordinal: view.turns.length + 1, text, target });
  }
  /** One explicit Send turn. A retry must retain the whole command, not create another ordinal. */
  async sendVoiceCallTurn(callId: string, command: VoiceCallConfirm, signal?: AbortSignal): Promise<VoiceCallView> {
    const input = structuredClone(command); id(callId);
    const data = await this.call(`/voice/calls/${callId}/turns`, 'POST', input, signal, `${callId}_t${input.ordinal}`);
    if (!callView(data) || data.id !== callId || !data.turns.some(turn => turn.ordinal === input.ordinal)) return invalid(); return data;
  }
  /** Reserve an existing finite capture for one live call revision; raw capture still uses the fixed worklet. */
  async captureVoiceCall(callId: string, command: VoiceCallCapture, conversationId: string, signal?: AbortSignal): Promise<VoiceCapture> {
    const input = structuredClone(command); id(callId); id(conversationId); id(input.requestId);
    const data = await this.call(`/voice/calls/${callId}/captures`, 'POST', input, signal, input.requestId);
    if (!this.voiceCapture(data, input.requestId, conversationId)) return invalid(); return data;
  }
  /** Guarded synthesis may overlap that call's one listening capture; interruption still never cancels work. */
  async playVoiceCallReply(callId: string, command: VoiceCallPlayback, signal?: AbortSignal): Promise<VoicePlayback> {
    const input = structuredClone(command); id(callId); id(input.request.requestId);
    const data = await this.call(`/voice/calls/${callId}/playback`, 'POST', input, signal, input.request.requestId);
    return this.playbackResult(data, input.request);
  }
  private voiceUsage(value: unknown): boolean { return record(value) && value.unit === 'local_audio_ms' && typeof value.day === 'string' && /^\d{4}-\d\d-\d\d$/.test(value.day) && [value.limitMs, value.chargedMs, value.reservedMs, value.conservativeMs].every(count); }
  private voiceCapture(value: unknown, expectedId: string, conversationId: string): value is VoiceCapture {
    return record(value) && value.id === expectedId && value.conversationId === conversationId && ['capturing', 'processing', 'ready', 'cancelled', 'failed', 'unknown', 'expired'].includes(String(value.state)) && count(value.recordingEndsAt) && count(value.expiresAt) && (value.recordingEndsAt as number) <= (value.expiresAt as number) && count(value.maxDurationMs) && (value.maxDurationMs as number) <= 60000;
  }
  /** Creates one local immutable send identity; callers retain this command through response loss. */
  prepareMessage(conversationId: string, text: string, files: readonly FileReference[] = []): ClientMessage {
    id(conversationId);
    if (typeof text !== "string" || (!text.trim() && (!files.length || text !== "")) || new TextEncoder().encode(text).length > 16384) throw new JitClientError("invalid_text", null, "not_sent");
    if (files.length) {
      if (files.length > 8 || new Set(files.map(file => file.id)).size !== files.length || files.some(file => !identifier(file.id) || !/^[a-f0-9]{64}$/.test(file.sha256))) throw new JitClientError("invalid_file_metadata", null, "not_sent");
      return Object.freeze({ contract: "s16-conversation/v2", requestId: crypto.randomUUID().replaceAll("-", ""), conversationId, text, continuation: null, files: Object.freeze(files.map(file => Object.freeze({ ...file }))) });
    }
    return Object.freeze({ contract: "s15-conversation/v1", requestId: crypto.randomUUID().replaceAll("-", ""), conversationId, text, continuation: null });
  }
  /** Explicitly sends the retained command once. Duplicate recovery uses this same ID and exact body. */
  async send(command: ClientMessage, signal?: AbortSignal): Promise<ClientReceipt> {
    const input = structuredClone(command); id(input.requestId); id(input.conversationId);
    return this.receipt(await this.call(`/conversations/${input.conversationId}/messages`, "POST", input, signal, input.requestId), input);
  }
  /** Fresh guarded snapshot; no queued work is started or replayed by reading. */
  /** Exact explicit owner press. No automatic retry: refresh the durable card after an unknown response. */
  async browserCard(conversationId: string, cardId: string, decision: "approve" | "decline"): Promise<BrowserActionCard> {
    const data = await this.call("/browser-cards/decisions", "POST", { contract: "s16-browser-card-decision/v1", conversationId: id(conversationId), cardId: id(cardId), decision });
    if (!browserCard(data, conversationId) || data.id !== cardId) return invalid();
    return data as unknown as BrowserActionCard;
  }
  /** Exact owner handoff command; chat text never invokes it, and unknown responses are not retried. */
  async needsYou(command: ComputerNeedsYouCommand): Promise<ComputerNeedsYouResult> {
    const input = structuredClone(command); id(input.requestId); id(input.conversationId); id(input.cardId);
    if (input.contract !== "s16-computer-needs-you/v1" || !["watch", "decline"].includes(input.kind) || !count(input.generation)) return invalid();
    const data = await this.call("/needs-you/commands", "POST", input, undefined, input.requestId);
    if (!record(data) || data.contract !== "s16-computer-needs-you-result/v1" || !needsYouCard(data.card, input.conversationId) || data.card.id !== input.cardId || data.screen !== null && (!this.screenView(data.screen) || data.screen.vmId !== data.card.vmId)) return invalid();
    return data as unknown as ComputerNeedsYouResult;
  }
  async snapshot(conversationId: string, signal?: AbortSignal): Promise<ClientSnapshot> {
    const data = await this.call(`/conversations/${id(conversationId)}`, "GET", undefined, signal);
    if (!record(data) || data.contract !== "s16-client-snapshot/v1" || !record(data.conversation) || data.conversation.contract !== "s15.owner-view/v1" || data.conversation.conversationId !== conversationId || !Number.isSafeInteger(data.conversation.cursor) || !Array.isArray(data.conversation.rows) || data.conversation.rows.length > 32 || !Array.isArray(data.conversation.needsYou)) return invalid();
    if (data.modelUsage !== undefined) {
      if (!record(data.modelUsage) || !Array.isArray(data.modelUsage.records) || data.modelUsage.records.length > 128 || typeof data.modelUsage.truncated !== "boolean") return invalid();
      const ids = new Set(data.conversation.rows.map(row => record(row) ? row.requestId : null));
      for (const step of data.modelUsage.records) {
        if (!record(step) || !identifier(step.id) || !ids.has(step.requestId) || typeof step.provider !== "string" || typeof step.model !== "string" || !modelChoice(step.selection) || !record(step.effort) || typeof step.effort.requested !== "string" || !record(step.usage) || !quantity(step.usage.spendMinor) || !nullableCount(step.physicalSends) || !nullableCount(step.refusedSends) || !count(step.reservedCalls) || typeof step.partial !== "boolean") return invalid();
        if (step.tokens !== null && (!record(step.tokens) || !nullableCount(step.tokens.inputTokens) || !nullableCount(step.tokens.outputTokens))) return invalid();
        if (step.effort.attempts !== undefined && (!Array.isArray(step.effort.attempts) || step.effort.attempts.some(value => value !== null && (!record(value) || value.sent !== null && typeof value.sent !== "string" || value.reported !== null && typeof value.reported !== "string")))) return invalid();
      }
    }
    for (const row of data.conversation.rows) if (!record(row) || !identifier(row.requestId) || !Number.isSafeInteger(row.revision) || !record(row.receipt) || row.receipt.conversationId !== conversationId || row.computerContinuation !== undefined && (!record(row.computerContinuation) || !identifier(row.computerContinuation.cardId) || !identifier(row.computerContinuation.originalRequestId))) return invalid();
    if (data.browserCards !== undefined && (!Array.isArray(data.browserCards) || data.browserCards.length > 128 || !data.browserCards.every(card => browserCard(card, conversationId)))) return invalid();
    if (data.needsYouCards !== undefined && (!Array.isArray(data.needsYouCards) || data.needsYouCards.length > 128 || !data.needsYouCards.every(card => needsYouCard(card, conversationId)))) return invalid();
    return data as unknown as ClientSnapshot;
  }
  /** Recovers a retained send by ID, including outside the recent conversation window; never resends. */
  async request(requestId: string, signal?: AbortSignal): Promise<ClientRequest> {
    const data = await this.call(`/requests/${id(requestId)}`, "GET", undefined, signal);
    if (!record(data) || data.contract !== "s16-client-request/v1" || !identifier(data.conversationId) || !record(data.receipt) || !record(data.row) || !identifier(data.row.requestId) || data.row.requestId !== data.receipt.rootRequestId || !record(data.row.receipt) || data.row.receipt.rootRequestId !== data.row.requestId || data.row.receipt.conversationId !== data.conversationId) return invalid();
    this.receipt(data.receipt, { requestId, conversationId: data.conversationId });
    return data as unknown as ClientRequest;
  }
  /** Metadata invalidates snapshots; only a fresh snapshot can supply result/evidence/approval content. */
  async events(conversationId: string, after: number, signal?: AbortSignal): Promise<ClientEvents> {
    id(conversationId);
    if (!Number.isSafeInteger(after) || after < 0) throw new JitClientError("cursor_invalid", null, "not_sent");
    const data = await this.call(`/conversations/${conversationId}/events?after=${after}`, "GET", undefined, signal);
    if (!record(data) || data.contract !== "s16-client-events/v1" || data.conversationId !== conversationId || !Number.isSafeInteger(data.cursor) || (data.cursor as number) < after || !Array.isArray(data.events) || data.events.length > 64) return invalid();
    let cursor = after;
    for (const event of data.events) {
      if (!record(event) || event.conversationId !== conversationId || !identifier(event.requestId) || !Number.isSafeInteger(event.sequence) || (event.sequence as number) <= cursor) return invalid();
      cursor = event.sequence as number;
    }
    if (data.cursor !== cursor) return invalid();
    return data as unknown as ClientEvents;
  }
  /** Protected native setup only; configuration and OS subscription are not proof of physical delivery. */
  async nativeNotificationSettings(signal?: AbortSignal): Promise<NativeNotificationSettings> {
    const data = await this.call("/native-notifications", "GET", undefined, signal);
    if (!record(data) || data.contract !== "s16-native-notifications/v1" || !sha256(data.service) || !count(data.devices) || (data.devices as number) > 20 || data.limit !== 20 || !Array.isArray(data.providers) || data.providers.length < 1 || data.providers.length > 2 || new Set(data.providers.map(provider => record(provider) ? provider.provider : null)).size !== data.providers.length || data.providers.some(provider => !record(provider) || !["apns", "fcm"].includes(String(provider.provider)) || typeof provider.available !== "boolean" || (provider.available ? provider.code !== null : provider.code !== "native_push_credentials_unavailable"))) return invalid();
    if (typeof data.service !== "string" || data.service.length !== 64) return invalid();
    return { contract: "s16-native-notifications/v1", service: data.service, devices: data.devices as number, limit: 20, providers: data.providers.map(provider => ({ provider: provider.provider, available: provider.available, code: provider.code })) };
  }
  /** Original OS token hash lookup. No registration or work starts from a settings restoration. */
  async nativeNotificationDevice(hash: string, signal?: AbortSignal): Promise<NativeNotificationDevice> {
    if (!sha256(hash) || hash.length !== 64) throw new JitClientError("native_push_token_invalid", null, "not_sent");
    return this.nativeDevice(await this.call(`/native-notifications/devices/${hash}`, "GET", undefined, signal));
  }
  /** One explicit notification opt-in or disable; uncertain replies are recovered by read-only device lookup. */
  async nativeNotificationSubscription(kind: "subscribe" | "unsubscribe", command: { provider: NativeProviderKind; token: string; locale?: "en" | "th" }, signal?: AbortSignal): Promise<NativeNotificationDevice> {
    const input = structuredClone(command); nativeToken(input.provider, input.token);
    if (!["subscribe", "unsubscribe"].includes(kind) || kind === "subscribe" && !["en", "th"].includes(String(input.locale))) throw new JitClientError("invalid_native_notification_command", null, "not_sent");
    return this.nativeDevice(await this.call(`/native-notifications/${kind}`, "POST", kind === "subscribe" ? { provider: input.provider, token: input.token, locale: input.locale } : { provider: input.provider, token: input.token }, signal));
  }
  private nativeDevice(data: unknown): NativeNotificationDevice {
    if (!record(data) || data.contract !== "s16-native-notification-device/v1" || typeof data.subscribed !== "boolean" || Object.keys(data).sort().join() !== "contract,subscribed") return invalid();
    return data as unknown as NativeNotificationDevice;
  }
  /** Stops only the named work. The acknowledgement does not certify external process/effect settlement. */
  async stop(requestId: string, signal?: AbortSignal): Promise<void> {
    const data = await this.call(`/requests/${id(requestId)}/stop`, "POST", {}, signal, requestId);
    if (!record(data) || data.state !== "stop_requested") throw new JitClientError("client_protocol_invalid", null, "unknown", requestId);
  }
  /** Creates one local immutable steer identity for an unfinished request; retain it through response loss. */
  prepareSteer(conversationId: string, target: string, text: string): ClientSteer {
    id(conversationId); id(target);
    if (typeof text !== "string" || !text.trim() || new TextEncoder().encode(text).length > 16384) throw new JitClientError("invalid_text", null, "not_sent");
    return Object.freeze({ contract: "s16-conversation-steer/v1", requestId: crypto.randomUUID().replaceAll("-", ""), conversationId, target, text });
  }
  /** Sends the retained steer once; a repeat with the same ID returns that steer's current disposition. */
  async steer(command: ClientSteer, signal?: AbortSignal): Promise<ClientSteerReceipt> {
    const input = structuredClone(command); id(input.requestId); id(input.conversationId); id(input.target);
    const data = await this.call(`/conversations/${input.conversationId}/steers`, "POST", input, signal, input.requestId);
    if (!record(data) || data.contract !== "s16-conversation-steer-receipt/v1" || data.requestId !== input.requestId || data.conversationId !== input.conversationId || data.target !== input.target || typeof data.state !== "string") throw new JitClientError("client_protocol_invalid", null, "unknown", input.requestId);
    return data as unknown as ClientSteerReceipt;
  }
  /** Explicit exact-slip command; never auto-refreshes an action revision or repeats a decision. */
  async decide(command: ClientDecision, signal?: AbortSignal): Promise<ClientReceipt> {
    const input = structuredClone(command); id(input.requestId); id(input.conversationId);
    return this.receipt(await this.call(`/conversations/${input.conversationId}/decisions`, "POST", input, signal, input.requestId), input);
  }
  /** Commit metadata once. Retain input.requestId until the original upload identity is recovered. */
  async createUpload(command: FileUploadCommand, signal?: AbortSignal): Promise<FileUpload> {
    const input = structuredClone(command); id(input.requestId); id(input.conversationId);
    return this.uploadResponse(await this.call(`/conversations/${input.conversationId}/uploads`, "POST", input, signal, input.requestId), input.requestId);
  }
  /** Read the original creation after response loss, scoped to the current conversation and request ID. */
  async uploadCreation(conversationId: string, requestId: string, signal?: AbortSignal): Promise<FileUpload> {
    const upload = this.uploadResponse(await this.call(`/conversations/${id(conversationId)}/uploads/commands/${id(requestId)}`, "GET", undefined, signal), requestId);
    if (upload.conversationId !== conversationId) return invalid();
    return upload;
  }
  /** Stream exact bytes once; an uncertain reply is recovered with uploadStatus, never automatic replay. */
  async uploadBytes(uploadId: string, bytes: Uint8Array, signal?: AbortSignal): Promise<FileUpload> {
    const input = new Uint8Array(bytes);
    return this.uploadResponse(await this.call(`/uploads/${id(uploadId)}/bytes`, "POST", undefined, signal, uploadId, input), undefined, uploadId, true);
  }
  /** Recover lifecycle without creating a new upload or starting work. */
  async uploadStatus(uploadId: string, signal?: AbortSignal): Promise<FileUpload> {
    return this.uploadResponse(await this.call(`/uploads/${id(uploadId)}`, "GET", undefined, signal), undefined, uploadId);
  }
  /** Cancel staging or withdraw a source and its future publications; never restarts a transfer. */
  async withdrawUpload(uploadId: string, signal?: AbortSignal): Promise<FileUpload> {
    return this.uploadResponse(await this.call(`/uploads/${id(uploadId)}/withdraw`, "POST", {}, signal, uploadId), undefined, uploadId, true);
  }
  /** Cookie-authenticated, freshly guarded attachment route; no bearer token or host path enters the URL. */
  artifactUrl(requestId: string, artifactId: string): string { return `${this.origin}/api/s16/client/requests/${id(requestId)}/artifacts/${id(artifactId)}`; }
  /** Reacquire publication permission and verify exact bounded immutable bytes before preview/download. */
  async artifactBytes(artifact: FileArtifact, signal?: AbortSignal): Promise<Uint8Array> {
    const generation = this.#sessionGeneration;
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > 1024 * 1024 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) return invalid();
    let response: Response;
    try { response = await this.#fetch(new Request(this.artifactUrl(artifact.requestId, artifact.id), { credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", ...(signal ? { signal } : {}) })); }
    catch { throw new JitClientError("connection_lost", null, "not_sent"); }
    if (generation !== this.#sessionGeneration) { await response.body?.cancel().catch(() => {}); throw new JitClientError("client_response_stale", response.status, "response"); }
    if (response.status === 401 || response.status === 403) {
      this.clear(); const current = this.#sessionGeneration;
      let code = response.status === 401 ? "authentication_required" : "authorization_required";
      try { const data = await this.json(response, "GET", null); const reason = safeCode(record(data) ? data.error : null); if (reason !== "client_unavailable") code = reason; } catch { /* The status still establishes that private content must be withheld. */ }
      if (current !== this.#sessionGeneration) throw new JitClientError("client_response_stale", response.status, "response");
      throw new JitClientError(code, response.status, "response");
    }
    if (!response.ok || response.redirected || response.headers.get("content-type") !== "application/octet-stream" || response.headers.get("x-content-sha256") !== artifact.sha256) { await response.body?.cancel(); throw new JitClientError("artifact_unavailable", response.status, "response"); }
    const reader = response.body?.getReader(); if (!reader) return invalid();
    const bytes = new Uint8Array(artifact.bytes); let offset = 0;
    try { for (;;) { const value = await reader.read(); if (value.done) break; if (offset + value.value.length > bytes.length) { await reader.cancel(); return invalid(); } bytes.set(value.value, offset); offset += value.value.length; } }
    finally { reader.releaseLock(); }
    const checksum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
    if (signal?.aborted) throw new JitClientError("aborted", null, "not_sent");
    if (generation !== this.#sessionGeneration) throw new JitClientError("client_response_stale", response.status, "response");
    if (offset !== artifact.bytes || checksum !== artifact.sha256) return invalid();
    return bytes;
  }
  /** Same-origin, script-free HTML viewer URL for an iframe; the server refuses any other request context. */
  artifactPreviewUrl(artifact: FileArtifact): string { return `${this.artifactUrl(artifact.requestId, artifact.id)}/preview`; }
  /** Current library page. Reading never changes an artifact, its sources or its publication. */
  async artifacts(query: ClientArtifactQuery, signal?: AbortSignal): Promise<ClientArtifactList> {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q); if (query.type !== "all") params.set("type", query.type);
    if (query.conversation !== null) params.set("conversation", id(query.conversation)); if (query.before !== null) params.set("before", query.before);
    const data = await this.call(`/artifacts${params.size ? "?" + params : ""}`, "GET", undefined, signal);
    const echo = record(data) ? data.query : null;
    if (!record(data) || data.contract !== "s16-client-artifacts/v1" || !record(echo) || echo.q !== query.q || echo.type !== query.type || echo.conversation !== query.conversation || echo.before !== query.before || data.limit !== 50
      || !Array.isArray(data.items) || data.items.length > 50 || data.items.some(item => !this.artifactItem(item)) || data.next !== null && (typeof data.next !== "string" || !/^\d{1,16}\.[A-Za-z0-9_-]{1,128}$/.test(data.next))) return invalid();
    return data as unknown as ClientArtifactList;
  }
  /** Fresh provenance/revision detail for one committed artifact. */
  async artifact(artifactId: string, signal?: AbortSignal): Promise<ClientArtifactDetail> {
    const data = await this.call(`/artifacts/${id(artifactId)}`, "GET", undefined, signal);
    if (!record(data) || data.contract !== "s16-client-artifact/v1" || !this.artifactItem(data.item) || (data.item as unknown as ClientArtifactItem).artifact.id !== artifactId || !["escaped_text", "sandboxed_html"].includes(data.preview as string)
      || !Array.isArray(data.inputs) || data.inputs.length > 8 || data.inputs.some(input => !record(input) || !identifier(input.id) || typeof input.name !== "string" || typeof input.mime !== "string" || !count(input.bytes) || !sha256(input.sha256) || input.origin !== null && !identifier(input.origin))
      || !Array.isArray(data.revisions) || data.revisions.length > 256 || data.revisions.some(item => !this.artifactItem(item)) || !Number.isSafeInteger(data.familyTotal) || (data.familyTotal as number) < data.revisions.length) return invalid();
    return data as unknown as ClientArtifactDetail;
  }
  /**
   * Explicitly copy one exact committed artifact into a ready input of its conversation. It starts no work;
   * the owner still sends a message. An unknown outcome may resend the same command: the service returns the
   * original input for the same request ID and refuses a changed payload.
   */
  async artifactInput(artifactId: string, command: ClientArtifactInputCommand, signal?: AbortSignal): Promise<FileUpload> {
    const input = structuredClone(command); id(artifactId); id(input.requestId); id(input.conversationId);
    if (!sha256(input.sha256)) throw new JitClientError("invalid_file_metadata", null, "not_sent", input.requestId);
    const upload = this.uploadResponse(await this.call(`/artifacts/${artifactId}/inputs`, "POST", input, signal, input.requestId), input.requestId);
    if (upload.conversationId !== input.conversationId || upload.state === "ready" && upload.receipt?.sha256 !== input.sha256) throw new JitClientError("client_protocol_invalid", null, "unknown", input.requestId);
    return upload;
  }
  private artifactItem(value: unknown): boolean {
    if (!record(value) || !record(value.artifact)) return false;
    const artifact = value.artifact;
    return artifact.contract === "s16-file-artifact/v1" && identifier(artifact.id) && sha256(artifact.sha256) && identifier(artifact.requestId) && identifier(artifact.workId) && identifier(artifact.conversationId) && artifact.conversationId === value.conversationId
      && typeof artifact.name === "string" && !!artifact.name && ["text/plain", "text/markdown", "text/csv", "text/html"].includes(artifact.mime as string) && Number.isSafeInteger(artifact.bytes) && (artifact.bytes as number) > 0 && count(artifact.createdAt)
      && typeof value.label === "string" && Array.from(value.label).length <= 120 && Number.isSafeInteger(value.revision) && (value.revision as number) >= 1 && (value.parent === null || identifier(value.parent)) && Number.isSafeInteger(value.inputs) && (value.inputs as number) >= 1;
  }
  private searchItem(value: unknown): value is SearchItem {
    if (!record(value) || !record(value.target) || !['history', 'work', 'routine', 'memory', 'artifact'].includes(value.target.kind as string) || !identifier(value.target.id) || typeof value.title !== 'string' || Array.from(value.title).length > 120 || typeof value.snippet !== 'string' || Array.from(value.snippet).length > 280 || typeof value.state !== 'string' || !/^[a-z_]{1,64}$/.test(value.state) || !count(value.at) || value.botId !== null && !identifier(value.botId) || !record(value.organization) || !count(value.organization.revision) || !this.searchLabelValues(value.organization.labels) || !record(value.source)) return false;
    return ['history', 'work'].includes(value.target.kind as string) ? value.source.kind === 'chat' && identifier(value.source.conversationId) && identifier(value.source.requestId)
      : value.source.kind === value.target.kind && value.source.id === value.target.id;
  }
  private searchLabelValues(value: unknown): value is string[] {
    return Array.isArray(value) && value.length <= 8 && new Set(value).size === value.length && value.every(label => typeof label === 'string' && !!label && label.isWellFormed() && Array.from(label).length <= 48 && new TextEncoder().encode(label).length <= 192 && !/[\p{Cc}\p{Cf}]/u.test(label));
  }
  /** Cross-object live search. A page contains current owner projections, never an authority token. */
  async search(query: SearchQuery, signal?: AbortSignal): Promise<SearchPage> {
    const params = new URLSearchParams();
    params.set('q', query.q); params.set('kind', query.kind);
    if (query.bot !== null) params.set('bot', id(query.bot)); if (query.label !== null) params.set('label', query.label);
    if (query.from !== null) params.set('from', String(query.from)); if (query.to !== null) params.set('to', String(query.to)); if (query.after !== null) params.set('after', query.after);
    const data = await this.call('/search?' + params, 'GET', undefined, signal);
    if (!record(data) || data.contract !== 's16-client-search/v1' || !record(data.query) || Object.keys(query).some(key => data.query && (data.query as Record<string, unknown>)[key] !== query[key as keyof SearchQuery]) || !count(data.total) || (data.total as number) > 10000 || data.limit !== 25 || !Array.isArray(data.items) || data.items.length > 25 || !data.items.every(item => this.searchItem(item)) || new Set(data.items.map(item => `${item.target.kind}:${item.target.id}`)).size !== data.items.length || data.next !== null && (typeof data.next !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(data.next) || data.next === query.after) || !Array.isArray(data.labels) || data.labels.length > 128 || !data.labels.every(label => record(label) && this.searchLabelValues([label.name]) && count(label.count) && (label.count as number) <= 10000)) return invalid();
    return data as unknown as SearchPage;
  }
  /** Resolves a stale result freshly before the caller enters its ordinary owning destination. */
  async searchObject(target: SearchTarget, signal?: AbortSignal): Promise<SearchItem> {
    const kinds: SearchKind[] = ['history', 'work', 'routine', 'memory', 'artifact']; if (!kinds.includes(target.kind)) return invalid();
    const data = await this.call(`/search/objects/${target.kind}/${id(target.id)}`, 'GET', undefined, signal);
    if (!this.searchItem(data) || data.target.kind !== target.kind || data.target.id !== target.id) return invalid();
    return data;
  }
  private searchReceipt(value: unknown, requestId: string): SearchLabelReceipt {
    if (!record(value) || value.contract !== 's16-search-label-receipt/v1' || value.requestId !== requestId || !record(value.target) || !['history', 'work', 'routine', 'memory', 'artifact'].includes(value.target.kind as string) || !identifier(value.target.id) || !count(value.appliedRevision) || value.appliedRevision === 0 || !record(value.current) || !count(value.current.revision) || (value.current.revision as number) < (value.appliedRevision as number) || !this.searchLabelValues(value.current.labels)) return invalid();
    return value as unknown as SearchLabelReceipt;
  }
  /** Exact label command. Unknown outcomes retain this request ID; no automatic replacement command. */
  async setSearchLabels(command: SearchLabelCommand, signal?: AbortSignal): Promise<SearchLabelReceipt> {
    const value = this.searchReceipt(await this.call('/search/labels', 'POST', command, signal, id(command.requestId)), command.requestId);
    if (value.target.kind !== command.target.kind || value.target.id !== command.target.id) return invalid();
    return value;
  }
  /** Original command read-back after response loss or reconnect. Never repeats a label mutation. */
  async searchLabelReceipt(requestId: string, signal?: AbortSignal): Promise<SearchLabelReceipt> {
    return this.searchReceipt(await this.call(`/search/commands/${id(requestId)}`, 'GET', undefined, signal), requestId);
  }
  /** Owner memory search; reading never changes retrieval, ranking or retention. */
  async memory(query: ClientMemoryQuery, signal?: AbortSignal): Promise<ClientMemoryList> {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q); if (query.kind !== "all") params.set("kind", query.kind); if (query.category !== "all") params.set("category", query.category);
    if (query.state !== "active") params.set("state", query.state); if (query.bot !== null) params.set("bot", id(query.bot)); if (query.offset) params.set("offset", String(query.offset));
    const data = await this.call(`/memory${params.size ? "?" + params : ""}`, "GET", undefined, signal);
    const echo = record(data) ? data.query : null;
    if (!record(data) || data.contract !== "s16-client-memory/v1" || !record(echo) || typeof echo.q !== "string" || !["all", "fact", "inference"].includes(echo.kind as string) || !["all", "fact", "preference", "working_knowledge"].includes(echo.category as string) || !["active", "inactive", "all"].includes(echo.state as string) || echo.bot !== null && !identifier(echo.bot) || !count(echo.offset) || !count(data.total) || data.limit !== 50 || !Array.isArray(data.items) || data.items.length > 50 || !Array.isArray(data.bots) || data.bots.some(bot => !identifier(bot))) return invalid();
    for (const entry of data.items) if (!this.memoryItem(entry)) return invalid();
    return data as unknown as ClientMemoryList;
  }
  /** Fresh owner detail for one item, including file-source state and correction chain labels. */
  async memoryDetail(claimId: string, signal?: AbortSignal): Promise<ClientMemoryDetail> {
    const data = await this.call(`/memory/${id(claimId)}`, "GET", undefined, signal);
    const uses = record(data) ? data.uses : null;
    if (!record(data) || data.contract !== "s16-client-memory-detail/v1" || !this.memoryItem(data.item) || data.item.id !== claimId || typeof data.item.text !== "string" || typeof data.item.quote !== "string" || data.item.text.length > 2048 || data.item.quote.length > 2048
      || !Array.isArray(data.files) || data.files.length > 128 || data.files.some(file => !record(file) || !identifier(file.sourceId) || !sha256(file.sha256) || file.representationSha256 !== null && !sha256(file.representationSha256) || typeof file.current !== "boolean")
      || !Array.isArray(data.chain) || data.chain.length > 64 || data.chain.some(entry => !this.memoryItem(entry)) || !record(uses) || !["contexts", "summaries", "artifacts", "workItems"].every(key => count(uses[key]))) return invalid();
    return data as unknown as ClientMemoryDetail;
  }
  /**
   * Explicit exact-revision memory command. It never retries. After an unknown outcome the caller may
   * send the same retained command again: MEM returns the original receipt or refuses a changed payload.
   */
  async memoryCommand(command: ClientMemoryCommand, signal?: AbortSignal): Promise<ClientMemoryResult> {
    const input = structuredClone(command); id(input.requestId); id(input.claim.id);
    if (input.contract !== "s15-memory-command/v1" || !Number.isSafeInteger(input.claim.revision) || input.claim.revision < 1 || input.kind === "memory.correct" && (typeof input.text !== "string" || !input.text.trim() || input.text.length > 2048)) throw new JitClientError("invalid_memory_command", null, "not_sent", input.requestId);
    const data = await this.call("/memory/commands", "POST", input, signal, input.requestId);
    const unknown = () => new JitClientError("client_protocol_invalid", null, input.kind === "memory.impact" ? "response" : "unknown", input.requestId);
    const impact = record(data) ? data.impact : null;
    if (!record(data) || !record(impact) || !["claims", "sources", "summaries", "artifacts", "contexts", "nativeSessions", "workItems"].every(key => count(impact[key])) || !record(data.claim) && data.claim !== null || record(data.claim) && (!identifier(data.claim.id) || !Number.isSafeInteger(data.claim.revision) || (data.claim.revision as number) < 1)) throw unknown();
    if (input.kind === "memory.impact") { if (data.contract !== "s15-memory-impact/v1" || !record(data.claim) || data.claim.id !== input.claim.id || data.claim.revision !== input.claim.revision) throw unknown(); }
    else if (data.contract !== "s15-memory-receipt/v1" || data.requestId !== input.requestId || data.kind !== input.kind || input.kind === "memory.correct" && (!record(data.claim) || !identifier(data.claim.id))) throw unknown();
    return data as unknown as ClientMemoryResult;
  }
  /** Complete item shape check, so malformed data fails as `client_protocol_invalid` instead of rendering. */
  private memoryItem(value: unknown): value is Record<string, unknown> {
    if (!record(value) || !identifier(value.id) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) return false;
    const scope = value.scope, source = value.source, link = (entry: unknown) => entry === null || identifier(entry);
    return ["fact", "inference"].includes(value.kind as string) && ["fact", "preference", "working_knowledge"].includes(value.category as string) && ["owner_stated", "observed", "unconfirmed"].includes(value.confirmation as string)
      && ["active", "superseded", "forgotten", "withdrawn"].includes(value.state as string) && typeof value.snippet === "string" && Array.from(value.snippet).length <= 280
      && record(scope) && (scope.kind === "team" && Object.keys(scope).length === 1 || scope.kind === "bot" && identifier(scope.botId))
      && record(source) && ["owner_message", "work", "historical"].includes(source.kind as string) && (source.conversationId === null || identifier(source.conversationId)) && count(source.at) && count(source.files)
      && link(value.supersedes) && link(value.correction) && count(value.createdAt) && (value.lastUsedAt === null || count(value.lastUsedAt)) && count(value.contexts);
  }
  /** BOT16-01 owner Bots page: profiles, pending proposals and route/resource choices. Reading changes nothing. */
  async bots(signal?: AbortSignal): Promise<ClientBotsView> {
    const data = await this.call("/bots", "GET", undefined, signal);
    if (!record(data) || data.contract !== "s16-client-bots/v1" || !Array.isArray(data.bots) || data.bots.length > 64 || !data.bots.every(bot => this.botView(bot)) || !Array.isArray(data.proposals) || data.proposals.length > 64 || !data.proposals.every(p => this.botProposal(p)) || !Array.isArray(data.selections) || !Array.isArray(data.resources) || !record(data.creation)) return invalid();
    return data as unknown as ClientBotsView;
  }
  /** One Bot with its recent conversations and what archiving it would stop and pause. */
  async bot(botId: string, signal?: AbortSignal): Promise<ClientBotDetail> {
    const data = await this.call(`/bots/${id(botId)}`, "GET", undefined, signal);
    if (!record(data) || data.contract !== "s16-client-bot/v1" || !this.botView(data.bot) || !Array.isArray(data.conversations) || !record(data.impact) || !Array.isArray(data.impact.running) || !Array.isArray(data.impact.routines)) return invalid();
    return data as unknown as ClientBotDetail;
  }
  /** Credential-free configuration export of one Bot. */
  async botExport(botId: string, signal?: AbortSignal): Promise<ClientBotExport> {
    const data = await this.call(`/bots/${id(botId)}/export`, "GET", undefined, signal);
    if (!record(data) || data.contract !== "s16-bot-export/v1" || typeof data.name !== "string") return invalid();
    return data as unknown as ClientBotExport;
  }
  /** A new exact proposal from the owner's form or an edited card. Nothing is created until it is accepted. */
  async proposeBot(draft: ClientBotDraft, signal?: AbortSignal): Promise<ClientBotProposal> { return this.proposal(await this.call("/bots/proposals", "POST", { draft: structuredClone(draft) }, signal)); }
  /** Duplicate copies configuration only, as a new proposal. */
  async duplicateBot(botId: string, name: string, signal?: AbortSignal): Promise<ClientBotProposal> { return this.proposal(await this.call(`/bots/${id(botId)}/duplicate`, "POST", { name }, signal)); }
  /** Import turns an exported file into a new proposal; references this installation lacks are listed. */
  async importBot(value: unknown, signal?: AbortSignal): Promise<ClientBotProposal> { return this.proposal(await this.call("/bots/imports", "POST", { export: value }, signal)); }
  /** Exact owner Bot command. It never retries; after an unknown outcome resend the same command (same `requestId`). */
  async botCommand(command: ClientBotCommand, signal?: AbortSignal): Promise<ClientBotReceipt> {
    const input = structuredClone(command);
    if (input.contract !== "s16-bot-command/v1" || !identifier(input.requestId)) throw new JitClientError("invalid_bot_command", null, "not_sent", input.requestId);
    const data = await this.call("/bots/commands", "POST", input, signal, input.requestId);
    if (!record(data) || data.contract !== "s16-bot-receipt/v1" || data.requestId !== input.requestId || data.kind !== input.kind || data.bot !== null && !this.botView(data.bot) || data.proposal !== null && !this.botProposal(data.proposal)) throw new JitClientError("client_protocol_invalid", null, "unknown", input.requestId);
    return data as unknown as ClientBotReceipt;
  }
  private proposal(data: unknown): ClientBotProposal { if (!this.botProposal(data)) return invalid(); return data; }
  private botView(value: unknown): value is ClientBot {
    return record(value) && identifier(value.id) && count(value.revision) && ["main", "configured", "created"].includes(value.origin as string) && typeof value.main === "boolean" && typeof value.name === "string" && typeof value.responsibility === "string"
      && ["active", "archived"].includes(value.state as string) && typeof value.assignments === "boolean" && Array.isArray(value.excluded) && value.excluded.every(identifier);
  }
  private botProposal(value: unknown): value is ClientBotProposal {
    return record(value) && value.contract === "s16-bot-proposal/v1" && identifier(value.id) && sha256(value.proposalHash) && record(value.draft) && value.draft.contract === "s16-bot-draft/v1" && typeof value.draft.name === "string"
      && ["pending", "accepted", "dismissed"].includes(value.state as string) && Array.isArray(value.resources) && Array.isArray(value.missing) && record(value.source);
  }
  /** SKILL16-01 owner catalog; reading it never imports, activates or executes a package. */
  async skills(signal?: AbortSignal): Promise<SkillsView> {
    const data = await this.call("/skills", "GET", undefined, signal);
    if (!record(data) || data.contract !== "s16-client-skills/v1" || !Array.isArray(data.items) || data.items.length > 64 || !data.items.every(item => record(item) && this.skillRecord(item.record) && typeof item.name === "string" && typeof item.description === "string") || !Array.isArray(data.bots) || !data.bots.every(bot => record(bot) && identifier(bot.id) && typeof bot.name === "string") || !Array.isArray(data.dependencies) || !data.dependencies.every(dep => record(dep) && identifier(dep.id) && typeof dep.endpoint === "string" && typeof dep.label === "string") || !record(data.limits)) return invalid();
    return data as unknown as SkillsView;
  }
  /** Exact bounded package metadata/parts/license preview; file bytes are requested separately. */
  async skill(skillId: string, signal?: AbortSignal): Promise<SkillDetail> {
    const data = await this.call(`/skills/${id(skillId)}`, "GET", undefined, signal);
    if (!record(data) || data.contract !== "s16-client-skill/v1" || !this.skillRecord(data.record) || data.record.id !== skillId || !count(data.releasedCopies)) return invalid();
    for (const pkg of [data.active, data.candidate]) if (pkg !== null && (!record(pkg) || pkg.contract !== "s16-skill-package/v1" || !sha256(pkg.pin) || typeof pkg.name !== "string" || !Array.isArray(pkg.files) || pkg.files.length > 128 || !pkg.files.every(file => record(file) && typeof file.path === "string" && sha256(file.sha256) && count(file.bytes)) || !Array.isArray(pkg.units) || pkg.units.length > 16 || !pkg.units.every(unit => record(unit) && identifier(unit.id) && typeof unit.name === "string" && typeof unit.description === "string" && typeof unit.userOnly === "boolean") || !Array.isArray(pkg.dependencies) || !Array.isArray(pkg.scripts) || !Array.isArray(pkg.unsupported) || !Array.isArray(pkg.licenseFiles) || !record(pkg.origin))) return invalid();
    return data as unknown as SkillDetail;
  }
  /** Literal current package file for escaped owner preview. A path never addresses the controller filesystem. */
  async skillFile(skillId: string, pin: string, path: string, signal?: AbortSignal): Promise<SkillFile> {
    if (!sha256(pin)) return invalid(); const data = await this.call(`/skills/${id(skillId)}/files?pin=${encodeURIComponent(pin)}&path=${encodeURIComponent(path)}`, "GET", undefined, signal);
    if (!record(data) || data.path !== path || !sha256(data.sha256) || !count(data.bytes) || (data.bytes as number) > 65536 || typeof data.base64 !== "string" || data.base64.length > 87384) return invalid(); return data as unknown as SkillFile;
  }
  /** Read-only exact recipient preview. The hash is supplied with the later explicit owner review. */
  async skillRecipients(skillId: string, pin: string, dependencies: Record<string, SkillDependencyBinding>, signal?: AbortSignal): Promise<{ hash: string; recipients: { id: string; revision: number; generation: number }[] }> {
    const data = await this.call(`/skills/${id(skillId)}/review-preview`, "POST", { pin, dependencies }, signal);
    if (!record(data) || !sha256(data.hash) || !Array.isArray(data.recipients) || !data.recipients.every(modelRef)) return invalid(); return data as { hash: string; recipients: { id: string; revision: number; generation: number }[] };
  }
  /** One exact owner command; unknown outcomes keep the original identity and are never retried here. */
  async skillCommand(command: SkillCommand, signal?: AbortSignal): Promise<SkillReceipt> {
    const value = structuredClone(command); if (value.contract !== "s16-skill-command/v1" || !identifier(value.requestId)) throw new JitClientError("invalid_skill_command", null, "not_sent", value.requestId);
    const data = await this.call("/skills/commands", "POST", value, signal, value.requestId); return this.skillReceipt(data, value.requestId);
  }
  /** Original-identity status lookup. This GET never starts an interrupted import or changes policy membership. */
  async skillCommandStatus(requestId: string, signal?: AbortSignal): Promise<SkillCommandStatus> {
    const data = await this.call(`/skills/commands/${id(requestId)}`, "GET", undefined, signal);
    if (!record(data) || data.contract !== "s16-skill-command-status/v1" || data.requestId !== requestId || !["complete", "queued", "importing", "interrupted"].includes(data.state as string)) return invalid(); if (data.state === "complete") this.skillReceipt(data.receipt, requestId);
    return data as unknown as SkillCommandStatus;
  }
  /** Explicitly resumes only that original inert import or already committed exact membership review. */
  async resumeSkillCommand(requestId: string, signal?: AbortSignal): Promise<SkillReceipt> {
    const data = await this.call(`/skills/commands/${id(requestId)}/resume`, "POST", {}, signal, requestId); return this.skillReceipt(data, requestId);
  }
  private skillReceipt(value: unknown, requestId: string): SkillReceipt {
    if (!record(value) || value.contract !== "s16-skill-receipt/v1" || value.requestId !== requestId || !identifier(value.skillId) || !count(value.revision) || value.pin !== null && !sha256(value.pin) || !["needs_review", "active", "revoked"].includes(value.state as string) || !["installed", "review_required", "not_needed"].includes(value.policy as string)) throw new JitClientError("client_protocol_invalid", null, "unknown", requestId);
    return value as unknown as SkillReceipt;
  }
  private skillRecord(value: unknown): value is import("../skills/types").SkillRecord {
    return record(value) && value.contract === "s16-skill/v1" && identifier(value.id) && count(value.revision) && count(value.ownerGeneration) && ["needs_review", "active", "revoked"].includes(value.state as string) && (value.activePin === null || sha256(value.activePin)) && (value.candidatePin === null || sha256(value.candidatePin)) && modelRef(value.resource) && modelRef(value.source) && (value.review === null || record(value.review) && sha256(value.review.pin) && sha256(value.review.recipientsHash) && Array.isArray(value.review.recipients) && value.review.recipients.every(modelRef) && record(value.review.availability) && ["team", "bots"].includes(value.review.availability.kind as string) && typeof value.review.executable === "boolean" && record(value.review.dependencies));
  }
  /** CONN16-01 connections: GitHub, tool sources (with their review state) and open chat cards. Reading connects nothing. */
  async connections(signal?: AbortSignal): Promise<ClientConnectionsView> {
    const data = await this.call("/connections", "GET", undefined, signal);
    if (!record(data) || data.contract !== "s16-client-connections/v1" || data.github !== null && !record(data.github) || !Array.isArray(data.sources) || data.sources.length > 64 || !data.sources.every(source => this.sourceView(source)) || !Array.isArray(data.requests) || data.requests.length > 64 || !record(data.limits) || typeof data.oauthRedirect !== "string") return invalid();
    return data as unknown as ClientConnectionsView;
  }
  /**
   * One exact connection command. It never retries: after an unknown outcome resend the same command (same `requestId`),
   * which returns the original receipt. Secrets are sent once, in this body only, and never come back.
   */
  async connectionCommand(command: ClientConnectionCommand, signal?: AbortSignal): Promise<ClientConnectionReceipt> {
    const input = structuredClone(command);
    if (input.contract !== "s16-connection-command/v1" || !identifier(input.requestId)) throw new JitClientError("invalid_connection_command", null, "not_sent", input.requestId);
    const data = await this.call("/connections/commands", "POST", input, signal, input.requestId);
    if (!record(data) || data.contract !== "s16-connection-receipt/v1" || data.requestId !== input.requestId || data.kind !== input.kind || data.source !== null && !this.sourceView(data.source) || data.authorize !== null && (typeof data.authorize !== "string" || !/^https?:\/\//.test(data.authorize))) throw new JitClientError("client_protocol_invalid", null, "unknown", input.requestId);
    return data as unknown as ClientConnectionReceipt;
  }
  private sourceView(value: unknown): value is ClientSource {
    return record(value) && identifier(value.id) && count(value.revision) && ["mcp", "openapi", "graphql"].includes(value.kind as string) && typeof value.label === "string" && typeof value.endpoint === "string"
      && ["authorizing", "needs_review", "active", "reconnect_required", "unavailable"].includes(value.state as string) && Array.isArray(value.tools) && value.tools.length <= 128 && Array.isArray(value.bots);
  }
  /** Protected recovery metadata. This read never opens a computer or transfers file bytes. */
  async workingState(signal?: AbortSignal): Promise<WorkingStateView> {
    const data = await this.call('/computers/working-state', 'GET', undefined, signal);
    if (!await workingStateView(data)) throw new JitClientError('client_protocol_invalid', null, 'response'); return data as WorkingStateView;
  }
  /** Capture exact selected work files once. An unknown reply is checked through its original package id. */
  async captureWorkingState(input: { requestId: string; workId: string; paths: string[] }, signal?: AbortSignal): Promise<WorkingStateManifest> {
    if (!/^[a-f0-9]{32}$/.test(input.requestId) || !identifier(input.workId)) throw new JitClientError('invalid_body', null, 'not_sent', input.requestId);
    const data = await this.call('/computers/working-state/capture', 'POST', input, signal, input.requestId);
    if (!await workingStateManifest(data) || (data as WorkingStateManifest).id !== input.requestId) throw new JitClientError('client_protocol_invalid', null, 'unknown', input.requestId); return data as WorkingStateManifest;
  }
  /** Immutable original manifest read after response loss; capture is never resubmitted. */
  async workingStatePackage(id: string, signal?: AbortSignal): Promise<WorkingStateManifest> {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new JitClientError('invalid_body', null, 'not_sent'); const data = await this.call('/computers/working-state/packages/' + id, 'GET', undefined, signal);
    if (!await workingStateManifest(data) || (data as WorkingStateManifest).id !== id) throw new JitClientError('client_protocol_invalid', null, 'response'); return data as WorkingStateManifest;
  }
  /** Exact reviewed hash and destination, to a fresh current scope; never silently retried. */
  async importWorkingState(input: { requestId: string; packageId: string; manifestSha256: string; vmId: string }, signal?: AbortSignal): Promise<WorkingStateImport> {
    if (!/^[a-f0-9]{32}$/.test(input.requestId) || !/^[a-f0-9]{32}$/.test(input.packageId) || !sha256(input.manifestSha256) || !identifier(input.vmId)) throw new JitClientError('invalid_body', null, 'not_sent', input.requestId);
    const data = await this.call('/computers/working-state/imports', 'POST', input, signal, input.requestId);
    if (!workingStateImport(data) || data.id !== input.requestId || data.packageId !== input.packageId || data.manifestSha256 !== input.manifestSha256 || data.destination.vmId !== input.vmId) throw new JitClientError('client_protocol_invalid', null, 'unknown', input.requestId); return data;
  }
  /** Explicit read-back of the original final subtree. It sends no pending file/rename operation again. */
  async inspectWorkingState(id: string, signal?: AbortSignal): Promise<WorkingStateImport> {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new JitClientError('invalid_body', null, 'not_sent'); const data = await this.call('/computers/working-state/receipts/' + id, 'POST', {}, signal, id);
    if (!workingStateImport(data) || data.id !== id) throw new JitClientError('client_protocol_invalid', null, 'unknown', id); return data;
  }
  /** TEAM16-01 working computers: shared/private computers, their observed state and each Bot's computer. Reading starts or stops nothing. */
  async computers(signal?: AbortSignal): Promise<ComputersView> {
    const data = await this.call("/computers", "GET", undefined, signal);
    if (!this.computersView(data)) return invalid();
    return data;
  }
  /** Explicit owner computer command. It never retries; after an unknown outcome resend the same command (same `requestId`). */
  async computerCommand(command: ComputerCommand, signal?: AbortSignal): Promise<ComputerCommandResult> {
    const input = structuredClone(command);
    if (input.contract !== "s16-computer-command/v1" || !identifier(input.requestId) || !identifier("botId" in input ? input.botId : input.vmId)) throw new JitClientError("invalid_computer_command", null, "not_sent", input.requestId);
    const data = await this.call("/computers/commands", "POST", input, signal, input.requestId);
    if (!record(data) || data.contract !== "s16-computer-command-result/v1" || data.requestId !== input.requestId || !identifier(data.vmId) || !this.computersView(data.view)) throw new JitClientError("client_protocol_invalid", null, "unknown", input.requestId);
    return data as unknown as ComputerCommandResult;
  }
  /** DESK16-01 screen state of one computer. Reading changes nothing (an expired owner lease is reported fenced). */
  async screen(vmId: string, signal?: AbortSignal): Promise<ScreenView> {
    if (!identifier(vmId)) throw new JitClientError("invalid_screen_command", null, "not_sent");
    const data = await this.call(`/computers/${vmId}/screen`, "GET", undefined, signal);
    if (!this.screenView(data) || data.vmId !== vmId) return invalid();
    return data;
  }
  /**
   * One PNG frame under the generation the owner last saw (`stale_screen` after any takeover, fence or
   * hand-back). The bytes stay in memory for display only; nothing is cached or stored.
   */
  async screenFrame(vmId: string, generation: number, signal?: AbortSignal): Promise<Blob> {
    if (!identifier(vmId) || !count(generation)) throw new JitClientError("invalid_screen_command", null, "not_sent");
    const session = this.#sessionGeneration;
    let response: Response;
    try { response = await this.#fetch(new Request(`${this.origin}/api/s16/client/computers/${vmId}/screen/frame?generation=${generation}`, { credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", ...(signal ? { signal } : {}) })); }
    catch { throw new JitClientError(signal?.aborted ? "aborted" : "connection_lost", null, "not_sent"); }
    if (session !== this.#sessionGeneration) { await response.body?.cancel().catch(() => {}); throw new JitClientError("client_response_stale", response.status, "response"); }
    if (response.status === 401 || response.status === 403) this.clear();
    if (!response.ok) { let code = "screen_unavailable"; try { const data = await this.json(response, "GET", null); code = safeCode(record(data) ? data.error : null); } catch { /* The status alone decides. */ } throw new JitClientError(code, response.status, "response"); }
    if (response.redirected || response.headers.get("content-type") !== "image/png") { await response.body?.cancel().catch(() => {}); return invalid(); }
    const blob = await response.blob();
    if (session !== this.#sessionGeneration) throw new JitClientError("client_response_stale", response.status, "response");
    if (blob.size < 33 || blob.size > 8 * 1_048_576) return invalid();
    return new Blob([blob], { type: "image/png" });
  }
  /**
   * One exact screen command. It never retries: after an unknown outcome resend the same command (same
   * `requestId`). Typed text is sent once in this body and never kept by the client.
   */
  async screenCommand(command: ScreenCommand, signal?: AbortSignal): Promise<ScreenCommandResult> {
    const input = structuredClone(command);
    if (input.contract !== "s16-screen-command/v1" || !identifier(input.requestId) || !identifier(input.vmId) || !count(input.generation)) throw new JitClientError("invalid_screen_command", null, "not_sent", input.requestId);
    const data = await this.call("/computers/screen/commands", "POST", input, signal, input.requestId);
    if (!record(data) || data.contract !== "s16-screen-command-result/v1" || data.requestId !== input.requestId || !this.screenView(data.view) || data.view.vmId !== input.vmId) throw new JitClientError("client_protocol_invalid", null, "unknown", input.requestId);
    return data as unknown as ScreenCommandResult;
  }
  private screenView(data: unknown): data is ScreenView {
    return record(data) && data.contract === "s16-computer-screen/v1" && identifier(data.vmId) && typeof data.available === "boolean" && (data.code === null || typeof data.code === "string")
      && count(data.width) && count(data.height) && ["agent", "yield", "settling", "owner", "fenced"].includes(data.state as string) && count(data.generation)
      && (data.takeoverId === null || identifier(data.takeoverId)) && (data.expiresAt === null || count(data.expiresAt)) && typeof data.agentBusy === "boolean"
      && record(data.scope) && (data.scope.kind === "shared" || data.scope.kind === "private" && identifier(data.scope.botId));
  }
  private computersView(data: unknown): data is ComputersView {
    if (!record(data) || data.contract !== "s16-client-computers/v1" || data.workingState !== undefined && typeof data.workingState !== "boolean" || data.idleStopMs !== null && !count(data.idleStopMs) || !Array.isArray(data.computers) || data.computers.length > 64 || !Array.isArray(data.bots) || data.bots.length > 64 || !record(data.privateCreation)) return false;
    const states = ["running", "sleeping", "starting", "stopping", "stopped", "setting_up", "setup_failed", "attention"];
    return data.computers.every(item => record(item) && identifier(item.id) && typeof item.isDefault === "boolean" && record(item.scope) && (item.scope.kind === "shared" || item.scope.kind === "private" && identifier(item.scope.botId)) && states.includes(item.state as string) && (item.reason === null || typeof item.reason === "string") && count(item.activeSessions) && count(item.capacity) && (item.backend === undefined || item.backend === null || isVmBackendDescriptor(item.backend, item.id as string)) && count(item.works) && (item.sleepsAt === null || count(item.sleepsAt)))
      && data.bots.every(bot => record(bot) && identifier(bot.id) && typeof bot.main === "boolean" && record(bot.computer) && (bot.computer.kind === "shared" || bot.computer.kind === "private" && identifier(bot.computer.vmId)));
  }
  /** Owner routines with derived display state. Reading never ticks, dispatches or marks anything seen. */
  async routines(signal?: AbortSignal): Promise<ClientRoutineList> {
    const data = await this.call("/routines", "GET", undefined, signal);
    if (!record(data) || data.contract !== "s16-client-routines/v1" || !Array.isArray(data.routines) || !count(data.attention) || !record(data.feed)) return invalid();
    return data as unknown as ClientRoutineList;
  }
  async routine(routineId: string, signal?: AbortSignal): Promise<ClientRoutineDetail> {
    const data = await this.call(`/routines/${id(routineId)}`, "GET", undefined, signal);
    if (!record(data) || data.contract !== "s16-client-routine/v1" || !record(data.summary) || !record(data.summary.routine) || data.summary.routine.id !== routineId || !Array.isArray(data.occurrences) || !Array.isArray(data.sources) || !Array.isArray(data.next)) return invalid();
    return data as unknown as ClientRoutineDetail;
  }
  /** Current review-sheet choices from live standing policy. */
  async routineOptions(signal?: AbortSignal): Promise<ClientRoutineOptions> {
    const data = await this.call("/routines/options", "GET", undefined, signal);
    if (!record(data) || data.contract !== "s16-routine-options/v1" || typeof data.available !== "boolean" || !Array.isArray(data.purposes) || !Array.isArray(data.resources)) return invalid();
    return data as unknown as ClientRoutineOptions;
  }
  /** Server-computed review of an unsaved draft. It stores nothing and grants nothing. */
  async proposeRoutine(draft: ClientRoutineDraft, signal?: AbortSignal): Promise<ClientRoutineProposal> {
    const data = await this.call("/routines/proposals", "POST", draft, signal);
    if (!record(data) || data.contract !== "s16-routine-proposal/v1" || !sha256(data.proposalHash) || !Array.isArray(data.next) || !record(data.draft)) throw new JitClientError("client_protocol_invalid", null, "response");
    return data as unknown as ClientRoutineProposal;
  }
  /**
   * One exact routine or feed command. It never retries: after an unknown outcome the caller replays the
   * same request ID, which returns the original receipt (without any one-time secret or URL).
   */
  async routineCommand(command: Record<string, unknown> & { kind: string; requestId: string }, signal?: AbortSignal): Promise<ClientRoutineReceipt> {
    id(command.requestId);
    const data = await this.call("/routines/commands", "POST", command, signal, command.requestId);
    if (!record(data) || data.contract !== "s16-routine-receipt/v1") throw new JitClientError("client_protocol_invalid", null, "unknown", command.requestId);
    return data as unknown as ClientRoutineReceipt;
  }
  /** Installation push key and this owner's device count. The first read creates the installation key; nothing else changes. */
  async notificationSettings(signal?: AbortSignal): Promise<ClientNotificationSettings> {
    const data = await this.call("/notifications", "GET", undefined, signal);
    if (!record(data) || data.contract !== "s16-notifications/v1" || typeof data.publicKey !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(data.publicKey) || !count(data.devices) || !count(data.limit)) return invalid();
    return data as unknown as ClientNotificationSettings;
  }
  /** Whether the device whose push endpoint hashes to `endpointSha256` is subscribed for this owner. */
  async notificationDevice(endpointSha256: string, signal?: AbortSignal): Promise<ClientNotificationDevice> {
    if (!sha256(endpointSha256)) throw new JitClientError("invalid_identity", null, "not_sent");
    return this.device(await this.call(`/notifications/devices/${endpointSha256}`, "GET", undefined, signal), "response");
  }
  /** Store this device's push subscription. Idempotent per endpoint, so an unknown outcome may simply be sent again. */
  async subscribeNotifications(command: ClientNotificationSubscribeCommand, signal?: AbortSignal): Promise<ClientNotificationDevice> {
    const device = this.device(await this.call("/notifications/subscribe", "POST", structuredClone(command), signal), "unknown");
    if (!device.subscribed) throw new JitClientError("client_protocol_invalid", null, "unknown");
    return device;
  }
  /** Remove this device's subscription. Idempotent per endpoint. */
  async unsubscribeNotifications(endpoint: string, signal?: AbortSignal): Promise<ClientNotificationDevice> {
    const device = this.device(await this.call("/notifications/unsubscribe", "POST", { endpoint }, signal), "unknown");
    if (device.subscribed) throw new JitClientError("client_protocol_invalid", null, "unknown");
    return device;
  }
  private device(data: unknown, outcome: "response" | "unknown"): ClientNotificationDevice {
    if (!record(data) || data.contract !== "s16-notification-device/v1" || typeof data.subscribed !== "boolean") throw new JitClientError("client_protocol_invalid", null, outcome);
    return data as unknown as ClientNotificationDevice;
  }
  /** Drop authority material when a native session signs out; callers also discard private projections. */
  clear(): void { this.#csrf = null; this.#sessionGeneration++; }
  private uploadResponse(data: unknown, requestId?: string, uploadId?: string, mutation = false): FileUpload {
    const malformed = () => new JitClientError("client_protocol_invalid", null, requestId || mutation ? "unknown" : "response", requestId ?? uploadId ?? null);
    if (!record(data) || data.contract !== "s16-file-upload/v1" || !identifier(data.id) || requestId && data.requestId !== requestId || uploadId && data.id !== uploadId || !identifier(data.conversationId) || typeof data.state !== "string" || !["created", "uploading", "validating", "ready", "rejected", "cancelled", "expired", "withdrawn"].includes(data.state)) throw malformed();
    const positive = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
    const sha = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    if (data.state === "ready") {
      const receipt = data.receipt;
      if (!record(receipt) || typeof receipt.contract !== "string" || !["s16-file-receipt/v1", "s16-file-receipt/v2"].includes(receipt.contract) || receipt.id !== data.id || receipt.conversationId !== data.conversationId || !sha(receipt.sha256) || receipt.sha256 !== data.expectedHash || !positive(receipt.bytes) || receipt.bytes !== data.bytes || typeof receipt.name !== "string" || !receipt.name || receipt.expiresAt !== null && !positive(receipt.expiresAt)) throw malformed();
      if (receipt.contract === "s16-file-receipt/v1") { if (receipt.mime !== "text/plain") throw malformed(); }
      else {
        const representation = receipt.representation;
        if (receipt.validation !== "s16-isolated-file/v1" || typeof receipt.parserGeneration !== "string" || !receipt.parserGeneration || receipt.parserGeneration.length > 4096 || !record(representation) || !sha(representation.sha256) || !positive(representation.bytes)) throw malformed();
        if (receipt.mime === "application/pdf") {
          if (representation.mime !== "text/plain" || !positive(representation.pages) || [representation.width, representation.height, representation.originalWidth, representation.originalHeight].some(value => value !== null)) throw malformed();
        } else if (!["image/png", "image/jpeg"].includes(receipt.mime as string) || !["image/png", "image/jpeg"].includes(representation.mime as string) || representation.pages !== null || [representation.width, representation.height, representation.originalWidth, representation.originalHeight].some(value => !positive(value))) throw malformed();
      }
    }
    return data as unknown as FileUpload;
  }
  private receipt(data: unknown, command: { requestId: string; conversationId: string }): ClientReceipt {
    if (!record(data) || data.contract !== "s15-conversation-receipt/v1" || data.requestId !== command.requestId || data.conversationId !== command.conversationId || !identifier(data.rootRequestId) || !Number.isSafeInteger(data.receivedAt)) throw new JitClientError("client_protocol_invalid", null, "unknown", command.requestId);
    return data as unknown as ClientReceipt;
  }
  private async call(path: string, method: "GET" | "POST", body: unknown, signal?: AbortSignal, requestId: string | null = null, raw?: Uint8Array): Promise<unknown> {
    const generation = this.#sessionGeneration;
    if (method === "POST" && !this.#csrf) throw new JitClientError("client_not_initialized", null, "not_sent", requestId);
    if (signal?.aborted) throw new JitClientError("aborted", null, "not_sent", requestId);
    const headers: Record<string, string> = { accept: "application/json" };
    if (method === "POST") { headers["content-type"] = raw ? "application/octet-stream" : "application/json"; headers["x-csrf-token"] = this.#csrf!; }
    const nativeBytes = raw && this.#fetchBytes ? new Uint8Array(raw) : undefined;
    const request = new Request(`${this.origin}/api/s16/client${path}`, { method, headers, credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", ...(signal ? { signal } : {}), ...(nativeBytes ? {} : raw ? { body: new Uint8Array(raw).buffer } : body === undefined ? {} : { body: JSON.stringify(body) }) });
    let response: Response;
    try { response = nativeBytes ? await this.#fetchBytes!(request, nativeBytes) : await this.#fetch(request); }
    catch { throw new JitClientError(signal?.aborted ? "aborted" : "connection_lost", null, method === "POST" ? "unknown" : "not_sent", requestId); }
    if (generation !== this.#sessionGeneration) { await response.body?.cancel().catch(() => {}); throw new JitClientError("client_response_stale", response.status, method === "POST" ? "unknown" : "response", requestId); }
    if (response.status === 401 || response.status === 403) this.clear();
    const responseGeneration = this.#sessionGeneration;
    const data = await this.json(response, method, requestId);
    if (responseGeneration !== this.#sessionGeneration) throw new JitClientError("client_response_stale", response.status, method === "POST" ? "unknown" : "response", requestId);
    if (!response.ok) throw new JitClientError(safeCode(record(data) ? data.error : null), response.status, "response", requestId);
    return data;
  }
  private async json(response: Response, method: "GET" | "POST", requestId: string | null): Promise<unknown> {
    if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" || response.redirected) throw new JitClientError("client_protocol_invalid", response.status, method === "POST" ? "unknown" : "response", requestId);
    const reader = response.body?.getReader(); if (!reader) throw new JitClientError("client_protocol_invalid", response.status, method === "POST" ? "unknown" : "response", requestId);
    let data: unknown;
    try {
      const chunks: Uint8Array[] = []; let length = 0;
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length; if (length > clientResponseBytes) { await reader.cancel(); throw new JitClientError("client_response_limit", response.status, method === "POST" ? "unknown" : "response", requestId); } chunks.push(chunk.value); }
      const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) { if (error instanceof JitClientError) throw error; throw new JitClientError("client_protocol_invalid", response.status, method === "POST" ? "unknown" : "response", requestId); }
    finally { reader.releaseLock(); }
    return data;
  }
}

/** Protected card snapshots still cross a JSON boundary; reject malformed/foreign rows before rendering them. */
function browserCard(value: unknown, conversationId: string): value is BrowserActionCard {
  if (!record(value) || !identifier(value.id) || !identifier(value.requestId) || value.conversationId !== conversationId || !["pending","sending","sent","unknown","stale","declined","expired"].includes(String(value.state)) || !["click","type","select","submit"].includes(String(value.kind)) || !["a","b","c","d","e","f"].includes(String(value.row))) return false;
  const facts = value.facts;
  return record(facts) && typeof facts.url === "string" && typeof facts.name === "string" && typeof facts.revision === "string" && Array.isArray(facts.fields) && facts.fields.length <= 100 && facts.fields.every(f => record(f) && typeof f.name === "string" && typeof f.value === "string") && (value.value === undefined || typeof value.value === "string");
}

/** No foreign card or malformed screen state is rendered across the client JSON boundary. */
function needsYouCard(value: unknown, conversationId: string): value is ComputerNeedsYouCard {
  if (!record(value) || !identifier(value.id) || !identifier(value.requestId) || !identifier(value.vmId) || value.conversationId !== conversationId || !count(value.ownerGeneration) || !count(value.vmGeneration) || !count(value.createdAt) || !count(value.expiresAt)) return false;
  if (!["pending", "void", "resumed", "declined", "expired"].includes(String(value.state)) || !["sign_in", "verify", "captcha"].includes(String(value.reason)) || typeof value.origin !== "string" || value.origin.length > 2048 || value.code !== null && typeof value.code !== "string") return false;
  try { const url = new URL(value.origin); if (!["http:", "https:"].includes(url.protocol) || url.origin !== value.origin) return false; } catch { return false; }
  if (value.continuation !== undefined) {
    const next = value.continuation;
    if (!record(next) || !["pending", "queued", "running", "completed", "held", "stopped", "covered", "unknown"].includes(String(next.state)) || next.requestId !== null && !identifier(next.requestId) || next.code !== null && !identifier(next.code)) return false;
  }
  return (value.generation === null || count(value.generation)) && (value.screenState === null || ["agent", "yield", "settling", "owner", "fenced"].includes(String(value.screenState))) && typeof value.canWatch === "boolean" && typeof value.canDecline === "boolean";
}

function protectedBrowserView(value: unknown): value is ProtectedBrowserView {
  if (!record(value) || value.contract !== 's16-protected-browser/v1' || typeof value.signIn !== 'boolean' || !count(value.generation) || !value.generation || typeof value.settling !== 'boolean' || !['not_signed_in', 'owner_control', 'checking', 'signed_in', 'cancelled', 'unknown'].includes(String(value.login))) return false;
  const action = value.reconciliation;
  return action === null || record(action) && identifier(action.id) && count(action.revision) && typeof action.actionHash === 'string' && /^[a-f0-9]{64}$/.test(action.actionHash);
}
