import { useMemo } from "react";
import { Pressable, StyleSheet, Text, useColorScheme, type TextProps } from "react-native";
import { copy, type Copy } from "../../../src/s16/client/copy";
import type { Locale } from "../../../src/i18n";

/** Authored native palette; ordinary OS text scaling is never capped. */
export function useUi(locale: Locale) {
  const dark = useColorScheme() === "dark";
  return useMemo(() => {
    // Jit design tokens (src/web-design.ts, ui.design_tokens/v1): monochrome surfaces, no brand accent.
    const colors = dark
      ? { background: "#0a0a0a", card: "#141414", raised: "#1c1c1c", text: "#ededed", muted: "#a3a3a3", line: "#2e2e2e", accent: "#ededed", onAccent: "#0a0a0a", notice: "#1c1c1c", ok: "#86efac", warn: "#fde047" }
      : { background: "#fafaf9", card: "#ffffff", raised: "#f0f0ee", text: "#0a0a0a", muted: "#525252", line: "#dededb", accent: "#0a0a0a", onAccent: "#fafaf9", notice: "#f4f4f3", ok: "#15803d", warn: "#8f5706" };
    const styles = StyleSheet.create({
      fill: { flex: 1 }, safe: { flex: 1, backgroundColor: colors.background },
      header: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 10, gap: 12 },
      brand: { fontSize: 24, lineHeight: 34, fontWeight: "700", letterSpacing: -0.5, color: colors.text }, title: { fontSize: 26, lineHeight: 38, fontWeight: "700", letterSpacing: -0.5, color: colors.text },
      text: { fontSize: 16, lineHeight: 24, color: colors.text }, muted: { fontSize: 14, lineHeight: 20, color: colors.muted },
      content: { paddingHorizontal: 20, paddingTop: 8, gap: 14, paddingBottom: 32 }, center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
      input: { borderWidth: 1, borderColor: colors.line, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 13, minHeight: 50, color: colors.text, backgroundColor: colors.card, fontSize: 16 },
      composer: { minHeight: 56, maxHeight: 200, textAlignVertical: "top", borderWidth: 0, backgroundColor: "transparent", paddingHorizontal: 6, paddingVertical: 6 },
      composerCard: { padding: 12, gap: 10, borderWidth: 1, borderColor: colors.line, borderRadius: 24, backgroundColor: colors.card },
      button: { backgroundColor: colors.accent, paddingHorizontal: 20, paddingVertical: 12, minHeight: 48, borderRadius: 999, alignItems: "center", justifyContent: "center" },
      buttonText: { color: colors.onAccent, fontSize: 16, lineHeight: 24, fontWeight: "600", textAlign: "center" },
      secondary: { backgroundColor: "transparent", borderColor: colors.line, borderWidth: 1 }, secondaryText: { color: colors.text, fontWeight: "500" },
      compact: { minHeight: 44, paddingVertical: 9, paddingHorizontal: 18, alignSelf: "flex-start" }, composerRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 },
      dock: { flexGrow: 0, paddingHorizontal: 12, paddingTop: 6, paddingBottom: 8, maxHeight: "62%" },
      disabled: { opacity: 0.4 }, actions: { gap: 10, flexDirection: "row", flexWrap: "wrap" },
      tabs: { paddingHorizontal: 6, paddingVertical: 6, gap: 2, flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.background },
      tab: { flex: 1, minHeight: 48, paddingVertical: 8, paddingHorizontal: 2, alignItems: "center", justifyContent: "center", borderRadius: 999 },
      selectedTab: { backgroundColor: colors.raised }, tabText: { color: colors.muted, fontSize: 13, lineHeight: 20, fontWeight: "500", textAlign: "center" }, selectedTabText: { color: colors.text, fontWeight: "700" },
      card: { padding: 16, gap: 10, borderWidth: 1, borderColor: colors.line, borderRadius: 18, backgroundColor: colors.card },
      message: { fontSize: 16, lineHeight: 24, fontWeight: "600", color: colors.text },
      notice: { marginHorizontal: 20, marginBottom: 8, padding: 14, gap: 6, backgroundColor: colors.notice, borderRadius: 14, borderLeftWidth: 3, borderLeftColor: colors.warn },
      turn: { gap: 12, marginBottom: 10 }, bubble: { alignSelf: "flex-end", maxWidth: "88%", backgroundColor: colors.raised, borderRadius: 20, borderBottomRightRadius: 6, paddingHorizontal: 16, paddingVertical: 10 },
      reply: { gap: 10 }, status: { flexDirection: "row", alignItems: "center", gap: 7 }, dot: { width: 7, height: 7, borderRadius: 4 },
      payload: { fontFamily: "monospace", fontSize: 13, color: colors.text }, preview: { minHeight: 360, height: 480, backgroundColor: colors.card },
    });
    return { locale, dark, t: copy(locale), colors, styles };
  }, [locale, dark]);
}
export type Ui = ReturnType<typeof useUi>;
/** Native text always inherits readable current-theme color and supports OS accessibility scaling. */
export function UiText({ ui, style, ...props }: TextProps & { ui: Ui }) { return <Text {...props} style={[ui.styles.text, style]} />; }
/** Real owner control; the disabled state is exposed to assistive technology. */
export function Button({ ui, label, onPress, disabled = false, secondary = false, compact = false }: { ui: Ui; label: string; onPress(): void; disabled?: boolean; secondary?: boolean; compact?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[ui.styles.button, secondary && ui.styles.secondary, compact && ui.styles.compact, disabled && ui.styles.disabled]}>
    <Text style={[ui.styles.buttonText, secondary && ui.styles.secondaryText]}>{label}</Text>
  </Pressable>;
}
/** Safe diagnostic identifier only; never copies a native error message containing a local path or credential. */
export function diagnostic(error: unknown): string { return error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(error.code) ? error.code : "mobile_request_failed"; }
