import { deflateSync } from "node:zlib";
import { appIcon } from "./web-logo";

/**
 * web.pwa/v1 install icons, drawn from the logo geometry in src/web-logo.ts (the same {@link appIcon} paths the
 * favicon SVG uses). Browsers and home screens need raster icons, so this module rasterizes those paths into
 * RGBA PNGs with no dependency: a small SVG path parser (M L H V C Q A Z, absolute and relative), fixed-step
 * curve flattening, a scanline filler with 8 sub-rows and exact horizontal span coverage, and a PNG encoder.
 *
 * The PNG files are generated once and shipped in `src/web-assets/icons/`, so the server only reads them, like the
 * fonts. Regenerate after a logo change with `bun src/web-icons.ts`; tests/web-ux03.test.ts decodes the shipped
 * files and compares them with a fresh drawing.
 */
export interface IconSpec {
  /** File under `src/web-assets/icons/`. */
  readonly file: string;
  readonly size: number;
  /**
   * `any`: the rounded favicon tile with transparent corners. `maskable`: a full-bleed tile with the figure inside
   * the central 80 % safe circle, for launchers that apply their own mask. `touch`: a full-bleed tile with the
   * favicon's figure size, for iOS, which rounds the corners itself and shows transparency as black.
   */
  readonly purpose: "any" | "maskable" | "touch";
}

/** The shipped icon set. The manifest lists the `any` and `maskable` icons; pages link the `touch` icon. */
export const iconSpecs: readonly IconSpec[] = Object.freeze([
  { file: "icon-192.png", size: 192, purpose: "any" },
  { file: "icon-512.png", size: 512, purpose: "any" },
  { file: "icon-maskable-512.png", size: 512, purpose: "maskable" },
  { file: "apple-touch-icon.png", size: 180, purpose: "touch" },
] as const);

/** Figure scale for maskable icons: its bounding box fits inside the 80 % safe circle with a margin. */
const maskableScale = .66;

type Point = readonly [number, number];
type Polygon = Point[];
type Matrix = readonly [number, number, number, number, number, number];

const curveSteps = 24;

