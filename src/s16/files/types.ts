/** Opaque immutable input identity; filenames never become filesystem paths or authority. */
export interface FileReference { id: string; sha256: string }
/** Bounded, currently accepted text input. Receipt acceptance is distinct from work authorization. */
export interface TextFileReceipt extends FileReference {
  contract: "s16-file-receipt/v1"; conversationId: string; name: string; mime: "text/plain"; bytes: number; expiresAt: number | null;
}
/** Sanitized representation is immutable and tied to the original receipt; parsing is not work authority. */
export interface BinaryFileReceipt extends FileReference {
  contract: "s16-file-receipt/v2"; conversationId: string; name: string; mime: "application/pdf" | "image/png" | "image/jpeg"; bytes: number; expiresAt: number | null;
  validation: "s16-isolated-file/v1";
  parserGeneration: string;
  representation: { sha256: string; bytes: number; mime: "text/plain" | "image/png" | "image/jpeg"; pages: number | null; width: number | null; height: number | null; originalWidth: number | null; originalHeight: number | null };
}
export type FileReceipt = TextFileReceipt | BinaryFileReceipt;
/** Upload identity is retained on failure/cancel so retries cannot recreate or repurpose old bytes. */
export interface FileUpload {
  contract: "s16-file-upload/v1"; id: string; requestId: string; conversationId: string; name: string;
  expectedBytes: number; expectedHash: string; bytes: number;
  state: "created" | "uploading" | "validating" | "ready" | "rejected" | "cancelled" | "expired" | "withdrawn";
  code: string | null; createdAt: number; expiresAt: number; retained: boolean; receipt: FileReceipt | null;
}
/** Authenticated metadata commit before any byte stream; declared type/size/hash are untrusted. */
export interface FileUploadCommand { requestId: string; conversationId: string; name: string; bytes: number; sha256: string }
/** Technical limits are server-advertised, not copied from upstream or inferred monetary permission. */
export interface FileLimits { fileBytes: number; messageFiles: number; messageBytes: number; totalBytes: number; uploadLifetimeMs: number }
/** Current owner identity resolved by the protected authentication service, never the client body. */
export interface FileOwner { id: string; generation: number }
/** Guarded immutable output identity. A candidate is not downloadable until CHAT commits its reference. */
export interface FileArtifact extends FileReference {
  contract: "s16-file-artifact/v1"; requestId: string; workId: string; conversationId: string; name: string; mime: "text/plain" | "text/markdown" | "text/csv" | "text/html"; bytes: number; createdAt: number;
}
/**
 * Metadata-only revision lineage of an artifact (`s16-artifact-lineage/v1`). `parents` are the prior
 * artifacts whose exact bytes became inputs of the producing request; `current` is true only while every
 * transitive input source is still ready. No field grants read, publication or recipient authority.
 */
export interface FileArtifactLineage { artifact: FileArtifact; inputs: FileReference[]; parents: FileReference[]; current: boolean }
/** Exact command adopting one committed artifact as a new input of its own conversation; never work authority. */
export interface FileArtifactInputCommand { requestId: string; conversationId: string; artifact: FileReference }
/** Initial text-only profile; binary formats remain unavailable until their isolated parser path is proven. */
export const defaultFileLimits: Readonly<FileLimits> = Object.freeze({ fileBytes: 64 * 1024, messageFiles: 4, messageBytes: 128 * 1024, totalBytes: 32 * 1024 * 1024, uploadLifetimeMs: 24 * 60 * 60 * 1000 });
