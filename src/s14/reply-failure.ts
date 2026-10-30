import type { HostAuthStatusCode } from "schway/host";

/** Public categories only; unknown failures never imply expired credentials, quota or a provider cause. */
export type ReplyUnavailableReason = "sign-in" | "quota" | "provider" | "timeout" | "unknown";

/** Trusted adapter failure with a fixed message; provider text/credentials never cross the chat boundary. */
export class ReplyUnavailable extends Error {
  constructor(readonly category: ReplyUnavailableReason) { super("reply_unavailable"); }
}

/** Maps Schway's public safe auth status; store failures remain unknown rather than inventing a provider cause. */
export function replyUnavailableReason(status: HostAuthStatusCode): ReplyUnavailableReason {
  if (["needs-login", "rejected", "invalid-store"].includes(status)) return "sign-in";
  if (status === "quota-exceeded") return "quota";
  if (["model-unavailable", "integration-unavailable"].includes(status)) return "provider";
  return "unknown";
}
