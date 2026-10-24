/**
 * Neutralizes destinations in untrusted text before it reaches an owner channel. Every URI scheme,
 * protocol-relative URL, Markdown link/autolink, e-mail address, Telegram handle-link and bare
 * host with a path or port (`evil.com/phish`) is replaced; remaining domain-like or IPv4 tokens are defanged with
 * `[.]` so clients cannot autolink them. File paths stay readable (`src/a[.]ts`). Callers append
 * only service-owned links after neutralizing.
 */

/** Replacement shown where a PR-supplied link or destination was removed. */
export const DESTINATION_REDACTED = "[ลิงก์ถูกตัด]";

const markdownLink = /!?\[([^\]\n]{0,500})\]\(\s*[^)\n]*\)/g;
const autolink = /<\s*[a-z][a-z0-9+.-]*:[^>\s]*>|<\s*[^>\s@]+@[^>\s]+>|<\s*(?:\/\/|www\.)[^>\s]*>/gi;
const schemeUri = /\b[a-z][a-z0-9+.-]{1,31}:\/\/\S*/gi;
const opaqueScheme = /\b(?:mailto|tg|tel|sms|javascript|data|file|magnet|xmpp|vbscript|intent|market|itms-services|sip|callto|skype|whatsapp|viber|ftp|ws|wss):\S+/gi;
const protocolRelative = /(^|[^\w:/])\/\/[^\s/]+\S*/g;
const email = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const handleLink = /(^|[^\w])(?:t\.me|telegram\.(?:me|dog)|wa\.me)\b\S*/gi;
const www = /\bwww\.\S+/gi;
const domainLike = /\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,61}[A-Za-z0-9]\b/g;
const ipv4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
// A bare host followed by a path or port (`evil.com/phish`, `evil.com:8080`) is a destination, not a file name.
const hostWithPath = /(^|[^\w./-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,61}[A-Za-z0-9](?:\/|:\d)\S*/g;

/** True when `text` contains any link or destination form `neutralizeDestinations` would change. */
export function containsDestination(text: string): boolean {
  return typeof text === "string" && neutralizeDestinations(text) !== text;
}

/** Removes links/destinations and defangs domain-like tokens in one untrusted field. */
export function neutralizeDestinations(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  return text
    .replace(markdownLink, (_m, label: string) => `${label.replace(/[[\]]/g, "")} ${DESTINATION_REDACTED}`.trim())
    .replace(autolink, DESTINATION_REDACTED)
    .replace(schemeUri, DESTINATION_REDACTED)
    .replace(opaqueScheme, DESTINATION_REDACTED)
    .replace(protocolRelative, (_m, lead: string) => `${lead}${DESTINATION_REDACTED}`)
    .replace(email, DESTINATION_REDACTED)
    .replace(handleLink, (_m, lead: string) => `${lead}${DESTINATION_REDACTED}`)
    .replace(www, DESTINATION_REDACTED)
    .replace(ipv4, match => match.replace(/\./g, "[.]"))
    .replace(hostWithPath, (_m, lead: string) => `${lead}${DESTINATION_REDACTED}`)
    .replace(domainLike, match => match.replace(/\./g, "[.]"));
}
