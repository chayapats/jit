const stopWords = new Set([
  "the", "and", "for", "with", "this", "that", "are", "was", "use", "not", "but", "you", "our", "can", "all", "any", "from",
  "into", "what", "which", "how", "why", "should", "would", "could", "has", "have", "had", "will", "its", "their", "about",
]);

/**
 * Bounded literal terms: ASCII-folded words of 3+ characters plus code-point trigrams of every non-ASCII letter run,
 * so Thai and other scripts without whitespace word boundaries still match. This is not semantic recall.
 */
export function lexicalTerms(text: string): Set<string> {
  const terms = new Set<string>();
  const folded = Array.from(text).slice(0, 4096).join("").replace(/[A-Z]/g, char => char.toLowerCase());
  for (const word of folded.match(/[a-z0-9]+/g) ?? []) if (word.length >= 3 && !stopWords.has(word)) terms.add(`w:${word}`);
  for (const run of folded.match(/[^\x00-\x7F\p{White_Space}\p{P}\p{S}]+/gu) ?? []) {
    const chars = Array.from(run);
    if (chars.length < 3) terms.add(`g:${run}`);
    for (let index = 0; index + 3 <= chars.length; index++) terms.add(`g:${chars.slice(index, index + 3).join("")}`);
    if (terms.size >= 2048) break;
  }
  return terms;
}

/** Word overlap counts three, trigram overlap one; a candidate is relevant at three or more. */
export function lexicalScore(query: ReadonlySet<string>, text: string): number {
  let score = 0;
  for (const term of lexicalTerms(text)) if (query.has(term)) score += term.startsWith("w:") ? 3 : 1;
  return score;
}
