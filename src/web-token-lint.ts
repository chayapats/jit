/**
 * ui.token_lint/v1 — deterministic source scan for token literals (NFR-13).
 *
 * The only file allowed to hold literal values is `src/web-design.ts`.
 * This linter scans stylesheet source text (`src/web-style.ts`) and fails
 * on literal colours, font sizes, radii, durations, unguarded hover rules,
 * literal press scales and long transitions outside the allowlist.
 *
 * Value rules parse each `prop: value` declaration across lines up to its
 * terminating `;` or `}` and check every comma-separated item, reporting
 * the line where the declaration starts.
 */

/** Rule identifiers reported by {@link lintStyleSource}. */
export type TokenLintRule =
  | "color-literal"
  | "font-size-literal"
  | "radius-literal"
  | "duration-literal"
  | "hover-outside-media"
  | "press-scale-literal"
  | "long-transition";

/** One lint finding with its file, 1-based line, rule and offending text. */
export interface TokenLintViolation {
  file: string;
  line: number;
  rule: TokenLintRule;
  text: string;
}

/** ui.token_lint/v1: files whose text is CSS (or a TS template that renders CSS). */
export const tokenLintTargets: readonly string[] = Object.freeze(["src/web-style.ts", "src/web-attachments-style.ts", "src/s14/web-style.ts", "src/s14/web-style-memory.ts", "src/s14/web-style-team.ts", "src/s14/web-style-first-run.ts", "src/s14/web-style-sharing.ts", "src/s14/web-style-routines.ts", "src/s14/web-style-personal.ts"]);

/** Animations allowed to run longer than 300 ms, each with its reason. */
export const longMotionAllowlist: Readonly<Record<string, string>> = Object.freeze({
  "jit-breath": "S09 design: the จุดตั้งจิต (thinking dot) breathes on a 4.8 s cycle",
  "ceremony-halo": "S09 design: the ตั้งจิต (setup) ceremony, 1.6 s",
  "ceremony-dot": "S09 design: the ตั้งจิต (setup) ceremony, 1.6 s",
});

const colorLiteralPattern = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;
const fontSizePxPattern = /\d+(\.\d+)?px/;
const pressScalePattern = /scale\(\s*[0-9.]/;
const hoverMediaPattern = /\(hover:\s*hover\)/;
const pointerFinePattern = /\(pointer:\s*fine\)/;

/** Words in an `animation` shorthand that are never the keyframe name. */
const animationKeywords: ReadonlySet<string> = new Set([
  "ease", "ease-in", "ease-out", "ease-in-out", "linear", "step-start", "step-end",
  "infinite", "normal", "reverse", "alternate", "alternate-reverse",
  "none", "forwards", "backwards", "both", "running", "paused",
  "initial", "inherit", "unset",
]);

/** Replace every `${ … }` interpolation with spaces, preserving newlines. */
function stripInterpolations(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const start = source.indexOf("${", i);
    if (start === -1) {
      out += source.slice(i);
      break;
    }
    out += source.slice(i, start);
    let depth = 0;
    let j = start;
    for (; j < source.length; j++) {
      const ch = source[j];
      if (ch === "$" && source[j + 1] === "{") {
        depth++;
        j++;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      } else if (ch === "\n") {
        // keep scanning; newlines are preserved below
      }
    }
    const span = source.slice(start, Math.min(j, source.length));
    out += span.replace(/[^\n]/g, " ");
    i = j;
  }
  return out;
}

/** Replace every `/* … *\/` comment with spaces, preserving newlines. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
}

/** Split on a separator that sits at paren depth zero (commas inside `var()`/`rgba()` stay). */
function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * A `@media` prelude guards `:hover` only when one comma-separated query
 * joins `(hover: hover)` and `(pointer: fine)` with `and`. A comma list
 * such as `@media (hover: hover), (pointer: fine)` is an OR and guards nothing.
 */
function isHoverMediaPrelude(prelude: string): boolean {
  const atMedia = prelude.indexOf("@media");
  if (atMedia === -1) return false;
  const query = prelude.slice(atMedia + "@media".length);
  return splitTopLevel(query, ",").some(
    (part) => hoverMediaPattern.test(part) && pointerFinePattern.test(part),
  );
}

/** Long-motion (`--motion-breath`/`--motion-ceremony`) marker in an animation item. */
function usesLongMotion(value: string): boolean {
  return value.includes("var(--motion-breath)") || value.includes("var(--motion-ceremony)");
}

/**
 * Whether one comma-separated `animation` item names an allowlisted keyframe.
 * The keyframe name must match exactly: `jit-breath-extra` is not `jit-breath`,
 * and each item in a list needs its own allowlisted name.
 */
function animationItemAllowed(item: string): boolean {
  const tokens = item
    .split(/\s+/)
    .map((token) => token.replace(/^[(),]+|[(),]+$/g, "").trim())
    .filter(Boolean);
  return tokens.some((token) => {
    if (!/^[A-Za-z][\w-]*$/.test(token)) return false;
    if (animationKeywords.has(token.toLowerCase())) return false;
    return Object.hasOwn(longMotionAllowlist, token);
  });
}

interface Declaration {
  prop: string;
  value: string;
  startLine: number;
  text: string;
}

/**
 * Scan stylesheet source text for token literals.
 *
 * Each returned violation carries the file name, the 1-based line where its
 * declaration starts, the rule and the offending source line text. Text inside
 * `/* … *\/` comments and inside `${ … }` interpolations is ignored.
 */
