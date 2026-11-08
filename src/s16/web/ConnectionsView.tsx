import { useEffect, useRef, useState } from "react";
import type { Locale, MessageKey } from "../../i18n";
import { JitClientError, type JitClient } from "../client";
import type { ClientConnectionCommand, ClientConnectionRequest, ClientConnectionsView, ClientSource, ClientSourceKind, ClientToolClass } from "../client/contracts";
import type { Copy } from "./copy";

/** A chat card's prefill. It is a suggestion only: the owner still enters every secret and confirms on this page. */
export interface ConnectionSeed { kind: "github" | ClientSourceKind; endpoint: string | null; label: string | null; conversationId: string; requestId: string }
export interface ConnectionsViewProps {
  client: JitClient; t: Copy; locale: Locale;
  /** Server capability. When false, no request is made and no control is shown. */
  available: boolean;
  seed: ConnectionSeed | null;
  /** OAuth return (`?oauth=<sourceId>` or `?oauth_error=`): finishing sign-in is the owner's same flow. */
  oauth: { sourceId: string | null; error: string | null } | null;
  onFailure(error: unknown): void;
  onOpenConversation(conversationId: string): void;
}
type Pending = { command: ClientConnectionCommand; message: MessageKey; state: "pending" | "unknown" | "error"; code?: string } | { command: ClientConnectionCommand; message: MessageKey; state: "done"; policy: "installed" | "unchanged" | "review_required" | null };
const uid = () => crypto.randomUUID().replaceAll("-", "");
const code = (error: unknown) => error instanceof JitClientError ? error.code : "client_unavailable";
const privateFailure = (error: unknown) => error instanceof JitClientError && ([401, 403].includes(error.status ?? 0) || ["authentication_required", "authorization_required", "csrf_rejected"].includes(error.code));
const tones: Record<ClientSource["state"], string> = { authorizing: "busy", needs_review: "warn", active: "ok", reconnect_required: "warn", unavailable: "warn", removed: "idle" };
const classes: ClientToolClass[] = ["read", "change", "approval", "off"];
type AuthKind = "none" | "bearer" | "header" | "oauth";

/**
 * CONN16-01/MCP16-01/OPEN16-01 owner Connections page (ADR 0089): the GitHub app, HTTPS tool sources and the one-time
 * review of their discovered tools. Every change is one explicit command, never retried silently: an unknown outcome
 * is checked again with the same command identity. Secrets are typed here only, sent once and cleared from the form.
 */
