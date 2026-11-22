import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/s16/web/Markdown";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

test("replies render a bounded Markdown subset as elements and never as supplied HTML", () => {
  const out = html("# Plan\n\n1. First **bold** step\n2. Second `code` step\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst a = 1 < 2;\n```\n\n<img src=x onerror=alert(1)> ![cat](https://example.test/cat.png)");
  expect(out).toContain("<h3>Plan</h3>"); expect(out).toContain("<ol><li>First <strong>bold</strong> step</li>"); expect(out).toContain("<code>code</code>");
  expect(out).toContain('<th scope="col">A</th>'); expect(out).toContain('data-language="ts"'); expect(out).toContain("const a = 1 &lt; 2;");
  // Supplied markup stays text, and an image reference never becomes an element that loads.
  expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;"); expect(out).not.toContain("<img");
});

test("a link names its real host unless the visible text is an address on that host", () => {
  const disguised = html("[https://bank.example/evil.test](https://evil.test/login)");
  expect(disguised).toContain('href="https://evil.test/login"'); expect(disguised).toContain('<span class="md-host"> (evil.test)</span>');
  expect(html("[Open the report](https://docs.example/report)")).toContain('<span class="md-host"> (docs.example)</span>');
  expect(html("[evil.test docs](https://evil.test/a)")).toContain('<span class="md-host"> (evil.test)</span>');
  for (const same of ["[https://docs.example/report](https://docs.example/report)", "[docs.example](https://docs.example/report)", "[docs.example/other](https://docs.example/report)"]) expect(html(same)).not.toContain("md-host");
  const link = html("[x](https://docs.example/a)"); expect(link).toContain('target="_blank"'); expect(link).toContain('rel="noopener noreferrer nofollow"');
  // Only http(s) destinations become links.
  expect(html("[x](javascript:alert(1))")).not.toContain("<a "); expect(html("[x](data:text/html,hi)")).not.toContain("<a ");
});

test("nesting is budgeted so a hostile reply cannot exhaust the stack", () => {
  const quoted = html(">".repeat(15000) + " deep"); expect((quoted.match(/<blockquote>/g) ?? []).length).toBeLessThanOrEqual(7); expect(quoted).toContain("deep");
  const items = Array.from({ length: 300 }, (_, index) => " ".repeat(index) + "- item " + index).join("\n"), listed = html(items);
  expect((listed.match(/<ul>/g) ?? []).length).toBeLessThanOrEqual(7); expect(listed).toContain("item 299");
  const emphasis = html("**a ~~b *c **d ~~e *f **g ~~h *i* h~~ g** f* e~~ d** c* b~~ a**"); expect(emphasis).toContain("i");
  // A full-size reply of unmatched markers still renders.
  expect(html("**".repeat(16000)).length).toBeGreaterThan(0); expect(html("[".repeat(32000)).length).toBeGreaterThan(0);
});
