import { useMemo, useState } from "react";
import { View } from "react-native";
import notices from "../notices/index.json";
import { Button, UiText, type Ui } from "./ui";

/** Shipped original notices and corresponding-source data, paged to keep native text layout bounded. */
export function Licenses({ ui }: { ui: Ui }) {
  const [opened, setOpened] = useState<string | null>(null), [page, setPage] = useState(0);
  const selected = notices.components.find(component => component.id === opened);
  const text = useMemo(() => selected ? selected.notices.map(id => notices.texts.find(value => value.id === id)?.text ?? "").join("\n\n") : "", [selected]);
  const count = Math.max(1, Math.ceil(text.length / 12000));
  if (selected) return <View style={ui.styles.card}><Button ui={ui} secondary label={ui.t("s16.mobile.licenses")} onPress={() => { setOpened(null); setPage(0); }} /><UiText ui={ui} accessibilityRole="header">{selected.id}</UiText><UiText ui={ui}>{selected.license}</UiText><UiText ui={ui} selectable>{text.slice(page * 12000, (page + 1) * 12000)}</UiText><UiText ui={ui}>{ui.t("s16.mobile.licensePage", { page: page + 1, count })}</UiText><View style={ui.styles.actions}><Button ui={ui} secondary label={ui.t("s16.mobile.previousPage")} disabled={page === 0} onPress={() => setPage(value => value - 1)} /><Button ui={ui} secondary label={ui.t("s16.mobile.nextPage")} disabled={page + 1 >= count} onPress={() => setPage(value => value + 1)} /></View></View>;
  return <View style={ui.styles.card}><UiText ui={ui} accessibilityRole="header" style={ui.styles.title}>{ui.t("s16.mobile.licenses")}</UiText>{notices.components.map(component => <Button ui={ui} secondary key={component.id} label={component.id} onPress={() => { setOpened(component.id); setPage(0); }} />)}</View>;
}
