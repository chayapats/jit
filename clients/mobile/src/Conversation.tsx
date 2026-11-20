import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, TextInput, View } from "react-native";
import WebView from "react-native-webview";
import { cardFacts } from "../../../src/s16/client/action-card";
import { JitClientError, type ClientSnapshot } from "../../../src/s16/client";
import type { ActionSlip } from "../../../src/s15/policy";
import type { FileArtifact } from "../../../src/s16/files/types";
import type { MobileSession } from "../../../src/s16/mobile/session";
import { MobileCommands, type MobilePending } from "../../../src/s16/mobile/commands";
import { checkMobileIntent, mobileIntent, MobileDrafts } from "../../../src/s16/mobile/drafts";
import { NativeFiles } from "./files";
import type { MobileVoice } from "../../../src/s16/mobile/voice";
import { VoiceControls } from "./Voice";
import { Button, diagnostic, UiText, type Ui } from "./ui";

const statusKey = (state: string) => state === "done" ? "s16.chat.done" : ["working", "inspecting"].includes(state) ? "s16.chat.working" : state === "understanding" ? "s16.chat.understanding" : state === "received" ? "s16.chat.received" : state === "stopped" ? "s16.chat.stopped" : "s16.chat.hold";
export { statusKey };

/** Complete immutable payload remains readable; only these current, explicit in-chat presses can decide. */
function ExactCard({ ui, session, commands, slip, onFailure }: { ui: Ui; session: MobileSession; commands: MobileCommands; slip: ActionSlip; onFailure(error: unknown): void }) {
  const facts = cardFacts(slip), lock = useRef(false), [busy, setBusy] = useState(false), [expanded, setExpanded] = useState(!facts.known), [done, setDone] = useState(false);
  const press = async (decision: "approve" | "deny") => {
    if (lock.current || done) return; lock.current = true; setBusy(true);
    try { await commands.decide(session.projection.conversationId!, slip, decision); setDone(true); await session.poll(); }
    catch (error) { onFailure(error); } finally { lock.current = false; setBusy(false); }
  };
  const fields = [
    [ui.t("s16.card.to"), facts.to.join(", ")], [ui.t("s16.card.cc"), facts.cc.join(", ")], [ui.t("s16.card.bcc"), facts.bcc.join(", ")],
    [ui.t("s16.card.subject"), facts.subject], [ui.t("s16.card.amount"), facts.amount], [ui.t("s16.card.target"), facts.target], [ui.t("s16.card.request"), facts.request],
    ...facts.rows.map(([key, value]) => [ui.t(`s16.card.row.${key}`), value]),
    ...facts.requestFields.map(field => [ui.t(field.source === "query" ? "s16.card.queryField" : "s16.card.formField", { field: field.name }), field.value]),
    ...(!facts.to.length ? [[ui.t("s16.card.recipients"), slip.action.recipients.map(recipient => recipient.id).join(", ")]] : []),
  ];
  return <View style={ui.styles.card}>
    <UiText ui={ui} accessibilityRole="header" style={ui.styles.message}>{ui.t(`s16.card.title.${facts.kind}`)}</UiText>
    <UiText ui={ui}>{ui.t(slip.reasonCode === "production_approval_required" ? "s16.card.why.production" : slip.reasonCode === "egress_approval_required" ? "s16.card.why.egress" : facts.firstShare.length ? "s16.card.why.firstShare" : "s16.card.why.required")}</UiText>
    {fields.filter(([, value]) => value !== null && value !== "").map(([label, value], index) => <View key={index}><UiText ui={ui} style={ui.styles.muted}>{label}</UiText><UiText ui={ui} selectable>{value}</UiText></View>)}
    {!!facts.body && <UiText ui={ui} selectable accessibilityLabel={ui.t("s16.card.body")}>{facts.body}</UiText>}
    <Button ui={ui} secondary label={ui.t("s16.card.allFields")} onPress={() => setExpanded(value => !value)} />
    {expanded && <UiText ui={ui} selectable style={ui.styles.payload}>{facts.payloadText || ui.t("s16.card.cannotApprove")}</UiText>}
    <UiText ui={ui} style={ui.styles.muted}>{ui.t("s16.card.once")}</UiText>
    {slip.canApprove ? <Button ui={ui} label={ui.t(busy ? "s16.card.working" : "s16.card.approve")} disabled={busy || done} onPress={() => { void press("approve"); }} /> : <UiText ui={ui}>{ui.t("s16.card.cannotApprove")}</UiText>}
    <Button ui={ui} secondary label={ui.t("s16.card.decline")} disabled={busy || done} onPress={() => { void press("deny"); }} />
  </View>;
}

