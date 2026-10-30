import type { Envelope } from "./types";
import type { ScopeRef } from "./authority-types";
import type { MemoryRef } from "./memory-types";

/** Owner-selected Google API consent; read and write are independently explicit. */
export type PersonalScope = "gmail.readonly" | "calendar.readonly" | "gmail.send" | "calendar.events";
/** Installation-owned OAuth Web client metadata; its secret is write-only in the broker vault. */
export interface PersonalClient {
  id: "google";
  revision: number;
  clientId: string;
  redirectUri: string;
  readiness: "configured_unverified";
}
/** One immutable Google consent identity, never an inferred or shared provider account. */
export interface PersonalConnection {
  id: string;
  revision: number;
  clientRevision: number;
  label: string;
  service: "gmail" | "calendar";
  scopes: PersonalScope[];
  account: string;
  accountVerification: "owner_label" | "gmail_profile";
  calendarId: string | null;
  state: "configured" | "authorizing" | "connected" | "reauth_required" | "revoked";
  revocation: "none" | "pending" | "confirmed" | "unknown";
  verifiedAt: number | null;
}
/** Explicit resource-slot permission for one Bot and connection; changing it fences captured work. */
export interface PersonalGrant {
  id: string;
  revision: number;
  connectionId: string;
  botId: string;
  botGeneration: number;
  active: boolean;
}
/** Credential-free OAuth progress; state, verifier and authorization code stay outside application state. */
export interface PersonalFlow {
  id: string;
  connectionId: string;
  connectionRevision: number;
  ownerGeneration: number;
  expiresAt: number;
  state: "pending" | "received" | "exchanging" | "complete" | "failed";
}
/** Exact owner setup and resource-grant commands, distinct from OAuth login and work execution. */
export type PersonalCommand =
  | Envelope<"personal.client.set", { clientId: string; clientSecret: string; redirectUri: string }>
  | Envelope<"personal.connection.create", { label: string; service: "gmail" | "calendar"; scopes: PersonalScope[]; account: string; calendarId: string | null }>
  | Envelope<"personal.oauth.begin", { connectionId: string }>
  | Envelope<"personal.connection.revoke", { connectionId: string }>
  | Envelope<"personal.grant.set", { scopeId: string; connectionId: string; botId: string; active: boolean }>;
/** Metadata-only receipt; no token, authorization code, state secret or credential digest is returned. */
export interface PersonalReceipt {
  kind: PersonalCommand["kind"];
  requestId: string;
  client?: PersonalClient;
  connection?: PersonalConnection;
  flow?: PersonalFlow;
  grant?: PersonalGrant;
}
/** Bounded owner/work-selected read window; arbitrary Gmail queries and calendar discovery are unavailable. */
export interface PersonalReadInput { scope: ScopeRef; from: number; to: number; timezone: string }
/** One untrusted mail, attachment or calendar snapshot with honest source time and timezone labels. */
export interface PersonalEvidence {
  source: MemoryRef;
  kind: "mail" | "attachment" | "event";
  providerId: string;
  title: string;
  text: string;
  sourceTimestamp: number | null;
  timezone: string | null;
  retrievedAt: number;
  untrusted: true;
}
/** A sourced triage/brief section; missing or stale data is never equivalent to no update. */
export interface PersonalRead {
  id: string;
  workId: string;
  attemptId: string;
  botId: string;
  connectionId: string;
  connectionRevision: number;
  scope: ScopeRef;
  window: { from: number; to: number; timezone: string };
  startedAt: number;
  finishedAt: number | null;
  outcome: "running" | "success" | "partial" | "failed" | "withdrawn";
  evidence: PersonalEvidence[];
  missing: string[];
  stale: boolean;
  calendarTimezone: string | null;
}
/** Broker-only credentials sealed outside SQLite, ordinary exports, backups and every execution box. */
export interface PersonalTokens { accessToken: string; refreshToken: string; expiresAt: number; scopes: PersonalScope[] }
/** Broker-only OAuth client material, never an application query projection. */
export interface PersonalClientSecret { clientId: string; clientSecret: string; redirectUri: string }
