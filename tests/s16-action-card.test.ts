import { expect, test } from "bun:test";
import type { ActionSlip } from "../src/s15/policy";
import { cardFacts } from "../src/s16/web/ActionCard";

// AUTH16-01: the inline card shows every owner-relevant field, or opens the complete exact payload.
const ref = (id: string) => ({ id, revision: 1, generation: 1 });
const slip = (classes: string[], payload: unknown, extra: Record<string, unknown> = {}): ActionSlip => ({
  contract: "s15-action-slip/v1", payloadBytesBase64: Buffer.from(JSON.stringify(payload)).toString("base64"), state: "pending", expiresAt: 1, reasonCode: "approval_required", canApprove: true, replacement: null, observation: null, recurring: [], statements: [],
  action: { id: "a", revision: 1, actionHash: "h".repeat(64), operation: "op", classes, resources: [], recipients: [ref("google_service")], payload: payload as never, fences: [], upperBound: null, expiresAt: 1, transaction: null, github: null, impact: "reversible", ...extra } as never,
});
const rows = (s: ActionSlip) => Object.fromEntries(cardFacts(s).rows);

test("calendar invites show title, time, place, attendees and description", () => {
  const facts = cardFacts(slip(["ordinary_edit", "communication"], { contract: "s15-google-effect/v1", kind: "calendar", calendar: { event: { summary: "Planning", description: "Agenda", location: "Room 2", start: "2026-11-07T10:00:00+07:00", end: "2026-11-07T11:00:00+07:00", attendees: ["alice@example.test"] } } }));
  expect(facts.kind).toBe("calendar"); expect(facts.subject).toBe("Planning"); expect(facts.body).toBe("Agenda"); expect(facts.known).toBe(true);
  expect(Object.fromEntries(facts.rows)).toEqual({ when: "2026-11-07T10:00:00+07:00 – 2026-11-07T11:00:00+07:00", where: "Room 2", attendees: "alice@example.test" });
});
test("email attachments, payment account and GitHub pull/thread are shown", () => {
  expect(rows(slip(["communication"], { contract: "s15-google-effect/v1", kind: "mail", message: { to: ["a@example.test"], cc: [], bcc: [], subject: "s", body: "b" }, attachments: [{ name: "q.pdf", mediaType: "application/pdf", dataBase64: "AAA=" }] })).attachments).toBe("q.pdf (application/pdf, 2 bytes)");
  const pay = rows(slip(["financial"], { contract: "fixture" }, { transaction: { payee: ref("payee"), account: ref("card"), currency: "USD", minorUnit: 2, amountMinor: "500", quoteId: "q1", quoteVersion: "v1", quoteExpiresAt: 1 } }));
  expect(pay).toMatchObject({ payee: "payee", account: "card", quote: "q1 · v1" });
  const gh = rows(slip(["github_publish", "communication"], { contract: "s15-github-effect/v1", repository: "o/r", issue: 442, branch: "jit/442", head: "a".repeat(40), operation: { kind: "review_reply", pull: 445, thread: "t1", body: "Fixed" } }, { github: { repository: ref("repo"), target: "main" } }));
  expect(gh).toMatchObject({ issue: "#442", pull: "#445", branch: "jit/442", head: "aaaaaaaaaaaa", thread: "t1" });
});
test("an action shape without its own rows opens the complete exact payload", () => {
  const facts = cardFacts(slip(["major_change"], { contract: "fixture", delete: ["x", "y"] }, { impact: "major" }));
  expect(facts.kind).toBe("decision"); expect(facts.known).toBe(false); expect(facts.payloadText).toContain('"delete"');
});