/** HTML has no authenticated URL, JS/bridge, persistence, navigation, external resource or file capability. */
function NativePreview({ ui, session, artifact, html, onFailure }: { ui: Ui; session: MobileSession; artifact: FileArtifact; html: boolean; onFailure(error: unknown): void }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let live = true, reading = false;
    const load = async () => {
      if (reading) return; reading = true;
      try { const bytes = await session.perform((client, signal) => client.artifactBytes(artifact, signal)); if (live) setText(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch (error) { if (live) { setText(null); onFailure(error); } } finally { reading = false; }
    };
    void load(); const timer = setInterval(() => { void load(); }, 4000);
    return () => { live = false; clearInterval(timer); };
  }, [session, artifact.id, artifact.sha256]);
  if (text === null) return <ActivityIndicator accessibilityLabel={ui.t("s16.common.loading")} color={ui.colors.accent} />;
  if (artifact.mime !== "text/html") return <UiText ui={ui} selectable>{text}</UiText>;
  if (!html) return <UiText ui={ui}>{ui.t("s16.artifact.previewUnavailable")}</UiText>;
  const policy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
  return <View>
    <WebView accessibilityLabel={ui.t("s16.artifact.htmlFrame", { name: artifact.name })} style={ui.styles.preview}
      source={{ html: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"></head><body>${text}</body></html>`, baseUrl: "about:blank" }}
      originWhitelist={["about:blank"]} onShouldStartLoadWithRequest={request => request.url === "about:blank"}
      javaScriptEnabled={false} domStorageEnabled={false} incognito cacheEnabled={false} sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false}
      allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false} mixedContentMode="never"
      setSupportMultipleWindows onOpenWindow={() => {}} onFileDownload={() => {}} allowsLinkPreview={false} dataDetectorTypes="none" webviewDebuggingEnabled={false}
      mediaPlaybackRequiresUserAction allowsInlineMediaPlayback={false} allowsAirPlayForMediaPlayback={false} allowsBackForwardNavigationGestures={false} />
    <UiText ui={ui} style={ui.styles.muted}>{ui.t("s16.artifact.htmlSandboxed")}</UiText>
  </View>;
}

