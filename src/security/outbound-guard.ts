/** One full private source; attachment identity is retained only for content-free audit and owner card markers. */
export interface PrivateContextEntry { text: string; attachmentId?: string }

/** Normalizes Unicode, whitespace, percent escapes and form/query `+` spaces on both sides of the comparison. */
export function normalizeOutbound(text: string): string {
  // Decode form/query spaces before percent escapes: %2B is a literal plus, not a space.
  const query = text.indexOf("?");
  const form = !/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && /^[^\s=&?#]+=[\s\S]*/u.test(text);
  let decoded = query >= 0 ? text.slice(0, query + 1) + text.slice(query + 1).replace(/\+/g, " ") : form ? text.replace(/\+/g, " ") : text;
  for (let depth = 0; depth < 8; depth++) {
    const next = decoded.replace(/(?:%[0-9a-f]{2})+/gi, value => { try { return decodeURIComponent(value); } catch { return Buffer.from(value.replaceAll("%", ""), "hex").toString("utf8"); } });
    if (next === decoded) break;
    decoded = next;
  }
  return decoded.normalize("NFC").toUpperCase().toLowerCase().replace(/\p{Cf}/gu, "").replace(/[\s\p{White_Space}]+/gu, " ").trim().normalize("NFC");
}

/** A directly confirmed match, or a potential outgoing span held conservatively when verification runs out. */
export interface OutboundMatch { span: string; attachmentId?: string; chars: number; reason?: "verification_budget_exhausted" | "corpus_refresh_failed" }
/** Maximum candidate code-point comparisons per outgoing value, shared by both normalization interpretations. */
export const outboundVerificationBudget = 64 * 1024;
/** Run-local corpus; sampled 12-code-point windows bound index space to roughly 1/13 of source length. */
export interface OutboundCorpus { readonly entries: readonly { text: string; attachmentId?: string; index: BigUint64Array }[] }
const hash = (text: string) => { let h = 2166136261; for (const char of text) h = Math.imul(h ^ char.codePointAt(0)!, 16777619); return h >>> 0; };
const next = (text: string, at: number) => at + (text.codePointAt(at)! > 0xffff ? 2 : 1);
const previous = (text: string, at: number) => at - (at > 1 && /[\uDC00-\uDFFF]/.test(text[at - 1]!) && /[\uD800-\uDBFF]/.test(text[at - 2]!) ? 2 : 1);
function windowEnd(text: string, at: number, count: number): number { for (let n = 0; n < count; n++) { if (at >= text.length) return -1; at = next(text, at); } return at; }

/** Builds a bounded sampled index of full text, without materializing every 24-character substring. */
export function buildOutboundCorpus(entries: readonly PrivateContextEntry[]): OutboundCorpus {
  return { entries: entries.map(entry => {
    const text = normalizeOutbound(entry.text), windows: bigint[] = [];
    for (let at = 0, cp = 0; at < text.length; at = next(text, at), cp++) {
      if (cp % 13) continue;
      const end = windowEnd(text, at, 12); if (end < 0) break;
      windows.push((BigInt(hash(text.slice(at, end))) << 32n) | BigInt(at));
    }
    return { text, ...(entry.attachmentId ? { attachmentId: entry.attachmentId } : {}), index: BigUint64Array.from(windows).sort() };
  }) };
}

function findNormalizedSpan(corpus: OutboundCorpus, text: string, minimum: number, work: { remaining: number }): OutboundMatch | null {
  const potentialEnd = windowEnd(text, 0, minimum);
  if (potentialEnd < 0) return null;
  for (let at = 0; at < text.length; at = next(text, at)) {
    const end = windowEnd(text, at, 12); if (end < 0) break;
    const anchor = text.slice(at, end), target = BigInt(hash(anchor)) << 32n;
    for (const entry of corpus.entries) {
      let lo = 0, hi = entry.index.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (entry.index[mid]! < target) lo = mid + 1; else hi = mid; }
      // Exhaustion is a match for every consumer: it follows the same owner-only release/card path. The reason
      // distinguishes this potential outgoing span from a directly confirmed source span (including hash collisions).
      const exhausted = (): OutboundMatch => ({ span: text.slice(0, potentialEnd), chars: minimum,
        reason: "verification_budget_exhausted", ...(entry.attachmentId ? { attachmentId: entry.attachmentId } : {}) });
      for (; lo < entry.index.length && entry.index[lo]! >> 32n === target >> 32n; lo++) {
        if (work.remaining < 12) return exhausted();
        work.remaining -= 12;
        const sourceAt = Number(entry.index[lo]! & 0xffffffffn), sourceEnd = windowEnd(entry.text, sourceAt, 12);
        if (entry.text.slice(sourceAt, sourceEnd) !== anchor) continue;
        let left = at, right = end, sl = sourceAt, sr = sourceEnd, count = 12;
        while (count < minimum && left > 0 && sl > 0) {
          if (work.remaining-- <= 0) return exhausted();
          const l = previous(text, left), s = previous(entry.text, sl);
          if (text.slice(l, left) !== entry.text.slice(s, sl)) break;
          left = l; sl = s; count++;
        }
        while (count < minimum && right < text.length && sr < entry.text.length) {
          if (work.remaining-- <= 0) return exhausted();
          const r = next(text, right), s = next(entry.text, sr);
          if (text.slice(right, r) !== entry.text.slice(sr, s)) break;
          right = r; sr = s; count++;
        }
        if (count >= minimum) return { span: text.slice(left, right), chars: count, ...(entry.attachmentId ? { attachmentId: entry.attachmentId } : {}) };
      }
    }
  }
  return null;
}

/**
 * Finds a directly confirmed span of at least 24 code points, or fails closed with a potential span on work-budget
 * exhaustion. Callers must hold either result for owner release. Ambiguous argument strings also get a form-value
 * interpretation, so a bare `word+word` value cannot bypass spaces while literal plus spans still match normally.
 */
export function findVerbatimSpan(corpus: OutboundCorpus, outgoing: string, minChars = 24): OutboundMatch | null {
  const text = normalizeOutbound(outgoing), minimum = Number.isSafeInteger(minChars) ? Math.max(24, minChars) : 24;
  const work = { remaining: outboundVerificationBudget };
  return findNormalizedSpan(corpus, text, minimum, work) ?? (text.includes("+")
    ? findNormalizedSpan(corpus, text.replace(/\+/g, " ").replace(/[\s\p{White_Space}]+/gu, " ").trim(), minimum, work) : null);
}

/** WEB01-compatible callable guard over the same full-text corpus. */
export function outboundGuard(entries: readonly PrivateContextEntry[]): (outgoing: string) => string | null {
  const corpus = buildOutboundCorpus(entries);
  return outgoing => findVerbatimSpan(corpus, outgoing)?.span ?? null;
}
