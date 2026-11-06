import { useEffect, useRef, useState, type ReactElement } from "react";
import type { Locale, MessageKey } from "../../i18n";
import { en } from "../../i18n/en";
import { JitClientError, type JitClient } from "../client";
import type { ClientArtifactItem, ClientRoutineDetail, ClientRoutineDraft, ClientRoutineList, ClientRoutineOccurrence, ClientRoutineOptions, ClientRoutineProposal, ClientRoutineSource, ClientRoutineSummary } from "../client/contracts";
import type { RoutineInstant, RoutineRecurrence } from "../routines/schedule";
import { suggestSchedule } from "../routines/suggest";
import type { Copy } from "./copy";

/** Conversational entry: the composer text and conversation that a new routine starts from. */
export interface RoutineSeed { conversationId: string; instruction: string; nonce: number }
export interface RoutinesViewProps {
  client: JitClient; t: Copy; locale: Locale;
  /** Server capability; when false no routine request is made. */
  available: boolean; artifacts: boolean;
  initialRoutine?: string | null; seed?: RoutineSeed | null;
  onFailure(error: unknown): void;
  onOpenConversation(conversationId: string): void;
  onSelect?(routineId: string | null): void;
  onAttention?(count: number): void;
}
type Load = "loading" | "ready" | "error";
type Notice = { state: "pending" | "done" | "unknown" | "error"; code?: string; retry?: () => void; message?: MessageKey };
type Minted = { kind: "secret"; secret: string; url: string; source: ClientRoutineSource } | { kind: "feed"; url: string };
const uid = () => crypto.randomUUID().replaceAll("-", "");
const code = (error: unknown) => error instanceof JitClientError ? error.code : "client_unavailable";
const privateFailure = (error: unknown) => error instanceof JitClientError && ([401, 403].includes(error.status ?? 0) || ["authentication_required", "authorization_required", "csrf_rejected"].includes(error.code));
const errorKey = (value: string | undefined): MessageKey => { const key = `s16.routine.error.${value}`; return key in en ? key as MessageKey : "s16.routine.error.generic"; };
const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
const zones = (() => { try { const list = Intl.supportedValuesOf("timeZone"); return list.includes("UTC") ? list : ["UTC", ...list]; } catch { return ["UTC"]; } })();
const localDate = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
type Repeat = "none" | "once" | "daily" | "weekdays" | "weekly" | "interval";
interface Form { name: string; instruction: string; conversationId: string; repeat: Repeat; time: string; date: string; days: number[]; minutes: number; timezone: string; misfire: "coalesce" | "skip"; quiet: boolean; maxRuns: number; endDate: string; purposeId: string; resourceIds: string[]; access: "read" | "reversible_write" | "effect" }

/**
 * Owner routines (`s16-client-routines/v1`). A routine starts from the conversation composer, is reviewed on a
 * server-computed sheet (next runs with DST interpretation, scope, limits) and saved only with that exact
 * review. Run now, pause, resume, stop and reaction sources are explicit exact-revision commands that never
 * retry silently; reading the list or a routine starts nothing.
 */
