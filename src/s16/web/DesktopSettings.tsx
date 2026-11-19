import { useEffect, useRef, useState } from "react";
import { observeDesktop, type DesktopStatus } from "../client/desktop";
import type { Copy } from "./copy";
import type { Locale } from "../../i18n";
import { notificationLocale } from "../client/notifications";

interface InstallPrompt extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> }

/** Browser-owned install/permission and public-package status. Every service action remains in its owning view. */
export function DesktopSettings({ t, locale, onReconnect }: { t: Copy; locale: Locale; onReconnect(): void }) {
  const standalone = () => matchMedia("(display-mode: standalone)").matches;
  const [installed, setInstalled] = useState(standalone), [promptState, setPromptState] = useState<"none" | "available" | "pending" | "dismissed" | "failed">("none");
  const [status, setStatus] = useState<DesktopStatus>({ state: "preparing", release: null }), [online, setOnline] = useState(navigator.onLine), [attempt, setAttempt] = useState(0);
  const prompt = useRef<InstallPrompt | null>(null), alive = useRef(true), epoch = useRef(0);
  useEffect(() => observeDesktop(setStatus), [attempt]);
  useEffect(() => { if (status.state === "ready" || status.state === "update") void notificationLocale(locale).catch(() => {}); }, [locale, status.state, status.release]);
  useEffect(() => {
    alive.current = true;
    const available = (event: Event) => { event.preventDefault(); prompt.current = event as InstallPrompt; epoch.current++; setPromptState("available"); };
    const done = () => { prompt.current = null; epoch.current++; setInstalled(true); setPromptState("none"); };
    const connectivity = () => setOnline(navigator.onLine), display = () => setInstalled(standalone());
    const media = matchMedia("(display-mode: standalone)");
    window.addEventListener("beforeinstallprompt", available); window.addEventListener("appinstalled", done); window.addEventListener("online", connectivity); window.addEventListener("offline", connectivity); media.addEventListener("change", display);
    return () => { alive.current = false; epoch.current++; window.removeEventListener("beforeinstallprompt", available); window.removeEventListener("appinstalled", done); window.removeEventListener("online", connectivity); window.removeEventListener("offline", connectivity); media.removeEventListener("change", display); };
  }, []);
  async function install() {
    const event = prompt.current; if (!event) return;
    prompt.current = null; const turn = ++epoch.current; setPromptState("pending");
    try {
      await event.prompt(); const choice = await event.userChoice;
      if (alive.current && turn === epoch.current) setPromptState(choice.outcome === "dismissed" ? "dismissed" : "none");
    } catch { if (alive.current && turn === epoch.current) setPromptState("failed"); }
  }
  return <section className="desktop-settings" aria-label={t("s16.desktop.title")}>
    <h2>{t("s16.desktop.title")}</h2><p className="desktop-origin">{t("s16.desktop.service", { origin: location.origin })}</p>
    <p>{t(installed ? "s16.desktop.installed" : promptState === "dismissed" ? "s16.desktop.dismissed" : promptState === "failed" ? "s16.desktop.failed" : "s16.desktop.instructions")}</p>
    {!installed && promptState === "available" && <button type="button" onClick={() => void install()}>{t("s16.desktop.install")}</button>}
    <p>{t("s16.desktop.permissions")}</p>
    <p role="status" data-desktop-state={status.state}>{t(!online ? "s16.desktop.offline" : status.state === "update" ? "s16.desktop.update" : status.state === "ready" ? "s16.desktop.ready" : status.state === "preparing" ? "s16.desktop.preparing" : "s16.desktop.unavailable")}</p>
    {status.release && <small className="desktop-version" title={status.release}>{status.release.slice(0, 12)}</small>}
    <button type="button" onClick={() => { setAttempt(value => value + 1); onReconnect(); }}>{t("s16.desktop.reconnect")}</button>
  </section>;
}
