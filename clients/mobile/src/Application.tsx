import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StatusBar, Text, TextInput, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { Locale } from "../../../src/i18n";
import type { ClientBootstrap, ClientSnapshot, ClientRoutineDetail } from "../../../src/s16/client";
import { MobileCommands } from "../../../src/s16/mobile/commands";
import { emptyMobileConfiguration, mobileConfiguration, mobileLink, type MobileConfiguration } from "../../../src/s16/mobile/configuration";
import { MobileDrafts } from "../../../src/s16/mobile/drafts";
import { MobileNotifications } from "../../../src/s16/mobile/notifications";
import { MobileVoice } from "../../../src/s16/mobile/voice";
import { MobileWork, type MobileWorkItem } from "../../../src/s16/mobile/work";
import { nativeNoticeTarget, type NativeNotice } from "../../../src/s16/mobile/notices";
import type { MobileProjection, MobileSession } from "../../../src/s16/mobile/session";
import { mobileOrigin, mobileServiceId } from "../../../src/s16/mobile/transport";
import { Conversation, statusKey } from "./Conversation";
import { NativeFiles, clearPickerStaging, nativeActive } from "./files";
import { createNativeSession, installNativeCrypto, nativeStore } from "./native";
import { Button, diagnostic, UiText, useUi, type Ui } from "./ui";
import { useLifecycle } from "./useLifecycle";
import { notificationOs, NotificationSettings, observeNotificationTaps } from "./Notifications";
import { voiceOs } from "./Voice";
import { Licenses } from "./Licenses";

installNativeCrypto();
const configurationKey = "jit.mobile.configuration.v1";
const empty: MobileProjection = Object.freeze({ generation: 0, phase: "locked", conversationId: null, bootstrap: null, snapshot: null, code: null, authenticationRevision: 0 });
type Page = "chats" | "needs" | "work" | "more";

/** A routine notification opens current protected facts only; no tick, run-now or configuration command. */
function Routine({ ui, session, id, open, onFailure }: { ui: Ui; session: MobileSession; id: string; open(id: string): void; onFailure(error: unknown): void }) {
  const [detail, setDetail] = useState<ClientRoutineDetail | null>(null);
  useEffect(() => { let live = true; void session.perform((client, signal) => client.routine(id, signal)).then(value => { if (live) setDetail(value); }, error => { if (live) onFailure(error); }); return () => { live = false; }; }, [session, id]);
  if (!detail) return <ActivityIndicator color={ui.colors.accent} accessibilityLabel={ui.t("s16.common.loading")} />;
  return <View style={ui.styles.card}><UiText ui={ui} accessibilityRole="header" style={ui.styles.title}>{detail.summary.routine.draft.name}</UiText><UiText ui={ui}>{ui.t(`s16.routine.state.${detail.summary.display}`)}</UiText><UiText ui={ui}>{detail.summary.routine.draft.instruction}</UiText><Button ui={ui} label={ui.t("s16.nav.chats")} onPress={() => open(detail.summary.routine.draft.conversationId)} /></View>;
}

/** Read-only recent work from protected snapshots. Navigation never resumes or resubmits work. */
function Work({ ui, session, bootstrap, open, onFailure }: { ui: Ui; session: MobileSession; bootstrap: Omit<ClientBootstrap, "csrf">; open(id: string): void; onFailure(error: unknown): void }) {
  const [items, setItems] = useState<readonly MobileWorkItem[] | null>(null), reader = useRef<MobileWork | null>(null), latest = useRef({ bootstrap, onFailure }); latest.current = { bootstrap, onFailure };
  useEffect(() => {
    let live = true; setItems(null);
    const work = new MobileWork(session, { publish(value) { if (live) setItems(value); }, failure(error) { if (live) latest.current.onFailure(error); } }); reader.current = work;
    void work.refresh(latest.current.bootstrap);
    return () => { live = false; if (reader.current === work) reader.current = null; work.close(); };
  }, [session]);
  useEffect(() => { void reader.current?.refresh(bootstrap); }, [bootstrap]);
  return <><UiText ui={ui} accessibilityRole="header" style={ui.styles.title}>{ui.t("s16.mobile.work")}</UiText>
    {items === null ? <ActivityIndicator color={ui.colors.accent} accessibilityLabel={ui.t("s16.common.loading")} /> : items.length === 0 ? <UiText ui={ui}>{ui.t("s16.mobile.workEmpty")}</UiText> : items.map(({ conversationId, row }) => <Pressable key={row.requestId} style={ui.styles.card} accessibilityRole="button" accessibilityLabel={row.ownerMessage} onPress={() => open(conversationId)}><UiText ui={ui} style={ui.styles.message}>{row.ownerMessage}</UiText><UiText ui={ui}>{ui.t(statusKey(row.state))}</UiText></Pressable>)}
  </>;
}

