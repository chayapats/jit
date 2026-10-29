import { expect, test } from "bun:test";
import { parseReply, ReplyProseBuffer, replyFormatInstruction } from "../src/team/reply-format";

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
    ['```json\nnot JSON\n```', { state: "complete", text: '```json\nnot JSON\n```', structured: false }],
    ["\ud800", { state: "failed", reason: "malformed" }],
    ["ตอบ" + tail({ version: 3, proposals: [] }), { state: "complete", text: "ตอบ", discarded: ["field:proposals"] }],
    ["ตอบ" + tail({ version: 2, proposals: "SECRET" }), { state: "complete", text: "ตอบ", discarded: ["field:proposals"] }],
    ["ตอบ\n```jit-proposals\n{truncated SECRET", { state: "complete", text: "ตอบ", discarded: ["field:proposals"] }],
    ["ตอบ\n```jit-proposals", { state: "complete", text: "ตอบ", discarded: ["field:proposals"] }],
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
  for (const output of ["ตอบครับ 😀" + tail({ version: 2, proposals: [{ kind: "role", name: "SECRET" }] }), "ตอบครับ 😀\n```jit-proposals\nSECRET truncated"]) {
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

test("only an exact unindented jit-proposals line is metadata; ordinary code stays verbatim", () => {
  const examples = [
    "```ts\nconst x = 1;\n```",
    "```\nconst x = 1;\n```",
    '```json\n{"proposals":[]}\n```',
    '```json\n{"reply":42}\n```',
    '```json\n["an array"]\n```',
    "before\n```js\nconst x = 1;\n```\nafter",
    "before\n```\ncode\n```\nafter",
    "before\n~~~ts\nconst x = 1;\n~~~\nafter",
    "before\n  ```jit-proposals\nindented code\n  ```\nafter",
    "  ```jit-proposals\nindented at start\n  ```",
    '  ```json\n{"reply":"indented code","proposals":[]}\n  ```',
    "before ```jit-proposals inline\nafter",
    "before\n```jit-proposalsX\nlookalike\n```\nafter",
    "before\n````jit-proposals\nlonger fence\n````\nafter",
    "before\n```jit-proposals \ninfo string has a space\n```\nafter",
  ];
  for (const output of examples) expect(parseReply(output, 4096), output)
    .toEqual({ state: "complete", text: output.trim(), structured: false, discarded: [], discardedTotal: 0 });
  const prose = examples.slice(0, 7).join("\n\n");
  expect(parseReply(prose + tail({ version: 2, proposals: [] }) + " \n\t", 4096))
    .toMatchObject({ text: prose, structured: true, discarded: [] });
  expect(parseReply(prose + tail({ version: 2, proposals: [] }).replaceAll("\n", "\r\n"), 4096))
    .toMatchObject({ text: prose, discarded: [] });
  for (const suffix of ["\n```ts\ncode after trailer\n```", "\nmore prose"]) {
    expect(parseReply(prose + tail({ version: 2, proposals: [] }) + suffix, 4096))
      .toMatchObject({ text: prose, discarded: ["field:proposals"] });
  }
  expect(replyFormatInstruction).toContain("Normal Markdown code fences are fine");
  expect(replyFormatInstruction).not.toContain("use ~~~");
});

test("normal fences are released as soon as they diverge; only the ambiguous line suffix waits", () => {
  const buffer = new ReplyProseBuffer(4096);
  expect(buffer.append("before\n`")).toBe("before");
  expect(buffer.append("``jit-proposals")).toBe("before");
  expect(buffer.append("X")).toBe("before\n```jit-proposalsX");
  expect(buffer.append("\nbody\n```")).toBe("before\n```jit-proposalsX\nbody");
  expect(buffer.append("\nafter")).toBe("before\n```jit-proposalsX\nbody\n```\nafter");
  for (const line of ["```js", "```json", "```ts", "````", "  ```jit-proposals", "```jit-proposals "]) {
    const b = new ReplyProseBuffer(4096);
    expect(b.append(`before\n${line}`)).toBe(`before\n${line}`.trim());
  }
  const plain = new ReplyProseBuffer(4096);
  expect(plain.append("```ts")).toBe("```ts");
  expect(plain.append("\ncode\n```\nafter")).toBe("```ts\ncode\n```\nafter");
  const ended = new ReplyProseBuffer(4096);
  expect(ended.append("before\n```jit-proposal")).toBe("before");
  expect(ended.append("\ncode")).toBe("before\n```jit-proposal\ncode");
  const indented = new ReplyProseBuffer(4096);
  expect(indented.append('  ```json\n{"reply":"code"}')).toBe('```json\n{"reply":"code"}');
});

test("every byte split preserves code and never exposes any part of a valid or discarded trailer", () => {
  const prose = '```ts\nconst x = 1;\n```\nafter code\n```json\n{"example":true}\n```\nfinished';
  const trailer = tail({ version: 2, proposals: ["SECRET"] });
  for (const suffix of [trailer, trailer + "\nmore prose", trailer + "\n```js\nmore code\n```", "\n```jit-proposals\nSECRET truncated"]) {
    const output = prose + suffix;
    // ASCII fixture: JS indices cover every UTF-8 byte offset, including CRLF delimiters.
    for (const input of [output, output.replaceAll("\n", "\r\n")]) {
      for (let split = 0; split <= input.length; split++) {
        const buffer = new ReplyProseBuffer(4096);
        for (const chunk of [input.slice(0, split), input.slice(split)]) {
          const shown = buffer.append(chunk);
          expect(prose.replaceAll("\n", input.includes("\r\n") ? "\r\n" : "\n").startsWith(shown)).toBe(true);
          expect(shown).not.toMatch(/jit-proposals|SECRET|more prose|more code/);
        }
      }
      const buffer = new ReplyProseBuffer(4096);
      for (const chunk of input) expect(buffer.append(chunk)).not.toMatch(/jit-proposals|SECRET|more prose|more code/);
      expect(buffer.append("")).toBe(input.slice(0, input.indexOf("\n```jit-proposals")).trim());
    }
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