/** Current protected conversation, real file receipts and immutable command recovery. */
export function Conversation({ ui, session, snapshot, commands, drafts, files, voice, onFailure }: { ui: Ui; session: MobileSession; snapshot: ClientSnapshot; commands: MobileCommands; drafts: MobileDrafts; files: NativeFiles; voice: MobileVoice; onFailure(error: unknown): void }) {
  const intent = mobileIntent(session), conversation = intent.conversationId;
  const uploadCapability = session.projection.bootstrap?.capabilities.uploads, creationLookup = uploadCapability?.available && uploadCapability.creationLookup === "s16-upload-creation/v1";
  const subscribe = useCallback((listener: () => void) => drafts.subscribe(listener), [drafts]);
  const read = useCallback(() => drafts.get(intent.scope, conversation), [drafts, intent.scope, conversation]);
  const voiceSubscribe = useCallback((listener: () => void) => voice.subscribe(listener), [voice]), voiceRead = useCallback(() => voice.projection, [voice]);
  const voiceState = useSyncExternalStore(voiceSubscribe, voiceRead, voiceRead);
  const draft = useSyncExternalStore(subscribe, read, read), lock = useRef(false), [busy, setBusy] = useState(false), [pending, setPending] = useState<readonly MobilePending[] | null>(null), [preview, setPreview] = useState<string | null>(null), [absent, setAbsent] = useState<string | null>(null);
  useEffect(() => { let live = true; void commands.pending().then(value => { if (live) setPending(value.filter(entry => entry.conversationId === conversation)); }, onFailure); return () => { live = false; }; }, [commands, conversation, intent.scope]);
  const run = async (operation: () => Promise<unknown>) => { if (lock.current) return; lock.current = true; setBusy(true); try { await operation(); } catch (error) { onFailure(error); } finally { lock.current = false; setBusy(false); } };
  async function send() {
    if (voice.projection.busy || pending === null || pending.length || !draft.text.trim() && !draft.files.length || draft.files.some(file => file.phase !== "ready" || !file.receipt)) return;
    await run(async () => {
      await commands.send(conversation, draft.text, draft.files.map(file => ({ id: file.receipt!.id, sha256: file.receipt!.sha256 })));
      checkMobileIntent(intent); drafts.change(intent, () => ({ text: "", files: [] })); setPending([]); await session.poll();
    });
  }
  const capability = session.projection.bootstrap!.capabilities;
  async function recover(entry: MobilePending) {
    try { await commands.recover(entry); checkMobileIntent(intent); drafts.change(intent, () => ({ text: "", files: [] })); setPending((await commands.pending()).filter(item => item.conversationId === conversation)); setAbsent(null); await session.poll(); }
    catch (error) { if (error instanceof JitClientError && error.status === 404) setAbsent(entry.requestId); else throw error; }
  }
  return <>
    {snapshot.conversation.rows.length === 0 && <UiText ui={ui}>{ui.t("s16.chat.empty")}</UiText>}
    {snapshot.conversation.rows.map(row => <View key={row.requestId} style={ui.styles.card}>
      <UiText ui={ui} selectable style={ui.styles.message}>{row.ownerMessage}</UiText>
      <UiText ui={ui} style={ui.styles.muted}>{ui.t(statusKey(row.state))}</UiText>
      {row.result && <UiText ui={ui} selectable>{row.result.text}</UiText>}
      {row.needsYou && <UiText ui={ui}>{ui.t("s16.chat.hold")} · {row.needsYou.code}</UiText>}
      {row.files?.inputs.map(file => <UiText ui={ui} key={file.id}>{file.name} · {file.bytes.toLocaleString(ui.locale)} bytes</UiText>)}
      {capability.exactDecisions && row.slips.filter(slip => slip.state === "pending").map(slip => <ExactCard key={`${slip.action.id}:${slip.action.revision}:${slip.action.actionHash}`} ui={ui} session={session} commands={commands} slip={slip} onFailure={onFailure} />)}
      {row.progress.active && <Button ui={ui} secondary label={ui.t("s16.chat.stop")} disabled={busy} onPress={() => { void run(async () => { await session.perform((client, signal) => client.stop(row.requestId, signal)); await session.poll(); }); }} />}
      {row.files?.artifacts.map(artifact => <View key={artifact.id} style={ui.styles.card}>
        <UiText ui={ui} style={ui.styles.message}>{artifact.name}</UiText><UiText ui={ui} selectable style={ui.styles.muted}>{artifact.sha256}</UiText>
        <Button ui={ui} secondary label={ui.t("s16.artifact.preview", { name: artifact.name })} onPress={() => setPreview(current => current === artifact.id ? null : artifact.id)} />
        {preview === artifact.id && <NativePreview ui={ui} session={session} artifact={artifact} html={capability.artifacts.available && capability.artifacts.html === "sandboxed_static"} onFailure={onFailure} />}
        <Button ui={ui} secondary label={ui.t("s16.artifact.download", { name: artifact.name })} disabled={busy} onPress={() => { void run(() => files.export(artifact)); }} />
      </View>)}
    </View>)}
    <View style={ui.styles.card}>
      {pending === null ? <ActivityIndicator color={ui.colors.accent} accessibilityLabel={ui.t("s16.common.loading")} /> : pending.length > 0 ? <>
        <UiText ui={ui}>{ui.t("s16.chat.unknown")}</UiText>
        {pending.map(entry => <View key={entry.requestId} style={ui.styles.card}>
          <Button ui={ui} label={ui.t("s16.chat.recover")} disabled={busy} onPress={() => { void run(() => recover(entry)); }} />
          {absent === entry.requestId && <><UiText ui={ui}>{ui.t("s16.mobile.originalAbsent")}</UiText>
            {commands.canRetry(entry) ? <Button ui={ui} label={ui.t("s16.chat.resend")} disabled={busy} onPress={() => { void run(async () => { await commands.retry(entry.requestId); checkMobileIntent(intent); drafts.change(intent, () => ({ text: "", files: [] })); setPending((await commands.pending()).filter(item => item.conversationId === conversation)); setAbsent(null); await session.poll(); }); }} />
            : <Button ui={ui} secondary label={ui.t("s16.mobile.composeNew")} disabled={busy} onPress={() => { void run(async () => { await commands.forgetAbsent(entry); checkMobileIntent(intent); drafts.change(intent, () => ({ text: "", files: [] })); setPending((await commands.pending()).filter(item => item.conversationId === conversation)); setAbsent(null); }); }} />}
          </>}
        </View>)}
      </> : null}
      {draft.files.map(file => <View style={ui.styles.card} key={file.requestId}>
        <UiText ui={ui}>{file.name} · {file.bytes.toLocaleString(ui.locale)} bytes</UiText>
        <UiText ui={ui}>{ui.t(file.phase === "ready" ? "s16.files.ready" : file.phase === "validating" ? "s16.files.validating" : file.phase === "uploading" ? "s16.files.uploading" : "s16.files.failed", { name: file.name })}</UiText>
        {file.phase !== "ready" && <Button ui={ui} secondary label={ui.t("s16.files.recover")} disabled={busy || !file.uploadId && !creationLookup} onPress={() => { void run(() => files.check(file)); }} />}
        {!file.uploadId && !creationLookup && <UiText ui={ui}>{ui.t("s16.mobile.fileRecoveryUnavailable")}</UiText>}
        {file.code === "mobile_upload_select_again" && <><UiText ui={ui}>{ui.t("s16.mobile.fileSelectAgainHint")}</UiText><Button ui={ui} secondary label={ui.t("s16.mobile.fileSelectAgain")} disabled={busy} onPress={() => { void run(() => files.resume(file)); }} /></>}
        <Button ui={ui} secondary label={ui.t("s16.files.removeFromMessage", { name: file.name })} disabled={busy || !!pending?.length} onPress={() => drafts.change(intent, current => ({ ...current, files: current.files.filter(chip => chip.requestId !== file.requestId) }))} />
      </View>)}
      <TextInput accessibilityLabel={ui.t("s16.chat.prompt")} placeholder={ui.t("s16.chat.prompt")} placeholderTextColor={ui.colors.muted}
        value={draft.text} onChangeText={text => drafts.change(intent, current => ({ ...current, text }))} multiline editable={!busy && !voiceState.busy && pending !== null && !pending.length}
        style={[ui.styles.input, ui.styles.composer]} />
      <Button ui={ui} label={ui.t(busy ? "s16.chat.sending" : "s16.chat.send")} disabled={busy || voiceState.busy || pending === null || !!pending.length || !draft.text.trim() && !draft.files.length || draft.files.some(file => file.phase !== "ready")} onPress={() => { void send(); }} />
      {capability.voice?.available ? <VoiceControls ui={ui} control={voice} disabled={busy || pending === null || !!pending.length} onFailure={onFailure} /> : <UiText ui={ui} style={ui.styles.muted}>{ui.t("s16.voice.unavailable")}</UiText>}
      {capability.uploads.available ? <>
        <Button ui={ui} secondary label={ui.t("s16.files.attach")} disabled={busy || voiceState.busy || pending === null || !!pending.length || draft.files.length >= capability.uploads.limits.messageFiles} onPress={() => { void run(() => files.pick()); }} />
        <UiText ui={ui} style={ui.styles.muted}>{ui.t("s16.files.limits", { count: capability.uploads.limits.messageFiles, bytes: (capability.uploads.textBytes ?? capability.uploads.limits.fileBytes).toLocaleString(ui.locale) })}</UiText>
      </> : <UiText ui={ui} style={ui.styles.muted}>{ui.t("s16.files.unavailable")}</UiText>}
    </View>
  </>;
}