/** Parses SVG path data into closed polygons (one per subpath). Supports M L H V C Q A Z, absolute and relative. */
export function pathPolygons(d: string): Polygon[] {
  const grammar = /[MLHVCQAZmlhvcqaz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
  // Anything besides commands, numbers, spaces and commas is malformed, never silently skipped.
  if (d.replace(grammar, "").replace(/[\s,]/g, "")) throw new Error("malformed path data");
  const tokens = d.match(grammar) ?? [];
  const polygons: Polygon[] = [];
  let index = 0, command = "", x = 0, y = 0, startX = 0, startY = 0, current: Polygon = [];
  const number = () => {
    const token = tokens[index++], value = Number(token);
    if (token === undefined || /^[MLHVCQAZ]$/i.test(token) || !Number.isFinite(value)) throw new Error(`malformed path near token ${index}`);
    return value;
  };
  const close = () => { if (current.length > 2) polygons.push(current); current = []; };
  while (index < tokens.length) {
    if (/^[a-z]$/i.test(tokens[index]!)) command = tokens[index++]!;
    else if (!command) throw new Error("path data must start with a command");
    const relative = command === command.toLowerCase(), ox = relative ? x : 0, oy = relative ? y : 0;
    switch (command.toUpperCase()) {
      case "M":
        close();
        x = ox + number(); y = oy + number(); startX = x; startY = y; current = [[x, y]];
        command = relative ? "l" : "L";
        break;
      case "L": x = ox + number(); y = oy + number(); current.push([x, y]); break;
      case "H": x = ox + number(); current.push([x, y]); break;
      case "V": y = oy + number(); current.push([x, y]); break;
      case "C": {
        const x1 = ox + number(), y1 = oy + number(), x2 = ox + number(), y2 = oy + number(), x3 = ox + number(), y3 = oy + number();
        for (let i = 1; i <= curveSteps; i++) {
          const t = i / curveSteps, u = 1 - t;
          current.push([u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3]);
        }
        x = x3; y = y3;
        break;
      }
      case "Q": {
        const x1 = ox + number(), y1 = oy + number(), x2 = ox + number(), y2 = oy + number();
        for (let i = 1; i <= curveSteps; i++) {
          const t = i / curveSteps, u = 1 - t;
          current.push([u * u * x + 2 * u * t * x1 + t * t * x2, u * u * y + 2 * u * t * y1 + t * t * y2]);
        }
        x = x2; y = y2;
        break;
      }
      case "A": {
        const rx = number(), ry = number(), rotation = number(), large = number(), sweep = number(), x2 = ox + number(), y2 = oy + number();
        current.push(...arcPoints(x, y, rx, ry, rotation, large !== 0, sweep !== 0, x2, y2));
        x = x2; y = y2;
        break;
      }
      case "Z": x = startX; y = startY; close(); current = [[x, y]]; command = ""; break;
      default: throw new Error(`unsupported path command ${command}`);
    }
  }
  close();
  return polygons;
}

/** SVG endpoint arc to points (SVG 1.1 appendix F.6.5), excluding the start point. */
function arcPoints(x1: number, y1: number, rx: number, ry: number, degrees: number, large: boolean, sweep: boolean, x2: number, y2: number): Point[] {
  // SVG 1.1 F.6.2: identical endpoints draw nothing; a zero radius is a straight line.
  if (x1 === x2 && y1 === y2) return [];
  if (rx === 0 || ry === 0) return [[x2, y2]];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = degrees * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const px = cos * dx + sin * dy, py = -sin * dx + cos * dy;
  const lambda = px * px / (rx * rx) + py * py / (ry * ry);
  if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
  const numerator = rx * rx * ry * ry - rx * rx * py * py - ry * ry * px * px;
  const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / (rx * rx * py * py + ry * ry * px * px)));
  const cxp = factor * rx * py / ry, cyp = -factor * ry * px / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const start = angle(1, 0, (px - cxp) / rx, (py - cyp) / ry);
  let delta = angle((px - cxp) / rx, (py - cyp) / ry, (-px - cxp) / rx, (-py - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const points: Point[] = [];
  for (let i = 1; i <= curveSteps; i++) {
    const theta = start + delta * i / curveSteps;
    points.push([cx + rx * Math.cos(theta) * cos - ry * Math.sin(theta) * sin, cy + rx * Math.cos(theta) * sin + ry * Math.sin(theta) * cos]);
  }
  points[points.length - 1] = [x2, y2];
  return points;
}

const circlePolygon = (cx: number, cy: number, r: number): Polygon =>
  Array.from({ length: 64 }, (_, i) => [cx + r * Math.cos(i * Math.PI / 32), cy + r * Math.sin(i * Math.PI / 32)] as Point);
const roundedSquare = (size: number, r: number) => pathPolygons(`M${r} 0H${size - r}A${r} ${r} 0 0 1 ${size} ${r}V${size - r}A${r} ${r} 0 0 1 ${size - r} ${size}H${r}A${r} ${r} 0 0 1 0 ${size - r}V${r}A${r} ${r} 0 0 1 ${r} 0Z`);
const apply = (m: Matrix, polygons: Polygon[]) => polygons.map(polygon => polygon.map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]] as Point));

