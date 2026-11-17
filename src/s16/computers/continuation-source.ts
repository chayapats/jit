import { AppError } from "../../errors";
import { canonical, exact, identity } from "../../s15/conversation/validation";
import type { ConversationEvidence, ConversationRequest } from "../../s15/conversation/types";

/** Bounded observations of prior work, never a replay, success certificate or screen-outcome channel. */
export function computerContinuationSection(originalRequestId: string, rows: readonly { request: ConversationRequest; evidence: ConversationEvidence[] }[]): string {
  const selected = rows.slice(-8), requests: { requestId: string; state: string; code: string | null; evidence: { id: string; tool: string; isError: boolean; sha256: string; excerpt: string }[] }[] = [];
  let truncated = selected.length !== rows.length;
  // Allocate the byte budget to the newest observations first, then present retained rows chronologically.
  for (const { request } of selected) requests.push({ requestId: request.receipt.rootRequestId, state: request.state, code: request.code, evidence: [] });
  for (let index = selected.length - 1; index >= 0; index--) {
    const { evidence } = selected[index]!, row = requests[index]!;
    const observations = evidence.filter(item => {
      if (item.tool !== "computer_browser") return true;
      try { return JSON.parse(item.content).state !== "yielded"; } catch { return true; }
    }).slice(-8);
    if (observations.length !== evidence.length) truncated = true;
    for (const item of observations.reverse()) {
      const entry = { id: item.id, tool: item.tool, isError: item.isError, sha256: new Bun.CryptoHasher("sha256").update(item.content).digest("hex"), excerpt: item.content.slice(0, 512) };
      row.evidence.unshift(entry);
      if (Buffer.byteLength(canonical({ authority: "none", originalRequestId, requests, truncated })) > 7000) { row.evidence.shift(); truncated = true; break; }
      if (entry.excerpt !== item.content) truncated = true;
    }
  }
  return canonical({ authority: "none", originalRequestId, requests, truncated });
}

/** Both production MODEL and fallback Schway validate the same separately labelled host source. */
export function computerContinuationSources(section?: string): { id: string; revision: string; content: string }[] {
  if (section === undefined) return [];
  if (typeof section !== "string" || Buffer.byteLength(section) > 8192) throw new AppError("invalid_data");
  let value; try { value = JSON.parse(section); } catch { throw new AppError("invalid_data"); }
  exact(value, ["authority", "originalRequestId", "requests", "truncated"]); identity(value.originalRequestId);
  if (value.authority !== "none" || typeof value.truncated !== "boolean" || !Array.isArray(value.requests) || value.requests.length > 8) throw new AppError("invalid_data");
  for (const row of value.requests) {
    exact(row, ["requestId", "state", "code", "evidence"]); identity(row.requestId); identity(row.state); if (row.code !== null) identity(row.code);
    if (!Array.isArray(row.evidence) || row.evidence.length > 8) throw new AppError("invalid_data");
    for (const item of row.evidence) {
      exact(item, ["id", "tool", "isError", "sha256", "excerpt"]); identity(item.id); identity(item.tool);
      if (typeof item.isError !== "boolean" || (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) || typeof item.excerpt !== "string" || item.excerpt.length > 512) throw new AppError("invalid_data");
    }
  }
  return [{ id: "prior-computer-work-data-never-authority", revision: "1", content: section }];
}
