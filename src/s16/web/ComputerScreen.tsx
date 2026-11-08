import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";
import { JitClientError, type JitClient } from "../client";
import type { ScreenCommand, ScreenView } from "../computers/screen";
import type { VmScreenInput } from "../../s15/vm/screen";
import type { MessageKey } from "../../i18n";
import type { Copy } from "./copy";

/** Props for one computer's live screen (DESK16-01). Every fact comes from `s16-computer-screen/v1`. */
export interface ComputerScreenProps {
  client: JitClient; t: Copy; vmId: string; title: string;
  onClose(): void;
  /** Shared private-content withholding for authentication/authorization failures. */
  onFailure(error: unknown): void;
}
type Command = { kind: "takeover" } | { kind: "hand_back" } | { kind: "renew" } | { kind: "input"; input: VmScreenInput };
const uid = () => crypto.randomUUID().replaceAll("-", "");
const code = (error: unknown) => error instanceof JitClientError ? error.code : "client_unavailable";
const privateFailure = (error: unknown) => error instanceof JitClientError && ([401, 403].includes(error.status ?? 0) || ["authentication_required", "authorization_required", "csrf_rejected"].includes(error.code));
/** Browser key names the screen forwards as one named key (everything printable is typed as text). */
const named: Record<string, string> = { Enter: "ret", Escape: "esc", Backspace: "backspace", Delete: "delete", Insert: "insert", Home: "home", End: "end", PageUp: "pgup", PageDown: "pgdn",
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `f${i + 1}`])) };

/**
 * Watch a working computer's screen and, when needed, take exclusive control: the Bot's work pauses, only the
 * owner's input reaches the screen, and handing back gives the Bot a fresh generation. A closed tab or lost
 * connection keeps the computer fenced (nobody writes) until the owner takes over again or hands it back.
 * Frames stay in memory only; typed text is sent once and cleared from the field.
 */