export function ConnectionsView({ client, t, locale, available, seed, oauth, onFailure, onOpenConversation }: ConnectionsViewProps) {
  const [data, setData] = useState<ClientConnectionsView | null>(null), [loadError, setLoadError] = useState<string | null>(null), [reload, setReload] = useState(0);
  const [tab, setTab] = useState<"apps" | "sources">(seed && seed.kind !== "github" ? "sources" : "apps");
  const [pending, setPending] = useState<Pending | null>(null), [confirm, setConfirm] = useState<{ kind: "github" } | { kind: "source"; source: ClientSource } | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null), [choices, setChoices] = useState<Record<string, ClientToolClass>>({});
  const [token, setToken] = useState(""), [repos, setRepos] = useState<string[] | null>(null), [replacing, setReplacing] = useState(false);
  const [kind, setKind] = useState<ClientSourceKind>(seed && seed.kind !== "github" ? seed.kind : "mcp"), [label, setLabel] = useState(seed?.label ?? ""), [endpoint, setEndpoint] = useState(seed?.endpoint ?? "");
  const [auth, setAuth] = useState<AuthKind>("none"), [secret, setSecret] = useState(""), [header, setHeader] = useState(""), [document, setDocument] = useState("");
  const [reconnecting, setReconnecting] = useState<string | null>(null), [problem, setProblem] = useState<string | null>(null);
  const commands = useRef(0), notice = useRef<HTMLDivElement>(null), finishing = useRef(false);
  const date = (value: number) => new Intl.DateTimeFormat(locale === "th" ? "th-TH" : "en-GB", { dateStyle: "medium", timeStyle: "short" }).format(value);

  useEffect(() => {
    if (!available) return;
    const stop = new AbortController();
    const turn = commands.current;
    void client.connections(stop.signal).then(next => { if (turn === commands.current) { setData(next); setLoadError(null); } }).catch(error => {
      if (stop.signal.aborted || code(error) === "client_response_stale") return;
      if (privateFailure(error)) { onFailure(error); return; }
      setLoadError(code(error));
    });
    return () => stop.abort();
  }, [available, reload]);
  useEffect(() => { if (pending && pending.state !== "pending") notice.current?.focus(); }, [pending?.state]);
  // OAuth return: finish the owner's own sign-in once (exchange the received code), then show the tools to review.
  useEffect(() => {
    if (!data || !oauth || finishing.current) return;
    finishing.current = true;
    history.replaceState(null, "", "/s16/connections");
    if (oauth.error || !oauth.sourceId) { setTab("sources"); setProblem(oauth.error ?? "source_oauth_stale"); return; }
    const source = data.sources.find(item => item.id === oauth.sourceId);
    setTab("sources");
    if (source?.state === "authorizing") void run({ contract: "s16-connection-command/v1", requestId: uid(), kind: "source.oauth_complete", sourceId: source.id, expectedRevision: source.revision }, "s16.connections.signedIn");
  }, [data, oauth]);

  async function run(command: ClientConnectionCommand, message: MessageKey) {
    commands.current++; setPending({ command, message, state: "pending" }); setConfirm(null); setProblem(null);
    try {
      const receipt = await client.connectionCommand(command);
      if (receipt.authorize) { location.assign(receipt.authorize); return; }
      setPending({ command, message, state: "done", policy: receipt.policy });
      if (receipt.source && receipt.source.state === "needs_review") openReview(receipt.source);
      commands.current++; setReload(value => value + 1);
    } catch (error) {
      if (privateFailure(error)) { onFailure(error); return; }
      setPending(error instanceof JitClientError && error.outcome === "unknown" ? { command, message, state: "unknown" } : { command, message, state: "error", code: code(error) });
    }
  }
  function openReview(source: ClientSource) {
    setReviewing(source.id);
    setChoices(Object.fromEntries(source.tools.map(tool => [tool.name, tool.decision ?? tool.suggested])));
  }
  const busy = pending?.state === "pending";
  async function loadFile(file: File | undefined) { if (!file) return; if (file.size > (data?.limits.documentBytes ?? 1_048_576)) { setProblem("source_document_invalid"); return; } setDocument(await file.text()); }
  function addSource() {
    const authInput = auth === "bearer" ? { kind: "bearer" as const, secret } : auth === "header" ? { kind: "header" as const, name: header.trim(), secret } : { kind: auth };
    const command: ClientConnectionCommand = { contract: "s16-connection-command/v1", requestId: uid(), kind: "source.add", sourceKind: kind, label: label.trim() || endpoint.trim(), endpoint: endpoint.trim(), auth: authInput, document: kind === "mcp" ? null : document, origin: seed && seed.kind !== "github" ? { conversationId: seed.conversationId, requestId: seed.requestId } : null };
    setSecret(""); setTab("sources");
    void run(command, "s16.connections.added");
  }

  const status = pending && <div ref={notice} tabIndex={-1} role={pending.state === "error" ? "alert" : "status"} className={`notice ${pending.state === "done" ? "ok" : ""}`} aria-live="polite">
    {pending.state === "pending" && <p>{t("s16.connections.working")}</p>}
    {pending.state === "done" && <><p>{t(pending.message)}</p>{pending.policy === "review_required" && <p>{t("s16.connections.policyReview")} <a href="/rules">{t("s16.connections.reviewRules")}</a></p>}</>}
    {pending.state === "unknown" && <p>{t("s16.connections.unknown")} <button type="button" onClick={() => void run(pending.command, pending.message)}>{t("s16.connections.checkAgain")}</button></p>}
    {pending.state === "error" && <p>{t(pending.code === "source_oauth_stale" ? "s16.connections.oauthFailed" : "s16.connections.failed", { reason: pending.code ?? "" })}</p>}
  </div>;
  const local = problem && <div role="alert" className="notice"><p>{t(problem === "source_oauth_stale" ? "s16.connections.oauthFailed" : "s16.connections.failed", { reason: problem })}</p></div>;
  if (!available) return <section className="connections" aria-labelledby="connections-title"><h1 id="connections-title">{t("s16.connections.title")}</h1><p>{t("s16.connections.unavailable")}</p><p><a href="/resources">{t("s16.nav.connections")}</a></p></section>;

  const github = data?.github ?? null;
  const selected = repos ?? github?.selected ?? [];
  const tokenForm = (submit: MessageKey) => <form className="connection-form" onSubmit={event => { event.preventDefault(); const value = token; setToken(""); setReplacing(false); void run({ contract: "s16-connection-command/v1", requestId: uid(), kind: "github.connect", token: value }, "s16.connections.github.done"); }}>
    <label>{t("s16.connections.github.token")} <input type="password" autoComplete="off" spellCheck={false} value={token} onChange={event => setToken(event.target.value)} required /></label>
    <p className="limits">{t("s16.connections.secretNote")} <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer noopener">{t("s16.connections.github.create")}</a></p>
    <div className="actions"><button type="submit" className="primary" disabled={busy || !token.trim()}>{t(submit)}</button></div>
  </form>;
  const policyLine = (value: "installed" | "review_required" | "not_needed") => value === "installed" ? <span className="pill ok">{t("s16.connections.policyInstalled")}</span> : value === "review_required" ? <span>{t("s16.connections.policyReview")} <a href="/rules">{t("s16.connections.reviewRules")}</a></span> : null;
  const sourceCard = (source: ClientSource) => {
    const allowed = source.bots.filter(bot => bot.allowed).map(bot => bot.name || t("s16.bots.mainName")), denied = source.bots.filter(bot => !bot.allowed).map(bot => bot.name || t("s16.bots.mainName"));
    return <li key={source.id} className="computer-card connection-card">
      <header><h3>{source.label}</h3><span className={`pill ${tones[source.state]}`}>{t(`s16.connections.state.${source.state}` as MessageKey)}</span></header>
      <p className="meta">{t(`s16.connections.kind.${source.kind}` as MessageKey)} · <span className="mono">{source.endpoint}</span> · {t(`s16.connections.auth.${source.auth.kind}` as MessageKey)}{source.auth.header ? ` (${source.auth.header})` : ""}</p>
      <p className="meta">{t("s16.connections.toolCount", { count: source.tools.length })}{source.verifiedAt ? ` · ${t("s16.connections.verified", { date: date(source.verifiedAt) })}` : ""}{source.code && source.state !== "active" ? ` · ${t("s16.connections.reason", { code: source.code })}` : ""}</p>
      {source.changed && <p className="notice warn">{t("s16.connections.changed")}</p>}
      {!!source.bots.length && <p className="meta">{allowed.length > 0 && t("s16.connections.available", { names: allowed.join(", ") })}{denied.length > 0 && ` · ${t("s16.connections.notAvailable", { names: denied.join(", ") })}`} <small>{t("s16.connections.botsHint")}</small></p>}
      {source.reviewedHash && <p className="meta">{policyLine(source.policy)}</p>}
      <div className="actions">
        {(source.state === "needs_review" || source.state === "active") && source.tools.length > 0 && <button type="button" className={source.state === "needs_review" ? "primary" : ""} disabled={busy} onClick={() => reviewing === source.id ? setReviewing(null) : openReview(source)}>{t("s16.connections.review")}</button>}
        {source.auth.kind === "oauth" && (source.state === "authorizing" || source.state === "reconnect_required") && <button type="button" className="primary" disabled={busy} onClick={() => void run({ contract: "s16-connection-command/v1", requestId: uid(), kind: "source.oauth_begin", sourceId: source.id, expectedRevision: source.revision }, "s16.connections.signingIn")}>{t("s16.connections.signIn")}</button>}
        <button type="button" disabled={busy} onClick={() => void run({ contract: "s16-connection-command/v1", requestId: uid(), kind: "source.refresh", sourceId: source.id, expectedRevision: source.revision }, "s16.connections.added")}>{t("s16.connections.refresh")}</button>
        <button type="button" disabled={busy} onClick={() => { setReconnecting(reconnecting === source.id ? null : source.id); setAuth(source.auth.kind); setSecret(""); setHeader(source.auth.header ?? ""); }}>{t("s16.connections.reconnect")}</button>
        <button type="button" disabled={busy} onClick={() => setConfirm({ kind: "source", source })}>{t("s16.connections.remove")}</button>
      </div>
      {reconnecting === source.id && <form className="connection-form" onSubmit={event => { event.preventDefault(); const authInput = auth === "bearer" ? { kind: "bearer" as const, secret } : auth === "header" ? { kind: "header" as const, name: header.trim(), secret } : { kind: auth }; setSecret(""); setReconnecting(null); void run({ contract: "s16-connection-command/v1", requestId: uid(), kind: "source.reconnect", sourceId: source.id, expectedRevision: source.revision, auth: authInput }, "s16.connections.added"); }}>
        {authFields(source.kind, source.id)}
        <div className="actions"><button type="submit" className="primary" disabled={busy}>{t("s16.connections.reconnectSave")}</button></div>
      </form>}
      {reviewing === source.id && <section className="connection-review" aria-labelledby={`review-${source.id}`}>
        <h4 id={`review-${source.id}`}>{t("s16.connections.reviewTitle", { name: source.label })}</h4>
        <p className="limits">{t("s16.connections.reviewLead")}</p>
        <ul className="tool-list">{source.tools.map(tool => <li key={tool.name}>
          <div><strong>{tool.title}</strong> <code>{tool.name}</code>{tool.request && <> · <code>{tool.request}</code></>}</div>
          {tool.description && <details><summary>{t("s16.common.details")}</summary><p className="owner-text">{tool.description}</p></details>}
          <p className="limits">{t("s16.connections.suggested", { value: t(`s16.connections.class.${tool.suggested}` as MessageKey) })}{tool.hint.readOnly === true ? ` · ${t("s16.connections.hint.readOnly")}` : ""}{tool.hint.destructive === true ? ` · ${t("s16.connections.hint.destructive")}` : ""}{tool.hint.operation ? ` · ${t(`s16.connections.hint.${tool.hint.operation}` as MessageKey)}` : ""}</p>
          <label className="visually-hidden" htmlFor={`class-${source.id}-${tool.name}`}>{tool.title}</label>
          <select id={`class-${source.id}-${tool.name}`} value={choices[tool.name] ?? tool.suggested} onChange={event => setChoices(current => ({ ...current, [tool.name]: event.target.value as ClientToolClass }))}>
            {classes.filter(option => tool.allowed.includes(option)).map(option => <option key={option} value={option}>{t(`s16.connections.class.${option}` as MessageKey)}</option>)}
          </select>
        </li>)}</ul>
        {!!source.skipped.length && <details><summary>{t("s16.connections.skipped", { count: source.skipped.length })}</summary><ul>{source.skipped.map(item => <li key={item.name}><code>{item.name}</code> · {item.code}</li>)}</ul></details>}
        <div className="actions"><button type="button" className="primary" disabled={busy || !source.catalogHash} onClick={() => { const decisions = Object.fromEntries(source.tools.map(tool => [tool.name, choices[tool.name] ?? tool.suggested])); setReviewing(null); void run({ contract: "s16-connection-command/v1", requestId: uid(), kind: "source.review", sourceId: source.id, expectedRevision: source.revision, catalogHash: source.catalogHash!, decisions }, "s16.connections.reviewed"); }}>{t("s16.connections.confirm")}</button>
          <button type="button" onClick={() => setReviewing(null)}>{t("s16.connections.cancel")}</button></div>
      </section>}
    </li>;
  };
  function authFields(sourceKind: ClientSourceKind, scope: string) {
    return <>
      <label htmlFor={`auth-${scope}`}>{t("s16.connections.auth")}</label>
      <select id={`auth-${scope}`} value={auth} onChange={event => setAuth(event.target.value as AuthKind)}>
        {(["none", "bearer", "header", ...(sourceKind === "mcp" ? ["oauth"] : [])] as AuthKind[]).map(option => <option key={option} value={option}>{t(`s16.connections.auth.${option}` as MessageKey)}</option>)}
      </select>
      {auth === "header" && <label>{t("s16.connections.headerName")} <input value={header} onChange={event => setHeader(event.target.value)} autoComplete="off" spellCheck={false} required /></label>}
      {(auth === "bearer" || auth === "header") && <><label>{t("s16.connections.secret")} <input type="password" value={secret} onChange={event => setSecret(event.target.value)} autoComplete="off" spellCheck={false} required /></label><p className="limits">{t("s16.connections.secretNote")}</p></>}
      {auth === "oauth" && data && <p className="limits">{t("s16.connections.redirect", { uri: data.oauthRedirect })}</p>}
    </>;
  }

  return <section className="computers connections" aria-labelledby="connections-title">
    <h1 id="connections-title">{t("s16.connections.title")}</h1>
    <p className="lead">{t("s16.connections.lead")}</p>
    {seed && <p className="notice">{t("s16.connections.fromChat")} <button type="button" className="memory-link" onClick={() => onOpenConversation(seed.conversationId)}>{t("s16.connections.back")}</button></p>}
    {!data && !loadError && <p role="status">{t("s16.common.loading")}</p>}
    {loadError && <p role="alert">{t("s16.connections.loadFailed", { reason: loadError })} <button type="button" onClick={() => setReload(value => value + 1)}>{t("s16.connections.retry")}</button></p>}
    {status}{local}
    {confirm && <div className="notice confirm" role="alertdialog" aria-labelledby="connection-confirm"><p id="connection-confirm">{confirm.kind === "github" ? t("s16.connections.github.removeConfirm") : t("s16.connections.removeConfirm", { name: confirm.source.label })}</p>
      <button type="button" className="primary" disabled={busy} onClick={() => { if (confirm.kind === "github") { if (github) void run({ contract: "s16-connection-command/v1", requestId: uid(), kind: "github.remove", expectedRevision: github.revision }, "s16.connections.github.removed"); } else void run({ contract: "s16-connection-command/v1", requestId: uid(), kind: "source.remove", sourceId: confirm.source.id, expectedRevision: confirm.source.revision }, "s16.connections.removed"); }}>{confirm.kind === "github" ? t("s16.connections.github.remove") : t("s16.connections.remove")}</button>
      <button type="button" onClick={() => setConfirm(null)}>{t("s16.connections.cancel")}</button></div>}
    {data && <>
      <div role="tablist" aria-label={t("s16.connections.title")} className="tabs">
        <button type="button" role="tab" id="tab-apps" aria-controls="panel-apps" aria-selected={tab === "apps"} onClick={() => setTab("apps")}>{t("s16.connections.tabApps")}</button>
        <button type="button" role="tab" id="tab-sources" aria-controls="panel-sources" aria-selected={tab === "sources"} onClick={() => setTab("sources")}>{t("s16.connections.tabSources")} ({data.sources.length})</button>
      </div>
      {tab === "apps" && <div role="tabpanel" id="panel-apps" aria-labelledby="tab-apps">
        {!github ? <p>{t("s16.connections.unavailable")}</p> : <article className="computer-card connection-card">
          <header><h2>{t("s16.connections.github.title")}</h2>{github.state === "connected" && <span className="pill ok">{t("s16.connections.github.connected", { login: github.login ?? "" })}</span>}{github.state === "reconnect_required" && <span className="pill warn">{t("s16.connections.state.reconnect_required")}</span>}</header>
          <p className="meta">{t("s16.connections.github.default")}</p>
          {(github.state === "not_connected" || github.state === "removed") && <><p>{t("s16.connections.github.lead")}</p>{tokenForm("s16.connections.github.connect")}</>}
          {github.state === "reconnect_required" && <><p className="notice warn">{t("s16.connections.github.reconnectRequired")}</p>{tokenForm("s16.connections.github.reconnect")}</>}
          {(github.state === "connected" || github.state === "reconnect_required") && <>
            {github.tokenExpiresAt && <p className="meta">{t("s16.connections.github.expires", { date: date(github.tokenExpiresAt) })}</p>}
            <fieldset><legend>{t("s16.connections.github.repos")}</legend>
              {!github.accessible.length && <p>{t("s16.connections.github.noRepos")}</p>}
              {github.accessible.map(repo => <label key={repo.name} className="check"><input type="checkbox" checked={selected.includes(repo.name)} onChange={event => setRepos(current => { const base = current ?? github.selected; return event.target.checked ? [...base, repo.name] : base.filter(name => name !== repo.name); })} /> <span className="mono">{repo.name}</span>{repo.private && ` · ${t("s16.connections.github.private")}`}{!repo.push && ` · ${t("s16.connections.github.readOnly")}`}</label>)}
              {github.truncated && <p className="limits">{t("s16.connections.github.truncated")}</p>}
            </fieldset>
            <p className="meta">{policyLine(github.policy)}</p>
            <div className="actions">
              {github.state === "connected" && <button type="button" className="primary" disabled={busy || !repos} onClick={() => { const names = [...selected].sort(); setRepos(null); void run({ contract: "s16-connection-command/v1", requestId: uid(), kind: "github.select", expectedRevision: github.revision, names }, "s16.connections.github.saved"); }}>{t("s16.connections.github.save")}</button>}
              {github.state === "connected" && <button type="button" disabled={busy} onClick={() => setReplacing(!replacing)}>{t("s16.connections.github.reconnect")}</button>}
              <button type="button" disabled={busy} onClick={() => setConfirm({ kind: "github" })}>{t("s16.connections.github.remove")}</button>
            </div>
            {replacing && tokenForm("s16.connections.github.reconnect")}
          </>}
        </article>}
      </div>}
      {tab === "sources" && <div role="tabpanel" id="panel-sources" aria-labelledby="tab-sources">
        {!data.sources.length && <p>{t("s16.connections.sources.empty")}</p>}
        <ul className="computer-list">{data.sources.map(sourceCard)}</ul>
        <h2>{t("s16.connections.add")}</h2>
        <form className="connection-form" onSubmit={event => { event.preventDefault(); addSource(); }}>
          <fieldset><legend>{t("s16.connections.kind")}</legend>{(["mcp", "openapi", "graphql"] as ClientSourceKind[]).map(option => <label key={option} className="check"><input type="radio" name="source-kind" checked={kind === option} onChange={() => { setKind(option); if (option !== "mcp" && auth === "oauth") setAuth("none"); }} /> {t(`s16.connections.kind.${option}` as MessageKey)}</label>)}</fieldset>
          <label>{t("s16.connections.label")} <input value={label} maxLength={60} onChange={event => setLabel(event.target.value)} /></label>
          <label>{t(kind === "openapi" ? "s16.connections.endpointOpenapi" : "s16.connections.endpoint")} <input type="url" inputMode="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://" required={kind !== "openapi"} spellCheck={false} /></label>
          {kind !== "mcp" && <><label>{t(kind === "openapi" ? "s16.connections.document.openapi" : "s16.connections.document.graphql")} <textarea rows={8} value={document} onChange={event => setDocument(event.target.value)} spellCheck={false} required /></label>
            <label>{t("s16.connections.loadFile")} <input type="file" accept={kind === "openapi" ? ".json,.yaml,.yml" : ".graphql,.gql,.txt"} onChange={event => { void loadFile(event.target.files?.[0]); event.target.value = ""; }} /></label></>}
          {authFields(kind, "new")}
          <div className="actions"><button type="submit" className="primary" disabled={busy || kind !== "openapi" && !endpoint.trim() || kind !== "mcp" && !document.trim()}>{t("s16.connections.submit")}</button></div>
        </form>
      </div>}
    </>}
  </section>;
}

