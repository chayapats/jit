import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Locale } from "../../i18n";
import { JitClient, JitClientError } from "../client";
import type { ClientBootstrap, ClientMessage, ClientSnapshot } from "../client/contracts";
import type { FileArtifact, FileReceipt, FileUploadCommand } from "../files/types";
import { ArtifactFileCard } from "./ArtifactFileCard";
import { copy } from "./copy";

type Chip = { key: string; file: File; state: "selected" | "uploading" | "ready" | "error"; code?: string; receipt?: FileReceipt; uploadId?: string; command?: FileUploadCommand };
type Draft = { text: string; chips: Chip[]; pending?: ClientMessage; notFound?: boolean };
const uid = () => crypto.randomUUID().replaceAll("-", "");
const empty = (): Draft => ({ text: "", chips: [] });
const errorCode = (error: unknown) => error instanceof JitClientError ? error.code : "client_unavailable";
const client = new JitClient({ origin: location.origin });

/** Implements the required S16 conversation/file handoff over real protected service contracts. */
function App() {
  const [locale, setLocale] = useState<Locale>(document.documentElement.lang === "en" ? "en" : "th"), t = copy(locale);
  const [boot, setBoot] = useState<Omit<ClientBootstrap, "csrf"> | null>(null), [conversation, setConversation] = useState(() => /^\/s16\/chat\/([A-Za-z0-9_-]{1,128})$/.exec(location.pathname)?.[1] ?? uid());
  const [snapshot, setSnapshot] = useState<ClientSnapshot | null>(null), [error, setError] = useState<string | null>(null), [drafts, setDrafts] = useState<Record<string, Draft>>({}), [sending, setSending] = useState(false), [menu, setMenu] = useState(false), [search, setSearch] = useState("");
  const [library, setLibrary] = useState(false), [preview, setPreview] = useState<FileArtifact | null>(null), [previewText, setPreviewText] = useState<string | null>(null);
  const target = useRef(conversation), generation = useRef(0), picker = useRef<HTMLInputElement>(null), composer = useRef<HTMLTextAreaElement>(null), inspector = useRef<HTMLElement>(null), returnFocus = useRef<HTMLElement | null>(null), transfers = useRef(new Map<string, { stop: AbortController; cancelled: boolean }>());
  const refreshing = useRef<{ id: string; turn: number; stop: AbortController } | null>(null), privacyEpoch = useRef(0);
  const draft = drafts[conversation] ?? empty(), capabilities = boot?.capabilities.uploads, rows = snapshot?.conversation.rows ?? [];
  const change = (id: string, update: (draft: Draft) => Draft) => setDrafts(old => ({ ...old, [id]: update(old[id] ?? empty()) }));
  function closePreview() { const id = preview?.id; setPreview(null); setPreviewText(null); if (returnFocus.current?.isConnected) returnFocus.current.focus(); else if (id) document.querySelector<HTMLElement>(`[data-preview-for="${id}"]`)?.focus(); }
  function hidePrivate(code: string) { generation.current++; privacyEpoch.current++; refreshing.current?.stop.abort(); refreshing.current = null; setSnapshot(null); setPreview(null); setPreviewText(null); setError(code); if (["authentication_required", "csrf_rejected"].includes(code)) { client.clear(); setBoot(null); setDrafts({}); for (const transfer of transfers.current.values()) transfer.stop.abort(); } }
  async function refresh(id = target.current) {
    if (id !== target.current) return;
    if (refreshing.current?.id === id) return;
    refreshing.current?.stop.abort(); const stop = new AbortController(), turn = ++generation.current; refreshing.current = { id, turn, stop }; setSnapshot(null);
    try { const data = await client.snapshot(id, stop.signal); if (turn !== generation.current || id !== target.current) return; setSnapshot(data); setError(null); }
    catch (error) { if (turn === generation.current && id === target.current) hidePrivate(errorCode(error)); }
    finally { if (refreshing.current?.turn === turn) refreshing.current = null; }
  }
  async function bootstrap() {
    const epoch = privacyEpoch.current;
    try { const data = await client.bootstrap(); if (epoch !== privacyEpoch.current) return; setBoot(data); await refresh(); }
    catch (error) { if (epoch === privacyEpoch.current) { hidePrivate(errorCode(error)); setBoot(null); } }
  }
  function navigate(id: string) { target.current = id; generation.current++; setConversation(id); setSnapshot(null); closePreview(); setLibrary(false); setMenu(false); setError(null); history.pushState(null, "", `/s16/chat/${id}`); }
  useEffect(() => { history.replaceState(null, "", `/s16/chat/${conversation}${location.hash}`); void bootstrap();
    const pop = () => { const id = /^\/s16\/chat\/([A-Za-z0-9_-]{1,128})$/.exec(location.pathname)?.[1]; if (id) { target.current = id; generation.current++; setConversation(id); setSnapshot(null); closePreview(); } };
    window.addEventListener("popstate", pop); return () => { window.removeEventListener("popstate", pop); generation.current++; privacyEpoch.current++; refreshing.current?.stop.abort(); for (const transfer of transfers.current.values()) transfer.stop.abort(); client.clear(); };
  }, []);
  useEffect(() => { if (boot) void refresh(conversation); const timer = setInterval(() => { if (boot && document.visibilityState === "visible") void refresh(conversation); }, 4000); return () => clearInterval(timer); }, [conversation, !!boot]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    if (!preview) { setPreviewText(null); return; }
    const stop = new AbortController(); let sequence = 0;
    const load = async () => { const turn = ++sequence; setPreviewText(null); try { const bytes = await client.artifactBytes(preview, stop.signal); if (!stop.signal.aborted && turn === sequence) setPreviewText(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch (error) { if (!stop.signal.aborted) hidePrivate(errorCode(error)); } };
    void load(); const timer = setInterval(() => void load(), 4000); inspector.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { stop.abort(); clearInterval(timer); setPreviewText(null); };
  }, [preview?.id]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { closePreview(); setMenu(false); } if (event.key === "Tab" && preview && matchMedia("(max-width: 900px)").matches) { const controls = [...(inspector.current?.querySelectorAll<HTMLElement>("button,a[href]") ?? [])], first = controls[0], last = controls.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } };
    document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key);
  }, [preview]);
  async function upload(id: string, chip: Chip) {
    const transfer = { stop: new AbortController(), cancelled: false }; transfers.current.set(chip.key, transfer);
    const update = (patch: Partial<Chip>) => change(id, draft => ({ ...draft, chips: draft.chips.map(current => current.key === chip.key ? { ...current, ...patch } : current) }));
    update({ state: "uploading" });
    try {
      const bytes = new Uint8Array(await chip.file.arrayBuffer());
      if (transfer.cancelled) return;
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
      const command = chip.command ?? { requestId: uid(), conversationId: id, name: chip.file.name, bytes: bytes.length, sha256 }; update({ command });
      let status = chip.uploadId ? await client.uploadStatus(chip.uploadId, transfer.stop.signal) : await client.createUpload(command, transfer.stop.signal);
      update({ uploadId: status.id });
      if (transfer.cancelled) { await client.withdrawUpload(status.id); return; }
      if (status.state === "created") status = await client.uploadBytes(status.id, bytes, transfer.stop.signal);
      if (transfer.cancelled) { await client.withdrawUpload(status.id); return; }
      if (status.state !== "ready" || !status.receipt) throw new JitClientError(status.code ?? "file_unavailable", 409, "response");
      update({ state: "ready", receipt: status.receipt });
    } catch (error) { if (!transfer.cancelled) { update({ state: "error", code: errorCode(error) }); if (error instanceof JitClientError && (error.status === 401 || error.status === 403)) hidePrivate(error.code); } }
    finally { if (transfers.current.get(chip.key) === transfer) transfers.current.delete(chip.key); }
  }
  function choose(files: FileList | null) {
    if (!files || !capabilities?.available) return;
    const id = conversation, selected = [...files];
    if (draft.chips.length + selected.length > capabilities.limits.messageFiles || draft.chips.reduce((sum, chip) => sum + chip.file.size, 0) + selected.reduce((sum, file) => sum + file.size, 0) > capabilities.limits.messageBytes) { setError("file_message_limit"); return; }
    const chips = selected.map(file => ({ key: uid(), file, state: "selected" as const })); change(id, draft => ({ ...draft, chips: [...draft.chips, ...chips] }));
    for (const chip of chips) {
      if (!chip.file.size || chip.file.size > capabilities.limits.fileBytes || !capabilities.extensions.includes(chip.file.name.split(".").at(-1)!.toLowerCase())) change(id, draft => ({ ...draft, chips: draft.chips.map(current => current.key === chip.key ? { ...current, state: "error", code: "file_type_or_size_unavailable" } : current) }));
      else void upload(id, chip);
    }
  }
  async function remove(chip: Chip) {
    const transfer = transfers.current.get(chip.key); if (transfer) { transfer.cancelled = true; transfer.stop.abort(); }
    change(conversation, draft => ({ ...draft, chips: draft.chips.filter(current => current.key !== chip.key) }));
    if (chip.uploadId) try { await client.withdrawUpload(chip.uploadId); } catch (error) { setError(errorCode(error)); }
  }
  async function send() {
    if (sending || draft.pending || draft.chips.some(chip => chip.state !== "ready") || !boot) return;
    const id = conversation;
    try {
      const command = client.prepareMessage(id, draft.text, draft.chips.map(chip => ({ id: chip.receipt!.id, sha256: chip.receipt!.sha256 }))); change(id, draft => ({ ...draft, pending: command })); setSending(true); history.replaceState(null, "", `/s16/chat/${id}#${command.requestId}`);
      await client.send(command); change(id, () => empty()); if (id === target.current) await refresh(id);
      const epoch = privacyEpoch.current, data = await client.bootstrap(); if (epoch === privacyEpoch.current) setBoot(data);
    } catch (error) {
      if (error instanceof JitClientError && (error.outcome === "not_sent" || error.outcome === "response" && ["invalid_text", "file_unavailable", "file_count_limit", "file_message_limit", "body_too_large", "invalid_contract", "invalid_body", "outside_scope", "upload_unavailable"].includes(error.code))) change(id, ({ pending: _pending, notFound: _notFound, ...draft }) => draft);
      if (id === target.current) hidePrivate(errorCode(error));
    } finally { setSending(false); }
  }
  async function recover() { if (!draft.pending) return; const id = conversation; try { const found = await client.request(draft.pending.requestId); if (found.conversationId === id) { change(id, () => empty()); if (target.current === id) await refresh(id); } } catch (error) { if (error instanceof JitClientError && error.status === 404) change(id, draft => ({ ...draft, notFound: true })); setError(errorCode(error)); } }
  async function resend() { if (!draft.pending || !draft.notFound || sending) return; const id = conversation; setSending(true); try { await client.send(draft.pending); change(id, () => empty()); if (target.current === id) await refresh(id); } catch (error) { setError(errorCode(error)); } finally { setSending(false); } }
  const status = (state: string) => t(state === "done" ? "s16.chat.done" : state === "working" || state === "inspecting" ? "s16.chat.working" : state === "understanding" ? "s16.chat.understanding" : state === "received" ? "s16.chat.received" : state === "stopped" ? "s16.chat.stopped" : "s16.chat.hold");
  const artifactCards = (items: FileArtifact[]) => items.map(artifact => <ArtifactFileCard key={artifact.id} artifact={artifact} client={client} t={t} onPreview={(file, focus) => { returnFocus.current = focus; setPreview(file); }} onFailure={() => hidePrivate("artifact_unavailable")} />);
  return <div className={`s16-app ${menu ? "nav-open" : ""} ${preview ? "inspector-open" : ""}`}>
    <a className="skip-link" href="#conversation-main">{t("s16.nav.chats")}</a>
    <nav className="rail" aria-label={t("s16.common.menu")}><a className="brand" href="/s16">Jit <span>S16</span></a><button onClick={() => navigate(uid())}>＋ {t("s16.chat.new")}</button><label className="search"><span>{t("s16.nav.search")}</span><input value={search} onChange={event => setSearch(event.target.value)} /></label>
      <a href="/needs-you">{t("s16.nav.needsYou")} <span className="count">{boot?.needsYou.length ?? 0}</span></a><h2>{t("s16.nav.bots")}</h2><button className="bot selected" onClick={() => setLibrary(false)}>● {t("s16.chat.title")}</button>
      <div className="recent">{boot?.conversations.filter(entry => entry.firstMessage.toLowerCase().includes(search.toLowerCase())).map(entry => <button key={entry.conversationId} aria-current={entry.conversationId === conversation ? "page" : undefined} onClick={() => navigate(entry.conversationId)}>{entry.firstMessage || t("s16.chat.receivedFiles")}</button>)}</div>
      <a href="/work">{t("s15.nav.work")}</a><button onClick={() => { setLibrary(true); setMenu(false); }}>{t("s16.nav.artifacts")}</button><div className="rail-secondary"><a href="/memory">{t("s16.nav.memory")}</a><a href="/resources">{t("s16.nav.connections")}</a><a href="/rules">{t("s16.nav.settings")}</a><label>{t("s16.common.language")} <select value={locale} onChange={event => setLocale(event.target.value === "en" ? "en" : "th")}><option value="th">TH</option><option value="en">English</option></select></label></div>
    </nav>
    <main id="conversation-main"><header className="chat-header"><button className="menu-toggle" aria-label={t("s16.common.menu")} onClick={() => setMenu(!menu)}>☰</button><div><h1>{t("s16.chat.title")}</h1><p>{t("s16.chat.lead")}</p></div><button onClick={() => void bootstrap()}>{t("s16.common.refresh")}</button></header>
      <div className="transcript" aria-busy={!snapshot && !error}>
        {error && <div role="alert" className="notice"><p>{t("s16.common.error")}</p><details><summary>{t("s16.common.details")}</summary><code>{error}</code></details></div>}
        {!snapshot && !error && <p role="status">{t("s16.common.loading")}</p>}
        {library ? <section><h2>{t("s16.artifact.current")}</h2>{artifactCards(rows.flatMap(row => row.files?.artifacts ?? []))}{!rows.some(row => row.files?.artifacts.length) && <p>{t("s16.artifact.empty")}</p>}</section> : <>
          {snapshot && !rows.length && <div className="empty"><h2>{t("s16.chat.empty")}</h2></div>}
          {rows.map(row => <article className="exchange" key={row.requestId}><div className="owner-message"><p>{row.ownerMessage}</p>{row.files?.inputs.map(file => <div className="source-chip" key={file.id}><span>{file.name} · {file.bytes.toLocaleString()} bytes</span><button title={t("s16.files.withdrawImpact")} onClick={() => void client.withdrawUpload(file.id).then(() => refresh()).catch(error => hidePrivate(errorCode(error)))}>{t("s16.files.withdraw")}</button></div>)}</div>
            <div className="bot-message"><strong>{t("s16.chat.title")}</strong><span className="status">{status(row.state)}</span>{row.result ? <p className="result">{row.result.text}</p> : row.files && row.state === "received" ? <p>{t("s16.chat.receivedFiles")}</p> : null}
              {artifactCards(row.files?.artifacts ?? [])}{row.progress.active && <button onClick={() => void client.stop(row.requestId).then(() => refresh()).catch(error => setError(errorCode(error)))}>{t("s16.chat.stop")}</button>}
              {row.needsYou && <div className="notice"><p>{t("s16.chat.hold")}</p>{row.needsYou.slip && <a href={`/actions/${row.needsYou.slip.action.id}`}>{t("s16.chat.review")}</a>}<details><summary>{t("s16.common.details")}</summary><code>{row.needsYou.code}</code></details></div>}
              {!!row.evidence.length && <details><summary>{t("s15.library.evidence_count").replace("{n}", String(row.evidence.length))}</summary>{row.evidence.map(evidence => <p key={evidence.id}><code>{evidence.tool}</code> · {evidence.isError ? t("s16.chat.hold") : t("s16.chat.done")}</p>)}</details>}
            </div></article>)}
        </>}
      </div>
      <form className="composer" onSubmit={event => { event.preventDefault(); void send(); }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); choose(event.dataTransfer.files); }}>
        <div className="chips" aria-live="polite">{draft.chips.map(chip => <div className="upload-chip" key={chip.key}><span>{chip.file.name} · {chip.file.size.toLocaleString()} bytes</span><small>{chip.state === "uploading" ? t("s16.files.uploading", { name: chip.file.name }) : chip.state === "ready" ? t("s16.files.ready") : chip.state === "error" ? t("s16.files.failed") : t("s16.files.selected")}</small>{chip.state === "uploading" && <progress aria-label={t("s16.files.uploading", { name: chip.file.name })} />}{chip.state === "error" && <><code>{chip.code}</code><button type="button" onClick={() => void upload(conversation, chip)}>{t("s16.files.recover")}</button></>}<button type="button" aria-label={t("s16.files.remove", { name: chip.file.name })} onClick={() => void remove(chip)}>×</button></div>)}</div>
        <label className="visually-hidden" htmlFor="message">{t("s16.chat.prompt")}</label><textarea ref={composer} id="message" value={draft.text} disabled={!!draft.pending} placeholder={t("s16.chat.prompt")} onChange={event => change(conversation, draft => ({ ...draft, text: event.target.value }))} onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); choose(event.clipboardData.files); } }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
        {draft.pending && !sending && <div className="notice"><p>{t("s16.chat.unknown")}</p><button type="button" onClick={() => void recover()}>{t("s16.chat.recover")}</button>{draft.notFound && <button type="button" onClick={() => void resend()}>{t("s16.chat.resend")}</button>}<code>{draft.pending.requestId}</code></div>}
        <div className="composer-actions"><input ref={picker} type="file" className="visually-hidden" multiple accept={capabilities?.available ? capabilities.extensions.map(ext => '.' + ext).join(',') : undefined} tabIndex={-1} onChange={event => { choose(event.target.files); event.target.value = ""; }} /><button type="button" disabled={!capabilities?.available || !!draft.pending} title={!capabilities?.available ? t("s16.files.unavailable") : undefined} onClick={() => picker.current?.click()}>＋ {t("s16.files.attach")}</button><small>{t("s16.common.keyboard")}</small><button className="primary" type="submit" disabled={!boot || sending || !!draft.pending || draft.chips.some(chip => chip.state !== "ready") || (!draft.text.trim() && !draft.chips.length)}>{t(sending ? "s16.chat.sending" : "s16.chat.send")}</button></div>
        <p className="limits">{capabilities?.available ? t("s16.files.limits", { count: capabilities.limits.messageFiles, bytes: capabilities.limits.fileBytes.toLocaleString() }) : t("s16.files.unavailable")}</p>{capabilities?.available && <p className="limits">{t("s16.files.memory")}</p>}
      </form>
    </main>
    {preview && <aside ref={inspector} className="inspector" role="dialog" aria-modal={matchMedia("(max-width: 900px)").matches} aria-label={t("s16.artifact.preview", { name: preview.name })}><header><h2>{preview.name}</h2><button aria-label={t("s16.common.close")} onClick={closePreview}>×</button></header><p>{preview.mime} · {preview.bytes.toLocaleString()} bytes</p><details><summary>{t("s16.common.details")}</summary><code>{preview.sha256}</code><p>{t("s16.artifact.revision")}</p></details>{previewText === null ? <p role="status">{t("s16.common.loading")}</p> : <pre className="preview-text">{previewText}</pre>}<h3>{t("s16.artifact.sources")}</h3>{rows.find(row => row.requestId === preview.requestId)?.files?.inputs.map(file => <p key={file.id}>{file.name}<br /><code>{file.sha256}</code></p>)}</aside>}
    <nav className="mobile-nav"><button onClick={() => { setLibrary(false); composer.current?.focus(); }}>{t("s16.nav.chats")}</button><a href="/needs-you">{t("s16.nav.needsYou")}</a><a href="/work">{t("s15.nav.work")}</a><button onClick={() => setMenu(!menu)}>{t("s16.nav.more")}</button></nav>
  </div>;
}

createRoot(document.getElementById("root")!).render(<App />);
