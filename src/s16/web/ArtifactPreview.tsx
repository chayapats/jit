import { useEffect, useState } from "react";
import { artifactPreviewKind } from "../client/artifact-preview";
import type { JitClient } from "../client";
import type { FileArtifact } from "../files/types";
import type { Copy } from "./copy";

/**
 * Current preview of one committed artifact. Every render first re-reads fresh authorization and verifies
 * exact bytes/hash, then rechecks every four seconds: a withdrawn source closes the viewer through
 * `onFailure`. Text and Markdown are escaped text. HTML is never inserted into this document: it opens in
 * a token-free `sandbox` iframe served with an opaque-origin, script-free CSP.
 */
export function ArtifactPreview({ artifact, client, t, html, onFailure }: { artifact: FileArtifact; client: JitClient; t: Copy; html: boolean; onFailure(error: unknown): void }) {
  const kind = artifactPreviewKind(artifact.mime), [text, setText] = useState<string | null>(null), [verified, setVerified] = useState(false);
  useEffect(() => {
    const stop = new AbortController(); let sequence = 0;
    const load = async () => {
      const turn = ++sequence;
      try {
        const bytes = await client.artifactBytes(artifact, stop.signal);
        if (stop.signal.aborted || turn !== sequence) return;
        if (kind === "html") setVerified(true); else setText(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch (error) { if (!stop.signal.aborted) { setVerified(false); setText(null); onFailure(error); } }
    };
    setText(null); setVerified(false); void load(); const timer = setInterval(() => void load(), 4000);
    return () => { stop.abort(); clearInterval(timer); setText(null); setVerified(false); };
  }, [artifact.id, artifact.sha256]);
  if (kind === "html") {
    if (!html) return <p className="limits">{t("s16.artifact.previewUnavailable")}</p>;
    if (!verified) return <p role="status">{t("s16.common.loading")}</p>;
    return <div className="artifact-frame-wrap"><iframe className="artifact-frame" sandbox="" referrerPolicy="no-referrer" src={client.artifactPreviewUrl(artifact)} title={t("s16.artifact.htmlFrame", { name: artifact.name })} /><p className="limits">{t("s16.artifact.htmlSandboxed")}</p></div>;
  }
  if (kind !== "text" && kind !== "markdown") return <p className="limits">{t("s16.artifact.previewUnavailable")}</p>;
  return text === null ? <p role="status">{t("s16.common.loading")}</p> : <pre className="preview-text">{text}</pre>;
}