export function RoutinesView({ client, t, locale, available, artifacts, initialRoutine = null, seed = null, onFailure, onOpenConversation, onSelect, onAttention }: RoutinesViewProps) {
  const [list, setList] = useState<ClientRoutineList | null>(null), [listState, setListState] = useState<Load>("loading");
  const [selected, setSelected] = useState<string | null>(initialRoutine), [detail, setDetail] = useState<ClientRoutineDetail | null>(null), [detailState, setDetailState] = useState<Load>("loading");
  const [notice, setNotice] = useState<Notice | null>(null), [minted, setMinted] = useState<Minted | null>(null), [reload, setReload] = useState(0);
  const [sheet, setSheet] = useState<RoutineSeed | null>(seed), [confirmStop, setConfirmStop] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null), noticeRef = useRef<HTMLDivElement>(null), returnFocus = useRef<HTMLElement | null>(null);
  const date = (value: number) => new Intl.DateTimeFormat(locale === "th" ? "th-TH" : "en-GB", { dateStyle: "medium", timeStyle: "short" }).format(value);
  const fail = (error: unknown) => { if (code(error) === "client_response_stale") return true; if (privateFailure(error)) { onFailure(error); return true; } return false; };
  useEffect(() => { if (seed) setSheet(seed); }, [seed?.nonce]);
  // A periodic refresh must not dismiss an open stop confirmation; only another selection does.
  useEffect(() => { setConfirmStop(false); }, [selected]);
  useEffect(() => {
    if (!available) return;
    const stop = new AbortController(); setListState(value => list ? value : "loading");
    client.routines(stop.signal).then(data => { if (!stop.signal.aborted) { setList(data); setListState("ready"); onAttention?.(data.attention); } }).catch(error => { if (!stop.signal.aborted && !fail(error)) setListState("error"); });
    const timer = setInterval(() => { if (document.visibilityState === "visible") setReload(value => value + 1); }, 5000);
    return () => { stop.abort(); clearInterval(timer); };
  }, [available, reload]);
  useEffect(() => {
    onSelect?.(selected);
    if (!selected || !available) { setDetail(null); return; }
    const stop = new AbortController(); setDetailState(value => detail?.summary.routine.id === selected ? value : "loading");
    client.routine(selected, stop.signal).then(data => { if (!stop.signal.aborted) { setDetail(data); setDetailState("ready"); } }).catch(error => { if (!stop.signal.aborted && !fail(error)) setDetailState("error"); });
    return () => stop.abort();
  }, [selected, available, reload]);

  /** One explicit command. An unknown outcome keeps its request ID and offers "Check again" with the same identity. */
  async function run(body: Record<string, unknown> & { kind: string }, requestId = uid()) {
    setNotice({ state: "pending" });
    try {
      const receipt = await client.routineCommand({ ...body, requestId });
      setNotice({ state: "done", message: body.kind === "routine.confirm" ? "s16.routine.saved" : "s16.routine.updated" });
      if (receipt.secret && receipt.source?.path) setMinted({ kind: "secret", secret: receipt.secret, url: client.origin + receipt.source.path, source: receipt.source });
      else if (receipt.url) setMinted({ kind: "feed", url: receipt.url });
      setReload(value => value + 1); requestAnimationFrame(() => noticeRef.current?.focus());
      return receipt;
    } catch (error) {
      if (fail(error)) { setNotice(null); return null; }
      const outcome = error instanceof JitClientError ? error.outcome : "unknown";
      setNotice({ state: outcome === "unknown" ? "unknown" : "error", code: code(error), retry: () => void run(body, requestId) });
      requestAnimationFrame(() => noticeRef.current?.focus()); return null;
    }
  }
  function open(routineId: string, origin: HTMLElement | null) {
    returnFocus.current = origin; setMinted(value => value?.kind === "feed" ? value : null); setNotice(value => value?.state === "pending" || value?.state === "unknown" ? value : null); setSelected(routineId);
    const summary = list?.routines.find(row => row.routine.id === routineId);
    // Opening a routine with unseen outcomes is the owner's explicit acknowledgement that they looked.
    if (summary && summary.routine.attention > 0) void client.routineCommand({ kind: "routine.seen", requestId: uid(), routineId, expectedRevision: summary.routine.revision }).then(() => setReload(value => value + 1)).catch(error => { fail(error); });
    requestAnimationFrame(() => heading.current?.focus());
  }
  function close() { const id = selected; setSelected(null); setMinted(value => value?.kind === "feed" ? value : null); requestAnimationFrame(() => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); else if (id) document.querySelector<HTMLElement>(`[data-routine-id="${id}"]`)?.focus(); }); }

  const dayName = (day: number) => new Intl.DateTimeFormat(locale === "th" ? "th-TH" : "en-GB", { weekday: "short", timeZone: "UTC" }).format(Date.UTC(2026, 10, 8 + day));
  const describe = (rec: RoutineRecurrence | null) => !rec ? t("s16.routine.repeat.noneLong") : rec.kind === "once" ? t("s16.routine.describe.once", { date: rec.date, time: rec.time }) : rec.kind === "daily" ? t("s16.routine.describe.daily", { time: rec.time })
    : rec.kind === "weekly" ? (rec.days.join() === "1,2,3,4,5" ? t("s16.routine.describe.weekdays", { time: rec.time }) : t("s16.routine.describe.weekly", { days: rec.days.map(dayName).join(", "), time: rec.time }))
    : rec.minutes % 60 === 0 ? t("s16.routine.describe.hours", { count: rec.minutes / 60 }) : t("s16.routine.describe.minutes", { count: rec.minutes });
  const instant = (item: RoutineInstant, zone: string) => <><span>{t("s16.routine.at", { time: item.local, zone })}</span>{item.resolution !== "exact" && <small className="routine-dst"> · {t(item.resolution === "gap_shifted" ? "s16.routine.dst.gap" : "s16.routine.dst.overlap")}</small>}</>;
  const display = (summary: ClientRoutineSummary) => <span className={`memory-badge routine-state routine-state-${summary.display}`}>{t(`s16.routine.state.${summary.display}` as MessageKey)}</span>;
  const runState = (row: ClientRoutineOccurrence) => <span className={`memory-badge routine-run routine-run-${row.state}`}>{t(`s16.routine.run.${row.state}` as MessageKey)}</span>;
  const access = (value: string) => t(value === "read" ? "s16.routine.access.read" : value === "reversible_write" ? "s16.routine.access.write" : "s16.routine.access.effect");
  const noticeView = notice && <div ref={noticeRef} tabIndex={-1} className={`notice memory-notice ${notice.state === "done" ? "memory-ok" : ""}`} role={notice.state === "done" ? "status" : "alert"}>
    {notice.state === "pending" && <p>{t("s16.routine.saving")}</p>}
    {notice.state === "done" && <p>{t(notice.message ?? "s16.routine.updated")}</p>}
    {notice.state === "unknown" && <><p>{t("s16.routine.unknown")}</p><button type="button" onClick={notice.retry}>{t("s16.memory.checkAgain")}</button></>}
    {notice.state === "error" && <><p>{t(errorKey(notice.code))}</p>{notice.code === "stale_revision" && <button type="button" onClick={() => { setNotice(null); setReload(value => value + 1); }}>{t("s16.common.refresh")}</button>}<details><summary>{t("s16.common.details")}</summary><code>{notice.code}</code></details></>}
  </div>;

  if (!available) return <section className="memory" aria-labelledby="routines-title"><h2 id="routines-title">{t("s16.routine.title")}</h2><p className="memory-empty">{t("s16.routine.unavailable")}</p></section>;
  const summary = detail?.summary, routine = summary?.routine;
  return <section className={`memory routines ${selected ? "memory-has-detail" : ""}`} aria-labelledby="routines-title">
    <header className="memory-header routines-header"><div><h2 id="routines-title">{t("s16.routine.title")}</h2><p>{t("s16.routine.lead")}</p></div><button type="button" className="primary" onClick={() => setSheet({ conversationId: uid(), instruction: "", nonce: Date.now() })}>＋ {t("s16.routine.new")}</button></header>
    {!selected && noticeView}
    <div className="memory-results" aria-busy={listState === "loading"}>
      {listState === "loading" && !list && <p role="status">{t("s16.common.loading")}</p>}
      {listState === "error" && <div className="notice" role="alert"><p>{t("s16.common.error")}</p><button type="button" onClick={() => setReload(value => value + 1)}>{t("s16.common.refresh")}</button></div>}
      {list && (list.routines.length === 0 ? <div className="memory-empty"><p>{t("s16.routine.empty")}</p><p><small>{t("s16.routine.emptyHint")}</small></p></div>
        : <ul className="memory-list">{list.routines.map(row => <li key={row.routine.id}><button type="button" className="memory-row routine-row" data-routine-id={row.routine.id} aria-current={row.routine.id === selected ? "true" : undefined} onClick={event => open(row.routine.id, event.currentTarget)}>
          <span className="memory-snippet">{row.routine.draft.name}{row.routine.attention > 0 && <span className="count" aria-label={t("s16.routine.unseen", { count: row.routine.attention })}>{row.routine.attention}</span>}</span>
          <p className="memory-labels">{display(row)}<span>{describe(row.routine.draft.schedule)}</span>{row.sources > 0 && <span>{t("s16.routine.reactionsCount", { count: row.sources })}</span>}</p>
          <small>{row.next ? <>{t("s16.routine.next")}: {instant(row.next, row.routine.draft.timezone)}</> : t("s16.routine.noNext")} · {t("s16.routine.runsLeft", { count: row.remainingRuns })}</small>
        </button></li>)}</ul>)}
      {list && <FeedPanel t={t} feed={list.feed} run={run} minted={minted?.kind === "feed" ? minted.url : null} />}
    </div>
    {selected && <aside className="memory-detail routine-detail" aria-labelledby="routine-detail-title">
      <header className="routine-detail-header"><h2 id="routine-detail-title" ref={heading} tabIndex={-1}>{routine?.draft.name ?? t("s16.common.loading")}</h2><button type="button" aria-label={t("s16.common.close")} onClick={close}>×</button></header>
      {noticeView}
      {detailState === "loading" && !detail && <p role="status">{t("s16.common.loading")}</p>}
      {detailState === "error" && <div className="notice" role="alert"><p>{t("s16.common.error")}</p><button type="button" onClick={() => setReload(value => value + 1)}>{t("s16.common.refresh")}</button></div>}
      {summary && routine && <>
        <p className="memory-labels">{display(summary)}<span>{t("s16.routine.runsLeft", { count: summary.remainingRuns })}</span>{routine.skipped > 0 && <span>{t("s16.routine.skipped", { count: routine.skipped })}</span>}</p>
        <h3>{t("s16.routine.instruction")}</h3><p className="memory-text">{routine.draft.instruction}</p>
        <ul className="memory-facts">
          <li>{describe(routine.draft.schedule)} · {routine.draft.timezone}</li>
          <li>{t(routine.draft.misfire === "coalesce" ? "s16.routine.misfire.coalesce" : "s16.routine.misfire.skip")}</li>
          <li>{t(routine.draft.quiet ? "s16.routine.quiet.on" : "s16.routine.quiet.off")}</li>
          <li>{t("s16.routine.scopeLine", { purpose: routine.draft.scope.purposeId, resources: routine.draft.scope.resourceIds.join(", "), access: access(routine.draft.scope.access) })}</li>
          <li>{t("s16.routine.limitsLine", { runs: routine.draft.limits.maxRuns, date: date(routine.draft.limits.endsAt) })}</li>
          <li>{t("s16.routine.approvals")}</li>
        </ul>
        {routine.state === "ended" && <p className="notice">{t(routine.endedReason === "exhausted" ? "s16.routine.ended.exhausted" : routine.endedReason === "expired" ? "s16.routine.ended.expired" : "s16.routine.ended.completed")}</p>}
        {!!detail!.next.length && <><h3>{t("s16.routine.nextRuns")}</h3><ol className="memory-facts">{detail!.next.map(item => <li key={item.at}>{instant(item, routine.draft.timezone)}</li>)}</ol></>}
        <div className="memory-actions">
          {routine.state === "active" && <button type="button" className="primary" disabled={summary.remainingRuns === 0} onClick={() => void run({ kind: "routine.run_now", routineId: routine.id, expectedRevision: routine.revision })}>{t("s16.routine.runNow")}</button>}
          {routine.state === "active" && <button type="button" onClick={() => void run({ kind: "routine.pause", routineId: routine.id, expectedRevision: routine.revision })}>{t("s16.routine.pause")}</button>}
          {routine.state === "paused" && <button type="button" className="primary" onClick={() => void run({ kind: "routine.resume", routineId: routine.id, expectedRevision: routine.revision })}>{t("s16.routine.resume")}</button>}
          <button type="button" className="memory-link" onClick={() => onOpenConversation(routine.draft.conversationId)}>{t("s16.routine.openConversation")}</button>
          {(routine.state === "active" || routine.state === "paused") && !confirmStop && <button type="button" className="memory-danger" onClick={() => setConfirmStop(true)}>{t("s16.routine.stop")}</button>}
        </div>
        {confirmStop && <div className="memory-forget" role="group" aria-labelledby="routine-stop-title"><h3 id="routine-stop-title">{t("s16.routine.stopTitle")}</h3><p>{t("s16.routine.stopImpact")}</p><div className="memory-actions"><button type="button" className="memory-danger" onClick={() => { setConfirmStop(false); void run({ kind: "routine.stop", routineId: routine.id, expectedRevision: routine.revision }); }}>{t("s16.routine.stopConfirm")}</button><button type="button" onClick={() => setConfirmStop(false)}>{t("s16.common.cancel")}</button></div></div>}
        <Sources t={t} client={client} detail={detail!} artifacts={artifacts} run={run} minted={minted?.kind === "secret" ? minted : null} date={date} onFailure={fail} />
        <h3>{t("s16.routine.history")}</h3>
        {detail!.occurrences.length === 0 ? <p className="limits">{t("s16.routine.noHistory")}</p> : <ol className="routine-history">{detail!.occurrences.map(row => <li key={row.id}>
          <p className="memory-labels">{runState(row)}<span>{t(`s16.routine.trigger.${row.trigger}` as MessageKey)}</span><span>{row.local ? t("s16.routine.at", { time: row.local, zone: routine.draft.timezone }) : date(row.dueAt)}</span></p>
          {row.coalesced > 0 && <small>{t("s16.routine.coalesced", { count: row.coalesced })}</small>}
          {row.requestId && ["succeeded", "quiet", "needs_you", "waiting_review", "unknown", "failed", "denied", "stopped", "running", "submitted"].includes(row.state) && <button type="button" className="memory-link" onClick={() => onOpenConversation(routine.draft.conversationId)}>{t(row.state === "waiting_review" ? "s16.routine.review" : "s16.routine.openRun")}</button>}
          {(row.state === "unknown" || row.state === "needs_you") && !row.acknowledged && <button type="button" onClick={() => void run({ kind: "routine.acknowledge", routineId: routine.id, expectedRevision: routine.revision, occurrenceId: row.id })}>{t("s16.routine.acknowledge")}</button>}
          {row.code && <details><summary>{t("s16.common.details")}</summary><code>{row.code}</code></details>}
        </li>)}</ol>}
      </>}
    </aside>}
    {sheet && <RoutineSheet key={sheet.nonce} client={client} t={t} seed={sheet} describe={describe} instant={instant} access={access} onClose={() => setSheet(null)} onSaved={id => { setSheet(null); setReload(value => value + 1); open(id, null); }} onFailure={fail} />}
  </section>;
}

