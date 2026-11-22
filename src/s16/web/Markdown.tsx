import type { ReactNode } from "react";

/**
 * Bounded Markdown for Bot replies. It builds React elements only: no HTML is parsed or injected, images never
 * load, and a link opens only `http(s)` in a new tab. Its real host is shown beside the link text unless that
 * text is itself an address on the same host, so model output cannot disguise a destination. Nesting is
 * budgeted: deeper quotes, lists and emphasis stay visible as plain text instead of recursing. Unsupported
 * syntax stays visible as written.
 */
const maxDepth = 6;
const linkProps = { target: "_blank", rel: "noopener noreferrer nofollow" } as const;
const host = (url: string) => { try { return new URL(url).host; } catch { return ""; } };
/** True only when the visible label is an address whose host is the destination's host. */
const namesHost = (label: string, url: string) => { const target = host(url), text = label.trim(); return !!target && !/\s/.test(text) && (host(text) === target || host("https://" + text) === target); };

type Rule = [pattern: RegExp, render: (match: RegExpExecArray, key: string, depth: number) => ReactNode];
const rules: Rule[] = [
  [/`([^`\n]+)`/, (m, key) => <code key={key}>{m[1]}</code>],
  [/\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]{1,2000})\)/, (m, key, depth) => <span key={key}><a href={m[2]} title={m[2]} {...linkProps}>{inline(m[1]!, key, depth + 1)}</a>{host(m[2]!) && !namesHost(m[1]!, m[2]!) ? <span className="md-host"> ({host(m[2]!)})</span> : null}</span>],
  [/https?:\/\/[^\s<>()]{1,2000}[^\s<>().,;:!?'"]/, (m, key) => <a key={key} href={m[0]} {...linkProps}>{m[0]}</a>],
  [/\*\*([^\n]+?)\*\*/, (m, key, depth) => <strong key={key}>{inline(m[1]!, key, depth + 1)}</strong>],
  [/~~([^\n]+?)~~/, (m, key, depth) => <del key={key}>{inline(m[1]!, key, depth + 1)}</del>],
  [/\*([^\s*][^*\n]*?)\*/, (m, key, depth) => <em key={key}>{inline(m[1]!, key, depth + 1)}</em>],
];

/** Inline spans: the earliest matching rule wins, and its text is parsed again for nested emphasis. */
function inline(text: string, key: string, depth = 0): ReactNode[] {
  if (depth > maxDepth) return [text];
  const out: ReactNode[] = []; let rest = text, index = 0;
  while (rest) {
    let best: { match: RegExpExecArray; rule: Rule } | null = null;
    for (const rule of rules) { const match = rule[0].exec(rest); if (match && (!best || match.index < best.match.index)) best = { match, rule }; }
    if (!best) { out.push(rest); break; }
    if (best.match.index) out.push(rest.slice(0, best.match.index));
    out.push(best.rule[1](best.match, `${key}.${index++}`, depth)); rest = rest.slice(best.match.index + best.match[0].length);
  }
  return out;
}
/** A paragraph keeps its single line breaks, as the plain-text transcript did. */
const lines = (text: string, key: string) => text.split("\n").flatMap((line, index) => index ? [<br key={`${key}.br${index}`} />, ...inline(line, `${key}.${index}`)] : inline(line, `${key}.0`));

const fence = /^\s{0,3}(```|~~~)\s*([A-Za-z0-9_+.#-]{0,32})\s*$/, heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/, rule = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const item = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/, quote = /^\s{0,3}>\s?(.*)$/, divider = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());

type Item = { indent: number; ordered: boolean; text: string };
function list(items: Item[], key: string, depth = 0): ReactNode {
  const base = items[0]!.indent, ordered = items[0]!.ordered, children: ReactNode[] = [];
  for (let index = 0; index < items.length;) {
    const current = items[index]!; let end = index + 1;
    // Past the budget deeper items join this level instead of opening another list.
    while (depth < maxDepth && end < items.length && items[end]!.indent > base) end++;
    children.push(<li key={`${key}.${index}`}>{lines(current.text, `${key}.${index}`)}{end > index + 1 ? list(items.slice(index + 1, end), `${key}.${index}n`, depth + 1) : null}</li>);
    index = end;
  }
  return ordered ? <ol key={key}>{children}</ol> : <ul key={key}>{children}</ul>;
}

function blocks(text: string, depth = 0): ReactNode[] {
  const source = text.replace(/\r\n?/g, "\n").split("\n"), out: ReactNode[] = [];
  for (let index = 0; index < source.length;) {
    const line = source[index]!, key = `b${index}`, opened = fence.exec(line);
    if (!line.trim()) { index++; continue; }
    if (opened) {
      const body: string[] = []; index++;
      while (index < source.length && !(source[index]!.trim() === opened[1])) body.push(source[index++]!);
      index++; out.push(<pre key={key} className="md-code" data-language={opened[2] || undefined}><code>{body.join("\n")}</code></pre>); continue;
    }
    const title = heading.exec(line);
    if (title) { const level = Math.min(title[1]!.length, 4); const Tag = (["h3", "h4", "h5", "h6"] as const)[level - 1]!; out.push(<Tag key={key}>{inline(title[2]!, key)}</Tag>); index++; continue; }
    if (rule.test(line)) { out.push(<hr key={key} />); index++; continue; }
    if (quote.test(line)) {
      const body: string[] = [];
      while (index < source.length && quote.test(source[index]!)) body.push(quote.exec(source[index++]!)![1]!);
      out.push(<blockquote key={key}>{depth < maxDepth ? blocks(body.join("\n"), depth + 1) : <p>{body.join("\n")}</p>}</blockquote>); continue;
    }
    if (item.test(line)) {
      const items: Item[] = [];
      while (index < source.length) {
        const match = item.exec(source[index]!);
        if (match) items.push({ indent: match[1]!.length, ordered: /\d/.test(match[2]!), text: match[3]! });
        else if (source[index]!.trim() && /^\s{2,}/.test(source[index]!) && items.length) items[items.length - 1]!.text += "\n" + source[index]!.trim();
        else break;
        index++;
      }
      out.push(list(items, key)); continue;
    }
    if (line.includes("|") && index + 1 < source.length && divider.test(source[index + 1]!) && cells(line).length === cells(source[index + 1]!).length) {
      const head = cells(line), rows: string[][] = []; index += 2;
      while (index < source.length && source[index]!.includes("|") && source[index]!.trim()) rows.push(cells(source[index++]!));
      out.push(<div key={key} className="md-table"><table><thead><tr>{head.map((cell, column) => <th key={column} scope="col">{inline(cell, `${key}.h${column}`)}</th>)}</tr></thead><tbody>{rows.map((row, r) => <tr key={r}>{head.map((_, column) => <td key={column}>{inline(row[column] ?? "", `${key}.${r}.${column}`)}</td>)}</tr>)}</tbody></table></div>); continue;
    }
    const body: string[] = [];
    while (index < source.length && source[index]!.trim() && !fence.test(source[index]!) && !heading.test(source[index]!) && !rule.test(source[index]!) && !quote.test(source[index]!) && !(body.length && item.test(source[index]!))) body.push(source[index++]!);
    out.push(<p key={key}>{lines(body.join("\n"), key)}</p>);
  }
  return out;
}

/** Renders one committed Bot reply. The same text always produces the same elements. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={className ? `md ${className}` : "md"}>{blocks(text)}</div>;
}
