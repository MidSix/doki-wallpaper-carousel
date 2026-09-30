import { spawn } from "child_process";
import { isAnimated } from "./formats";

// The main colors of a wallpaper: a few frames read small with ffmpeg, their pixels grouped with
// k-means in CIELAB (where distances follow how different colors look). No vscode import: it can
// be tried with plain Node.

const WIDTH = 48;
const HEIGHT = 27;
const FRAME_BYTES = WIDTH * HEIGHT * 3;
/** Frames read from an animation: two per second over its first six seconds. */
const MAX_FRAMES = 12;
const CLUSTERS = 6;

export interface PaletteColor {
  /** sRGB, 0–255 each. */
  rgb: [number, number, number];
  /** Share of the picture, 0–1. */
  weight: number;
}

// ---------------------------------------------------------------- color spaces

export type Lab = [number, number, number];

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

export function rgbToLab([r, g, b]: [number, number, number]): Lab {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  // D65 white.
  const x = (0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047;
  const y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  const z = (0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Back to sRGB; colors outside it are clipped. */
export function labToRgb([l, a, b]: Lab): [number, number, number] {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t: number) => (t > 6 / 29 ? t ** 3 : (108 / 841) * (t - 4 / 29));
  const [x, y, z] = [inv(fx) * 0.95047, inv(fy), inv(fz) * 1.08883];
  const lr = 3.2406 * x - 1.5372 * y - 0.4986 * z;
  const lg = -0.9689 * x + 1.8758 * y + 0.0415 * z;
  const lb = 0.0557 * x - 0.204 * y + 1.057 * z;
  return [lr, lg, lb].map((v) => Math.round(Math.min(255, Math.max(0, fromLinear(Math.min(1, Math.max(0, v))))))) as [number, number, number];
}

// ---------------------------------------------------------------- reading the frames

function readFrames(ffmpeg: string, file: string): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    // fps= would drop the only frame of a still image.
    const sample = isAnimated(file) ? "fps=2," : "";
    const args = ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `${sample}scale=${WIDTH}:${HEIGHT}:flags=area,format=rgb24`, "-frames:v", String(MAX_FRAMES), "-f", "rawvideo", "-"];
    const chunks: Buffer[] = [];
    const child = spawn(ffmpeg, args, { windowsHide: true });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolve(undefined));
    child.on("close", () => {
      const data = Buffer.concat(chunks);
      resolve(data.length >= FRAME_BYTES ? data.subarray(0, data.length - (data.length % FRAME_BYTES)) : undefined);
    });
  });
}

// ---------------------------------------------------------------- k-means

/** Same result every time for the same picture. */
function seededRandom(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const distance2 = (p: Lab, q: Lab) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;

/** Group weighted colors into `k` clusters; returns their centers and weights, largest first. */
export function kMeans(points: Lab[], weights: number[], k: number): { center: Lab; weight: number }[] {
  const random = seededRandom(points.length * 2654435761);
  const total = weights.reduce((a, b) => a + b, 0);
  // k-means++: each new center far from the ones already picked.
  const centers: Lab[] = [points[weights.indexOf(Math.max(...weights))]];
  while (centers.length < Math.min(k, points.length)) {
    const d = points.map((p, i) => weights[i] * Math.min(...centers.map((c) => distance2(p, c))));
    const sum = d.reduce((a, b) => a + b, 0);
    if (!sum) break;
    let pick = random() * sum;
    let i = 0;
    while (i < d.length - 1 && (pick -= d[i]) > 0) i++;
    centers.push(points[i]);
  }
  const assignment = new Array<number>(points.length).fill(0);
  for (let round = 0; round < 20; round++) {
    let moved = false;
    points.forEach((p, i) => {
      let best = 0;
      for (let c = 1; c < centers.length; c++) if (distance2(p, centers[c]) < distance2(p, centers[best])) best = c;
      if (assignment[i] !== best) {
        assignment[i] = best;
        moved = true;
      }
    });
    const sums = centers.map(() => [0, 0, 0, 0]);
    points.forEach((p, i) => {
      const s = sums[assignment[i]];
      s[0] += p[0] * weights[i];
      s[1] += p[1] * weights[i];
      s[2] += p[2] * weights[i];
      s[3] += weights[i];
    });
    sums.forEach((s, c) => s[3] && (centers[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]));
    if (!moved && round > 0) break;
  }
  const clusterWeights = centers.map(() => 0);
  points.forEach((_, i) => (clusterWeights[assignment[i]] += weights[i]));
  return centers
    .map((center, c) => ({ center, weight: clusterWeights[c] / total }))
    .filter((c) => c.weight > 0)
    .sort((a, b) => b.weight - a.weight);
}

/** The wallpaper's main colors, largest share first; undefined when ffmpeg can't read it. */
export async function extractPalette(ffmpeg: string, file: string): Promise<PaletteColor[] | undefined> {
  const data = await readFrames(ffmpeg, file);
  if (!data) return undefined;
  // Wallpapers are often darkened (blended with black), which leaves every color near black.
  // Their hues are still there: brighten them back first, as the hover previews do, up to 4x,
  // from the brightest pixels.
  const levels = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 3) levels[Math.max(data[i], data[i + 1], data[i + 2])]++;
  let top = 255;
  for (let seen = 0, pixels = data.length / 3; top > 0 && (seen += levels[top]) < pixels * 0.01; top--);
  const gain = Math.min(4, 255 / Math.max(1, top));
  const lift = (v: number) => Math.min(255, Math.round(v * gain));
  // Similar colors share a bin first (5 bits a channel), so k-means works on a few thousand
  // distinct colors instead of every pixel.
  const bins = new Map<number, number>();
  for (let i = 0; i < data.length; i += 3) {
    const key = ((lift(data[i]) >> 3) << 10) | ((lift(data[i + 1]) >> 3) << 5) | (lift(data[i + 2]) >> 3);
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }
  const points: Lab[] = [];
  const weights: number[] = [];
  for (const [key, count] of bins) {
    const rgb: [number, number, number] = [((key >> 10) << 3) + 4, (((key >> 5) & 31) << 3) + 4, ((key & 31) << 3) + 4];
    points.push(rgbToLab(rgb));
    weights.push(count);
  }
  return kMeans(points, weights, CLUSTERS).map((c) => ({ rgb: labToRgb(c.center), weight: Math.round(c.weight * 1000) / 1000 }));
}