function FeedPanel({ t, feed, run, minted }: { t: Copy; feed: ClientRoutineList["feed"]; run: (body: Record<string, unknown> & { kind: string }) => Promise<unknown>; minted: string | null }) {
  return <section className="routine-feed" aria-labelledby="routine-feed-title"><h3 id="routine-feed-title">{t("s16.routine.feed.title")}</h3><p className="limits">{t("s16.routine.feed.lead")}</p>
    {minted && <div className="notice routine-secret" role="status"><p>{t("s16.routine.feed.copyOnce")}</p><code>{minted}</code></div>}
    <div className="memory-actions">
      {feed.enabled ? <><button type="button" onClick={() => void run({ kind: "feed.rotate", expectedRevision: feed.revision })}>{t("s16.routine.feed.rotate")}</button><button type="button" className="memory-danger" onClick={() => void run({ kind: "feed.disable", expectedRevision: feed.revision })}>{t("s16.routine.feed.disable")}</button></>
        : <button type="button" onClick={() => void run({ kind: "feed.enable", expectedRevision: feed.revision })}>{t("s16.routine.feed.enable")}</button>}
      <label className="routine-check"><input type="checkbox" checked={feed.names} onChange={event => void run({ kind: "feed.names", expectedRevision: feed.revision, names: event.target.checked })} /> {t("s16.routine.feed.names")}</label>
    </div></section>;
}

