import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import Gate from "../modules/jit-native-gate";
import Capture from "../modules/jit-native-gate/capture";
import { MobileVoice, type MobileVoiceOs, type MobileVoicePending } from "../../../src/s16/mobile/voice";
import { nativeActive } from "./files";
import { Button, UiText, type Ui } from "./ui";

/** Explicit native permission and finite capture use the same authored lifecycle-bound adapter. */
export const voiceOs: MobileVoiceOs = {
  async permission() { return (await Capture.requestPermission()).granted; }, active: nativeActive,
  async epoch() { const value = await Gate.status(); if (!value.active) throw Object.assign(Error(), { code: "mobile_capture_interrupted" }); return value.epoch; },
  prepare: (epoch, ms) => Capture.prepare(epoch, ms), start: lease => Capture.start(lease), finish: lease => Capture.finish(lease), cancel: lease => Capture.cancel(lease)
};
/** Original capture recovery and explicit microphone controls; all transcript output remains an editable draft. */
export function VoiceControls({ ui, control, disabled, onFailure }: { ui: Ui; control: MobileVoice; disabled: boolean; onFailure(error: unknown): void }) {
  const subscribe = useCallback((listener: () => void) => control.subscribe(listener), [control]), snapshot = useCallback(() => control.projection, [control]);
  const view = useSyncExternalStore(subscribe, snapshot, snapshot), [pending, setPending] = useState<readonly MobileVoicePending[] | null>(null);
  const refresh = useCallback(async () => { setPending(await control.pending()); }, [control]);
  useEffect(() => { let live = true; void control.pending().then(value => { if (live) setPending(value); }, error => { if (live) onFailure(error); }); return () => { live = false; }; }, [control, view.phase]);
  const run = async (operation: () => Promise<unknown>) => { try { await operation(); await refresh(); } catch (error) { onFailure(error); } };
  const phaseKey = view.phase === "recording" ? "s16.voice.recording" : view.phase === "permission" ? "s16.voice.permission" : view.phase === "transcribing" ? "s16.voice.transcribing" : view.phase === "starting" ? "s16.voice.preparing" : view.phase === "ready" ? "s16.voice.review" : ["interrupted", "uncertain"].includes(view.phase) ? view.code === "mobile_microphone_denied" ? "s16.voice.permissionDenied" : "s16.voice.failed" : "s16.voice.local";
  return <View style={ui.styles.card}><UiText ui={ui} accessibilityRole="header">{ui.t("s16.voice.title")}</UiText><UiText ui={ui} accessibilityLiveRegion="polite">{ui.t(phaseKey)}</UiText>
    {view.phase === "recording" ? <Button ui={ui} label={ui.t("s16.voice.stop")} onPress={() => { void run(() => control.finish()); }} /> : <Button ui={ui} secondary label={ui.t("s16.voice.dictate")} disabled={disabled || view.busy || pending === null || pending.length > 0} onPress={() => { void run(() => control.start()); }} />}
    {view.busy && <Button ui={ui} secondary label={ui.t("s16.voice.cancel")} onPress={() => { void run(() => control.cancel()); }} />}
    {pending?.map(entry => <View key={entry.id} style={ui.styles.card}><UiText ui={ui}>{ui.t("s16.mobile.voicePending")}</UiText><Button ui={ui} secondary label={ui.t("s16.mobile.voiceCheck")} disabled={view.busy} onPress={() => { void run(() => control.check(entry)); }} /><Button ui={ui} secondary label={ui.t("s16.voice.cancel")} disabled={view.busy} onPress={() => { void run(() => control.cancel(entry)); }} /></View>)}
  </View>;
}
