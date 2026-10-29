/**
 * Voice check for app.communication_policy/v2 (S12-D05), shared by the scripted eval (tests/chat-voice.test.ts) and
 * the opt-in live test (tests/chat-voice.live.test.ts). It only measures committed reply text; nothing in the product
 * truncates or rewrites a reply to meet these limits.
 */

/** The policy's limits as the check reads them: "about 80 words", and a long-work reply of one line (two at most). */
export const voiceLimits = Object.freeze({ words: 80, taskReplyLines: 2 });

/** What the check reads from one reply. Words are dictionary words (ICU), so Thai without spaces counts like English. */
export interface VoiceMeasure { words: number; lines: number; headings: number; preamble: boolean; closingOffer: boolean }

const words = new Intl.Segmenter("th", { granularity: "word" });
// Openers that delay the answer, and sign-offs that offer more help instead of ending, in Thai and English.
const preambles = [/^(?:great|good|excellent|interesting) question/i, /^thanks? (?:you )?for (?:asking|your question)/i, /^as an ai\b/i,
  /^i(?:'|’)d be (?:happy|glad) to help/i, /^คำถาม(?:ที่)?ดี/, /^ขอบคุณ(?:สำหรับ|ที่)(?:คำถาม|ถาม)/, /^ในฐานะ ?AI/i, /^ยินดี(?:ที่จะ)?ช่วย/];
const closingOffers = [/let me know if/i, /feel free to/i, /hope (?:this|that) helps/i, /anything else/i,
  /มีอะไรให้(?:จิต)?ช่วย(?:อีก|เพิ่ม)/, /(?:ถ้า|หาก)มีคำถาม(?:เพิ่มเติม|อื่น)/, /(?:ถ้า|หาก)ต้องการ(?:ข้อมูล|รายละเอียด)เพิ่มเติม/, /สอบถามเพิ่มเติมได้/];

/** Measures one committed reply's prose. */
export function measureVoice(text: string): VoiceMeasure {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return {
    words: [...words.segment(text)].filter(part => part.isWordLike).length,
    lines: lines.length,
    headings: lines.filter(line => /^#{1,6}\s/.test(line) || /^\*\*[^*]+\*\*:?$/.test(line)).length,
    preamble: preambles.some(pattern => pattern.test(lines[0] ?? "")),
    closingOffer: closingOffers.some(pattern => pattern.test(lines.at(-1) ?? "")),
  };
}

/**
 * Every way a reply breaks the short chat voice, as stable codes (empty when it conforms). `words: null` lifts the
 * length limit for a reply the owner explicitly asked to be detailed; `lines` adds a line limit (long-work replies).
 */
export function voiceProblems(text: string, options: { words?: number | null; lines?: number } = {}): string[] {
  const measure = measureVoice(text), limit = options.words === undefined ? voiceLimits.words : options.words;
  return [
    limit !== null && measure.words > limit ? `words:${measure.words}>${limit}` : "",
    options.lines !== undefined && measure.lines > options.lines ? `lines:${measure.lines}>${options.lines}` : "",
    measure.headings ? `headings:${measure.headings}` : "",
    measure.preamble ? "preamble" : "",
    measure.closingOffer ? "closing_offer" : "",
  ].filter(Boolean);
}