function Sources({ t, client, detail, artifacts, run, minted, date, onFailure }: { t: Copy; client: JitClient; detail: ClientRoutineDetail; artifacts: boolean; run: (body: Record<string, unknown> & { kind: string }) => Promise<unknown>; minted: Extract<Minted, { kind: "secret" }> | null; date: (at: number) => string; onFailure: (error: unknown) => boolean }) {
  const routine = detail.summary.routine, live = routine.state === "active" || routine.state === "paused";
  const [kind, setKind] = useState<"github" | "signed" | "artifact">(routine.draft.scope.access === "read" ? "github" : "artifact"), [repository, setRepository] = useState(""), [events, setEvents] = useState<string[]>(["ci_completed"]), [names, setNames] = useState("");
  const [files, setFiles] = useState<ClientArtifactItem[] | null>(null), [artifactId, setArtifactId] = useState("");
  useEffect(() => {
    if (kind !== "artifact" || !artifacts) return;
    const stop = new AbortController();
    client.artifacts({ q: "", type: "all", conversation: routine.draft.conversationId, before: null }, stop.signal).then(page => { if (!stop.signal.aborted) { setFiles(page.items); setArtifactId(value => value || page.items[0]?.artifact.id || ""); } }).catch(error => { if (!stop.signal.aborted && !onFailure(error)) setFiles([]); });
    return () => stop.abort();
  }, [kind, routine.id]);
  const signedAllowed = routine.draft.scope.access === "read", artifactAllowed = artifacts && routine.draft.scope.access !== "effect";
  const sourceLabel = (source: ClientRoutineSource) => source.kind === "github" ? t("s16.routine.source.githubLabel", { repository: source.repository ?? "" }) : source.kind === "signed" ? t("s16.routine.source.signedLabel", { events: source.events.join(", ") }) : t("s16.routine.source.artifactLabel");
  const submit = () => {
    const source = kind === "github" ? { kind, repository: repository.trim(), events } : kind === "signed" ? { kind, events: names.split(",").map(value => value.trim()).filter(Boolean) } : { kind, artifactId };
    void run({ kind: "routine.source.create", routineId: routine.id, expectedRevision: routine.revision, source });
  };
  return <section className="routine-sources" aria-labelledby="routine-sources-title"><h3 id="routine-sources-title">{t("s16.routine.source.title")}</h3><p className="limits">{t("s16.routine.source.lead")}</p>
    {minted && <div className="notice routine-secret" role="status"><p>{t("s16.routine.source.copyOnce")}</p><dl><dt>{t("s16.routine.source.url")}</dt><dd><code>{minted.url}</code></dd><dt>{t("s16.routine.source.secret")}</dt><dd><code>{minted.secret}</code></dd></dl><p className="limits">{t(minted.source.kind === "github" ? "s16.routine.source.githubHelp" : "s16.routine.source.signedHelp")}</p></div>}
    {detail.sources.filter(source => source.state === "active").map(source => <div className="routine-source" key={source.id}><p><strong>{sourceLabel(source)}</strong></p>
      {source.path && <p className="limits"><code>{client.origin + source.path}</code></p>}
      <p className="limits">{t("s16.routine.source.stats", { accepted: source.stats.accepted, coalesced: source.stats.coalesced, duplicates: source.stats.duplicates, ignored: source.stats.ignored, refused: source.stats.refused })}{source.stats.lastAt !== null && <> · {t("s16.routine.source.last", { date: date(source.stats.lastAt), outcome: source.stats.lastOutcome ?? "" })}</>}</p>
      {live && <div className="memory-actions">{source.kind !== "artifact" && <button type="button" onClick={() => void run({ kind: "routine.source.rotate", routineId: routine.id, expectedRevision: routine.revision, sourceId: source.id })}>{t("s16.routine.source.rotate")}</button>}<button type="button" className="memory-danger" onClick={() => void run({ kind: "routine.source.revoke", routineId: routine.id, expectedRevision: routine.revision, sourceId: source.id })}>{t("s16.routine.source.revoke")}</button></div>}
    </div>)}
    {live && <form className="memory-edit routine-source-form" onSubmit={event => { event.preventDefault(); submit(); }}>
      <label htmlFor="routine-source-kind">{t("s16.routine.source.kind")}</label>
      <select id="routine-source-kind" value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
        <option value="github" disabled={!signedAllowed}>{t("s16.routine.source.github")}</option><option value="signed" disabled={!signedAllowed}>{t("s16.routine.source.signed")}</option><option value="artifact" disabled={!artifactAllowed}>{t("s16.routine.source.artifact")}</option>
      </select>
      {!signedAllowed && <p className="limits">{t("s16.routine.source.readOnly")}</p>}
      {kind === "github" && signedAllowed && <><label htmlFor="routine-source-repo">{t("s16.routine.source.repository")}</label><input id="routine-source-repo" value={repository} placeholder="owner/name" onChange={event => setRepository(event.target.value)} />
        <fieldset className="routine-days"><legend>{t("s16.routine.source.events")}</legend>{(["ci_completed", "review_submitted"] as const).map(event => <label key={event} className="routine-check"><input type="checkbox" checked={events.includes(event)} onChange={change => setEvents(current => change.target.checked ? [...current, event].sort() : current.filter(value => value !== event))} /> {t(event === "ci_completed" ? "s16.routine.source.ci" : "s16.routine.source.reviewEvent")}</label>)}</fieldset></>}
      {kind === "signed" && signedAllowed && <><label htmlFor="routine-source-names">{t("s16.routine.source.names")}</label><input id="routine-source-names" value={names} placeholder="inbox.updated" onChange={event => setNames(event.target.value)} /></>}
      {kind === "artifact" && artifactAllowed && (files === null ? <p role="status">{t("s16.common.loading")}</p> : files.length === 0 ? <p className="limits">{t("s16.routine.source.noArtifacts")}</p>
        : <><label htmlFor="routine-source-artifact">{t("s16.routine.source.artifactPick")}</label><select id="routine-source-artifact" value={artifactId} onChange={event => setArtifactId(event.target.value)}>{files.map(item => <option key={item.artifact.id} value={item.artifact.id}>{item.artifact.name} · r{item.revision}</option>)}</select></>)}
      <div className="memory-actions"><button type="submit" disabled={kind === "github" ? !signedAllowed || !repository.trim() || !events.length : kind === "signed" ? !signedAllowed || !names.trim() : !artifactAllowed || !artifactId}>{t("s16.routine.source.add")}</button></div>
    </form>}
  </section>;
}

