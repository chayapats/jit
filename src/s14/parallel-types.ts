import type { Envelope } from "./types";

/** Explicit owner choice; authenticated mode never falls back to an anonymous or another billed identity. */
export interface ParallelSetting { id: "parallel"; revision: number; mode: "anonymous" | "authenticated"; connectionId: string | null; billingAcknowledged: boolean }
/** Vault metadata only; the credential value is never present in application state or query projections. */
export interface ParallelConnection { id: string; revision: number; state: "set" | "removed" }
/** Optional owner-selected credential configuration; anonymous mode requires no connection or billing acknowledgement. */
export type ConfigureParallelCommand = Envelope<"web.parallel.configure", { mode: "anonymous" | "authenticated"; connectionId: string | null; billingAcknowledged: boolean }>;
/** Write-only credential ingress; retry identity deliberately excludes the credential and never hashes it. */
export type SetParallelKeyCommand = Envelope<"web.parallel.key.set", { secret: string }>;
/** Removes one optional credential without changing the selected mode or silently using another identity. */
export type RemoveParallelKeyCommand = Envelope<"web.parallel.key.remove", { connectionId: string }>;
/** app.parallel-web/v1 authenticated owner command union. */
export type ParallelCommand = ConfigureParallelCommand | SetParallelKeyCommand | RemoveParallelKeyCommand;
/** Public optional web configuration receipt contains metadata only. */
export interface ParallelReceipt { kind: ParallelCommand["kind"]; requestId: string; setting?: ParallelSetting; connection?: ParallelConnection }
/** Honest finite read outcome; unknown usage and vendor metadata remain null rather than zero. */
export type WebOutcome = "success" | "partial" | "quota" | "schema_changed" | "service_error" | "blocked" | "private_context" | "credential_refused" | "cancelled" | "deadline" | "oversize" | "authority_changed" | "key_unavailable";
/** One untrusted evidence revision actually returned by a bounded search or page read. */
export interface ExternalEvidence {
  id: string; revision: 1; generation: 1; workId: string; attemptId: string; botId: string;
  tool: "web_search" | "web_fetch"; provider: "parallel"; mode: ParallelSetting["mode"];
  requestedUrl: string | null; url: string; finalUrl: string | null; title: string;
  content: string; coverage: "snippet" | "excerpt" | "full_content_returned";
  retrievedAt: number; publishedAt: string | null; reportedRetrievedAt: string | null;
  freshness: "unknown" | "cached_reported" | "live_reported"; cache: Record<string, unknown> | null;
  truncated: boolean; untrusted: true;
}
/** One exact bounded public read, including failure, missing URLs and optional vendor-reported usage. */
export interface WebRead {
  id: string; attemptId: string; workId: string; botId: string; tool: "web_search" | "web_fetch";
  subject: string; dispatched: boolean; requestedAt: number; finishedAt: number | null; outcome: WebOutcome | "running";
  mode: ParallelSetting["mode"]; settingRevision: number; evidence: ExternalEvidence[]; missing: string[];
  failures: { url: string; kind: string; status: number | null }[];
  usage: { name: string; count: number; costUsd: number }[] | null; omittedResults: number; remoteRequests: number; reason: string | null;
}
/** Normalized vendor result independent of owner authorization, with no claimed remote DNS validation. */
export interface ParallelResult {
  evidence: Omit<ExternalEvidence, "id" | "revision" | "generation" | "workId" | "attemptId" | "botId" | "tool" | "provider" | "mode" | "retrievedAt">[];
  missing: string[]; failures: WebRead["failures"]; usage: WebRead["usage"]; sessionId: string | null; omittedResults: number; partial: boolean;
}
