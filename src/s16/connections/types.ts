import type { JsonValue, Ref } from "../../s15/policy";

/**
 * CONN16-01 / MCP16-01 / OPEN16-01 (`s16-connections/v1`, ADR 0089). A connected tool source is an owner-added HTTPS
 * endpoint (an MCP server, an OpenAPI service or a GraphQL endpoint with owner-written operations). Everything a source
 * reports about itself (tool names, descriptions, schemas, read-only hints, HTTP methods) is data: only the owner's
 * one-time review decides what each tool is, and a changed catalog needs a new review before any tool runs again.
 */
export type SourceKind = "mcp" | "openapi" | "graphql";
/**
 * The owner's decision for one discovered tool: `read` (reads only; the Bot uses it freely), `change` (changes data;
 * the Bot runs it on its own), `approval` (the owner approves each exact call on its in-chat card) or `off`.
 */
export type ToolClass = "read" | "change" | "approval" | "off";
export const toolClasses: readonly ToolClass[] = Object.freeze(["read", "change", "approval", "off"]);

/** Bounded JSON Schema subset kept from a source; unknown keywords are carried for the model but never trusted. */
export type JsonSchema = { [key: string]: JsonValue };

/** How a tool is actually called. Only trusted adapter code builds requests from it; the model supplies arguments only. */
export type SourceBinding =
  | { kind: "mcp"; tool: string }
  | { kind: "openapi"; method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; parameters: { name: string; in: "path" | "query"; required: boolean }[]; body: "none" | "json"; bodyRequired: boolean }
  | { kind: "graphql"; operationName: string; operation: "query" | "mutation"; document: string };

/** One discovered tool. `hint` is what the source said about itself, shown to the owner as a suggestion only. */
export interface SourceTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  /** Digest of the exact tool identity, schema and binding; any change makes the catalog hash change. */
  schemaHash: string;
  hint: { readOnly: boolean | null; destructive: boolean | null; method: string | null; operation: "query" | "mutation" | null };
  /** The pre-selected review choice derived from `hint` (never authority); unknown effects suggest `approval`. */
  suggested: ToolClass;
  /** Classes the owner may choose. A GraphQL mutation can never be `read`. */
  allowed: ToolClass[];
  binding: SourceBinding;
}
/** One discovery result. `hash` binds every tool's identity, schema and binding in order. */
export interface SourceCatalog {
  contract: "s16-source-catalog/v1";
  hash: string;
  tools: SourceTool[];
  /** Tools listed beyond the bounds, or entries the bounded importer could not support (named by reason). */
  skipped: { name: string; code: string }[];
  truncated: boolean;
  server: { name: string | null; version: string | null; protocol: string | null };
  discoveredAt: number;
}
/** The owner's confirmed decisions for exactly one catalog hash. */
export interface SourceReview { revision: number; catalogHash: string; decisions: Record<string, ToolClass>; reviewedAt: number }

/** Owner-entered credential; secrets are write-only and live in the protected vault only. */
export type SourceAuthInput = { kind: "none" } | { kind: "bearer"; secret: string } | { kind: "header"; name: string; secret: string } | { kind: "oauth" };
/** Stored auth facts. `fingerprint` binds the vault value the record was verified with (bearer/header). */
export interface SourceAuth {
  kind: "none" | "bearer" | "header" | "oauth";
  header: string | null;
  fingerprint: string | null;
  oauth: { issuer: string; authorizationEndpoint: string; tokenEndpoint: string; clientId: string; resource: string; scope: string | null; expiresAt: number | null } | null;
}
/**
 * `authorizing`: waiting for the owner's OAuth sign-in. `needs_review`: a catalog awaits the owner's review (first
 * time or after it changed). `active`: reviewed tools are usable. `reconnect_required`: the credential was refused or
 * expired. `unavailable`: discovery failed (`code` says why). `removed`: revoked; the identity never becomes active again.
 */
export type SourceState = "authorizing" | "needs_review" | "active" | "reconnect_required" | "unavailable" | "removed";
/** Protected source record (journal row). Never contains a secret. */
export interface SourceRecord {
  contract: "s16-source/v1";
  id: string; revision: number; kind: SourceKind; label: string;
  /** Exact HTTPS endpoint (MCP endpoint, OpenAPI base URL or GraphQL endpoint). */
  endpoint: string;
  auth: SourceAuth;
  state: SourceState; code: string | null;
  /** TEAM/POLICY resource, DATA15 service recipient and private DATA15 source of everything read from it. */
  resource: Ref; recipient: Ref; source: Ref;
  catalog: SourceCatalog | null;
  review: SourceReview | null;
  /** The imported OpenAPI document or GraphQL operations (owner text), with its digest. */
  document: { text: string; sha256: string } | null;
  origin: { kind: "owner" } | { kind: "chat"; conversationId: string; requestId: string };
  createdAt: number; updatedAt: number; verifiedAt: number | null;
}