function RoutineSheet({ client, t, seed, describe, instant, access, onClose, onSaved, onFailure }: { client: JitClient; t: Copy; seed: RoutineSeed; describe: (rec: RoutineRecurrence | null) => string; instant: (item: RoutineInstant, zone: string) => ReactElement; access: (value: string) => string; onClose(): void; onSaved(id: string): void; onFailure: (error: unknown) => boolean }) {
  const suggested = suggestSchedule(seed.instruction);
  const repeatOf = (rec: RoutineRecurrence | null): Repeat => !rec ? "daily" : rec.kind === "weekly" ? (rec.days.join() === "1,2,3,4,5" ? "weekdays" : "weekly") : rec.kind;
  const [options, setOptions] = useState<ClientRoutineOptions | null>(null), [state, setState] = useState<Load>("loading");
  const [form, setForm] = useState<Form>(() => ({ name: Array.from(seed.instruction.trim().replace(/\s+/g, " ")).slice(0, 40).join("") || "", instruction: seed.instruction, conversationId: seed.conversationId, repeat: repeatOf(suggested),
    time: suggested && "time" in suggested ? suggested.time : "09:00", date: localDate(Date.now() + 86400000), days: suggested?.kind === "weekly" ? suggested.days : [1], minutes: suggested?.kind === "interval" ? suggested.minutes : 60, timezone: browserZone(), misfire: "coalesce", quiet: true, maxRuns: 30, endDate: localDate(Date.now() + 90 * 86400000), purposeId: "", resourceIds: [], access: "read" }));
  const [saving, setSaving] = useState<{ kind: "routine.confirm"; requestId: string; draft: ClientRoutineDraft; proposalHash: string } | null>(null);
  const [proposal, setProposal] = useState<ClientRoutineProposal | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null), first = useRef<HTMLInputElement>(null), requestId = useRef(uid());
  useEffect(() => {
    const stop = new AbortController();
    client.routineOptions(stop.signal).then(data => { if (stop.signal.aborted) return; setOptions(data); setState("ready"); if (data.defaults) setForm(value => ({ ...value, purposeId: value.purposeId || data.defaults!.purposeId, resourceIds: value.resourceIds.length ? value.resourceIds : data.defaults!.resourceIds, access: data.defaults!.access }));
      if (data.policyExpiresAt) setForm(value => ({ ...value, endDate: localDate(Math.min(data.policyExpiresAt! - 86400000, Date.now() + 90 * 86400000)) })); })
      .catch(failure => { if (!stop.signal.aborted && !onFailure(failure)) setState("error"); });
    requestAnimationFrame(() => first.current?.focus());
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } if (event.key === "Tab") { const controls = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)") ?? [])], head = controls[0], tail = controls.at(-1); if (event.shiftKey && document.activeElement === head) { event.preventDefault(); tail?.focus(); } else if (!event.shiftKey && document.activeElement === tail) { event.preventDefault(); head?.focus(); } } };
    document.addEventListener("keydown", key); return () => { stop.abort(); document.removeEventListener("keydown", key); };
  }, []);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => { setForm(current => ({ ...current, [key]: value })); setProposal(null); setError(null); };
  const draft = (): ClientRoutineDraft => {
    const schedule: RoutineRecurrence | null = form.repeat === "none" ? null : form.repeat === "once" ? { kind: "once", date: form.date, time: form.time } : form.repeat === "daily" ? { kind: "daily", time: form.time } : form.repeat === "weekdays" ? { kind: "weekly", days: [1, 2, 3, 4, 5], time: form.time } : form.repeat === "weekly" ? { kind: "weekly", days: [...form.days].sort(), time: form.time } : { kind: "interval", minutes: form.minutes };
    const endsAt = Math.min(new Date(`${form.endDate}T23:59:00`).getTime(), options?.policyExpiresAt ?? Number.MAX_SAFE_INTEGER);
    return { contract: "s16-routine-draft/v1", conversationId: form.conversationId, name: form.name.trim(), instruction: form.instruction, schedule, timezone: form.timezone, misfire: form.misfire, quiet: form.quiet, limits: { maxRuns: form.maxRuns, endsAt }, scope: { purposeId: form.purposeId, resourceIds: form.resourceIds, access: form.access } };
  };
  async function review() {
    setBusy(true); setError(null);
    try { setProposal(await client.proposeRoutine(draft())); }
    catch (failure) { if (!onFailure(failure)) setError(code(failure)); }
    finally { setBusy(false); }
  }
  /** Save exactly the reviewed proposal. An unknown outcome keeps that exact command for "Check again" and
   * blocks editing until it resolves; a definitive refusal releases the identity so a changed draft gets a new one. */
  async function save() {
    if (!proposal) return;
    const command = saving ?? { kind: "routine.confirm", requestId: requestId.current, draft: proposal.draft, proposalHash: proposal.proposalHash };
    setBusy(true); setError(null); setSaving(command);
    try { const receipt = await client.routineCommand(command); setSaving(null); if (receipt.routine) onSaved(receipt.routine.id); }
    catch (failure) {
      if (onFailure(failure)) return;
      setError(code(failure));
      if (!(failure instanceof JitClientError) || failure.outcome === "unknown") return;
      setSaving(null); requestId.current = uid(); if (code(failure) === "stale_proposal") setProposal(null);
    }
    finally { setBusy(false); }
  }
  function edit() { if (saving) return; requestId.current = uid(); setProposal(null); setError(null); }
  const field = (id: string, label: MessageKey, input: ReactElement) => <div className="routine-field"><label htmlFor={id}>{t(label)}</label>{input}</div>;
  return <div className="routine-overlay" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="routine-sheet" role="dialog" aria-modal="true" aria-labelledby="routine-sheet-title">
      <header className="routine-detail-header"><h2 id="routine-sheet-title">{t(proposal ? "s16.routine.sheet.reviewTitle" : "s16.routine.sheet.title")}</h2><button type="button" aria-label={t("s16.common.close")} onClick={onClose}>×</button></header>
      {state === "loading" && <p role="status">{t("s16.common.loading")}</p>}
      {state === "error" && <div className="notice" role="alert"><p>{t("s16.common.error")}</p></div>}
      {options && !options.available && <div className="notice" role="alert"><p>{t(options.code === "policy_required" ? "s16.routine.error.policy_required" : "s16.routine.error.policy_match_required")}</p></div>}
      {options?.available && !proposal && <form onSubmit={event => { event.preventDefault(); void review(); }}>
        <p className="limits">{t("s16.routine.sheet.lead")}</p>
        {field("routine-name", "s16.routine.field.name", <input ref={first} id="routine-name" required maxLength={80} value={form.name} onChange={event => set("name", event.target.value)} />)}
        {field("routine-instruction", "s16.routine.field.instruction", <textarea id="routine-instruction" required maxLength={4000} value={form.instruction} onChange={event => set("instruction", event.target.value)} />)}
        <div className="routine-grid">
          {field("routine-repeat", "s16.routine.field.repeat", <select id="routine-repeat" value={form.repeat} onChange={event => set("repeat", event.target.value as Repeat)}>{(["daily", "weekdays", "weekly", "interval", "once", "none"] as const).map(value => <option key={value} value={value}>{t(`s16.routine.repeat.${value}` as MessageKey)}</option>)}</select>)}
          {form.repeat === "interval" ? field("routine-minutes", "s16.routine.field.minutes", <input id="routine-minutes" type="number" min={options.limits.intervalMinutes.min} max={options.limits.intervalMinutes.max} step={15} value={form.minutes} onChange={event => set("minutes", Number(event.target.value))} />)
            : form.repeat !== "none" && field("routine-time", "s16.routine.field.time", <input id="routine-time" type="time" required value={form.time} onChange={event => set("time", event.target.value)} />)}
          {form.repeat === "once" && field("routine-date", "s16.routine.field.date", <input id="routine-date" type="date" required value={form.date} onChange={event => set("date", event.target.value)} />)}
          {field("routine-zone", "s16.routine.field.timezone", <select id="routine-zone" value={form.timezone} onChange={event => set("timezone", event.target.value)}>{zones.map(zone => <option key={zone} value={zone}>{zone}</option>)}</select>)}
        </div>
        {form.repeat === "weekly" && <fieldset className="routine-days"><legend>{t("s16.routine.field.days")}</legend>{[1, 2, 3, 4, 5, 6, 0].map(day => <label key={day} className="routine-check"><input type="checkbox" checked={form.days.includes(day)} onChange={event => set("days", event.target.checked ? [...form.days, day] : form.days.filter(value => value !== day))} /> {new Intl.DateTimeFormat(document.documentElement.lang === "en" ? "en-GB" : "th-TH", { weekday: "short", timeZone: "UTC" }).format(Date.UTC(2026, 10, 8 + day))}</label>)}</fieldset>}
        {form.repeat === "none" && <p className="limits">{t("s16.routine.repeat.noneLong")}</p>}
        <fieldset className="routine-days"><legend>{t("s16.routine.field.misfire")}</legend>
          <label className="routine-check"><input type="radio" name="misfire" checked={form.misfire === "coalesce"} onChange={() => set("misfire", "coalesce")} /> {t("s16.routine.misfire.coalesce")}</label>
          <label className="routine-check"><input type="radio" name="misfire" checked={form.misfire === "skip"} onChange={() => set("misfire", "skip")} /> {t("s16.routine.misfire.skip")}</label></fieldset>
        <label className="routine-check"><input type="checkbox" checked={form.quiet} onChange={event => set("quiet", event.target.checked)} /> {t("s16.routine.field.quiet")}</label>
        <div className="routine-grid">
          {field("routine-runs", "s16.routine.field.maxRuns", <input id="routine-runs" type="number" min={1} max={options.limits.maxRuns} value={form.maxRuns} onChange={event => set("maxRuns", Number(event.target.value))} />)}
          {field("routine-end", "s16.routine.field.endDate", <input id="routine-end" type="date" required value={form.endDate} onChange={event => set("endDate", event.target.value)} />)}
        </div>
        <fieldset className="routine-days"><legend>{t("s16.routine.field.scope")}</legend>
          {field("routine-purpose", "s16.routine.field.purpose", <select id="routine-purpose" value={form.purposeId} onChange={event => set("purposeId", event.target.value)}>{options.purposes.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select>)}
          <p className="routine-label">{t("s16.routine.field.resources")}</p>
          {options.resources.map(entry => <label key={entry.id} className="routine-check"><input type="checkbox" checked={form.resourceIds.includes(entry.id)} onChange={event => set("resourceIds", event.target.checked ? [...form.resourceIds, entry.id] : form.resourceIds.filter(value => value !== entry.id))} /> {entry.label}</label>)}
          <p className="routine-label">{t("s16.routine.field.access")}</p>
          {(["read", "reversible_write", "effect"] as const).map(value => <label key={value} className="routine-check"><input type="radio" name="access" checked={form.access === value} onChange={() => set("access", value)} /> {access(value)}</label>)}
        </fieldset>
        {error && <div className="notice" role="alert"><p>{t(errorKey(error))}</p><details><summary>{t("s16.common.details")}</summary><code>{error}</code></details></div>}
        <div className="memory-actions"><button type="submit" className="primary" disabled={busy || !form.name.trim() || !form.instruction.trim() || !form.resourceIds.length || form.repeat === "weekly" && !form.days.length}>{t(busy ? "s16.routine.saving" : "s16.routine.sheet.review")}</button><button type="button" onClick={onClose}>{t("s16.common.cancel")}</button></div>
      </form>}
      {proposal && <div className="routine-review">
        <p className="limits">{t("s16.routine.sheet.reviewLead")}</p>
        <h3>{proposal.draft.name}</h3><p className="memory-text">{proposal.draft.instruction}</p>
        <ul className="memory-facts">
          <li>{describe(proposal.draft.schedule)} · {proposal.draft.timezone}</li>
          <li>{t(proposal.draft.misfire === "coalesce" ? "s16.routine.misfire.coalesce" : "s16.routine.misfire.skip")}</li>
          <li>{t(proposal.draft.quiet ? "s16.routine.quiet.on" : "s16.routine.quiet.off")}</li>
          <li>{t("s16.routine.scopeLine", { purpose: proposal.effective.purpose.label, resources: proposal.effective.resources.map(entry => entry.label).join(", "), access: access(proposal.effective.access) })}</li>
          <li>{t("s16.routine.limitsLine", { runs: proposal.draft.limits.maxRuns, date: new Intl.DateTimeFormat(document.documentElement.lang === "en" ? "en-GB" : "th-TH", { dateStyle: "medium" }).format(proposal.draft.limits.endsAt) })}</li>
          <li>{t("s16.routine.approvals")}</li>
          <li>{t(proposal.effective.reactions.signed ? "s16.routine.sheet.reactionsRead" : "s16.routine.sheet.reactionsLimited")}</li>
        </ul>
        {proposal.next.length ? <><h3>{t("s16.routine.nextRuns")}</h3><ol className="memory-facts">{proposal.next.map(item => <li key={item.at}>{instant(item, proposal.draft.timezone)}</li>)}</ol>{proposal.draft.schedule?.kind === "interval" && <p className="limits">{t("s16.routine.sheet.intervalNote")}</p>}</> : <p className="limits">{t("s16.routine.repeat.noneLong")}</p>}
        {error && <div className="notice" role="alert"><p>{t(errorKey(error))}</p><details><summary>{t("s16.common.details")}</summary><code>{error}</code></details></div>}
        <div className="memory-actions">{saving && !busy && <p className="limits" role="status">{t("s16.routine.unknown")}</p>}<button type="button" className="primary" disabled={busy} onClick={() => void save()}>{t(busy ? "s16.routine.saving" : saving ? "s16.memory.checkAgain" : "s16.routine.sheet.save")}</button><button type="button" disabled={!!saving} onClick={edit}>{t("s16.routine.sheet.edit")}</button></div>
      </div>}
    </div>
  </div>;
}