/** Private roots require the native lifecycle gate and fresh owning service facts. */
export default function Application() {
  const [configuration, setConfiguration] = useState<MobileConfiguration>(emptyMobileConfiguration), config = useRef(configuration), writes = useRef(Promise.resolve());
  const [locale, setLocale] = useState<Locale>("th"), [origin, setOrigin] = useState(""), [password, setPassword] = useState(""), [loaded, setLoaded] = useState(false);
  const [session, setSession] = useState<MobileSession | null>(null), active = useRef<MobileSession | null>(null), instance = useRef(0), connecting = useRef(false);
  const [page, setPage] = useState<Page>("chats"), [error, setError] = useState<string | null>(null), [licenses, setLicenses] = useState(false);
  const pendingLink = useRef<ReturnType<typeof mobileLink>>(null), pendingNotice = useRef<Readonly<NativeNotice> | null>(null), [routineId, setRoutineId] = useState<string | null>(null), ui = useUi(locale);
  const lifecycle = useLifecycle(active), subscribe = useCallback((listener: () => void) => session ? session.subscribe(listener) : () => {}, [session]);
  const snapshot = useCallback(() => session?.projection ?? empty, [session]), frame = useSyncExternalStore(subscribe, snapshot, snapshot);
  const controls = useMemo(() => { if (!session) return null; const drafts = new MobileDrafts(); return { commands: new MobileCommands(session, nativeStore), drafts, files: new NativeFiles(session, drafts), notifications: new MobileNotifications(session, nativeStore, notificationOs("Jit")), voice: new MobileVoice(session, drafts, nativeStore, voiceOs) }; }, [session]);
  const adopt = useCallback((next: MobileSession | null) => { active.current?.background(); active.current = next; instance.current++; setSession(next); setRoutineId(null); setPage("chats"); setError(null); }, []);
  const save = useCallback(async (next: MobileConfiguration) => {
    config.current = next; setConfiguration(next);
    const operation = writes.current.catch(() => {}).then(() => nativeStore.set(configurationKey, JSON.stringify(next))); writes.current = operation; await operation;
  }, []);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        clearPickerStaging(); const restored = await mobileConfiguration(await nativeStore.get(configurationKey));
        if (!live) return; config.current = restored; setConfiguration(restored); setLocale(restored.locale);
        const selected = restored.services.find(service => service.id === restored.selected);
        if (selected) { setOrigin(selected.origin); const next = createNativeSession(selected.origin); adopt(next); if (lifecycle.current.current.active) void next.restore().catch(() => {}); }
      } catch (failure) { if (live) setError(diagnostic(failure)); } finally { if (live) setLoaded(true); }
    })();
    return () => { live = false; };
  }, [adopt, lifecycle.current]);
  useEffect(() => {
    if (!session || !controls) return; let scope: string | undefined;
    const release = session.subscribe(() => {
      const current = session.projection, nextScope = current.bootstrap?.sessionScope;
      if (current.phase === "locked" || nextScope && scope && nextScope !== scope) { controls.commands.clearPrivate(); controls.drafts.clear(); }
      if (nextScope) scope = nextScope;
    });
    return () => { release(); controls.voice.close(); controls.commands.clearPrivate(); controls.drafts.clear(); };
  }, [session, controls]);
  useEffect(() => { if (!session || frame.phase !== "ready") return; const timer = setInterval(() => { void session.poll().catch(() => {}); }, 5000); return () => clearInterval(timer); }, [session, frame.phase, frame.generation]);
  async function followLink(value: string) {
    const parsed = mobileLink(value), service = parsed && config.current.services.find(entry => entry.id === parsed.service);
    if (!parsed || !service) { setError("mobile_link_unavailable"); return; } pendingLink.current = parsed; pendingNotice.current = null;
    try {
      await nativeActive(); let next = active.current;
      if (!next || next.transport.origin !== service.origin) { next = createNativeSession(service.origin); setOrigin(service.origin); adopt(next); }
      await next.restore(); if (active.current !== next || next.projection.phase !== "ready") return;
      await next.selectConversation(parsed.conversationId);
      if (parsed.requestId) { const request = await next.perform((client, signal) => client.request(parsed.requestId!, signal)); if (request.conversationId !== parsed.conversationId) throw Error("mobile_link_scope_invalid"); }
      if (active.current === next) { setRoutineId(null); setPage("chats"); pendingLink.current = null; await save({ ...config.current, selected: parsed.service }); }
    } catch (failure) { if (diagnostic(failure) !== "mobile_response_stale") setError(diagnostic(failure)); }
  }
  async function followNotice(notice: Readonly<NativeNotice>) {
    const service = config.current.services.find(entry => entry.id === notice.service);
    if (!service) { setError("mobile_link_unavailable"); return; } pendingNotice.current = notice; pendingLink.current = null;
    try {
      const target = nativeNoticeTarget(notice); await nativeActive(); let next = active.current;
      if (!next || next.transport.origin !== service.origin) { next = createNativeSession(service.origin); setOrigin(service.origin); adopt(next); }
      await next.restore(); if (active.current !== next || next.projection.phase !== "ready") return;
      await next.selectConversation(target.kind === "conversation" ? target.id : null);
      if (target.kind === "routine") await next.perform((client, signal) => client.routine(target.id, signal));
      if (active.current === next) { setRoutineId(target.kind === "routine" ? target.id : null); setPage(target.kind === "routine" ? "work" : "chats"); pendingNotice.current = null; await save({ ...config.current, selected: notice.service }); }
    } catch (failure) { if (diagnostic(failure) !== "mobile_response_stale") setError(diagnostic(failure)); }
  }
  useEffect(() => loaded ? observeNotificationTaps(notice => { void followNotice(notice); }, () => setError("mobile_link_unavailable")) : undefined, [loaded, adopt, save]);
  useEffect(() => {
    if (!loaded) return; let live = true;
    const listener = Linking.addEventListener("url", event => { if (live) void followLink(event.url); });
    void Linking.getInitialURL().then(value => { if (live && value) void followLink(value); }, () => { if (live) setError("mobile_link_unavailable"); });
    return () => { live = false; listener.remove(); };
  }, [loaded, adopt, save]);
  async function connect() {
    if (connecting.current || !lifecycle.native.active || !loaded) return; connecting.current = true; setError(null);
    const entered = password; setPassword(""); let next: MobileSession | null = null;
    try {
      next = createNativeSession(mobileOrigin(origin)); adopt(next); await next.signIn(entered); if (active.current !== next) return;
      const id = await mobileServiceId(next.transport.origin), services = config.current.services.filter(service => service.id !== id);
      if (services.length >= 8) throw Object.assign(Error(), { code: "mobile_service_limit" });
      await save({ contract: "s16-mobile-configuration/v1", locale, selected: id, services: [...services, { id, origin: next.transport.origin }] });
      const link = pendingLink.current; if (link?.service === id) await followLink(`jit://open/${id}/${link.conversationId}${link.requestId ? "/" + link.requestId : ""}`);
      const notice = pendingNotice.current; if (notice?.service === id) await followNotice(notice);
    } catch (failure) { if (!next || active.current === next) setError(diagnostic(failure)); } finally { connecting.current = false; }
  }
  async function chooseService(id: string) {
    const selected = config.current.services.find(service => service.id === id); if (!selected) return;
    setPassword(""); setOrigin(selected.origin); const next = createNativeSession(selected.origin); adopt(next);
    try { await save({ ...config.current, selected: id }); if (active.current === next && lifecycle.current.current.active) await next.restore(); } catch (failure) { if (active.current === next) setError(diagnostic(failure)); }
  }
  async function navigate(id: string | null, nextPage = page) {
    if (!session) return; setError(null); setRoutineId(null); setPage(nextPage); const generation = session.projection.generation + 1;
    try { await session.selectConversation(id); } catch (failure) { if (active.current === session && session.projection.generation === generation) setError(diagnostic(failure)); }
  }
  async function language(value: Locale) { setLocale(value); try { await save({ ...config.current, locale: value }); } catch (failure) { setError(diagnostic(failure)); } }
  async function signOut() {
    if (!session) return;
    try { await session.signOut(); controls?.drafts.clear(); await save({ ...config.current, selected: null }); setPassword(""); setPage("chats"); } catch (failure) { setError(diagnostic(failure)); }
  }
  const failure = lifecycle.failure ?? error ?? frame.code, ready = lifecycle.ready && frame.phase === "ready" && !!frame.bootstrap && !!controls, selection = session?.selectionRevision;
  const onFailure = (failure: unknown) => { const code = diagnostic(failure); if (active.current === session && session?.selectionRevision === selection && code !== "mobile_response_stale") setError(code); };
  return <SafeAreaProvider><StatusBar barStyle={ui.dark ? "light-content" : "dark-content"} /><SafeAreaView style={ui.styles.safe}><KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={ui.styles.fill}>
    <View key={`${instance.current}:${frame.generation}:${lifecycle.native.epoch}`} style={ui.styles.fill} onLayout={() => lifecycle.acknowledge(lifecycle.native.epoch, frame.generation, session)}>
      <View style={ui.styles.header}><UiText ui={ui} accessibilityRole="header" style={ui.styles.brand}>Jit</UiText>{session && <Button ui={ui} secondary label={ui.t("s16.common.refresh")} onPress={() => { void session.restore().catch(() => {}); }} />}</View>
      {failure && <View accessibilityRole="alert" style={ui.styles.notice}><UiText ui={ui}>{ui.t(failure === "mobile_link_unavailable" ? "s16.mobile.linkUnavailable" : "s16.common.error")}</UiText><UiText ui={ui} selectable style={ui.styles.muted}>{failure}</UiText></View>}
      {!loaded || !lifecycle.ready || ["loading", "background"].includes(frame.phase) ? <View style={ui.styles.center}><ActivityIndicator color={ui.colors.accent} /><UiText ui={ui}>{ui.t("s16.mobile.checking")}</UiText></View>
      : frame.phase === "unavailable" ? <View style={ui.styles.content}><UiText ui={ui}>{ui.t("s16.mobile.reconnect")}</UiText><Button ui={ui} label={ui.t("s16.desktop.reconnect")} onPress={() => { void session?.restore().catch(() => {}); }} /></View>
      : !ready ? <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={ui.styles.content}>
        <UiText ui={ui} accessibilityRole="header" style={ui.styles.title}>{ui.t("s16.mobile.connectTitle")}</UiText><UiText ui={ui}>{ui.t("s16.mobile.connectLead")}</UiText>
        <UiText ui={ui}>{ui.t("s16.mobile.service")}</UiText><TextInput accessibilityLabel={ui.t("s16.mobile.service")} value={origin} onChangeText={setOrigin} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={ui.styles.input} />
        <UiText ui={ui}>{ui.t("s14.login.password")}</UiText><TextInput accessibilityLabel={ui.t("s14.login.password")} value={password} onChangeText={setPassword} secureTextEntry textContentType="password" autoCapitalize="none" autoCorrect={false} style={ui.styles.input} onSubmitEditing={() => { void connect(); }} />
        <Button ui={ui} label={ui.t("s16.mobile.connect")} disabled={!origin || !password || connecting.current} onPress={() => { void connect(); }} />
        {configuration.services.length > 0 && <UiText ui={ui} accessibilityRole="header">{ui.t("s16.mobile.savedServices")}</UiText>}{configuration.services.map(service => <Button ui={ui} secondary key={service.id} label={service.origin} onPress={() => { void chooseService(service.id); }} />)}
        <View style={ui.styles.actions}><Button ui={ui} secondary label={ui.t("s16.mobile.languageEnglish")} onPress={() => { void language("en"); }} /><Button ui={ui} secondary label={ui.t("s16.mobile.languageThai")} onPress={() => { void language("th"); }} /></View>
      </ScrollView> : <>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={ui.styles.content}>
          {page === "more" ? <><UiText ui={ui} accessibilityRole="header" style={ui.styles.title}>{ui.t("s16.nav.more")}</UiText><UiText ui={ui} selectable>{session!.transport.origin}</UiText>
            <NotificationSettings ui={ui} control={controls!.notifications} onFailure={onFailure} />
            <Button ui={ui} secondary label={ui.t("s16.mobile.licenses")} onPress={() => setLicenses(value => !value)} />{licenses && <Licenses ui={ui} />}
            <Button ui={ui} secondary label={ui.t("s16.mobile.languageEnglish")} onPress={() => { void language("en"); }} /><Button ui={ui} secondary label={ui.t("s16.mobile.languageThai")} onPress={() => { void language("th"); }} /><Button ui={ui} secondary label={ui.t("s16.mobile.changeService")} onPress={() => { adopt(null); setPassword(""); }} /><Button ui={ui} secondary label={ui.t("s16.mobile.localSignOut")} onPress={() => { void signOut(); }} />
          </> : routineId ? <Routine ui={ui} session={session!} id={routineId} onFailure={onFailure} open={id => { void navigate(id, "chats"); }} /> : page === "work" ? <Work ui={ui} session={session!} bootstrap={frame.bootstrap!} onFailure={onFailure} open={id => { void navigate(id, "chats"); }} />
          : page === "needs" ? <><UiText ui={ui} accessibilityRole="header" style={ui.styles.title}>{ui.t("s16.nav.needsYou")}</UiText>{frame.bootstrap!.needsYou.length === 0 && <UiText ui={ui}>{ui.t("s16.mobile.needsEmpty")}</UiText>}{frame.bootstrap!.needsYou.map(item => <View key={`${item.conversationId}:${item.entry.id}`} style={ui.styles.card}><UiText ui={ui}>{ui.t("s16.chat.hold")} · {item.entry.code}</UiText><Button ui={ui} label={ui.t("s16.nav.chats")} onPress={() => { void navigate(item.conversationId, "chats"); }} /></View>)}</>
          : frame.snapshot ? <><Button ui={ui} secondary label={ui.t("s16.nav.chats")} onPress={() => { void navigate(null, "chats"); }} /><Conversation ui={ui} session={session!} snapshot={frame.snapshot} commands={controls!.commands} drafts={controls!.drafts} files={controls!.files} voice={controls!.voice} onFailure={onFailure} /></>
          : <><UiText ui={ui} accessibilityRole="header" style={ui.styles.title}>{ui.t("s16.nav.chats")}</UiText><Button ui={ui} label={ui.t("s16.chat.new")} onPress={() => { void navigate(crypto.randomUUID().replaceAll("-", ""), "chats"); }} />{frame.bootstrap!.conversations.length === 0 && <UiText ui={ui}>{ui.t("s16.chat.empty")}</UiText>}{frame.bootstrap!.conversations.map(item => <Pressable key={item.conversationId} style={ui.styles.card} accessibilityRole="button" accessibilityLabel={item.firstMessage || ui.t("s16.chat.title")} onPress={() => { void navigate(item.conversationId, "chats"); }}><UiText ui={ui} style={ui.styles.message}>{item.firstMessage || ui.t("s16.chat.title")}</UiText></Pressable>)}</>}
        </ScrollView>
        <View style={ui.styles.tabs}>{(["chats", "needs", "work", "more"] as Page[]).map(tab => <Pressable key={tab} accessibilityRole="tab" accessibilityState={{ selected: page === tab }} accessibilityLabel={ui.t(tab === "chats" ? "s16.nav.chats" : tab === "needs" ? "s16.nav.needsYou" : tab === "work" ? "s16.mobile.work" : "s16.nav.more")} onPress={() => { void navigate(null, tab); }} style={[ui.styles.tab, page === tab && ui.styles.selectedTab]}><Text style={[ui.styles.tabText, page === tab && ui.styles.selectedTabText]}>{ui.t(tab === "chats" ? "s16.nav.chats" : tab === "needs" ? "s16.nav.needsYou" : tab === "work" ? "s16.mobile.work" : "s16.nav.more")}</Text></Pressable>)}</View>
      </>}
    </View>
  </KeyboardAvoidingView></SafeAreaView></SafeAreaProvider>;
}
