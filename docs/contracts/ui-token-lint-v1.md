# `ui.token_lint/v1` — token-only stylesheet check

The owner-approved S14 Plain palette and shell dimensions live in `src/s14/web-design.ts`; legacy/shared values remain in `src/web-design.ts`. All existing S14 stylesheet targets retain the same literal-value, hover and motion checks. Plain theme contrast is additionally verified in `tests/s14-browser-navigation.test.ts` against the same foreground/background pairs.

Owner: Jit #112 (S10 UX04). Status: implemented. Spec: [S10](../specs/S10-reliability-and-owner-integrations.md) (S10-AC10, NFR-13, NFR-11). Visual values: [design/README.md](../design/README.md). Tokens: `ui.design_tokens/v1` (see [web-design-system-v1](web-design-system-v1.md)).

| Contract | Public entry and behavior |
| --- | --- |
| `ui.token_lint/v1` | `src/web-token-lint.ts`: `lintStyleSource(source, file)` parses each `prop: value` declaration across lines up to its terminating `;` or `}` (1-based start lines, skipping `/* … */` comments and `${ … }` interpolations) and returns `TokenLintViolation[]` (`{ file, line, rule, text }`). Every comma-separated item is checked. `tokenLintTargets` is `["src/web-style.ts", "src/web-attachments-style.ts", "src/s14/web-style.ts"]`. `longMotionAllowlist` names the only animations allowed above 300 ms. `tests/web-token-lint.test.ts` runs it in CI and fails on any violation in the real stylesheet. |

## Rules

- `color-literal`: `#[0-9a-fA-F]{3,8}\b` or `\b(rgba?|hsla?)\(`. The only `rgba()` literals in the UI are the shadow and scrim values in `effectTokens` (`src/web-design.ts`), referenced through `--shadow`, `--scrim-palette` and `--scrim-drawer`.
- `font-size-literal`: `font-size:` where any comma-separated item's first token is not `0`, `inherit` or starting with `var(`; and a `font:` shorthand where any item contains `\d+(\.\d+)?px`. Sizes come from `--size-xs` … `--size-xxl`, plus `--size-input-mobile` (16 px) for form inputs on small screens so iOS Safari does not zoom on focus.
- `radius-literal`: any `border(-…)-radius:` where any comma-separated item, split on spaces, contains a token other than `0`, `50%`, `inherit` or a `var(--radius-…)`. Radii come from `--radius-control`, `--radius-card`, `--radius-composer`, `--radius-pill` and `--radius-tail`.
- `duration-literal`: inside `transition`, `transition-duration`, `transition-delay`, `animation`, `animation-duration` or `animation-delay` values, any `\d+(\.\d+)?m?s\b` other than `0s` / `0ms` in any comma-separated item. Durations come from `--motion-ui` (160 ms) and `--motion-panel` (240 ms).
- `long-transition`: a `transition`, `transition-duration` or `transition-delay` value that uses `var(--motion-breath)` or `var(--motion-ceremony)` (transitions may only use `--motion-ui` or `--motion-panel`).
- `press-scale-literal`: `scale\(\s*[0-9.]`. Press shrink uses the single token `--press-scale` (`scaleTokens.press`, 0.97).
- `hover-outside-media`: a rule prelude containing `:hover` that is not nested (at any depth) inside a single media query joining `(hover: hover)` and `(pointer: fine)` with `and`. A comma-separated list such as `@media (hover: hover), (pointer: fine)` is an OR and guards nothing. Nesting is tracked with a brace stack of preludes; rules already inside another `@media` block get the hover media query nested inside that block.

## Long-motion allowlist

Every `transition` uses `--motion-ui` (160 ms) or `--motion-panel` (240 ms), both under 300 ms. An `animation:` item that uses `--motion-breath` or `--motion-ceremony` must name one of these keyframes with an exact match, otherwise it reports `long-transition` (substring names such as `jit-breath-extra` fail, and every item in a comma-separated list needs its own allowlisted name):

| Keyframe | Reason |
| --- | --- |
| `jit-breath` | S09 design: the จุดตั้งจิต (thinking dot) breathes on a 4.8 s cycle |
| `ceremony-halo` | S09 design: the ตั้งจิต (setup) ceremony, 1.6 s |
| `ceremony-dot` | S09 design: the ตั้งจิต (setup) ceremony, 1.6 s |

No other allowlist entries exist, and there are no per-line ignore comments. Every animation stops under `prefers-reduced-motion`.

## Evidence

`tests/web-token-lint.test.ts` covers the following:

- planted violations are reported with file, line and rule;
- allowed forms pass;
- declarations split across lines are reported at their start line;
- literals in later list items and `font:` shorthands beside `font-size:` are reported;
- `transition-duration` with a long-motion token fails;
- the animation allowlist matches keyframe names exactly per list item;
- hover guards require `hover` and `pointer-fine` joined by `and` in one query;
- mobile form inputs use a 16 px token so iOS does not zoom;
- the real stylesheet (`tokenLintTargets`) has zero violations;
- transition tokens stay under 300 ms and every allowlist key appears as `@keyframes` with a non-empty reason;
- the rendered stylesheet still themes (`--size-chat:15px`, `--radius-pill:999px`, `--press-scale:0.97`, both shadow values).
