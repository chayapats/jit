import { useEffect, useRef, useState } from "react";
import type { Locale, MessageKey } from "../../i18n";
import { JitClientError, type JitClient } from "../client";
import type { ComputerBotView, ComputerCommand, ComputersView as ComputersData, ComputerView } from "../computers/service";
import { ComputerScreen } from "./ComputerScreen";
import type { Copy } from "./copy";

/** Props for the owner computers surface (TEAM16-01). Data comes only from the protected client. */
export interface ComputersViewProps {
  client: JitClient; t: Copy; locale: Locale;
  /** Server capability. When false, no request is made and no control is shown. */
  available: boolean;
  /** FILE16-01C: file work can stage attachments into a computer and collect results. */
  files: boolean;
  /** Shared private-content withholding for authentication/authorization failures. */
  onFailure(error: unknown): void;
  /** BOT16-01: owner-written names of persistent Bots, keyed by Bot ID. */
  names?: Record<string, string>;
  /** DESK16-01: the owner can watch a running computer's screen and take control. */
  screen?: boolean;
}
type Pending = { command: ComputerCommand; state: "pending" | "unknown" | "error"; code?: string } | { command: ComputerCommand; state: "done" };
type Confirm = { kind: "create"; bot: ComputerBotView } | { kind: "retire"; bot: ComputerBotView; vmId: string };
const uid = () => crypto.randomUUID().replaceAll("-", "");
const code = (error: unknown) => error instanceof JitClientError ? error.code : "client_unavailable";
const privateFailure = (error: unknown) => error instanceof JitClientError && ([401, 403].includes(error.status ?? 0) || ["authentication_required", "authorization_required", "csrf_rejected"].includes(error.code));
const tones: Record<ComputerView["state"], string> = { running: "ok", sleeping: "idle", starting: "busy", stopping: "busy", stopped: "idle", setting_up: "busy", setup_failed: "warn", attention: "warn" };

/**
 * Owner computers: which Bot uses which computer, the observed state of every shared and private computer,
 * private-computer creation/retirement and "sleep now". Every change is one explicit command that is never
 * retried silently; an unknown outcome is rechecked with the same command identity.
 */