/** Owner-visible tool row: the review decision, if any, beside the source's own suggestion. */
export interface SourceToolView { name: string; title: string; description: string; hint: SourceTool["hint"]; suggested: ToolClass; allowed: ToolClass[]; decision: ToolClass | null; request: string | null }
/** Owner projection of one source. Credentials, tokens and session identities never appear. */
export interface SourceView {
  id: string; revision: number; kind: SourceKind; label: string; endpoint: string;
  auth: { kind: SourceAuth["kind"]; header: string | null; issuer: string | null; expiresAt: number | null };
  state: SourceState; code: string | null;
  catalogHash: string | null; reviewedHash: string | null; changed: boolean;
  tools: SourceToolView[]; skipped: { name: string; code: string }[]; truncated: boolean;
  server: SourceCatalog["server"] | null;
  /** Bots that may use the source now (team resource minus each Bot's exclusions). */
  bots: { id: string; name: string; allowed: boolean }[];
  /** `installed`: the standing rules include the reviewed source. `review_required`: the rules page must be accepted first. */
  policy: "installed" | "review_required" | "not_needed";
  verifiedAt: number | null; createdAt: number; updatedAt: number;
}
/** GitHub app projection (fine-grained token connection). */
export interface GithubAppView {
  state: "not_connected" | "connected" | "reconnect_required" | "removed"; revision: number;
  login: string | null; tokenExpiresAt: number | null; verifiedAt: number | null; truncated: boolean;
  accessible: { name: string; private: boolean; push: boolean }[]; selected: string[];
  policy: "installed" | "review_required" | "not_needed";
}
/** A connection a Bot suggested in chat. It is inert: pressing it only opens the owner's protected form. */
export interface ConnectionRequestView { id: string; conversationId: string; requestId: string; kind: "github" | SourceKind; endpoint: string | null; label: string | null; createdAt: number; state: "open" | "done" | "dismissed"; sourceId: string | null }
export interface ConnectionsView {
  contract: "s16-client-connections/v1";
  github: GithubAppView | null;
  sources: SourceView[];
  requests: ConnectionRequestView[];
  limits: typeof connectionLimits;
  /** Exact OAuth redirect URI the owner may need to allow on a server that refuses dynamic registration. */
  oauthRedirect: string;
}

/** Exact owner commands. Each carries its own `requestId`; a retry with the same ID returns the original receipt. */
export type ConnectionCommand =
  | { contract: "s16-connection-command/v1"; requestId: string; kind: "source.add"; sourceKind: SourceKind; label: string; endpoint: string; auth: SourceAuthInput; document: string | null; origin: { conversationId: string; requestId: string } | null }
  | { contract: "s16-connection-command/v1"; requestId: string; kind: "source.review"; sourceId: string; expectedRevision: number; catalogHash: string; decisions: Record<string, ToolClass> }
  | { contract: "s16-connection-command/v1"; requestId: string; kind: "source.refresh" | "source.remove" | "source.oauth_begin" | "source.oauth_complete"; sourceId: string; expectedRevision: number }
  | { contract: "s16-connection-command/v1"; requestId: string; kind: "source.reconnect"; sourceId: string; expectedRevision: number; auth: SourceAuthInput }
  /** Replace the OpenAPI document or GraphQL operations; a changed catalog needs a new review (held calls go stale). */
  | { contract: "s16-connection-command/v1"; requestId: string; kind: "source.document"; sourceId: string; expectedRevision: number; document: string }
  | { contract: "s16-connection-command/v1"; requestId: string; kind: "github.connect"; token: string }
  | { contract: "s16-connection-command/v1"; requestId: string; kind: "github.select"; expectedRevision: number; names: string[] }
  | { contract: "s16-connection-command/v1"; requestId: string; kind: "github.remove"; expectedRevision: number }
  | { contract: "s16-connection-command/v1"; requestId: string; kind: "request.dismiss"; connectionRequestId: string };
/** Command receipt. `authorize` is the OAuth sign-in URL to open (only for `source.oauth_begin`). */
export interface ConnectionReceipt {
  contract: "s16-connection-receipt/v1"; requestId: string; kind: ConnectionCommand["kind"];
  source: SourceView | null; github: GithubAppView | null; authorize: string | null;
  /** Standing-rule outcome of a review/selection/removal; `review_required` names the /rules page. */
  policy: "installed" | "unchanged" | "review_required" | null;
}

/** Finite bounds (S16 NFR-05). Everything beyond them is refused or reported as skipped, never silently widened. */
export const connectionLimits = Object.freeze({
  sources: 32, toolsPerSource: 128, listPages: 16, documentBytes: 1_048_576, responseBytes: 1_048_576,
  resultBytes: 65_536, argumentBytes: 65_536, schemaBytes: 32_768, schemaDepth: 12, descriptionChars: 1_024,
  requestMs: 30_000, callMs: 120_000, oauthFlowMs: 600_000, graphqlDepth: 12, graphqlFields: 256, openapiRefs: 512,
});
