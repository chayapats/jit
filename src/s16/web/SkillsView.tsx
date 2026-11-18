import { useEffect, useRef, useState } from "react";
import { JitClientError, type JitClient } from "../client";
import type { SkillDetail, SkillsView as SkillsData } from "../skills/owner-view";
import type { SkillCommand, SkillCommandStatus, SkillDependencyBinding, SkillFileInput, SkillImport, SkillReceipt } from "../skills/types";
import type { Copy } from "./copy";

const uid = () => crypto.randomUUID().replaceAll("-", "");
const code = (error: unknown) => error instanceof JitClientError ? error.code : "client_unavailable";
const auth = (error: unknown) => error instanceof JitClientError && [401, 403].includes(error.status ?? 0);
const recovery = () => /^#skill-command=([A-Za-z0-9_-]{1,128})$/.exec(location.hash)?.[1] ?? null;
type Pending = { id: string; state: "sending" | "unknown" | "error"; code?: string } | { id: string; state: "done"; receipt: SkillReceipt } | { id: string; state: "checked"; status: SkillCommandStatus };

/** Pinned know-how review over protected owner APIs. Only the original receipt ID survives a reload; package bytes,
 * previews, CSRF and selected files remain ephemeral. Reading recovery state never resumes or runs anything. */
export function SkillsView({ client, t, available, onFailure }: { client: JitClient; t: Copy; available: boolean; onFailure(error: unknown): void }) {
  const [data, setData] = useState<SkillsData | null>(null), [detail, setDetail] = useState<SkillDetail | null>(null), [selected, setSelected] = useState<string | null>(null), [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(false), [kind, setKind] = useState<"github" | "folder">("github"), [url, setUrl] = useState(""), [label, setLabel] = useState(""), [files, setFiles] = useState<File[]>([]), [update, setUpdate] = useState<SkillDetail["record"] | null>(null);
  const [team, setTeam] = useState(true), [bots, setBots] = useState<string[]>([]), [computer, setComputer] = useState(false), [bindings, setBindings] = useState<Record<string, SkillDependencyBinding>>({}), [sharing, setSharing] = useState<{ hash: string; recipients: { id: string }[] } | null>(null);
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null), [pending, setPending] = useState<Pending | null>(() => { const id = recovery(); return id ? { id, state: "unknown" } : null; }), [revoke, setRevoke] = useState(false);
  const fileTurn = useRef(0), revokePanel = useRef<HTMLDivElement>(null), revokeButton = useRef<HTMLButtonElement>(null), formTitle = useRef<HTMLHeadingElement>(null);
  const epoch = useRef(0), heading = useRef<HTMLHeadingElement>(null), notice = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const pkg = detail?.candidate ?? detail?.active ?? null, sending = pending?.state === "sending", locked = sending || pending?.state === "unknown";
  function fail(error: unknown) { if (code(error) === "client_response_stale") return; if (auth(error)) { epoch.current++; setData(null); setDetail(null); setPreview(null); setFiles([]); setBindings({}); setSharing(null); setPending(null); onFailure(error); return; } setError(code(error)); }
  useEffect(() => {
    if (!available) return; const stop = new AbortController(), turn = epoch.current;
    void client.skills(stop.signal).then(value => { if (turn === epoch.current) { setData(value); setError(null); } }).catch(error => { if (!stop.signal.aborted) fail(error); });
    return () => stop.abort();
  }, [available, reload]);
  useEffect(() => {
    if (!selected) { setDetail(null); return; } const stop = new AbortController(), turn = epoch.current; setLoading(true); setDetail(null); setPreview(null); setSharing(null);
    void client.skill(selected, stop.signal).then(value => { if (turn !== epoch.current) return; setDetail(value); setTeam(value.record.review?.availability.kind !== "bots"); setBots(value.record.review?.availability.kind === "bots" ? value.record.review.availability.botIds : []); setComputer(value.record.review?.executable ?? false); setBindings(Object.fromEntries(Object.entries(value.record.review?.dependencies ?? {}).filter(([key, binding]) => (value.candidate ?? value.active)?.dependencies.some(dep => dep.key === key && data?.dependencies.some(source => source.id === binding.sourceId && source.endpoint === dep.endpoint && source.catalogHash === binding.catalogHash && source.reviewRevision === binding.reviewRevision))))); setLoading(false); requestAnimationFrame(() => heading.current?.focus()); }).catch(error => { if (!stop.signal.aborted) { setLoading(false); fail(error); } });
    return () => stop.abort();
  }, [selected, reload]);
  const bindingKey = JSON.stringify(bindings);
  useEffect(() => {
    setSharing(null); if (!detail || !pkg || detail.record.state === "revoked" || pkg.dependencies.some(dep => !bindings[dep.key])) return;
    const stop = new AbortController(), turn = epoch.current;
    void client.skillRecipients(detail.record.id, pkg.pin, bindings, stop.signal).then(value => { if (turn === epoch.current) setSharing(value); }).catch(error => { if (!stop.signal.aborted) fail(error); });
    return () => stop.abort();
  }, [detail?.record.id, detail?.record.revision, pkg?.pin, bindingKey]);
  useEffect(() => { if (pending && pending.state !== "sending") notice.current?.focus(); }, [pending?.state]);
  useEffect(() => { if (revoke) revokePanel.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [revoke]);
  function remember(id: string) { history.replaceState(null, "", `/s16/connections#skill-command=${id}`); }
  function received(receipt: SkillReceipt) { setPending({ id: receipt.requestId, state: "done", receipt }); setSelected(receipt.skillId); setReload(value => value + 1); setRevoke(false); }
  async function run(command: SkillCommand) {
    const turn = epoch.current; remember(command.requestId); setPending({ id: command.requestId, state: "sending" }); setError(null); setPreview(null);
    try { const receipt = await client.skillCommand(command); if (turn === epoch.current) received(receipt); }
    catch (error) { if (turn !== epoch.current) return; if (auth(error)) { fail(error); return; } setPending({ id: command.requestId, state: error instanceof JitClientError && error.outcome === "unknown" ? "unknown" : "error", code: code(error) }); }
  }
  async function check(id: string, resume = false) {
    const turn = epoch.current; setPending({ id, state: "sending" }); setError(null);
    try {
      if (resume) { const receipt = await client.resumeSkillCommand(id); if (turn === epoch.current) received(receipt); }
      else { const status = await client.skillCommandStatus(id); if (turn !== epoch.current) return; if (status.state === "complete") received(status.receipt); else setPending({ id, state: "checked", status }); }
    } catch (error) { if (turn !== epoch.current) return; if (auth(error)) { fail(error); return; } setPending({ id, state: "error", code: code(error) }); }
  }
  async function importFiles() {
    if (!data) return; setError(null); setLoading(true); const turn = epoch.current;
    try {
      let source: SkillImport;
      if (kind === "github") source = { kind, url: url.trim() };
      else {
        if (!files.length || files.length > data.limits.files || files.some(file => file.size > data.limits.fileBytes) || files.reduce((n, file) => n + file.size, 0) > data.limits.totalBytes) throw new Error("skill_file_limit");
        const base = files[0]!.webkitRelativePath.split("/")[0], entries: SkillFileInput[] = [];
        for (const file of files) {
          const path = file.webkitRelativePath ? file.webkitRelativePath.slice((base?.length ?? 0) + 1) : file.name;
          if (!path || /[\\%:\x00-\x1f\x7f]/.test(path) || path.split("/").some(part => !part || [".", ".."].includes(part) || /^(?:\.git|\.ssh|\.env(?:\..*)?|\.npmrc|\.netrc|id_(?:rsa|ed25519|dsa)(?:\.pub)?)$/i.test(part))) throw new Error("skill_path_invalid");
          const bytes = new Uint8Array(await file.arrayBuffer()); if (turn !== epoch.current) return; let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
          entries.push({ path, base64: btoa(binary) });
        }
        source = { kind, label: label.trim() || base || t("s16.skills.folder"), files: entries };
      }
      setFiles([]); setLoading(false); const requestId = uid();
      const command: SkillCommand = update ? { contract: "s16-skill-command/v1", requestId, kind: "skill.update", skillId: update.id, expectedRevision: update.revision, input: source } : { contract: "s16-skill-command/v1", requestId, kind: "skill.import", input: source };
      setUpdate(null); await run(command);
    } catch (error) { if (turn === epoch.current) { setLoading(false); setError(error instanceof Error ? error.message : "skill_package_invalid"); } }
  }
  function closeDetail() { const id = selected; epoch.current++; setSelected(null); setPreview(null); setDetail(null); setSharing(null); setRevoke(false); requestAnimationFrame(() => document.getElementById(`skill-open-${id}`)?.focus()); }
  async function showFile(path: string) {
    if (!detail || !pkg) return; const turn = epoch.current, version = ++fileTurn.current; setPreview(null);
    try { const file = await client.skillFile(detail.record.id, pkg.pin, path); if (turn !== epoch.current || version !== fileTurn.current) return; let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(file.base64), char => char.charCodeAt(0))); if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw Error(); } catch { text = t("s16.skills.binary"); } setPreview({ path, text }); }
    catch (error) { if (turn === epoch.current) fail(error); }
  }
  if (!available) return <p>{t("s16.skills.unavailable")}</p>;
  return <section className="skills" aria-labelledby="skills-title">
    <h2 id="skills-title">{t("s16.skills.title")}</h2><p className="lead">{t("s16.skills.lead")}</p>
    {error && <p role="alert" className="notice">{t("s16.skills.failed", { reason: error })} <button type="button" onClick={() => setReload(value => value + 1)}>{t("s16.connections.retry")}</button></p>}
    {pending && <div className="notice" ref={notice} tabIndex={-1} role="status" aria-live="polite">
      <p>{t(pending.state === "sending" ? "s16.skills.working" : pending.state === "done" ? "s16.skills.saved" : pending.state === "error" ? "s16.skills.commandFailed" : pending.state === "checked" ? "s16.skills.interrupted" : "s16.skills.unknown", { reason: pending.state === "error" ? pending.code ?? "" : "" })}</p><code>{pending.id}</code>
      {pending.state === "done" && pending.receipt.policy === "review_required" && <p>{t("s16.connections.policyReview")} <a href="/rules">{t("s16.connections.reviewRules")}</a></p>}
      {!sending && <button type="button" onClick={() => void check(pending.id)}>{t("s16.skills.checkStatus")}</button>}
      {pending.state === "checked" && pending.status.state === "interrupted" && <button type="button" onClick={() => void check(pending.id, true)}>{t("s16.skills.resume")}</button>}
      {pending.state === "done" && pending.receipt.policy === "review_required" && <button type="button" onClick={() => void check(pending.id, true)}>{t("s16.skills.reconcile")}</button>}
    </div>}
    {!data ? <p role="status">{t("s16.common.loading")}</p> : <>
      <form className="connection-form" onSubmit={event => { event.preventDefault(); void importFiles(); }}>
        <h3 ref={formTitle} tabIndex={-1}>{t(update ? "s16.skills.update" : "s16.skills.import")}{update && <code> {update.id}</code>}</h3>
        <fieldset disabled={locked || loading}><legend>{t("s16.skills.origin")}</legend><label className="check"><input type="radio" name="skill-origin" checked={kind === "github"} onChange={() => setKind("github")} /> {t("s16.skills.github")}</label><label className="check"><input type="radio" name="skill-origin" checked={kind === "folder"} onChange={() => setKind("folder")} /> {t("s16.skills.folder")}</label>
          {kind === "github" ? <label>{t("s16.skills.url")} <input ref={input} type="url" value={url} onChange={event => setUrl(event.target.value)} required placeholder="https://github.com/owner/repository" /></label> : <><label>{t("s16.skills.label")} <input value={label} onChange={event => setLabel(event.target.value)} maxLength={160} /></label><label>{t("s16.skills.chooseFolder")} <input type="file" multiple {...{ webkitdirectory: "" }} onChange={event => { setFiles([...event.target.files ?? []]); event.target.value = ""; }} /></label><p className="meta">{t("s16.skills.selectedFiles", { count: files.length })}</p></>}
          <p className="limits">{t("s16.skills.limits", { count: data.limits.files, bytes: data.limits.totalBytes.toLocaleString() })}</p>
          <button type="submit" className="primary" disabled={kind === "folder" && !files.length}>{t("s16.skills.inspect")}</button>{update && <button type="button" onClick={() => setUpdate(null)}>{t("s16.connections.cancel")}</button>}
        </fieldset>
      </form>
      <h3>{t("s16.skills.imported")}</h3>{!data.items.length && <p>{t("s16.skills.empty")}</p>}
      <ul className="computer-list">{data.items.map(item => <li key={item.record.id} className="computer-card"><header><h3>{item.name}</h3><span className={`pill ${item.record.state === "active" ? "ok" : "warn"}`}>{t(item.record.state === "active" ? "s16.skills.active" : item.record.state === "revoked" ? "s16.skills.revoked" : "s16.skills.needsReview")}</span></header><p className="owner-text">{item.description}</p>{item.record.candidatePin && item.record.activePin && <p>{t("s16.skills.candidate")}</p>}<button type="button" id={`skill-open-${item.record.id}`} disabled={sending} onClick={() => { epoch.current++; setSelected(item.record.id); setRevoke(false); }}>{t("s16.skills.open")}</button></li>)}</ul>
    </>}
    {loading && selected && <p role="status">{t("s16.common.loading")}</p>}
    {detail && pkg && <article className="computer-card skill-detail">
      <header><h3 ref={heading} tabIndex={-1}>{pkg.name}</h3><button type="button" disabled={sending} onClick={closeDetail}>{t("s16.common.close")}</button></header>
      <p className="owner-text">{pkg.description}</p><p>{t("s16.skills.pin")} <code className="skill-pin">{pkg.pin}</code></p><p className="meta">{pkg.origin.kind === "github" ? `${pkg.origin.repository} · ${pkg.origin.commit} · ${pkg.origin.folder}` : pkg.origin.label}</p>
      <p>{t("s16.skills.license")}: {pkg.license ?? t("s16.skills.unknownLicense")}</p>{pkg.licenseFiles.map(path => <button type="button" className="memory-link" key={path} onClick={() => void showFile(path)}>{path}</button>)}
      <details><summary>{t("s16.skills.parts")}</summary><ul>{pkg.units.map(unit => <li key={unit.id}>{unit.name} · {unit.userOnly ? t("s16.skills.userOnly") : t("s16.skills.instructions")} <button type="button" className="memory-link" onClick={() => void showFile(unit.path)}>{t("s16.skills.preview")}</button></li>)}{pkg.scripts.map(script => <li key={script.path}><code>{script.path}</code> · {script.runtime}</li>)}</ul><ul>{pkg.files.map(file => <li key={file.path}><button type="button" className="memory-link" onClick={() => void showFile(file.path)}>{file.path}</button> · {file.bytes.toLocaleString()} bytes</li>)}</ul></details>
      {!!pkg.unsupported.length && <details><summary>{t("s16.skills.unsupported", { count: pkg.unsupported.length })}</summary><ul>{pkg.unsupported.map((part, index) => <li key={index}><code>{part.path}</code> · {part.code}</li>)}</ul></details>}
      {preview && <section className="skill-preview" aria-label={t("s16.skills.preview")}><h4>{preview.path}</h4><pre>{preview.text}</pre><button type="button" onClick={() => setPreview(null)}>{t("s16.common.close")}</button></section>}
      {detail.record.state === "revoked" ? <p>{t("s16.skills.revokedNote")}</p> : <>
        <fieldset disabled={locked}><legend>{t("s16.skills.dependencies")}</legend>{!pkg.dependencies.length && <p>{t("s16.skills.noDependencies")}</p>}{pkg.dependencies.map(dep => <label key={dep.key}>{dep.key} · <span className="mono">{dep.endpoint}</span><select value={bindings[dep.key]?.sourceId ?? ""} onChange={event => { const source = data?.dependencies.find(source => source.id === event.target.value); setBindings(current => { const next = { ...current }; if (source?.catalogHash && source.reviewRevision) next[dep.key] = { sourceId: source.id, catalogHash: source.catalogHash, reviewRevision: source.reviewRevision }; else delete next[dep.key]; return next; }); }}><option value="">{t("s16.skills.missingDependency")}</option>{data?.dependencies.filter(source => source.state === "active" && source.endpoint === dep.endpoint && source.catalogHash && source.reviewRevision).map(source => <option key={source.id} value={source.id}>{source.label}</option>)}</select></label>)}<p className="limits">{t("s16.skills.dependencyNote")}</p></fieldset>
        <fieldset disabled={locked}><legend>{t("s16.skills.availability")}</legend><label className="check"><input type="radio" name="skill-scope" checked={team} onChange={() => setTeam(true)} /> {t("s16.skills.team")}</label><label className="check"><input type="radio" name="skill-scope" checked={!team} onChange={() => setTeam(false)} /> {t("s16.skills.selectedBots")}</label>{!team && data?.bots.map(bot => <label className="check" key={bot.id}><input type="checkbox" checked={bots.includes(bot.id)} onChange={event => setBots(current => event.target.checked ? [...current, bot.id] : current.filter(id => id !== bot.id))} /> {bot.name || t("s16.bots.mainName")}</label>)}<label className="check"><input type="checkbox" checked={computer} onChange={event => setComputer(event.target.checked)} /> {t("s16.skills.computer")}</label><p className="limits">{t("s16.skills.computerNote")}</p></fieldset>
        <h4>{t("s16.skills.recipients")}</h4>{sharing ? <ul>{sharing.recipients.map(recipient => <li key={recipient.id}>{recipient.id}</li>)}</ul> : <p>{t(pkg.dependencies.some(dep => !bindings[dep.key]) ? "s16.skills.missingDependency" : "s16.common.loading")}</p>}<p className="limits">{t("s16.skills.sharingNote")}</p><p className="limits">{t("s16.skills.copies", { count: detail.releasedCopies })}</p>
        <div className="actions"><button type="button" className="primary" disabled={locked || !sharing || !team && !bots.length || !pkg.units.length && !pkg.scripts.length && !pkg.dependencies.length} onClick={() => { if (!sharing) return; const availability = team ? { kind: "team" as const } : { kind: "bots" as const, botIds: bots }; void run({ contract: "s16-skill-command/v1", requestId: uid(), kind: "skill.review", skillId: detail.record.id, expectedRevision: detail.record.revision, pin: pkg.pin, availability, executable: computer, dependencies: bindings, recipientsHash: sharing.hash }); }}>{t("s16.skills.confirm")}</button>
          <button type="button" disabled={locked} onClick={() => { setUpdate(detail.record); setKind(detail.record.importSource?.kind ?? "folder"); setUrl(detail.record.importSource?.kind === "github" ? detail.record.importSource.url : ""); setFiles([]); requestAnimationFrame(() => { formTitle.current?.scrollIntoView({ block: "center" }); formTitle.current?.focus(); }); }}>{t("s16.skills.update")}</button><button ref={revokeButton} type="button" disabled={locked} onClick={() => setRevoke(true)}>{t("s16.skills.revoke")}</button></div>
        {revoke && <div ref={revokePanel} className="notice" role="alertdialog" aria-label={t("s16.skills.revoke")} onKeyDown={event => { if (event.key === "Escape") { setRevoke(false); revokeButton.current?.focus(); } }}><p>{t("s16.skills.revokeNote")}</p><button type="button" disabled={locked} onClick={() => void run({ contract: "s16-skill-command/v1", requestId: uid(), kind: "skill.revoke", skillId: detail.record.id, expectedRevision: detail.record.revision })}>{t("s16.skills.revoke")}</button><button type="button" onClick={() => { setRevoke(false); revokeButton.current?.focus(); }}>{t("s16.connections.cancel")}</button></div>}
      </>}
    </article>}
  </section>;
}