export function ComputersView({ client, t, locale, available, files, onFailure, names, screen }: ComputersViewProps) {
  const [watching, setWatching] = useState<string | null>(null), watchButton = useRef<HTMLButtonElement | null>(null);
  const [data, setData] = useState<ComputersData | null>(null), [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null), [confirm, setConfirm] = useState<Confirm | null>(null), [reload, setReload] = useState(0);
  // Bumped by every command: a poll that started before a command never overwrites the command's fresh view.
  const commands = useRef(0);
  const notice = useRef<HTMLDivElement>(null), confirmRef = useRef<HTMLDivElement>(null), returnFocus = useRef<HTMLElement | null>(null);
  const time = (value: number) => new Intl.DateTimeFormat(locale === "th" ? "th-TH" : "en-GB", { timeStyle: "short" }).format(value);
  const botName = (id: string) => data?.bots.find(bot => bot.id === id)?.main ? t("s16.computers.mainBot") : names?.[id] || id;

  useEffect(() => {
    if (!available) return;
    const stop = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const turn = commands.current, next = await client.computers(stop.signal);
        if (turn === commands.current) { setData(next); setLoadError(null); }
        // Poll quickly only while something is changing; otherwise refresh the idle clock occasionally.
        const moving = next.computers.some(item => ["starting", "stopping", "setting_up"].includes(item.state));
        timer = setTimeout(() => void load(), moving ? 3000 : 30000);
      } catch (error) {
        if (stop.signal.aborted || code(error) === "client_response_stale") return;
        if (privateFailure(error)) { onFailure(error); return; }
        setLoadError(code(error)); timer = setTimeout(() => void load(), 15000);
      }
    };
    void load();
    return () => { stop.abort(); clearTimeout(timer); };
  }, [available, reload]);
  useEffect(() => { if (confirm) confirmRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [confirm]);
  useEffect(() => { if (pending && pending.state !== "pending") notice.current?.focus(); }, [pending?.state]);

  async function send(command: ComputerCommand) {
    commands.current++; setPending({ command, state: "pending" });
    try { const result = await client.computerCommand(command); commands.current++; setData(result.view); setPending({ command, state: "done" }); }
    catch (error) {
      if (privateFailure(error)) { onFailure(error); return; }
      setPending(error instanceof JitClientError && error.outcome === "unknown" ? { command, state: "unknown" } : { command, state: "error", code: code(error) });
    }
  }
  function closeConfirm() { setConfirm(null); if (returnFocus.current?.isConnected) returnFocus.current.focus(); }
  function ask(next: Confirm, from: HTMLElement) { returnFocus.current = from; setConfirm(next); }

  if (!available) return <section className="computers" aria-labelledby="computers-title"><h1 id="computers-title">{t("s16.computers.title")}</h1><p>{t("s16.computers.unavailable")}</p></section>;
  const busy = pending?.state === "pending";
  const sharedIndex = new Map((data?.computers ?? []).filter(item => item.scope.kind === "shared").map((item, index) => [item.id, index] as const));
  const title = (item: ComputerView) => item.scope.kind === "private" ? t("s16.computers.private", { bot: botName(item.scope.botId) })
    : (sharedIndex.size > 1 && !item.isDefault ? t("s16.computers.sharedN", { n: (sharedIndex.get(item.id) ?? 0) + 1 }) : t("s16.computers.shared"));
  const status = (item: ComputerView) => {
    if (item.state === "running") return item.sleepsAt !== null ? t("s16.computers.sleepsAt", { time: time(item.sleepsAt) }) : null;
    if (item.state === "sleeping") return t("s16.computers.sleepingNote");
    if (item.state === "stopped") return t("s16.computers.stoppedNote");
    if (item.state === "attention") return t("s16.computers.attentionNote");
    if ((item.state === "setting_up" || item.state === "setup_failed") && item.setup) return t("s16.computers.setupStep", { step: item.setup.step });
    return null;
  };
  return <section className="computers" aria-labelledby="computers-title">
    <h1 id="computers-title">{t("s16.computers.title")}</h1>
    <p className="lead">{data?.idleStopMs ? t("s16.computers.lead", { minutes: Math.round(data.idleStopMs / 60000) }) : t("s16.computers.leadNoIdle")}{files ? " " + t("s16.computers.files") : ""}</p>
    <div ref={notice} tabIndex={-1} role={pending?.state === "error" || pending?.state === "unknown" ? "alert" : "status"} aria-live="polite">
      {pending?.state === "done" && <p className="notice ok">{t("s16.computers.saved")}</p>}
      {pending?.state === "error" && <p className="notice warn">{t("s16.computers.failed", { reason: pending.code ?? "client_unavailable" })}</p>}
      {pending?.state === "unknown" && <p className="notice warn">{t("s16.computers.unknown")} <button type="button" onClick={() => void send(pending.command)}>{t("s16.computers.checkAgain")}</button></p>}
    </div>
    {!data && !loadError && <p role="status">{t("s16.common.loading")}</p>}
    {loadError && <p role="alert">{t("s16.computers.loadFailed", { reason: loadError })} <button type="button" onClick={() => setReload(value => value + 1)}>{t("s16.computers.retry")}</button></p>}
    {data && <>
      <h2>{t("s16.computers.bots")}</h2>
      <ul className="computer-bots">{data.bots.map(bot => <li key={bot.id}>
        <strong>{botName(bot.id)}</strong> <span>{t(bot.computer.kind === "private" ? "s16.computers.usesPrivate" : "s16.computers.usesShared")}</span>
        {bot.computer.kind === "shared" && data.privateCreation.available && <button type="button" disabled={busy} onClick={event => ask({ kind: "create", bot }, event.currentTarget)}>{t("s16.computers.givePrivate", { bot: botName(bot.id) })}</button>}
        {bot.computer.kind === "private" && <button type="button" disabled={busy} onClick={event => ask({ kind: "retire", bot, vmId: (bot.computer as { vmId: string }).vmId }, event.currentTarget)}>{t("s16.computers.retire")}</button>}
      </li>)}</ul>
      {!data.privateCreation.available && data.privateCreation.code !== "computer_local_unavailable" && <p className="limits">{t("s16.computers.privateUnavailable", { reason: data.privateCreation.code })}</p>}
      {confirm && <div ref={confirmRef} className="notice confirm" role="group" aria-labelledby="computer-confirm-title" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); closeConfirm(); } }}>
        <h3 id="computer-confirm-title">{confirm.kind === "create" ? t("s16.computers.givePrivate", { bot: botName(confirm.bot.id) }) : t("s16.computers.retire")}</h3>
        <p>{t(confirm.kind === "create" ? "s16.computers.givePrivateBody" : "s16.computers.retireBody", { bot: botName(confirm.bot.id) })}</p>
        <button type="button" className="primary" disabled={busy} onClick={() => { const current = confirm; setConfirm(null); void send(current.kind === "create" ? { contract: "s16-computer-command/v1", requestId: uid(), kind: "create_private", botId: current.bot.id } : { contract: "s16-computer-command/v1", requestId: uid(), kind: "retire_private", vmId: current.vmId }); }}>{t(confirm.kind === "create" ? "s16.computers.create" : "s16.computers.confirmRetire")}</button>
        <button type="button" onClick={closeConfirm}>{t("s16.computers.cancel")}</button>
      </div>}
      <h2>{t("s16.computers.list")}</h2>
      {!data.computers.length && <p>{t("s16.computers.empty")}</p>}
      <ul className="computer-list" aria-label={t("s16.computers.list")}>{data.computers.map(item => <li key={item.id}><article className="computer-card" aria-labelledby={`computer-${item.id}`}>
        <header><h3 id={`computer-${item.id}`}>{title(item)}</h3><span className={`pill ${tones[item.state]}`}>{t(`s16.computers.state.${item.state}` as MessageKey)}</span>{item.retired && <span className="pill idle">{t("s16.computers.retired")}</span>}</header>
        <p className="meta">{item.capacity > 0 && t("s16.computers.sessions", { n: item.activeSessions, max: item.capacity })}{item.works > 0 && <> · {t("s16.computers.works", { n: item.works })}</>}</p>
        {status(item) && <p>{status(item)}</p>}
        {item.reason && <details><summary>{t("s16.common.details")}</summary><code>{item.reason}</code></details>}
        <div className="actions">
          {item.state === "running" && item.activeSessions === 0 && data.idleStopMs !== null && <button type="button" disabled={busy} onClick={() => void send({ contract: "s16-computer-command/v1", requestId: uid(), kind: "sleep", vmId: item.id })}>{t("s16.computers.sleepNow")}</button>}
          {screen && item.state === "running" && watching !== item.id && <button type="button" onClick={event => { watchButton.current = event.currentTarget; setWatching(item.id); }}>{t("s16.screen.watch")}</button>}
          {item.state === "setup_failed" && !item.retired && <button type="button" disabled={busy} onClick={() => void send({ contract: "s16-computer-command/v1", requestId: uid(), kind: "retry_private", vmId: item.id })}>{t("s16.computers.retry")}</button>}
        </div>
        {screen && watching === item.id && <ComputerScreen client={client} t={t} vmId={item.id} title={title(item)} onFailure={onFailure} onClose={() => { setWatching(null); requestAnimationFrame(() => { if (watchButton.current?.isConnected) watchButton.current.focus(); }); }} />}
      </article></li>)}</ul>
    </>}
  </section>;
}
