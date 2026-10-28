/**
 * Shared credential detector for untrusted or outbound text (PR evidence, model output, outbox
 * payloads, exports). Patterns favour recall: a false positive holds or redacts text, a false
 * negative leaks a secret. Callers either hold the item (`containsCredential`) or redact it
 * (`redactCredentials`); neither function ever returns the matched value.
 */

interface CredentialPattern {
  kind: string;
  pattern: RegExp;
}

/** Credential shapes in priority order. Every pattern is global so redaction replaces all matches. */
export const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = Object.freeze([
  { kind: "private_key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  { kind: "authorization_header", pattern: /\b(?:proxy-)?authorization\s*:\s*\S*(?:\s+\S+)?/gi },
  { kind: "bearer", pattern: /\bbearer\s+\S*/gi },
  { kind: "telegram_header", pattern: /x-telegram[\w-]*(?:\s*:\s*\S+)?/gi },
  { kind: "bot_token_label", pattern: /\bbot[_ -]?token\b(?:\s*[:=]\s*\S+)?/gi },
  { kind: "telegram_bot_token", pattern: /\b[0-9]{5,}:[A-Za-z0-9_-]{8,}/g },
  { kind: "openai_or_anthropic_key", pattern: /\bsk-(?:proj-|svcacct-|admin-|ant-(?:api\d+-|admin\d+-)?)?[A-Za-z0-9_-]{16,}/g },
  { kind: "xai_key", pattern: /\bxai-[A-Za-z0-9_-]{16,}/g },
  { kind: "github_token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { kind: "gitlab_token", pattern: /\bglpat-[A-Za-z0-9_-]{16,}/g },
  { kind: "slack_token", pattern: /\bxox[abposre]-[A-Za-z0-9-]{10,}/g },
  { kind: "stripe_key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { kind: "google_oauth_token", pattern: /\bya29\.[0-9A-Za-z_-]{20,}/g },
  { kind: "aws_access_key", pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g },
  { kind: "npm_token", pattern: /\bnpm_[A-Za-z0-9]{30,}/g },
  { kind: "jit_webhook_secret", pattern: /\bjitwh_[A-Za-z0-9_-]{16,}/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "url_userinfo", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi },
  {
    kind: "secret_assignment",
    pattern: /\b(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key|password|passwd)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{8,}/gi,
  },
]);

/** Returns the first matching credential kind, or null when the text has no credential-like content. */
export function findCredential(text: string): string | null {
  if (typeof text !== "string" || text.length === 0) return null;
  for (const { kind, pattern } of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    const hit = pattern.test(text);
    pattern.lastIndex = 0;
    if (hit) return kind;
  }
  return null;
}

/** True when `text` contains any credential-like value or credential-bearing header. */
export function containsCredential(text: string): boolean {
  return findCredential(text) !== null;
}

/** Replaces every credential-like span with `replacement`; the original value is never returned. */
export function redactCredentials(text: string, replacement = "[credential-redacted]"): string {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  for (const { pattern } of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, replacement);
    pattern.lastIndex = 0;
  }
  return out;
}
