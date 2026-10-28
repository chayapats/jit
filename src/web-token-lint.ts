/**
 * ui.token_lint/v1 — deterministic source scan for token literals (NFR-13).
 *
 * The only file allowed to hold literal values is `src/web-design.ts`.
 * This linter scans stylesheet source text (`src/web-style.ts`) and fails
 * on literal colours, font sizes, radii, durations, unguarded hover rules,
 * literal press scales and long transitions outside the allowlist.
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
export const tokenLintTargets: readonly string[] = Object.freeze(["src/web-style.ts"]);

/** Animations allowed to run longer than 300 ms, each with its reason. */
export const longMotionAllowlist: Readonly<Record<string, string>> = Object.freeze({
  "jit-breath": "S09 design: the จุดตั้งจิต (thinking dot) breathes on a 4.8 s cycle",
  "ceremony-halo": "S09 design: the ตั้งจิต (setup) ceremony, 1.6 s",
  "ceremony-dot": "S09 design: the ตั้งจิต (setup) ceremony, 1.6 s",
});

const colorLiteralPattern = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;
const fontSizePxPattern = /\d+(\.\d+)?px/;
const durationPattern = /\d+(\.\d+)?m?s\b/;
const pressScalePattern = /scale\(\s*[0-9.]/;
const hoverMediaPattern = /\(hover:\s*hover\)/;
const pointerFinePattern = /\(pointer:\s*fine\)/;

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

/** Value after the first `:` in a declaration, up to `;` or `}`. */
function declarationValue(line: string, property: string): string | null {
  const index = line.indexOf(property);
  if (index === -1) return null;
  let value = line.slice(index + property.length).trim();
  if (!value.startsWith(":")) return null;
  value = value.slice(1).trim();
  const end = value.search(/[;}]/);
  if (end !== -1) value = value.slice(0, end);
  return value.trim();
}

function isHoverMediaPrelude(prelude: string): boolean {
  return (
    prelude.includes("@media") &&
    hoverMediaPattern.test(prelude) &&
    pointerFinePattern.test(prelude)
  );
}

/**
 * Scan stylesheet source text for token literals.
 *
 * Each returned violation carries the file name, 1-based line number, rule
 * and the offending line text. Text inside `/* … *\/` comments and inside
 * `${ … }` interpolations is ignored.
 */
export function lintStyleSource(source: string, file: string): TokenLintViolation[] {
  const cleaned = stripInterpolations(stripComments(source));
  const lines = cleaned.split("\n");
  const violations: TokenLintViolation[] = [];

  // Brace stack of block preludes for hover-outside-media tracking.
  const stack: string[] = [];
  let preludeBuffer = "";

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex]!;
    const lineNumber = lineIndex + 1;
    const text = (source.split("\n")[lineNumber - 1] ?? "").trim();

    // --- per-line rules (on the cleaned line) ---

    if (colorLiteralPattern.test(rawLine)) {
      violations.push({ file, line: lineNumber, rule: "color-literal", text });
    }

    // font-size-literal: font-size: whose value is not 0/inherit/var(; font: shorthand with px.
    const fontSizeValue = declarationValue(rawLine, "font-size");
    if (fontSizeValue !== null) {
      const firstToken = fontSizeValue.split(/[\s,;]+/)[0] ?? "";
      if (!(firstToken === "0" || firstToken === "inherit" || firstToken.startsWith("var("))) {
        violations.push({ file, line: lineNumber, rule: "font-size-literal", text });
      }
    } else {
      const fontValue = declarationValue(rawLine, "font");
      if (fontValue !== null && fontSizePxPattern.test(fontValue)) {
        violations.push({ file, line: lineNumber, rule: "font-size-literal", text });
      }
    }

    // radius-literal: border(-...)-radius with a disallowed token.
    const radiusPattern = /\bborder(?:-[a-z]+)*-radius\s*:([^;{}]*)/g;
    for (const match of rawLine.matchAll(radiusPattern)) {
      const value = (match[1] ?? "").trim();
      const tokens = value
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
        violations.push({ file, line: lineNumber, rule: "radius-literal", text });
        break;
      }
    }

    // duration-literal + long-transition + animation allowlist.
    const watchedProps = [
      "transition-duration",
      "transition-delay",
      "animation-duration",
      "animation-delay",
      "transition",
      "animation",
    ];
    let watchedValue: string | null = null;
    let watchedProp = "";
    for (const prop of watchedProps) {
      const value = declarationValue(rawLine, prop);
      // Avoid matching "transition" inside "transition-duration" twice: prefer longest match.
      if (value !== null) {
        // Ensure the match is for this exact property (declarationValue already checks prefix).
        // For "transition"/"animation", skip when a longer prop matched on the same line.
        if ((prop === "transition" || prop === "animation") && watchedValue !== null) continue;
        if (watchedValue === null || prop.length > watchedProp.length) {
          watchedValue = value;
          watchedProp = prop;
        }
      }
    }
    // Collect every watched declaration on the line (there can be two, e.g. transition + animation).
    // Simpler: scan each prop independently for duration-literal.
    for (const prop of watchedProps) {
      // Find all occurrences of `prop:` on the line.
      const pattern = new RegExp(`\\b${prop}\\s*:([^;{}]*)`, "g");
      for (const match of rawLine.matchAll(pattern)) {
        const value = (match[1] ?? "").trim();
        for (const duration of value.matchAll(/\d+(\.\d+)?m?s\b/g)) {
          const token = duration[0];
          if (token !== "0s" && token !== "0ms") {
            violations.push({ file, line: lineNumber, rule: "duration-literal", text });
            break;
          }
        }
      }
    }

    // long-transition: transition using breath/ceremony; animation using them without allowlisted keyframe.
    {
      const transitionPattern = /\btransition\s*:([^;{}]*)/g;
      for (const match of rawLine.matchAll(transitionPattern)) {
        const value = match[1] ?? "";
        if (value.includes("var(--motion-breath)") || value.includes("var(--motion-ceremony)")) {
          violations.push({ file, line: lineNumber, rule: "long-transition", text });
        }
      }
      const animationPattern = /\banimation\s*:([^;{}]*)/g;
      for (const match of rawLine.matchAll(animationPattern)) {
        const value = match[1] ?? "";
        if (value.includes("var(--motion-breath)") || value.includes("var(--motion-ceremony)")) {
          const namesAllowlist = Object.keys(longMotionAllowlist);
          const namesOne = namesAllowlist.some((name) => value.includes(name));
          if (!namesOne) {
            violations.push({ file, line: lineNumber, rule: "long-transition", text });
          }
        }
      }
      // animation-duration/delay with breath/ceremony vars (no keyframe name to check): treat as long-transition.
      const animLongPattern = /\b(?:animation-duration|animation-delay)\s*:([^;{}]*)/g;
      for (const match of rawLine.matchAll(animLongPattern)) {
        const value = match[1] ?? "";
        if (value.includes("var(--motion-breath)") || value.includes("var(--motion-ceremony)")) {
          violations.push({ file, line: lineNumber, rule: "long-transition", text });
        }
      }
    }

    if (pressScalePattern.test(rawLine)) {
      violations.push({ file, line: lineNumber, rule: "press-scale-literal", text });
    }

    // --- hover-outside-media via brace stack ---
    // Walk the cleaned line character by character.
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
            violations.push({ file, line: lineNumber, rule: "hover-outside-media", text });
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
    // A line without braces that is a complete rule prelude without `{` yet
    // keeps accumulating; a declaration line ending with `;` was already reset.
  }

  return violations;
}
