import { useCallback, useEffect, useSyncExternalStore } from "react";
import { Platform, View } from "react-native";
import * as Notifications from "expo-notifications";
import { MobileNotifications, type MobileNotificationOs, type MobileNotificationView } from "../../../src/s16/mobile/notifications";
import { nativeNotice, type NativeNotice } from "../../../src/s16/mobile/notices";
import { nativeActive } from "./files";
import Gate from "../modules/jit-native-gate";
import { Button, UiText, type Ui } from "./ui";

function permission(value: Notifications.NotificationPermissionsStatus): Awaited<ReturnType<MobileNotificationOs["permission"]>> {
  if (value.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL || value.ios?.status === Notifications.IosAuthorizationStatus.EPHEMERAL) return "provisional";
  if (value.granted && (!value.ios || value.ios.status === Notifications.IosAuthorizationStatus.AUTHORIZED)) return "granted";
  return value.status === "undetermined" ? "undetermined" : "denied";
}
/** Direct APNs/FCM device token only. No Expo Push Service, automatic enrollment or credential-bearing URL. */
export function notificationOs(title: string): MobileNotificationOs {
  return {
    provider: Platform.OS === "ios" ? "apns" : "fcm", active: nativeActive,
    configured: () => Gate.nativePushConfigured(),
    async permission() { return permission(await Notifications.getPermissionsAsync()); },
    async requestPermission() {
      if (Platform.OS === "android") await Notifications.setNotificationChannelAsync("jit-work", { name: title, importance: Notifications.AndroidImportance.DEFAULT, lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE });
      return permission(await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false, allowProvisional: false } }));
    },
    async token() { try { const token = await Notifications.getDevicePushTokenAsync(); if (token.type !== Platform.OS || typeof token.data !== "string") throw Error(); return token.data; } catch { throw Object.assign(Error(), { code: "mobile_notification_unavailable" }); } }
  };
}
const stateKeys: Record<MobileNotificationView["state"], Parameters<Ui["t"]>[0]> = {
  off: "s16.mobile.notificationOff", enabled: "s16.mobile.notificationEnabled", denied: "s16.mobile.notificationDenied", provisional: "s16.mobile.notificationProvisional", unavailable: "s16.mobile.notificationUnavailable", uncertain: "s16.mobile.notificationUncertain", token_changed: "s16.mobile.notificationTokenChanged"
};
/** Current protected subscription controls. Mount/Check reads; Enable and Disable each require an explicit press. */
export function NotificationSettings({ ui, control, onFailure }: { ui: Ui; control: MobileNotifications; onFailure(error: unknown): void }) {
  const subscribe = useCallback((listener: () => void) => control.subscribe(listener), [control]), snapshot = useCallback(() => control.projection, [control]);
  const view = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => { let live = true; void control.refresh().catch(error => { if (live) onFailure(error); }); return () => { live = false; }; }, [control]);
  return <View style={ui.styles.card}><UiText ui={ui} accessibilityRole="header">{ui.t("s16.mobile.notifications")}</UiText><UiText ui={ui} accessibilityLiveRegion="polite">{ui.t(stateKeys[view.state])}</UiText>
    <Button ui={ui} label={ui.t("s16.mobile.notificationEnable")} disabled={view.busy || view.state === "enabled" || view.state === "token_changed" || view.state === "unavailable"} onPress={() => { void control.enable(ui.locale).catch(onFailure); }} />
    {view.canDisable && <Button ui={ui} secondary label={ui.t("s16.mobile.notificationDisable")} disabled={view.busy} onPress={() => { void control.disable().catch(onFailure); }} />}
    <Button ui={ui} secondary label={ui.t("s16.mobile.notificationCheck")} disabled={view.busy} onPress={() => { void control.refresh().catch(onFailure); }} />
  </View>;
}
/** OS default taps carry navigation only. Action buttons and malformed envelopes are never interpreted. */
export function observeNotificationTaps(open: (notice: Readonly<NativeNotice>) => void, unavailable: () => void): () => void {
  let live = true; const seen = new Set<string>();
  const receive = (response: Notifications.NotificationResponse | null) => {
    if (!live || !response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const notice = nativeNotice(response.notification.request.content.data?.jit);
    if (!notice) { unavailable(); return; }
    if (seen.has(notice.id)) return; seen.add(notice.id); if (seen.size > 128) seen.delete(seen.values().next().value!);
    open(notice); void Notifications.clearLastNotificationResponseAsync().catch(() => {});
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(receive);
  void Notifications.getLastNotificationResponseAsync().then(receive, () => { if (live) unavailable(); });
  return () => { live = false; subscription.remove(); seen.clear(); };
}
