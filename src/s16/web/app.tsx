import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Locale } from "../../i18n";
import { JitClient, JitClientError } from "../client";
import type { ClientBootstrap, ClientMessage, ClientSnapshot } from "../client/contracts";
import type { FileArtifact, FileReceipt, FileUploadCommand } from "../files/types";
import { ArtifactFileCard } from "./ArtifactFileCard";
import { copy } from "./copy";

type Chip = { key: string; name: string; bytes: number; file?: File; state: "selected" | "uploading" | "validating" | "ready" | "error"; code?: string; receipt?: FileReceipt; uploadId?: string; command?: FileUploadCommand };
type Draft = { text: string; chips: Chip[]; pending?: ClientMessage; recoveryId?: string; notFound?: boolean };
const uid = () => crypto.randomUUID().replaceAll("-", "");
const empty = (): Draft => ({ text: "", chips: [] });
const recoveryHash = () => /^#[A-Za-z0-9_-]{1,128}$/.test(location.hash) ? location.hash.slice(1) : undefined;
const errorCode = (error: unknown) => error instanceof JitClientError ? error.code : "client_unavailable";
const client = new JitClient({ origin: location.origin });

/** Implements the required S16 conversation/file handoff over real protected service contracts. */
function App() {
  const [locale, setLocale] = useState<Locale>(document.documentElement.lang === "en" ? "en" : "th"), t = copy(locale);
  const [boot, setBoot] = useState<Omit<ClientBootstrap, "csrf"> | null>(null), [conversation, setConversation] = useState(() => /^\/s16\/chat\/([A-Za-z0-9_-]{1,128})$/.exec(location.pathname)?.[1] ?? uid());
  const [snapshot, setSnapshot] = useState<ClientSnapshot | null>(null), [error, setError] = useState<string | null>(null), [drafts, setDrafts] = useState<Record<string, Draft>>(() => { const id = recoveryHash(); return id ? { [conversation]: { ...empty(), recoveryId: id } } : {}; }), [sending, setSending] = useState(false), [menu, setMenu] = useState(false), [search, setSearch] = useState("");
  const [authHidden, setAuthHidden] = useState(false), notice = useRef<HTMLDivElement>(null);
  const [library, setLibrary] = useState(false), [preview, setPreview] = useState<FileArtifact | null>(null), [previewText, setPreviewText] = useState<string | null>(null);
  const target = useRef(conversation), generation = useRef(0), picker = useRef<HTMLInputElement>(null), composer = useRef<HTMLTextAreaElement>(null), inspector = useRef<HTMLElement>(null), returnFocus = useRef<HTMLElement | null>(null), transfers = useRef(new Map<string, { stop: AbortController; cancelled: boolean }>());
  const refreshing = useRef<{ id: string; turn: number; stop: AbortController } | null>(null), privacyEpoch = useRef(0);
  const draft = drafts[conversation] ?? empty(), capabilities = boot?.capabilities.uploads, rows = snapshot?.conversation.rows ?? [];
  const pendingId = draft.pending?.requestId ?? draft.recoveryId;
  const change = (id: string, update: (draft: Draft) => Draft) => setDrafts(old => ({ ...old, [id]: update(old[id] ?? empty()) }));
  function closePreview() { const id = preview?.id; setPreview(null); setPreviewText(null); if (returnFocus.current?.isConnected) returnFocus.current.focus(); else if (id) document.querySelector<HTMLElement>(`[data-preview-for="${id}"]`)?.focus(); }
  function hidePrivate(error: unknown) {
    const code = typeof error === "string" ? error : errorCode(error); if (code === "client_response_stale") return;
    generation.current++; privacyEpoch.current++; refreshing.current?.stop.abort(); refreshing.current = null; setSnapshot(null); setPreview(null); setPreviewText(null); setError(code);
    if (["authentication_required", "csrf_rejected", "authorization_required"].includes(code) || error instanceof JitClientError && [401, 403].includes(error.status ?? 0)) {
      client.clear(); setBoot(null); setDrafts({}); setSearch(""); setSending(false); setAuthHidden(true);
      for (const transfer of transfers.current.values()) { transfer.cancelled = true; transfer.stop.abort(); } transfers.current.clear();
      requestAnimationFrame(() => notice.current?.focus());
    }
  }
  async function refresh(id = target.current) {
    if (id !== target.current) return;
    if (refreshing.current?.id === id) return;
    refreshing.current?.stop.abort(); const stop = new AbortController(), turn = ++generation.current; refreshing.current = { id, turn, stop }; setSnapshot(null);
    try { const data = await client.snapshot(id, stop.signal); if (turn !== generation.current || id !== target.current) return; setSnapshot(data); setError(null); }
    catch (error) { if (turn === generation.current && id === target.current) hidePrivate(error); }
    finally { if (refreshing.current?.turn === turn) refreshing.current = null; }
  }
  async function bootstrap() {
    const epoch = privacyEpoch.current;
    try { const data = await client.bootstrap(); if (epoch !== privacyEpoch.current) return; setBoot(data); setAuthHidden(false); await refresh(); const recovery = drafts[target.current]?.recoveryId; if (recovery && epoch === privacyEpoch.current) await recover(target.current, recovery); }
    catch (error) { if (epoch === privacyEpoch.current && errorCode(error) !== "client_response_stale") { hidePrivate(error); setBoot(null); } }
  }
  function navigate(id: string) { target.current = id; generation.current++; setConversation(id); setSnapshot(null); closePreview(); setLibrary(false); setMenu(false); setError(null); const pending = drafts[id]?.pending?.requestId ?? drafts[id]?.recoveryId; history.pushState(null, "", `/s16/chat/${id}${pending ? '#' + pending : ''}`); }
  useEffect(() => { history.replaceState(null, "", `/s16/chat/${conversation}${location.hash}`); void bootstrap();
    const pop = () => { const id = /^\/s16\/chat\/([A-Za-z0-9_-]{1,128})$/.exec(location.pathname)?.[1]; if (id) { target.current = id; generation.current++; setConversation(id); setSnapshot(null); closePreview(); const recovery = recoveryHash(); if (recovery) change(id, draft => draft.pending || draft.recoveryId ? draft : { ...draft, recoveryId: recovery }); } };
    window.addEventListener("popstate", pop); return () => { window.removeEventListener("popstate", pop); generation.current++; privacyEpoch.current++; refreshing.current?.stop.abort(); for (const transfer of transfers.current.values()) transfer.stop.abort(); client.clear(); };
  }, []);
  useEffect(() => { if (boot) void refresh(conversation); const timer = setInterval(() => { if (boot && document.visibilityState === "visible") void refresh(conversation); }, 4000); return () => clearInterval(timer); }, [conversation, !!boot]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    if (!preview) { setPreviewText(null); return; }
    const stop = new AbortController(); let sequence = 0;
    const load = async () => { const turn = ++sequence; setPreviewText(null); try { const bytes = await client.artifactBytes(preview, stop.signal); if (!stop.signal.aborted && turn === sequence) setPreviewText(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch (error) { if (!stop.signal.aborted) hidePrivate(error); } };
    void load(); const timer = setInterval(() => void load(), 4000); inspector.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { stop.abort(); clearInterval(timer); setPreviewText(null); };
  }, [preview?.id]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { closePreview(); setMenu(false); } if (event.key === "Tab" && preview && matchMedia("(max-width: 900px)").matches) { const controls = [...(inspector.current?.querySelectorAll<HTMLElement>("button,a[href]") ?? [])], first = controls[0], last = controls.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } };
    document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key);
  }, [preview]);
  async function upload(id: string, chip: Chip) {
    const transfer = { stop: new AbortController(), cancelled: false }; transfers.current.set(chip.key, transfer);
    const update = (patch: Partial<Chip>) => { if (!transfer.cancelled) change(id, draft => ({ ...draft, chips: draft.chips.map(current => current.key === chip.key ? { ...current, ...patch } : current) })); };
    let timer: ReturnType<typeof setInterval> | undefined, checking = false;
    const polling = new AbortController();
    update({ state: "uploading" });
    try {
      if (!chip.file) throw new JitClientError("file_unavailable", null, "not_sent");
      const bytes = new Uint8Array(await chip.file.arrayBuffer());
      if (transfer.cancelled) return;
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
      const command = chip.command ?? { requestId: uid(), conversationId: id, name: chip.name, bytes: bytes.length, sha256 }; update({ command });
      let status = chip.uploadId ? await client.uploadStatus(chip.uploadId, transfer.stop.signal) : await client.createUpload(command, transfer.stop.signal);
      update({ uploadId: status.id });
      if (transfer.cancelled) { await client.withdrawUpload(status.id); return; }
      const uploadId = status.id;
      // The phase comes from the server journal. No transfer percentage or fabricated validation delay.
      timer = setInterval(() => {
        if (checking || transfer.cancelled || polling.signal.aborted) return;
        checking = true;
        void client.uploadStatus(uploadId, AbortSignal.any([transfer.stop.signal, polling.signal])).then(current => {
          if (!polling.signal.aborted && !transfer.stop.signal.aborted && current.state === "validating") update({ state: "validating" });
        }).catch(error => { if (!polling.signal.aborted && error instanceof JitClientError && (error.status === 401 || error.status === 403)) { hidePrivate(error.code); transfer.stop.abort(); } }).finally(() => { checking = false; });
      }, 400);
      if (status.state === "created") status = await client.uploadBytes(status.id, bytes, transfer.stop.signal);
      // An uncertain upload reply may leave a live receiver/parser. Recover identity without replaying bytes.
      const until = Date.now() + 65000;
      while (["uploading", "validating"].includes(status.state) && !transfer.stop.signal.aborted && Date.now() < until) {
        if (status.state === "validating") update({ state: "validating" });
        await new Promise<void>(resolve => setTimeout(resolve, 400));
        status = await client.uploadStatus(status.id, transfer.stop.signal);
      }
      if (transfer.cancelled) { await client.withdrawUpload(status.id); return; }
      if (status.state !== "ready" || !status.receipt) throw new JitClientError(status.code ?? "file_unavailable", 409, "response");
      update({ state: "ready", receipt: status.receipt });
    } catch (error) { if (!transfer.cancelled) { update({ state: "error", code: errorCode(error) }); if (error instanceof JitClientError && (error.status === 401 || error.status === 403)) hidePrivate(error); } }
    finally { clearInterval(timer); polling.abort(); if (transfers.current.get(chip.key) === transfer) transfers.current.delete(chip.key); }
  }
  function choose(files: FileList | null) {
    if (!files || !capabilities?.available || pendingId) return;
    const id = conversation, selected = [...files];
    if (draft.chips.length + selected.length > capabilities.limits.messageFiles || draft.chips.reduce((sum, chip) => sum + chip.bytes, 0) + selected.reduce((sum, file) => sum + file.size, 0) > capabilities.limits.messageBytes) { setError("file_message_limit"); return; }
    const chips = selected.map(file => ({ key: uid(), file, name: file.name, bytes: file.size, state: "selected" as const })); change(id, draft => ({ ...draft, chips: [...draft.chips, ...chips] }));
    for (const chip of chips) {
      const extension = chip.name.split(".").at(-1)!.toLowerCase(), limit = capabilities.formats?.find(format => format.extension === extension)?.bytes ?? capabilities.limits.fileBytes;
      if (!chip.bytes || chip.bytes > limit || !capabilities.extensions.includes(extension)) change(id, draft => ({ ...draft, chips: draft.chips.map(current => current.key === chip.key ? { ...current, state: "error", code: "file_type_or_size_unavailable" } : current) }));
      else void upload(id, chip);
    }
  }
  async function remove(chip: Chip) {
    const transfer = transfers.current.get(chip.key); if (transfer) { transfer.cancelled = true; transfer.stop.abort(); }
    change(conversation, draft => ({ ...draft, chips: draft.chips.filter(current => current.key !== chip.key) }));
    if (chip.uploadId && chip.file) try { await client.withdrawUpload(chip.uploadId); } catch (error) { hidePrivate(error); }
  }
  async function selectReceipt(receipt: FileReceipt) {
    if (pendingId || !capabilities?.available || draft.chips.some(chip => chip.receipt?.id === receipt.id)) return;
    const id = conversation, epoch = privacyEpoch.current;
    try {
      const current = await client.uploadStatus(receipt.id);
      if (epoch !== privacyEpoch.current || target.current !== id) return;
      if (current.state !== "ready" || !current.receipt || current.conversationId !== id || current.receipt.sha256 !== receipt.sha256) throw new JitClientError("file_unavailable", 409, "response");
      if (draft.chips.length >= capabilities.limits.messageFiles || draft.chips.reduce((sum, chip) => sum + chip.bytes, 0) + current.receipt.bytes > capabilities.limits.messageBytes) throw new JitClientError("file_message_limit", 413, "not_sent");
      const chip: Chip = { key: uid(), name: current.receipt.name, bytes: current.receipt.bytes, state: "ready", receipt: current.receipt, uploadId: current.id };
      change(id, draft => draft.pending || draft.recoveryId || draft.chips.some(selected => selected.receipt?.id === receipt.id) || draft.chips.length >= capabilities.limits.messageFiles || draft.chips.reduce((sum, selected) => sum + selected.bytes, 0) + chip.bytes > capabilities.limits.messageBytes ? draft : { ...draft, chips: [...draft.chips, chip] }); composer.current?.focus();
    } catch (error) { if (epoch === privacyEpoch.current) hidePrivate(error); }
  }
  async function send() {
    if (sending || pendingId || draft.chips.some(chip => chip.state !== "ready") || !boot) return;
    const id = conversation;
    try {
      const command = client.prepareMessage(id, draft.text, draft.chips.map(chip => ({ id: chip.receipt!.id, sha256: chip.receipt!.sha256 }))); change(id, draft => ({ ...draft, pending: command })); setSending(true); history.replaceState(null, "", `/s16/chat/${id}#${command.requestId}`);
      await client.send(command); change(id, () => empty()); if (id === target.current) { history.replaceState(null, "", `/s16/chat/${id}`); await refresh(id); }
      const epoch = privacyEpoch.current, data = await client.bootstrap(); if (epoch === privacyEpoch.current) setBoot(data);
    } catch (error) {
      if (error instanceof JitClientError && (error.outcome === "not_sent" || error.outcome === "response" && ["invalid_text", "file_unavailable", "file_count_limit", "file_message_limit", "body_too_large", "invalid_contract", "invalid_body", "outside_scope", "upload_unavailable"].includes(error.code))) change(id, ({ pending: _pending, notFound: _notFound, ...draft }) => draft);
      if (id === target.current) hidePrivate(error);
    } finally { setSending(false); }
  }
  async function recover(id = conversation, requestId = drafts[id]?.pending?.requestId ?? drafts[id]?.recoveryId) {
    if (!requestId) return; const epoch = privacyEpoch.current;
    try { const found = await client.request(requestId); if (epoch !== privacyEpoch.current) return; if (found.conversationId !== id) throw new JitClientError("client_recovery_scope_mismatch", null, "response"); change(id, () => empty()); if (target.current === id) { history.replaceState(null, "", `/s16/chat/${id}`); await refresh(id); } }
    catch (error) { if (epoch !== privacyEpoch.current) return; if (error instanceof JitClientError && error.status === 404) change(id, draft => ({ ...draft, notFound: true })); else hidePrivate(error); }
  }
  function composeReplacement() { if (!draft.recoveryId || !draft.notFound) return; change(conversation, () => empty()); history.replaceState(null, "", `/s16/chat/${conversation}`); requestAnimationFrame(() => composer.current?.focus()); }
  async function resend() { if (!draft.pending || !draft.notFound || sending) return; const id = conversation; setSending(true); try { await client.send(draft.pending); change(id, () => empty()); if (target.current === id) { history.replaceState(null, "", `/s16/chat/${id}`); await refresh(id); } } catch (error) { hidePrivate(error); } finally { setSending(false); } }
  const status = (state: string) => t(state === "done" ? "s16.chat.done" : state === "working" || state === "inspecting" ? "s16.chat.working" : state === "understanding" ? "s16.chat.understanding" : state === "received" ? "s16.chat.received" : state === "stopped" ? "s16.chat.stopped" : "s16.chat.hold");
  const artifactCards = (items: FileArtifact[]) => { const epoch = privacyEpoch.current; return items.map(artifact => <ArtifactFileCard key={artifact.id} artifact={artifact} client={client} t={t} onPreview={(file, focus) => { returnFocus.current = focus; setPreview(file); }} onFailure={error => { if (epoch === privacyEpoch.current) hidePrivate(error); }} />); };
  const fileDetails = (file: FileReceipt) => <details className="source-details"><summary>{t("s16.common.details")}</summary><p>{t("s16.files.original")} · {file.mime} · {file.bytes.toLocaleString()} bytes</p><code>{file.sha256}</code>{file.contract === "s16-file-receipt/v2" && <><p>{t("s16.files.transformed")} · {file.representation.mime} · {file.representation.bytes.toLocaleString()} bytes</p>{file.representation.pages !== null ? <p>{t("s16.files.pages", { count: file.representation.pages })}</p> : <p>{file.representation.originalWidth} × {file.representation.originalHeight} → {file.representation.width} × {file.representation.height} px</p>}<code>{file.representation.sha256}</code></>}</details>;
  return <div className={`s16-app ${menu ? "nav-open" : ""} ${preview ? "inspector-open" : ""}`}>
    <a className="skip-link" href="#conversation-main">{t("s16.nav.chats")}</a>
    <nav className="rail" aria-label={t("s16.common.menu")}><a className="brand" href="/s16">Jit <span>S16</span></a><button onClick={() => navigate(uid())}>＋ {t("s16.chat.new")}</button><label className="search"><span>{t("s16.nav.search")}</span><input value={search} onChange={event => setSearch(event.target.value)} /></label>
      <a href="/needs-you">{t("s16.nav.needsYou")} <span className="count">{boot?.needsYou.length ?? 0}</span></a><h2>{t("s16.nav.bots")}</h2><button className="bot selected" onClick={() => setLibrary(false)}>● {t("s16.chat.title")}</button>
      <div className="recent">{boot?.conversations.filter(entry => entry.firstMessage.toLowerCase().includes(search.toLowerCase())).map(entry => <button key={entry.conversationId} aria-current={entry.conversationId === conversation ? "page" : undefined} onClick={() => navigate(entry.conversationId)}>{entry.firstMessage || t("s16.chat.receivedFiles")}</button>)}</div>
      <a href="/work">{t("s15.nav.work")}</a><button onClick={() => { setLibrary(true); setMenu(false); }}>{t("s16.nav.artifacts")}</button><div className="rail-secondary"><a href="/memory">{t("s16.nav.memory")}</a><a href="/resources">{t("s16.nav.connections")}</a><a href="/rules">{t("s16.nav.settings")}</a><label>{t("s16.common.language")} <select value={locale} onChange={event => setLocale(event.target.value === "en" ? "en" : "th")}><option value="th">TH</option><option value="en">English</option></select></label></div>
    </nav>
    <main id="conversation-main"><header className="chat-header"><button className="menu-toggle" aria-label={t("s16.common.menu")} onClick={() => setMenu(!menu)}>☰</button><div><h1>{t("s16.chat.title")}</h1><p>{t("s16.chat.lead")}</p></div><button onClick={() => void bootstrap()}>{t("s16.common.refresh")}</button></header>
      <div className="transcript" aria-busy={!snapshot && !error}>
        {error && <div ref={notice} tabIndex={-1} role="alert" className="notice"><p>{t(authHidden ? "s16.common.authenticationRequired" : "s16.common.error")}</p><details><summary>{t("s16.common.details")}</summary><code>{error}</code></details></div>}
        {!snapshot && !error && <p role="status">{t("s16.common.loading")}</p>}
        {library ? <section><h2>{t("s16.artifact.current")}</h2>{artifactCards(rows.flatMap(row => row.files?.artifacts ?? []))}{!rows.some(row => row.files?.artifacts.length) && <p>{t("s16.artifact.empty")}</p>}</section> : <>
          {snapshot && !rows.length && <div className="empty"><h2>{t("s16.chat.empty")}</h2></div>}
          {rows.map(row => <article className="exchange" key={row.requestId}><div className="owner-message"><p>{row.ownerMessage}</p>{row.files?.inputs.map(file => <div className="source-chip" key={file.id}><span>{file.name} · {file.bytes.toLocaleString()} bytes</span>{fileDetails(file)}<button disabled={!!pendingId || draft.chips.some(chip => chip.receipt?.id === file.id)} onClick={() => void selectReceipt(file)}>{t("s16.files.useNext")}</button><button title={t("s16.files.withdrawImpact")} onClick={() => void client.withdrawUpload(file.id).then(() => refresh()).catch(error => hidePrivate(error))}>{t("s16.files.withdraw")}</button></div>)}</div>
            <div className="bot-message"><strong>{t("s16.chat.title")}</strong><span className="status">{status(row.state)}</span>{row.result ? <p className="result">{row.result.text}</p> : row.files && row.state === "received" ? <p>{t("s16.chat.receivedFiles")}</p> : null}
              {artifactCards(row.files?.artifacts ?? [])}{row.progress.active && <button onClick={() => void client.stop(row.requestId).then(() => refresh()).catch(error => hidePrivate(error))}>{t("s16.chat.stop")}</button>}
              {row.needsYou && <div className="notice"><p>{t("s16.chat.hold")}</p>{row.needsYou.slip && <a href={`/actions/${row.needsYou.slip.action.id}`}>{t("s16.chat.review")}</a>}<details><summary>{t("s16.common.details")}</summary><code>{row.needsYou.code}</code></details></div>}
              {!!row.evidence.length && <details><summary>{t("s15.library.evidence_count").replace("{n}", String(row.evidence.length))}</summary>{row.evidence.map(evidence => <p key={evidence.id}><code>{evidence.tool}</code> · {evidence.isError ? t("s16.chat.hold") : t("s16.chat.done")}</p>)}</details>}
            </div></article>)}
        </>}
      </div>
      <form className="composer" onSubmit={event => { event.preventDefault(); void send(); }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); choose(event.dataTransfer.files); }}>
        <div className="chips" aria-live="polite">{draft.chips.map(chip => <div className="upload-chip" key={chip.key}><span>{chip.name} · {chip.bytes.toLocaleString()} bytes</span><small>{chip.state === "validating" ? t("s16.files.validating") : chip.state === "uploading" ? t("s16.files.uploading", { name: chip.name }) : chip.state === "ready" ? t("s16.files.ready") : chip.state === "error" ? t("s16.files.failed") : t("s16.files.selected")}</small>{(chip.state === "uploading" || chip.state === "validating") && <progress aria-label={chip.state === "validating" ? t("s16.files.validating") : t("s16.files.uploading", { name: chip.name })} />}{chip.receipt && fileDetails(chip.receipt)}{chip.state === "error" && <><code>{chip.code}</code><button type="button" onClick={() => void upload(conversation, chip)}>{t("s16.files.recover")}</button></>}<button type="button" aria-label={t("s16.files.removeFromMessage", { name: chip.name })} onClick={() => void remove(chip)}>×</button></div>)}</div>
        <label className="visually-hidden" htmlFor="message">{t("s16.chat.prompt")}</label><textarea ref={composer} id="message" value={draft.text} disabled={!!pendingId} placeholder={t("s16.chat.prompt")} onChange={event => change(conversation, draft => ({ ...draft, text: event.target.value }))} onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); choose(event.clipboardData.files); } }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
        {pendingId && !sending && <div className="notice"><p>{t(draft.recoveryId && draft.notFound ? "s16.chat.originalNotFound" : "s16.chat.unknown")}</p><button type="button" onClick={() => void recover()}>{t("s16.chat.recover")}</button>{draft.notFound && (draft.pending ? <button type="button" onClick={() => void resend()}>{t("s16.chat.resend")}</button> : <button type="button" onClick={composeReplacement}>{t("s16.chat.composeReplacement")}</button>)}<code>{pendingId}</code></div>}
        <div className="composer-actions"><input ref={picker} type="file" className="visually-hidden" multiple accept={capabilities?.available ? capabilities.extensions.map(ext => '.' + ext).join(',') : undefined} tabIndex={-1} onChange={event => { choose(event.target.files); event.target.value = ""; }} /><button type="button" disabled={!capabilities?.available || !!pendingId} title={!capabilities?.available ? t("s16.files.unavailable") : undefined} onClick={() => picker.current?.click()}>＋ {t("s16.files.attach")}</button><small>{t("s16.common.keyboard")}</small><button className="primary" type="submit" disabled={!boot || sending || !!pendingId || draft.chips.some(chip => chip.state !== "ready") || (!draft.text.trim() && !draft.chips.length)}>{t(sending ? "s16.chat.sending" : "s16.chat.send")}</button></div>
        <p className="limits">{capabilities?.available ? t("s16.files.limits", { count: capabilities.limits.messageFiles, bytes: capabilities.limits.fileBytes.toLocaleString() }) : t("s16.files.unavailable")}</p>{capabilities?.available && <p className="limits">{t("s16.files.memory")}</p>}
      </form>
    </main>
    {preview && <aside ref={inspector} className="inspector" role="dialog" aria-modal={matchMedia("(max-width: 900px)").matches} aria-label={t("s16.artifact.preview", { name: preview.name })}><header><h2>{preview.name}</h2><button aria-label={t("s16.common.close")} onClick={closePreview}>×</button></header><p>{preview.mime} · {preview.bytes.toLocaleString()} bytes</p><details><summary>{t("s16.common.details")}</summary><code>{preview.sha256}</code><p>{t("s16.artifact.revision")}</p></details>{previewText === null ? <p role="status">{t("s16.common.loading")}</p> : <pre className="preview-text">{previewText}</pre>}<h3>{t("s16.artifact.sources")}</h3>{rows.find(row => row.requestId === preview.requestId)?.files?.inputs.map(file => <div key={file.id}><p>{file.name}</p>{fileDetails(file)}</div>)}</aside>}
    <nav className="mobile-nav"><button onClick={() => { setLibrary(false); composer.current?.focus(); }}>{t("s16.nav.chats")}</button><a href="/needs-you">{t("s16.nav.needsYou")}</a><a href="/work">{t("s15.nav.work")}</a><button onClick={() => setMenu(!menu)}>{t("s16.nav.more")}</button></nav>
  </div>;
}

const root = document.getElementById("root")!;
if (typeof globalThis.crypto?.randomUUID !== "function" || !globalThis.crypto?.subtle) {
  root.className = "notice"; root.setAttribute("role", "alert");
  root.textContent = copy(document.documentElement.lang === "en" ? "en" : "th")("s16.common.secureContext");
} else createRoot(root).render(<App />);
