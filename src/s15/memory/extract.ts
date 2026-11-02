import type { MemoryCandidate } from "./types";

/**
 * Conservative local automatic extraction: explicit first-person preferences/facts and named working
 * knowledge only. It performs no model/network call or whole-history retention. Other extractors may
 * propose candidates through retain(), with the same exact-quote/provenance checks. Quoted commands,
 * credentials and instruction-shaped approval text never become authenticated decisions.
 */
export function extractMemory(text: string): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  for (const sentence of text.split(/(?:\r?\n)+|(?<=[.!?])\s+/u).slice(0, 32)) {
    const quote = sentence.trim(); if (!quote || quote.length > 2048 || /^["'“‘>`]/u.test(quote)) continue;
    const preference = /^(?:I (?:prefer|like|usually|always)|My preference is|(?:ฉัน|ผม|เรา)(?:ชอบ|ต้องการให้|มักจะ)|ปกติ(?:ฉัน|ผม))/iu.test(quote);
    const fact = /^(?:My (?:name|timezone|time zone|language|working hours|role) (?:is|are)|I (?:live in|work as|work in)|(?:ฉัน|ผม)(?:ชื่อ|อยู่ที่|ทำงานเป็น))/iu.test(quote);
    const knowledge = /^(?:The (?:build|test|lint|start) command is|Tests run with|Working knowledge:|คำสั่ง(?:build|test|ทดสอบ)คือ)/iu.test(quote);
    const inference = /^(?:It (?:appears|seems) that|I infer that|คาดว่า|สันนิษฐานว่า)/iu.test(quote);
    if (!preference && !fact && !knowledge && !inference) continue;
    candidates.push({ kind: inference ? "inference" : "fact", category: preference ? "preference" : knowledge ? "working_knowledge" : "fact", text: quote, quote });
    if (candidates.length === 16) break;
  }
  return candidates;
}
