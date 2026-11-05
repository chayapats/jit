/**
 * Adapted from Rakazo, copyright 2026 Rakazo contributors, Apache-2.0.
 * Source: packages/contracts/src/attachments.ts at abf3c08145a05cba92a912d6c24fdfb5f569d0e0.
 * Modified for Jit: extracted classification only; it grants no upload or preview capability.
 * See third_party/rakazo/LICENSE and provenance.json.
 */
export type ArtifactPreviewKind = "html" | "markdown" | "pdf" | "image" | "video" | "text" | "none";
const textApplications = new Set(["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/javascript", "application/x-sh", "application/sql"]);
/** Shared display classification. Server capability and current authorization independently gate rendering. */
export function artifactPreviewKind(mimeType: string): ArtifactPreviewKind {
  const type = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "text/html") return "html";
  if (type === "text/markdown") return "markdown";
  if (type === "application/pdf") return "pdf";
  if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(type)) return "image";
  if (type === "video/mp4") return "video";
  if (type.startsWith("text/") || textApplications.has(type)) return "text";
  return "none";
}