/** CONN16-01 chat card: a Bot's inert suggestion. Pressing it only opens the protected form; dismissing hides it. */
export function ConnectionRequestCard({ client, t, request, onOpen, onDismissed, onFailure }: { client: JitClient; t: Copy; request: ClientConnectionRequest; onOpen(request: ClientConnectionRequest): void; onDismissed(): void; onFailure(error: unknown): void }) {
  const [busy, setBusy] = useState(false);
  const kindLabel = request.kind === "github" ? "" : t(`s16.connections.kind.${request.kind}` as MessageKey);
  return <section className="action-card connection-request" aria-labelledby={`conn-${request.id}`}>
    <h3 id={`conn-${request.id}`}>{t("s16.connections.card.title")}</h3>
    <p>{request.kind === "github" ? t("s16.connections.card.github") : request.endpoint ? t("s16.connections.card.source", { kind: kindLabel, endpoint: request.endpoint }) : t("s16.connections.card.sourceNoEndpoint", { kind: kindLabel })}{request.label ? ` · ${request.label}` : ""}</p>
    <p className="card-note">{t("s16.connections.card.note")}</p>
    <div className="card-actions"><button type="button" className="primary" onClick={() => onOpen(request)}>{t("s16.connections.card.open")}</button>
      <button type="button" disabled={busy} onClick={() => { setBusy(true); void client.connectionCommand({ contract: "s16-connection-command/v1", requestId: uid(), kind: "request.dismiss", connectionRequestId: request.id }).then(onDismissed).catch(error => { setBusy(false); if (privateFailure(error)) onFailure(error); }); }}>{t("s16.connections.card.dismiss")}</button></div>
  </section>;
}
