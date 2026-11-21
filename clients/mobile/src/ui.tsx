import { useMemo } from "react";
import { Pressable, StyleSheet, Text, useColorScheme, type TextProps } from "react-native";
import { copy, type Copy } from "../../../src/s16/client/copy";
import type { Locale } from "../../../src/i18n";

/** Authored native palette; ordinary OS text scaling is never capped. */
export function useUi(locale: Locale) {
  const dark = useColorScheme() === "dark";
  return useMemo(() => {
    const colors = dark
      ? { background: "#14151a", card: "#202127", text: "#f4f4f7", muted: "#c2c3cf", line: "#545666", accent: "#c5caff", onAccent: "#15172a", notice: "#3e2c24" }
      : { background: "#f8f8fa", card: "#ffffff", text: "#20212a", muted: "#535664", line: "#a3a5b1", accent: "#343956", onAccent: "#ffffff", notice: "#fff1e6" };
    const styles = StyleSheet.create({
      fill: { flex: 1 }, safe: { flex: 1, backgroundColor: colors.background },
      header: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", padding: 16, gap: 12 },
      brand: { fontSize: 26, fontWeight: "700", color: colors.text }, title: { fontSize: 24, fontWeight: "600", color: colors.text },
      text: { fontSize: 16, color: colors.text }, muted: { fontSize: 14, color: colors.muted },
      content: { padding: 16, gap: 14, paddingBottom: 28 }, center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
      input: { borderWidth: 1, borderColor: colors.line, borderRadius: 12, padding: 14, minHeight: 48, color: colors.text, backgroundColor: colors.card, fontSize: 16 },
      composer: { minHeight: 100, textAlignVertical: "top" },
      button: { backgroundColor: colors.accent, paddingHorizontal: 16, paddingVertical: 13, minHeight: 48, borderRadius: 12, alignItems: "center", justifyContent: "center" },
      buttonText: { color: colors.onAccent, fontSize: 16, fontWeight: "600", textAlign: "center" },
      secondary: { backgroundColor: colors.card, borderColor: colors.line, borderWidth: 1 }, secondaryText: { color: colors.text },
      disabled: { opacity: 0.5 }, actions: { gap: 10, flexDirection: "row", flexWrap: "wrap" },
      tabs: { padding: 8, gap: 4, flexDirection: "row", borderTopWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
      tab: { flex: 1, minHeight: 48, paddingVertical: 12, paddingHorizontal: 4, alignItems: "center", justifyContent: "center", borderRadius: 10 },
      selectedTab: { backgroundColor: colors.accent }, tabText: { color: colors.text, fontSize: 14, textAlign: "center" }, selectedTabText: { color: colors.onAccent },
      card: { padding: 16, gap: 10, borderWidth: 1, borderColor: colors.line, borderRadius: 14, backgroundColor: colors.card },
      message: { fontSize: 16, fontWeight: "600", color: colors.text }, notice: { padding: 16, gap: 8, backgroundColor: colors.notice },
      payload: { fontFamily: "monospace", fontSize: 13, color: colors.text }, preview: { minHeight: 360, height: 480, backgroundColor: colors.card },
    });
    return { locale, dark, t: copy(locale), colors, styles };
  }, [locale, dark]);
}
export type Ui = ReturnType<typeof useUi>;
/** Native text always inherits readable current-theme color and supports OS accessibility scaling. */
export function UiText({ ui, style, ...props }: TextProps & { ui: Ui }) { return <Text {...props} style={[ui.styles.text, style]} />; }
/** Real owner control; the disabled state is exposed to assistive technology. */
export function Button({ ui, label, onPress, disabled = false, secondary = false }: { ui: Ui; label: string; onPress(): void; disabled?: boolean; secondary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[ui.styles.button, secondary && ui.styles.secondary, disabled && ui.styles.disabled]}>
    <Text style={[ui.styles.buttonText, secondary && ui.styles.secondaryText]}>{label}</Text>
  </Pressable>;
}
/** Safe diagnostic identifier only; never copies a native error message containing a local path or credential. */
export function diagnostic(error: unknown): string { return error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(error.code) ? error.code : "mobile_request_failed"; }