export function lintStyleSource(source: string, file: string): TokenLintViolation[] {
  const cleaned = stripInterpolations(stripComments(source));
  const sourceLines = source.split("\n");
  const violations: TokenLintViolation[] = [];

  // Map a cleaned-source offset to its 1-based line number.
  const lineStarts: number[] = [0];
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "\n") lineStarts.push(i + 1);
  }
  const lineOf = (offset: number): number => {
    let line = 1;
    for (let i = 1; i < lineStarts.length; i++) {
      if (lineStarts[i]! <= offset) line = i + 1;
      else break;
    }
    return line;
  };
  const textOf = (line: number): string => (sourceLines[line - 1] ?? "").trim();

  // Every `prop: value` declaration, including ones split across lines.
  const declarations: Declaration[] = [];
  const declarationPattern = /([\-\w]+)\s*:([^;{}]*)([;}])/g;
  for (const match of cleaned.matchAll(declarationPattern)) {
    const startLine = lineOf(match.index ?? 0);
    declarations.push({
      prop: (match[1] ?? "").trim(),
      value: (match[2] ?? "").trim(),
      startLine,
      text: textOf(startLine),
    });
  }

  for (const declaration of declarations) {
    const prop = declaration.prop.toLowerCase();
    const push = (rule: TokenLintRule) => {
      violations.push({ file, line: declaration.startLine, rule, text: declaration.text });
    };

    if (colorLiteralPattern.test(declaration.value)) {
      push("color-literal");
    }

    if (prop === "font-size") {
      for (const item of splitTopLevel(declaration.value, ",")) {
        const firstToken = item.trim().split(/\s+/)[0] ?? "";
        if (firstToken === "") continue;
        if (!(firstToken === "0" || firstToken === "inherit" || firstToken.startsWith("var("))) {
          push("font-size-literal");
          break;
        }
      }
    } else if (prop === "font") {
      for (const item of splitTopLevel(declaration.value, ",")) {
        if (fontSizePxPattern.test(item)) {
          push("font-size-literal");
          break;
        }
      }
    }

    if (/^border(?:-[a-z]+)*-radius$/.test(prop)) {
      for (const item of splitTopLevel(declaration.value, ",")) {
        const tokens = item
          .split(/\s+/)
          .map((t) => t.replace(/[,;]+$/, "").trim())
          .filter(Boolean);
        const bad = tokens.some(
          (token) =>
            token !== "0" &&
            token !== "50%" &&
            token !== "inherit" &&
            !token.startsWith("var(--radius-"),
        );
        if (bad) {
          push("radius-literal");
          break;
        }
      }
    }

    if (
      prop === "transition" ||
      prop === "transition-duration" ||
      prop === "transition-delay" ||
      prop === "animation" ||
      prop === "animation-duration" ||
      prop === "animation-delay"
    ) {
      for (const item of splitTopLevel(declaration.value, ",")) {
        let bad = false;
        for (const duration of item.matchAll(/\d+(\.\d+)?m?s\b/g)) {
          const token = duration[0];
          if (token !== "0s" && token !== "0ms") {
            bad = true;
            break;
          }
        }
        if (bad) {
          push("duration-literal");
          break;
        }
      }
    }

    // Transitions may only use --motion-ui or --motion-panel.
    if (prop === "transition" || prop === "transition-duration" || prop === "transition-delay") {
      if (usesLongMotion(declaration.value)) {
        push("long-transition");
      }
    } else if (prop === "animation") {
      if (usesLongMotion(declaration.value)) {
        const allowed = splitTopLevel(declaration.value, ",")
          .filter((item) => usesLongMotion(item))
          .every((item) => animationItemAllowed(item));
        if (!allowed) {
          push("long-transition");
        }
      }
    } else if (prop === "animation-duration" || prop === "animation-delay") {
      if (usesLongMotion(declaration.value)) {
        push("long-transition");
      }
    }

    if (pressScalePattern.test(declaration.value)) {
      push("press-scale-literal");
    }
  }

  // --- hover-outside-media via brace stack (preludes may span lines) ---
  const lines = cleaned.split("\n");
  const stack: string[] = [];
  let preludeBuffer = "";
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex]!;
    const lineNumber = lineIndex + 1;
    let segmentStart = 0;
    const flushSegment = (end: number, isOpen: boolean) => {
      const segment = rawLine.slice(segmentStart, end);
      preludeBuffer += segment;
      if (isOpen) {
        const prelude = preludeBuffer;
        preludeBuffer = "";
        if (prelude.includes(":hover")) {
          const protectedByHoverMedia = stack.some(isHoverMediaPrelude);
          if (!protectedByHoverMedia) {
            violations.push({ file, line: lineNumber, rule: "hover-outside-media", text: textOf(lineNumber) });
          }
        }
        stack.push(prelude);
      }
      segmentStart = end + 1;
    };
    for (let ci = 0; ci < rawLine.length; ci++) {
      const ch = rawLine[ci];
      if (ch === "{") {
        flushSegment(ci, true);
      } else if (ch === "}") {
        preludeBuffer = "";
        stack.pop();
        segmentStart = ci + 1;
      } else if (ch === ";") {
        preludeBuffer = "";
        segmentStart = ci + 1;
      }
    }
    preludeBuffer += rawLine.slice(segmentStart);
  }

  // Declarations parse in document order and hover findings append after;
  // a stable sort by line restores source order for the report.
  violations.sort((a, b) => a.line - b.line);
  return violations;
}