export function ComputerScreen({ client, t, vmId, title, onClose, onFailure }: ComputerScreenProps) {
  const [view, setView] = useState<ScreenView | null>(null), [frame, setFrame] = useState<{ url: string; generation: number } | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const [typed, setTyped] = useState(""), [reveal, setReveal] = useState(false);
  // Bumped by every command: a poll that started before a command never overwrites the command's fresh view.
  const commands = useRef(0);
  const viewRef = useRef<ScreenView | null>(null), screenRef = useRef<HTMLDivElement>(null), headingRef = useRef<HTMLHeadingElement>(null);
  viewRef.current = view;
  const fail = (failure: unknown) => { if (privateFailure(failure)) { onFailure(failure); return; } const reason = code(failure); if (reason === "stale_screen") setRefresh(value => value + 1); else setError(reason); };

  // Screen state: quick while control is changing hands, otherwise every few seconds.
  useEffect(() => {
    const stop = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try { const turn = commands.current, next = await client.screen(vmId, stop.signal); if (turn === commands.current) { setView(next); setError(null); } timer = setTimeout(() => void load(), next.state === "settling" ? 1000 : 3000); }
      catch (failure) { if (stop.signal.aborted) return; fail(failure); timer = setTimeout(() => void load(), 5000); }
    };
    void load();
    return () => { stop.abort(); clearTimeout(timer); };
  }, [vmId, refresh]);
  useEffect(() => { headingRef.current?.focus(); }, []);

  // Frames under the generation last seen; a stale frame reloads the state instead of showing an old screen.
  const generation = view?.available ? view.generation : null, driving = view?.state === "owner";
  useEffect(() => {
    if (generation === null) { setFrame(null); return; }
    const stop = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, url: string | null = null;
    const next = async () => {
      if (document.visibilityState === "visible") {
        try {
          const blob = await client.screenFrame(vmId, generation, stop.signal), fresh = URL.createObjectURL(blob);
          if (stop.signal.aborted) { URL.revokeObjectURL(fresh); return; }
          if (url) URL.revokeObjectURL(url); url = fresh; setFrame({ url: fresh, generation });
        } catch (failure) { if (stop.signal.aborted) return; if (code(failure) === "stale_screen") { setRefresh(value => value + 1); return; } fail(failure); }
      }
      timer = setTimeout(() => void next(), driving ? 500 : 1500);
    };
    void next();
    // The frame is dropped with its URL, so a frame of an earlier generation is never shown as the current screen.
    return () => { stop.abort(); clearTimeout(timer); if (url) URL.revokeObjectURL(url); setFrame(null); };
  }, [vmId, generation, driving]);

  // Owner control lasts only while this page renews it.
  useEffect(() => {
    if (view?.state !== "owner" && view?.state !== "settling") return;
    const timer = setInterval(() => void send({ kind: "renew" }, true), 10_000);
    return () => clearInterval(timer);
  }, [view?.state, view?.generation, view?.takeoverId]);

  async function send(command: Command, quiet = false): Promise<boolean> {
    const current = viewRef.current; if (!current) return false;
    const base = { contract: "s16-screen-command/v1" as const, requestId: uid(), vmId, generation: current.generation };
    const body: ScreenCommand = command.kind === "takeover" ? { ...base, kind: "takeover" } : command.kind === "hand_back" ? { ...base, kind: "hand_back", takeoverId: current.takeoverId }
      : command.kind === "renew" ? { ...base, kind: "renew", takeoverId: current.takeoverId ?? "" } : { ...base, kind: "input", takeoverId: current.takeoverId ?? "", input: command.input };
    if (!quiet) setBusy(true);
    commands.current++;
    try { const result = await client.screenCommand(body); commands.current++; setView(result.view); setError(null); return true; }
    catch (failure) { fail(failure); return false; }
    finally { if (!quiet) setBusy(false); }
  }
  const point = (event: MouseEvent<HTMLImageElement> | WheelEvent<HTMLImageElement>) => {
    const box = event.currentTarget.getBoundingClientRect(), width = view?.width ?? 1280, height = view?.height ?? 800;
    return { x: Math.min(width - 1, Math.max(0, Math.floor((event.clientX - box.left) * width / box.width))), y: Math.min(height - 1, Math.max(0, Math.floor((event.clientY - box.top) * height / box.height))) };
  };
  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (!driving || event.key === "Tab") return;
    const mods = [event.ctrlKey && "ctrl", event.altKey && "alt", event.metaKey && "meta"].filter(Boolean) as string[];
    const name = named[event.key] ?? (mods.length && /^[a-zA-Z0-9]$/.test(event.key) ? event.key.toLowerCase() : null);
    // Shift is part of every forwarded combination (Ctrl+Shift+Z is not Ctrl+Z); alone with a character it is just typing.
    if (name) { event.preventDefault(); void send({ kind: "input", input: { kind: "key", keys: [...mods, ...(event.shiftKey ? ["shift"] : []), name] } }); return; }
    if (event.key.length === 1 && !mods.length) { event.preventDefault(); void send({ kind: "input", input: { kind: "text", text: event.key } }); }
  }

  const state = view?.state;
  return <section className="computer-screen" aria-labelledby={`screen-${vmId}`}>
    <header className="screen-bar" data-driver={state === "owner" ? "owner" : "bot"}>
      <h3 id={`screen-${vmId}`} ref={headingRef} tabIndex={-1}>{t("s16.screen.title", { computer: title })}</h3>
      <span className={`pill ${state === "owner" ? "busy" : state === "fenced" ? "warn" : "ok"}`} role="status">{view ? t(`s16.screen.state.${view.state}` as MessageKey) : t("s16.common.loading")}</span>
      <div className="actions">
        {view?.available && (state === "agent" || state === "fenced") && <button type="button" className="primary" disabled={busy} onClick={() => void send({ kind: "takeover" }).then(ok => { if (ok) screenRef.current?.focus(); })}>{t(state === "fenced" ? "s16.screen.takeBack" : "s16.screen.takeOver")}</button>}
        {(state === "owner" || state === "settling" || state === "fenced") && <button type="button" disabled={busy} onClick={() => void send({ kind: "hand_back" })}>{t(state === "settling" ? "s16.screen.cancel" : "s16.screen.handBack")}</button>}
        <button type="button" onClick={onClose}>{t("s16.screen.close")}</button>
      </div>
    </header>
    <div aria-live="polite">
      {state === "settling" && <p className="notice">{t("s16.screen.settling")}</p>}
      {state === "owner" && <p className="notice">{t("s16.screen.driving")}</p>}
      {state === "fenced" && <p className="notice warn" role="alert">{t("s16.screen.fenced")}</p>}
      {view && !view.available && <p className="notice warn">{t("s16.screen.unavailable", { reason: view.code ?? "vm_desktop_unavailable" })}</p>}
      {error && <p className="notice warn" role="alert">{t("s16.screen.failed", { reason: error })}</p>}
    </div>
    {view?.scope.kind === "private" && <p className="limits">{t("s16.screen.private")}</p>}
    <div ref={screenRef} className="screen-frame" tabIndex={driving ? 0 : -1} aria-label={driving ? t("s16.screen.keyboard") : undefined} onKeyDown={key}>
      {frame && view?.available && frame.generation === view.generation ? <img src={frame.url} width={view?.width ?? 1280} height={view?.height ?? 800} alt={t("s16.screen.alt", { computer: title })} draggable={false}
        onClick={event => { if (driving) void send({ kind: "input", input: { kind: "click", ...point(event), button: "left", double: false } }); }}
        onContextMenu={event => { if (!driving) return; event.preventDefault(); void send({ kind: "input", input: { kind: "click", ...point(event), button: "right", double: false } }); }}
        onWheel={event => { if (driving && event.deltaY) void send({ kind: "input", input: { kind: "scroll", ...point(event), delta: Math.max(-5, Math.min(5, Math.round(event.deltaY / 100) || Math.sign(event.deltaY))) } }); }} />
        : view?.available && <p role="status">{t("s16.screen.waitingFrame")}</p>}
    </div>
    {driving && <form className="screen-type" onSubmit={event => { event.preventDefault(); const value = typed; setTyped(""); if (value) void send({ kind: "input", input: { kind: "text", text: value } }); }}>
      <label>{t("s16.screen.typeLabel")} <input type={reveal ? "text" : "password"} value={typed} autoComplete="off" spellCheck={false} maxLength={512} onChange={event => setTyped(event.target.value)} /></label>
      <label><input type="checkbox" checked={reveal} onChange={event => setReveal(event.target.checked)} /> {t("s16.screen.show")}</label>
      <button type="submit" disabled={busy || !typed}>{t("s16.screen.send")}</button>
      {(["ret", "tab", "esc", "backspace"] as const).map(name => <button key={name} type="button" disabled={busy} onClick={() => void send({ kind: "input", input: { kind: "key", keys: [name] } })}>{t(`s16.screen.key.${name}` as MessageKey)}</button>)}
      <p className="limits">{t("s16.screen.typeHint")}</p>
    </form>}
  </section>;
}
