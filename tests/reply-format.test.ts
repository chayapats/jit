import { expect, test } from "bun:test";
import { parseReply, ReplyProseBuffer } from "../src/team/reply-format";

const tail = (value: unknown) => `\n\`\`\`jit-proposals\n${JSON.stringify(value)}\n\`\`\``;

test("v2 parser matrix: prose, legacy JSON, valid metadata and safe discard evidence", () => {
  const cases: [string, object][] = [
    ["  ตอบครับ 🧪\nหลายบรรทัด  ", { state: "complete", text: "ตอบครับ 🧪\nหลายบรรทัด", structured: false }],
    ["~~~ts\nconst x = 1;\n~~~", { state: "complete", text: "~~~ts\nconst x = 1;\n~~~" }],
    ['{"reply":"เดิม","proposals":[{"kind":"task"}]}', { state: "complete", text: "เดิม", discarded: ["proposal:task"] }],
    ['```json\n{"reply":"เดิม"}\n```', { state: "complete", text: "เดิม", structured: true }],
    ["ตอบ" + tail({ version: 2, proposals: [] }), { state: "complete", text: "ตอบ", structured: true, discarded: [] }],
    ["ตอบ" + tail({ version: 2, proposals: [{ kind: "future" }, { kind: "<script>" }, null], future: true, "bad key": "SECRET" }),
      { state: "complete", text: "ตอบ", discarded: ["proposal:future", "proposal:invalid", "proposal:invalid", "field:future", "field:invalid"], discardedTotal: 5 }],
    ["", { state: "failed", reason: "empty" }],
    ["   ", { state: "failed", reason: "empty" }],
    ["{bad", { state: "failed", reason: "malformed" }],
    ["[]", { state: "failed", reason: "malformed" }],
    ['{"reply":false}', { state: "failed", reason: "malformed" }],
    ['```json\nnot JSON\n```', { state: "failed", reason: "malformed" }],
    ["\ud800", { state: "failed", reason: "malformed" }],
    ["ตอบ" + tail({ version: 3, proposals: [] }), { state: "complete", text: "ตอบ", discarded: ["field:proposals"] }],
    ["ตอบ" + tail({ version: 2, proposals: "SECRET" }), { state: "complete", text: "ตอบ", discarded: ["field:proposals"] }],
    ["ตอบ\n```jit-proposals\n{truncated SECRET", { state: "complete", text: "ตอบ", discarded: ["field:proposals"] }],
    ["ตอบ\n```json\n{\"proposals\":[]}\n```", { state: "complete", text: "ตอบ", discarded: ["field:proposals"] }],
    ["ตอบ\n  ```jit-proposals\n{\"version\":2,\"proposals\":[]}\n```", { state: "complete", text: "ตอบ", discarded: ["field:proposals"] }],
    ["ตอบ" + tail({ version: 2, proposals: [] }) + "\nextra", { state: "complete", text: "ตอบ", discarded: ["field:proposals"] }],
    ["ตอบ" + tail({ version: 2, proposals: [] }) + tail({ version: 2, proposals: [] }), { state: "complete", text: "ตอบ", discarded: ["field:proposals"] }],
    ["```jit-proposals\n{}\n```", { state: "failed", reason: "empty" }],
  ];
  for (const [output, expected] of cases) expect(parseReply(output, 4096), JSON.stringify(output)).toMatchObject(expected);
  expect(parseReply("😀", 3)).toEqual({ state: "failed", reason: "malformed" });
  expect(parseReply("ok" + tail({ version: 2, proposals: Array.from({ length: 12 }, () => ({ kind: "unknown" })) }), 4096))
    .toMatchObject({ discarded: Array(8).fill("proposal:unknown"), discardedTotal: 12 });
});

test("v2 uses the existing registered proposal handlers; invalid trailers never call a handler", () => {
  const accepted: unknown[] = [];
  const handlers = { role: (item: unknown) => { accepted.push(item); return true; }, dispatch: () => false };
  const role = { kind: "role", name: "designer" };
  expect(parseReply("ok" + tail({ version: 2, proposals: [role, { kind: "dispatch" }], reply: "SECRET" }), 4096, handlers))
    .toMatchObject({ text: "ok", discarded: ["proposal:dispatch", "field:reply"] });
  expect(accepted).toEqual([role]);
  parseReply("ok" + tail({ version: 1, proposals: [role] }), 4096, handlers);
  expect(accepted).toHaveLength(1);
});

test("every split and one-code-unit chunks hide the whole fence and metadata, including malformed trailers", () => {
  for (const output of ["ตอบครับ 😀" + tail({ version: 2, proposals: [{ kind: "role", name: "SECRET" }] }), "ตอบครับ 😀\n```jit-proposals\nSECRET truncated", "ตอบครับ 😀\n \t```jit-proposals\nSECRET truncated"]) {
    for (let split = 0; split <= output.length; split++) {
      const buffer = new ReplyProseBuffer(4096);
      for (const chunk of [output.slice(0, split), output.slice(split)]) {
        const shown = buffer.append(chunk);
        expect(shown).not.toMatch(/[`{}]|SECRET|proposals|\uFFFD/);
        expect("ตอบครับ 😀".startsWith(shown)).toBe(true);
      }
    }
    const buffer = new ReplyProseBuffer(4096);
    for (const chunk of output.split("")) expect(buffer.append(chunk)).not.toMatch(/[`{}]|SECRET|proposals|\uFFFD/);
  }
});

test("legacy JSON is withheld in full; UTF-8 overflow clears and permanently bounds the preview", () => {
  for (const output of ['  {"reply":"ok","proposals":["SECRET"]}', '```json\n{"reply":"ok"}\n```', '["SECRET"]']) {
    const buffer = new ReplyProseBuffer(4096);
    for (const chunk of output) expect(buffer.append(chunk)).toBe("");
  }
  const buffer = new ReplyProseBuffer(4);
  expect(buffer.append("ก")).toBe("ก");
  expect(buffer.append("ข")).toBe("");
  expect(buffer.append("x".repeat(100_000))).toBe("");
  expect(buffer.append("ok")).toBe("");
  const pair = new ReplyProseBuffer(4);
  expect(pair.append("\ud83d")).toBe("");
  expect(pair.append("\ude00")).toBe("😀");
  const inline = new ReplyProseBuffer(128);
  expect(inline.append("\n`code` is prose")).toBe("`code` is prose");
});
