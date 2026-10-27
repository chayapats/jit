/**
 * Jit logo, concept D "บอทนั่งสมาธิ" (S09-D10, docs/design/README.md), hand-built on a 24-unit grid.
 *
 * One colour only (`currentColor`, i.e. `--fg`). The head is a rounded square whose closed-eye arcs are
 * negative space (even-odd fill). The body is a wide, low seated base without limbs. A thin halo sits
 * behind the figure, and the floating dot (จุดตั้งจิต) is the only part that animates. There is no
 * religious iconography: no ushnisha, lotus, unalome, flames or gold.
 */

const head = "M10.25 6.6h3.5a2.25 2.25 0 0 1 2.25 2.25v2.6a2.25 2.25 0 0 1-2.25 2.25h-3.5A2.25 2.25 0 0 1 8 10.85v-2.6A2.25 2.25 0 0 1 10.25 6.6Z";
/** Tapered closed-eye arcs, cut out of the head. `bold` thickens them so they survive at favicon size. */
const eyes = (bold: boolean) => bold
  ? "M9.3 9.65Q10.35 11.55 11.4 9.65Q10.35 10.55 9.3 9.65ZM12.6 9.65Q13.65 11.55 14.7 9.65Q13.65 10.55 12.6 9.65Z"
  : "M9.45 9.85Q10.4 11.2 11.35 9.85Q10.4 10.65 9.45 9.85ZM12.65 9.85Q13.6 11.2 14.55 9.85Q13.6 10.65 12.65 9.85Z";
const body = "M7.75 14.4C8.05 13.65 8.9 13.25 10 13.25h4c1.1 0 1.95.4 2.25 1.15.5 1.55 2.1 2.35 3.55 2.9 1.1.42 1.7 1.1 1.7 1.95 0 1-.7 1.6-1.8 1.6H4.3c-1.1 0-1.8-.6-1.8-1.6 0-.85.6-1.53 1.7-1.95 1.45-.55 3.05-1.35 3.55-2.9Z";
const dot = (cls = "jit-dot") => `<circle class="${cls}" cx="12" cy="4.6" r=".95"/>`;
const halo = `<circle class="jit-halo" cx="12" cy="11.6" r="8.9" fill="none" stroke="currentColor" stroke-width=".7"/>`;

/**
 * The mark alone. Drop the halo below 24 px (`halo: false`). `label` names it for assistive technology;
 * without a label the mark is decorative.
 */
export function logoMark(options: { size?: number; halo?: boolean; label?: string; className?: string } = {}): string {
  const { size = 24, label, className = "jit-mark" } = options;
  const showHalo = options.halo ?? size >= 24;
  const a11y = label ? `role="img" aria-label="${label}"` : `aria-hidden="true" focusable="false"`;
  return `<svg class="${className}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" ${a11y}>`
    + `${showHalo ? halo : ""}<path d="${body}"/><path fill-rule="evenodd" d="${head}${eyes(size < 24)}"/>${dot()}</svg>`;
}

/**
 * Custom "จิต" lettering: loopless, geometric strokes on a 10-unit x-height (not font text).
 * จ: an arch over the top, a right stem to the baseline and a back-stroke into the counter.
 * ิ: a low dome above จ. ต: two shoulders with a centre notch over two stems.
 */
const wordmarkStrokes = [
  "M1 4.6C1 2.3 2.55 1 4.5 1S8 2.3 8 4.5V10L4.7 6.7", // จ
  "M2.4 -1.3C2.9 -3.2 7.4 -3.4 8.1 -1", // ิ
  "M11.5 10V3.4C11.5 1.9 12.4 1 13.6 1S15.3 1.8 15.3 2.9C15.3 1.8 16.05 1 17.2 1S19 1.9 19 3.4V10", // ต
];
/** "JIT" in small geometric caps for the line under the Thai wordmark. */
const latinStrokes = ["M2.2 0V2.1A1 1 0 0 1 .2 2.2", "M4.6 0V3", "M6.9 0H9.9M8.4 0V3"];

/** The lockup: mark, the custom "จิต" wordmark and "JIT" small caps beneath it. */
export function logoLockup(options: { height?: number; label?: string } = {}): string {
  const { height = 32, label = "Jit" } = options;
  const width = Math.round(height * 56 / 24);
  return `<svg class="jit-lockup" viewBox="0 0 56 24" width="${width}" height="${height}" role="img" aria-label="${label}">`
    + `<g fill="currentColor">${halo}<path d="${body}"/><path fill-rule="evenodd" d="${head}${eyes(false)}"/>${dot()}</g>`
    + `<g transform="translate(30 5.2) scale(1.12)" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${wordmarkStrokes.map(d => `<path d="${d}"/>`).join("")}</g>`
    + `<g transform="translate(36.4 18.6)" fill="none" stroke="currentColor" stroke-width=".55" stroke-linecap="round" stroke-linejoin="round">${latinStrokes.map(d => `<path d="${d}"/>`).join("")}</g></svg>`;
}

/**
 * Standalone favicon / app icon: the mark without halo on a dark rounded tile, with fixed colours
 * because an icon file cannot read page tokens (dark `--bg` and `--fg`).
 */
export const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5.5" fill="#0a0a0a"/>`
  + `<g fill="#ededed" transform="translate(12 12.4) scale(.86) translate(-12 -12)"><path d="${body}"/><path fill-rule="evenodd" d="${head}${eyes(true)}"/>${dot("d")}</g></svg>`;
