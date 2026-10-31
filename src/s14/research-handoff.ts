import type { StepGap, StepInput } from "./graph-types";
import type { ReportEvidence } from "./report-types";

/** Already-authorized committed dependency; citations only rank its existing evidence, never grant access. */
export interface CommittedHandoff { input: StepInput; evidence: ReportEvidence[]; cited: { id: string; revision: number }[] }
const key = (source: { id: string; revision: number }) => JSON.stringify([source.id, source.revision]);
function prefix(bytes: Buffer, length: number): string {
  while (length > 0 && (bytes[length]! & 0xc0) === 0x80) length--;
  return bytes.subarray(0, length).toString("utf8");
}

/** Packs untrusted dependencies within 49,152 bytes, using at most 16,384 for fair summaries when evidence exists; sources are never trimmed. */
export function researchHandoff(sources: CommittedHandoff[], initialGaps: StepGap[]): { inputs: StepInput[]; gaps: StepGap[] } {
  const inputs: StepInput[] = [], gaps = [...initialGaps];
  const gap = (stepId: string, reason: string) => {
    if (!gaps.some(item => item.stepId === stepId && item.reason === reason)) gaps.push({ stepId, reason });
  };
  const summaryBytes = sources.some(source => source.evidence.length) ? 16384 : 49152;
  const share = Math.floor((summaryBytes - 2) / Math.max(1, sources.length)) - 1;
  const lanes: { input: StepInput; cited: ReportEvidence[]; other: ReportEvidence[] }[] = [];
  for (const source of sources) {
    const input: StepInput = { ...source.input, text: "", evidence: [] }, bytes = Buffer.from(source.input.text);
    let low = 0, high = Math.min(8192, bytes.length);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      input.text = prefix(bytes, middle);
      if (Buffer.byteLength(JSON.stringify(input)) <= share) low = middle; else high = middle - 1;
    }
    input.text = prefix(bytes, low);
    if (!input.text || Buffer.byteLength(JSON.stringify(input)) > share) { gap(input.stepId, "handoff_result_omitted"); continue; }
    if (input.text !== source.input.text) gap(input.stepId, "handoff_result_excerpt");
    inputs.push(input);
    const order = new Map<string, number>();
    for (const item of source.cited) if (!order.has(key(item))) order.set(key(item), order.size);
    lanes.push({ input, cited: source.evidence.filter(item => order.has(key(item))).sort((a, b) => order.get(key(a))! - order.get(key(b))!),
      other: source.evidence.filter(item => !order.has(key(item))) });
  }
  for (const phase of ["cited", "other"] as const) {
    const rounds = Math.max(0, ...lanes.map(lane => lane[phase].length));
    for (let round = 0; round < rounds; round++) for (const lane of lanes) {
      const evidence = lane[phase][round]; if (!evidence) continue;
      lane.input.evidence.push(evidence);
      if (Buffer.byteLength(JSON.stringify(inputs)) > 49152) {
        lane.input.evidence.pop(); gap(lane.input.stepId, "handoff_evidence_omitted");
      }
    }
  }
  return { inputs, gaps };
}
