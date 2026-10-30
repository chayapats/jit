import type { ConnectionVault } from "../exec/connections";
import type { Effect } from "./authority-types";
import type { CodingRepository } from "./coding-types";
import type { Envelope } from "./types";

/** Resource-scoped GitHub metadata follows the existing write-only connection/vault model without a Project. */
export interface GitConnection {
  id: string;
  revision: number;
  kind: "github_token";
  label: string;
  repositoryId: string;
  secret: "empty" | "set";
  removed: boolean;
}
/** Exact PR creation fields never imply merge, deployment, comments or later updates. */
export interface GitPullRequest { base: string; baseCommit: string; title: string; body: string; draft: boolean }
/** One immutable approved push and optional PR, including exact evidence, destination and connection revision. */
export interface GitAction {
  version: "app.git-effects/v2";
  intentId: string;
  codingAttemptId: string;
  ownerGeneration: number;
  repository: CodingRepository;
  connection: { id: string; revision: number };
  headCommit: string;
  diffHash: string;
  reportId: string;
  update: { ref: string; oldCommit: string | null; newCommit: string };
  pr: GitPullRequest | null;
}
/** Owner proposal selects exact retained coding evidence; approval remains a separate exact-action decision. */
export type GitProposeCommand = Envelope<"git.propose", {
  attemptId: string;
  connection: { id: string; revision: number };
  update: GitAction["update"];
  pr: GitPullRequest | null;
  expiresAt: number;
}>;
/** Connection values are transient write-only Web input and never occur in a receipt or retry digest. */
export type GitConnectionCommand = Envelope<"git.connection.create", { repositoryId: string; label: string }> |
  Envelope<"git.connection.secret.set" | "git.connection.rotate", { connectionId: string; secret: string }> |
  Envelope<"git.connection.remove" | "git.connection.test", { connectionId: string }>;
/** Durable commands either configure a scoped connection or propose one exact external action. */
export type GitCommand = GitProposeCommand | GitConnectionCommand | Envelope<"git.reconcile", { effectId: string; actionHash: string }>;
/** Safe Git command result never contains a token, bundle, mirror path or authenticated process detail. */
export interface GitReceipt {
  kind: GitCommand["kind"];
  requestId: string;
  connection?: GitConnection;
  effect?: Effect;
  test?: "present" | "missing" | "unsafe";
}
/** Durable per-stage receipt prevents retry across partial push/PR and process-death windows. */
export interface GitProgress {
  effectId: string;
  intentId: string;
  actionHash: string;
  stage: "prepared" | "verifying" | "push_dispatching" | "pushed" | "pr_dispatching" | "complete" | "failed" | "unknown";
  reason: string | null;
  pullNumber: number | null;
  verification: "none" | "protocol" | "remote_readback";
}
/** Remote proof distinguishes verified occurrence from incomplete, ambiguous or contradictory observations. */
export interface GitRemoteProof {
  headCommit: string | null;
  baseCommit: string | null;
  prs: { number: number; headCommit: string; baseCommit: string; base: string; head: string; title: string; body: string; draft: boolean }[];
  complete: boolean;
}
/** Trusted transport receives credentials only outside the workspace and guards immediately before each dispatch. */
export interface GitRemotePort {
  push(mirror: string, action: GitAction, secret: string, allowed: () => void): Promise<"succeeded" | "failed" | "unknown">;
  createPr(action: GitAction, secret: string, allowed: () => void): Promise<{ outcome: "succeeded" | "failed" | "unknown"; number: number | null }>;
  readBack(action: GitAction, secret: string, allowed: () => void): Promise<GitRemoteProof>;
}
/** Service-owned broker configuration reuses ConnectionVault; deterministic transport/fault seams never come from HTTP. */
export interface GitOptions {
  vault?: ConnectionVault;
  remote?: GitRemotePort;
  afterStage?: (stage: GitProgress["stage"]) => void | Promise<void>;
}
