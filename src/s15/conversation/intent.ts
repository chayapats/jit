import type { ConversationIntent } from "./types";

/**
 * Conservative English/Thai direct-request grammar. Only original authenticated owner text is input.
 * Quotes, fenced code and forwarded lines are inert. Unknown/conditional/mixed scope is held once;
 * a model never upgrades this result. This deliberately is not a universal language classifier.
 */
export function groundConversationIntent(original: string): ConversationIntent {
  const instruction = original.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ")
    .replace(/^\s*>.*$/gm, " ").replace(/"(?:\\.|[^"\\])*"|“[^”]*”|‘[^’]*’|'[^'\n]*'|`[^`]*`/g, " ").trim();
  let text = instruction.toLowerCase();
  for (let prefix = 0; prefix < 4; prefix++) text = text.replace(/^(?:please\s+|can you\s+|could you\s+|i want you to\s+|help me\s+|ช่วย|กรุณา)/u, "").trim();
  const issues = [...new Set([...instruction.matchAll(/(?:issue\s*|#)(\d+)/gi)].map(match => `issue:${match[1]}`))];
  const subject = issues.length === 1 ? issues[0]! : null;
  // Preserve quoted payload bytes for the task/model as data; only the stripped view determines authority.
  const result = (kind: ConversationIntent["kind"]): ConversationIntent => ({ kind, subject, instruction: original });
  if (!instruction) return result("answer");
  if (/(?:\bif\b|\bunless\b|\bwhen\b|only after|ถ้า|หาก|เมื่อ)/u.test(text) || issues.length > 1 && /^(?:implement|fix|start|work|ทำ|เริ่ม|แก้)/u.test(text)) return result("ambiguous");
  if (/^(?:inspect|check|review|recommend|report|read|list|look\s+(?:at|up)|find|search|analy[sz]e|explain|summari[sz]e|ตรวจ|ดู|แนะนำ|อ่าน|ค้นหา|สรุป|วิเคราะห์|อธิบาย)/u.test(text)) {
    // An explicit subsequent mutation is material scope, not an inspection method.
    if (/(?:\band\b|\band then\b|\bthen\b|และจากนั้น|แล้ว|และ)\s*(?:implement|fix|write|create|delete|publish|ทำ|แก้|สร้าง|ลบ)/u.test(text)) return result("ambiguous");
    return result("inspect");
  }
  if (/^(?:do not|don't|never|ห้าม|อย่า|ยังไม่)/u.test(text)) return result("answer");
  if (/^(?:accept|select|choose|keep|ยอมรับ|เลือก|เก็บ)/u.test(text)) {
    if (/(?:\band\b|แล้ว|และ)\s*(?:start|implement|fix|execute|เริ่ม|ทำ|แก้)/u.test(text)) return issues.length > 1 ? result("ambiguous") : result("execute");
    return result("accept");
  }
  if (/^(?:implement\b|fix\b|create\b|write\b|process\b|convert\b|edit\b|update\b|run\b|execute\b|start\b|build\b|make\b|send\b|publish\b|delete\b|ทำ|เริ่ม|แก้|สร้าง|เขียน|ประมวลผล|แปลง|อัปเดต|รัน|ส่ง|เผยแพร่|ลบ)/u.test(text)) {
    if (/^(?:start|implement|fix|เริ่ม|ทำ|แก้)\s*(?:it|that|the selected one|อันนั้น|อันที่เลือก)\b/u.test(text) && !subject) return result("ambiguous");
    return result("execute");
  }
  if (/^(?:what|why|how|who|hello|hi\b|thanks|อะไร|ทำไม|อย่างไร|สวัสดี|ขอบคุณ)/u.test(text)) return result("answer");
  return result("ambiguous");
}