const subRows = 8;
/** Coverage (0–1 per pixel) of polygons on a size×size grid, with the nonzero or even-odd fill rule. */
function coverage(polygons: Polygon[], size: number, evenOdd: boolean): Float64Array {
  const cover = new Float64Array(size * size);
  const edges: [number, number, number, number][] = [];
  for (const polygon of polygons) {
    for (let i = 0; i < polygon.length; i++) {
      const [x0, y0] = polygon[i]!, [x1, y1] = polygon[(i + 1) % polygon.length]!;
      if (y0 !== y1) edges.push([x0, y0, x1, y1]);
    }
  }
  for (let row = 0; row < size; row++) {
    for (let sub = 0; sub < subRows; sub++) {
      const y = row + (sub + .5) / subRows;
      const crossings: [number, number][] = [];
      for (const [x0, y0, x1, y1] of edges) {
        if ((y0 <= y && y < y1) || (y1 <= y && y < y0)) crossings.push([x0 + (y - y0) * (x1 - x0) / (y1 - y0), y1 > y0 ? 1 : -1]);
      }
      crossings.sort((a, b) => a[0] - b[0]);
      let winding = 0;
      for (let i = 0; i < crossings.length - 1; i++) {
        winding += crossings[i]![1];
        if (evenOdd ? winding % 2 === 0 : winding === 0) continue;
        const from = Math.max(0, crossings[i]![0]), to = Math.min(size, crossings[i + 1]![0]);
        for (let px = Math.floor(from); px < to; px++) {
          cover[row * size + px]! += (Math.min(to, px + 1) - Math.max(from, px)) / subRows;
        }
      }
    }
  }
  return cover;
}

const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/** Draws one icon as straight (non-premultiplied) RGBA pixels, row by row. */
export function drawIcon(spec: Pick<IconSpec, "size" | "purpose">): Uint8Array {
  const { size, purpose } = spec, unit = size / 24;
  const scale = (purpose === "maskable" ? maskableScale : appIcon.scale) * unit;
  // translate(12 12) scale(s) translate(-12 -centerY), in pixels.
  const figure: Matrix = [scale, 0, 0, scale, 12 * unit - 12 * scale, 12 * unit - appIcon.centerY * scale];
  const tile = purpose === "any" ? roundedSquare(size, appIcon.tile.radius * unit) : [[[0, 0], [size, 0], [size, size], [0, size]] as Polygon];
  const layers: { cover: Float64Array; color: [number, number, number] }[] = [
    { cover: coverage(tile, size, false), color: rgb(appIcon.tile.background) },
    { cover: coverage(apply(figure, pathPolygons(appIcon.body)), size, false), color: rgb(appIcon.tile.foreground) },
    { cover: coverage(apply(figure, pathPolygons(appIcon.head)), size, true), color: rgb(appIcon.tile.foreground) },
    { cover: coverage(apply(figure, [circlePolygon(appIcon.dot.cx, appIcon.dot.cy, appIcon.dot.r)]), size, false), color: rgb(appIcon.tile.foreground) },
  ];
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    // Source-over compositing in premultiplied form, then back to straight alpha.
    let r = 0, g = 0, b = 0, a = 0;
    for (const { cover, color } of layers) {
      const alpha = Math.min(1, cover[i]!);
      r = color[0] * alpha + r * (1 - alpha); g = color[1] * alpha + g * (1 - alpha); b = color[2] * alpha + b * (1 - alpha);
      a = alpha + a * (1 - alpha);
    }
    pixels.set(a > 0 ? [Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a * 255)] : [0, 0, 0, 0], i * 4);
  }
  return pixels;
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
/** Encodes straight RGBA pixels as an 8-bit RGBA PNG (filter type 0 on every row). */
export function encodePng(pixels: Uint8Array, size: number): Uint8Array {
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, size); view.setUint32(4, size);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rows.set(pixels.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", new Uint8Array(deflateSync(rows, { level: 9 }))), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { png.set(part, offset); offset += part.length; }
  return png;
}

if (import.meta.main) {
  const { join } = await import("node:path");
  for (const spec of iconSpecs) {
    const target = join(import.meta.dir, "web-assets", "icons", spec.file);
    await Bun.write(target, encodePng(drawIcon(spec), spec.size));
    console.log(`wrote ${target}`);
  }
}
