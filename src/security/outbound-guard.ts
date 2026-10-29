/** One private context entry; ATT04 can append full sanitized attachment text without changing the guard. */
export interface PrivateContextEntry { text: string }

/** Normalizes both sides of an outbound comparison, including percent-encoded URLs, without retaining raw text. */
export function normalizeOutbound(text: string): string {
  // Decode each valid UTF-8 percent run independently: a malformed escape cannot mask a later valid span.
  let decoded = text;
  for (let depth = 0; depth < 8; depth++) {
    const next = decoded.replace(/(?:%[0-9a-f]{2})+/gi, value => { try { return decodeURIComponent(value); } catch { return Buffer.from(value.replaceAll("%", ""), "hex").toString("utf8"); } });
    if (next === decoded) break;
    decoded = next;
  }
  return decoded.normalize("NFC").toUpperCase().toLowerCase().replace(/\p{Cf}/gu, "").replace(/\s+/gu, " ").trim().normalize("NFC");
}

/** Builds a run-local verbatim guard; a match is at least 24 normalized Unicode code points from one private entry. */
export function outboundGuard(entries: readonly PrivateContextEntry[]): (outgoing: string) => string | null {
  const spans = new Set<string>();
  for (const entry of entries) {
    const chars = Array.from(normalizeOutbound(entry.text));
    for (let at = 0; at + 24 <= chars.length; at++) spans.add(chars.slice(at, at + 24).join(""));
  }
  return outgoing => {
    const chars = Array.from(normalizeOutbound(outgoing));
    for (let at = 0; at + 24 <= chars.length; at++) { const span = chars.slice(at, at + 24).join(""); if (spans.has(span)) return span; }
    return null;
  };
}
