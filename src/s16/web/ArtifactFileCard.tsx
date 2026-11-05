/**
 * Adapted from Rakazo, copyright 2026 Rakazo contributors, Apache-2.0.
 * Source: apps/web/src/components/ArtifactFileCard.tsx at abf3c08145a05cba92a912d6c24fdfb5f569d0e0.
 * Modified for Jit: protected Fetch client, local i18n, the authored inspector, escaped text only,
 * fresh verified downloads and no upstream RPC, renderer, icon or design-system dependencies.
 * See third_party/rakazo/LICENSE and provenance.json.
 */
import { useRef, useState } from "react";
import { artifactPreviewKind } from "../client/artifact-preview";
import type { FileArtifact } from "../files/types";
import type { JitClient } from "../client";
import type { Copy } from "./copy";

/** Committed artifact only. Preview and Download have separate labelled controls and current guards. */
export function ArtifactFileCard({ artifact, client, t, onPreview, onFailure }: { artifact: FileArtifact; client: JitClient; t: Copy; onPreview(file: FileArtifact, returnFocus: HTMLButtonElement | null): void; onFailure(): void }) {
  const previewButton = useRef<HTMLButtonElement>(null), [error, setError] = useState(false), [busy, setBusy] = useState(false);
  const kind = artifactPreviewKind(artifact.mime), previewable = kind === "markdown" || kind === "text";
  async function download() {
    setError(false); setBusy(true);
    try {
      const bytes = await client.artifactBytes(artifact), url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: "application/octet-stream" }));
      const link = document.createElement("a"); link.href = url; link.download = artifact.name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError(true); onFailure(); } finally { setBusy(false); }
  }
  return <div className="artifact-wrap">
    <div className="artifact-card">
      <button ref={previewButton} data-preview-for={artifact.id} className="artifact-main" disabled={!previewable} onClick={() => onPreview(artifact, previewButton.current)} aria-label={t("s16.artifact.preview", { name: artifact.name })}>
        <span className="file-icon" aria-hidden="true">≡</span><span><strong>{artifact.name}</strong><small>{artifact.mime} · {artifact.bytes.toLocaleString()} bytes</small><small>{t("s16.artifact.revision")}</small></span>
      </button>
      <button className="artifact-download" disabled={busy} onClick={() => void download()} aria-label={t("s16.artifact.download", { name: artifact.name })}>↓</button>
    </div>
    {error && <p role="alert">{t("s16.artifact.unavailable")}</p>}
  </div>;
}
