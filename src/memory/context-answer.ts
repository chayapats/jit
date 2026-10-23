import type { SourceReference } from "../sources";
import type { ApplicationRunRequest, ContextConstraint } from "../team/types";

const short = (text: string, max = 160): string => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
};
const cite = (ref: SourceReference) => `${ref.sourceId} r${ref.revision} g${ref.generation}`;
const stateLabel: Record<ContextConstraint["state"], string> = {
  proposed: "งานที่เสนอ (ยังไม่รับ)", accepted: "งานที่รับแล้ว", ready_for_review: "งานรอตรวจ", current: "มติปัจจุบันของคุณ",
};

function fit(lines: string[], maxBytes: number): string {
  const marker = "…(ตัดตามงบ output ดูบริบทเต็มในหน้า context)";
  let out = "";
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line;
    if (Buffer.byteLength(next) + Buffer.byteLength(marker) + 1 > maxBytes) return out ? `${out}\n${marker}` : marker;
    out = next;
  }
  return out;
}

/**
 * Deterministic fixture answer over app.memory_context/v1. It applies the documented precedence and disclosure rules
 * so tests can observe them; it claims no model reasoning quality and never reads anything outside the request.
 */
export function renderContextAnswer(request: ApplicationRunRequest, maxBytes: number): string {
  const context = request.manifest.context;
  if (!context) return fit(["บริบท: คำขอนี้ไม่มี memory_context จึงตอบจากต้นฉบับที่ระบุเท่านั้น"], maxBytes);
  const lines = [
    `บริบทที่ใช้ (app.memory_context/v1 · ${context.recordId}) — fixture ไม่ใช่คุณภาพโมเดลจริง`,
    `คำสั่งปัจจุบัน: ${short(request.purpose)}`,
    "ข้อผูกพันและมติปัจจุบัน (สถานะโครงการ ไม่ใช่ memory):",
  ];
  for (const item of context.constraints) {
    lines.push(`- ${stateLabel[item.state]}: ${short(item.text)}${item.truncated ? " (ตัดข้อความ)" : ""} · ${item.kind} ${item.id} r${item.revision} · หลักฐาน ${cite(item.source)}`);
  }
  if (!context.constraints.length) lines.push("- ไม่มีงานหรือมติที่ยังมีผลในโครงการนี้");
  const claims = request.manifest.claims.map((claim, index) => ({ claim, layer: context.claims[index]! }));
  const preferences = claims.filter(item => item.layer.layer === "explicit_preference");
  const inferences = claims.filter(item => item.layer.layer === "inference");
  if (preferences.length) {
    lines.push("สิ่งที่คุณระบุไว้ในโครงการนี้:");
    for (const { claim, layer } of preferences) lines.push(`- ${short(claim.text)} · claim ${claim.claimId} r${claim.revision} g${claim.generation} · ที่มา ${cite(layer.source)}`);
  }
  if (inferences.length) {
    lines.push("ข้ออนุมาน (ไม่ใช่ข้อกำหนด ตรวจที่มาก่อนใช้):");
    for (const { claim, layer } of inferences) {
      const origin = layer.scope === "cross_project"
        ? `จากโครงการอื่น ${claim.projectId}${layer.kind === "explicit_fact" ? " (คุณกล่าวไว้ที่นั่น ไม่ใช่ความชอบของโครงการนี้)" : ""}`
        : "ข้ออนุมานในโครงการนี้";
      lines.push(`- ${origin}: ${short(claim.text)} · claim ${claim.claimId} r${claim.revision} g${claim.generation} · ที่มา ${cite(layer.source)}`);
    }
  }
  const conflicts = claims.flatMap(({ claim, layer }) => layer.conflicts.map(ref => [claim.claimId, ref.claimId].sort().join(" ↔ ")));
  const unique = [...new Set(conflicts)];
  if (unique.length) {
    lines.push("ข้อขัดแย้งที่ต้องให้คุณตัดสิน (ไม่เลือกข้อใดเป็นความจริงเอง):");
    for (const pair of unique) lines.push(`- claim ${pair}`);
  }
  const basis = context.constraints[0], preference = preferences[0], inference = inferences[0];
  if (unique.length) lines.push(`คำแนะนำ: ยังมีข้อขัดแย้ง ${unique.length} คู่ จึงถามคุณก่อนแนะนำ`);
  else if (basis) lines.push(`คำแนะนำ: อิง${stateLabel[basis.state]} ${basis.kind} ${basis.id} — ${short(basis.text, 80)}`);
  else if (preference) lines.push(`คำแนะนำ: อิงสิ่งที่คุณระบุไว้ claim ${preference.claim.claimId} — ${short(preference.claim.text, 80)}`);
  else if (inference) {
    lines.push(`คำแนะนำนี้อิงข้ออนุมาน: ${short(inference.claim.text, 80)} · claim ${inference.claim.claimId} · โครงการ ${inference.claim.projectId} · ที่มา ${cite(inference.layer.source)}`);
  } else lines.push("คำแนะนำ: ไม่มีสถานะโครงการหรือ memory ที่อ้างอิงได้ คำตอบนี้จึงไม่มีแหล่งอ้างอิงรองรับ");
  const { omitted } = context;
  if (omitted.constraints || omitted.claims || omitted.budget) {
    lines.push(`ขอบเขต: บริบทไม่ครบ ละงาน/มติ ${omitted.constraints} และ memory ${omitted.claims} รายการตามงบที่จำกัด`);
  }
  if (omitted.loopGuard) lines.push("ขอบเขต: ไม่ดึง memory เพิ่ม เพราะอินพุตมาจากคำตอบที่ใช้ memory แล้ว (loop guard)");
  if (omitted.unavailable) lines.push(`ขอบเขต: memory ที่ถูกถอนหรือไม่พร้อมใช้ ${omitted.unavailable} รายการไม่ถูกนำมาใช้`);
  return fit(lines, maxBytes);
}
