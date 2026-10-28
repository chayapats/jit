/**
 * Jit logo, concept D "บอทนั่งสมาธิ" (S09-D10, docs/design/README.md), hand-built on a 24-unit grid.
 *
 * The geometry is measured from the owner-chosen concept image (docs/design/assets/logo-concept-d.png)
 * so the drawing keeps its proportions: a big rounded-square head with two closed-eye arcs cut out as
 * negative space, a small gap at the neck, and a soft seated body that flares into a cloud-like base.
 * One colour only (`currentColor`, i.e. `--fg`). A thin halo sits behind the figure, and the floating
 * dot is the only part that animates. There is no religious iconography: no ushnisha, lotus, unalome,
 * flames or gold.
 */

const head = "M9.68 6.78h4.64a2.1 2.1 0 0 1 2.1 2.1v3.81a2.1 2.1 0 0 1-2.1 2.1H9.68a2.1 2.1 0 0 1-2.1-2.1V8.88a2.1 2.1 0 0 1 2.1-2.1Z";
/** Closed-eye arcs, cut out of the head. `bold` thickens them so they survive at favicon size. */
const eyes = (bold: boolean) => bold
  ? "M8.7 10.75Q10.07 11.5 11.44 10.75L11.34 11.05Q10.07 12.25 8.8 11.05ZM12.56 10.75Q13.93 11.5 15.3 10.75L15.2 11.05Q13.93 12.25 12.66 11.05Z"
  : "M8.72 10.76Q10.07 11.6 11.42 10.76L11.32 11.06Q10.07 12.1 8.82 11.06ZM12.58 10.76Q13.93 11.6 15.28 10.76L15.18 11.06Q13.93 12.1 12.68 11.06Z";
/** Rounded shoulders just under the head, a gentle slope, then the base flares into two soft lobes. */
const body = "M9.1 14.72C8.3 14.72 7.9 14.95 7.6 15.36C7.15 15.95 6.3 17 5.72 17.75C5.3 18.25 4.2 19.1 3.13 19.35"
  + "C2.75 19.45 2.43 20.1 2.43 20.74C2.43 21.9 3.2 23 5 23H19C20.8 23 21.57 21.9 21.57 20.74"
  + "C21.57 20.1 21.25 19.45 20.87 19.35C19.8 19.1 18.7 18.25 18.28 17.75C17.7 17 16.85 15.95 16.4 15.36"
  + "C16.1 14.95 15.7 14.72 14.9 14.72Z";
const dotAt = Object.freeze({ cx: 12, cy: 4.42, r: 1.13 });
const dot = (cls = "jit-dot") => `<circle class="${cls}" cx="${dotAt.cx}" cy="${dotAt.cy}" r="${dotAt.r}"/>`;
const halo = `<circle class="jit-halo" cx="12" cy="11.04" r="9.85" fill="none" stroke="currentColor" stroke-width=".45"/>`;
const figure = (bold: boolean, cls?: string) => `<path d="${body}"/><path fill-rule="evenodd" d="${head}${eyes(bold)}"/>${dot(cls)}`;

/**
 * The mark alone. Drop the halo below 24 px (`halo: false`); without it the figure moves up to stay
 * centred. `label` names it for assistive technology; without a label the mark is decorative.
 */
export function logoMark(options: { size?: number; halo?: boolean; label?: string; className?: string } = {}): string {
  const { size = 24, label, className = "jit-mark" } = options;
  const showHalo = options.halo ?? size >= 24;
  const a11y = label ? `role="img" aria-label="${label}"` : `aria-hidden="true" focusable="false"`;
  return `<svg class="${className}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" ${a11y}>`
    + (showHalo ? `${halo}${figure(size < 24)}` : `<g transform="translate(0 -1.1)">${figure(size < 24)}</g>`) + `</svg>`;
}

/**
 * Custom "Jit" lettering: geometric round-capped strokes on a 10-unit cap height (not font text).
 * J: a stem with a round hook. i: a stem and a round dot. t: a stem curving into a short foot, and a bar.
 */
const wordmarkStrokes = [
  "M5 0V7A2.5 2.5 0 0 1 0 7", // J
  "M8.6 3.4V10", "M8.6 .4h0", // i
  "M12.2 .8V8.2A1.8 1.8 0 0 0 14 10H14.9", "M10.6 3.4H14.6", // t
];

/** The lockup: the mark with its halo and the custom "Jit" wordmark beside it. */
export function logoLockup(options: { height?: number; label?: string } = {}): string {
  const { height = 32, label = "Jit" } = options;
  const width = Math.round(height * 46 / 24);
  return `<svg class="jit-lockup" viewBox="0 0 46 24" width="${width}" height="${height}" role="img" aria-label="${label}">`
    + `<g fill="currentColor">${halo}${figure(false)}</g>`
    + `<g transform="translate(28 6.5) scale(1.1)" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">${wordmarkStrokes.map(d => `<path d="${d}"/>`).join("")}</g></svg>`;
}

/**
 * The app-icon drawing as plain geometry, shared by {@link faviconSvg} and the PNG install icons (web.pwa/v1,
 * src/web-icons.ts): the mark without halo (bold eyes) on a dark tile, with fixed colours because an icon file
 * cannot read page tokens (dark `--bg` and `--fg`). The figure is scaled about the tile centre; `centerY` is the
 * figure's own vertical centre, so it sits optically centred.
 */
export const appIcon = Object.freeze({
  body, head: `${head}${eyes(true)}`, dot: dotAt,
  tile: Object.freeze({ radius: 5.5, background: "#0a0a0a", foreground: "#ededed" }),
  scale: .84, centerY: 13.15,
});

/** Standalone favicon: the {@link appIcon} drawing as SVG. */
export const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="${appIcon.tile.radius}" fill="${appIcon.tile.background}"/>`
  + `<g fill="${appIcon.tile.foreground}" transform="translate(12 12) scale(${String(appIcon.scale).replace(/^0/, "")}) translate(-12 -${appIcon.centerY})">${figure(true, "d")}</g></svg>`;
