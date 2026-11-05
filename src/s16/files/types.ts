/** Opaque immutable input identity; filenames never become filesystem paths or authority. */
export interface FileReference { id: string; sha256: string }
/** Bounded, currently accepted text input. Receipt acceptance is distinct from work authorization. */
export interface FileReceipt extends FileReference {
  contract: "s16-file-receipt/v1"; conversationId: string; name: string; mime: "text/plain"; bytes: number; expiresAt: number | null;
}
/** Upload identity is retained on failure/cancel so retries cannot recreate or repurpose old bytes. */
export interface FileUpload {
  contract: "s16-file-upload/v1"; id: string; requestId: string; conversationId: string; name: string;
  expectedBytes: number; expectedHash: string; bytes: number;
  state: "created" | "uploading" | "ready" | "rejected" | "cancelled" | "expired" | "withdrawn";
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
  contract: "s16-file-artifact/v1"; requestId: string; workId: string; conversationId: string; name: string; mime: "text/plain" | "text/markdown" | "text/csv"; bytes: number; createdAt: number;
}
/** Initial text-only profile; binary formats remain unavailable until their isolated parser path is proven. */
export const defaultFileLimits: Readonly<FileLimits> = Object.freeze({ fileBytes: 64 * 1024, messageFiles: 4, messageBytes: 128 * 1024, totalBytes: 32 * 1024 * 1024, uploadLifetimeMs: 24 * 60 * 60 * 1000 });
