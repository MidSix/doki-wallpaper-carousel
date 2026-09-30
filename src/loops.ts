import { ChildProcess, spawn } from "child_process";

// Finding where a GIF starts over: every frame, shrunk to a tiny picture, is compared with the
// first one. Where the animation comes back to a frame like the first, a loop ends. The panel
// picks those points from the similarities (loopPoints in sidebar.js), so the match level can
// change at once. No vscode import: it can be tried with plain Node.

/** Frames are compared at this size: enough to tell scenes apart, small enough to be fast. */
const WIDTH = 64;
const HEIGHT = 36;
const PIXELS = WIDTH * HEIGHT;
const FRAME_BYTES = PIXELS * 3;
/** A pixel still matches the first frame when no color moved more than this (of 255). */
const TOLERANCE = 12;
/** Below this share of moving pixels the GIF is considered still. */
const MIN_MOVING = 0.005;

export interface LoopAnalysis {
  /** Length of the GIF in seconds. */
  duration: number;
  /** Start time of each frame, in seconds. */
  times: number[];
  /**
   * How much each frame looks like the first one, 0–1: the share of the moving pixels that are
   * back where they were. Static background doesn't count, or it would make every frame match.
   */
  similarity: number[];
  /** Share of the picture that moves at some point; tiny for an almost still GIF. */
  moving: number;
}

export interface Analysis {
  result: Promise<LoopAnalysis | undefined>;
  cancel(): void;
}

/**
 * Wallpapers are often darkened (blended with black), which shrinks every difference: brighten
 * the comparison as the hover previews do, up to 4x, from the brightest pixels of the first frame.
 */
function gainFor(first: Buffer): number {
  const levels: number[] = [];
  for (let p = 0; p < PIXELS; p++) levels.push(Math.max(first[p * 3], first[p * 3 + 1], first[p * 3 + 2]));
  levels.sort((a, b) => a - b);
  return Math.min(4, 255 / Math.max(1, levels[Math.floor(PIXELS * 0.99)]));
}

/** Read every frame of the GIF with ffmpeg; `progress` gets the seconds read so far. */
export function analyzeLoops(ffmpeg: string, file: string, progress?: (seconds: number) => void): Analysis {
  let child: ChildProcess | undefined;
  let cancelled = false;
  const run = (timing: string[]) =>
    new Promise<{ ok: boolean; analysis?: LoopAnalysis; stderr: string }>((resolve) => {
      const times: number[] = [];
      const durations: number[] = [];
      // Per frame and pixel, how far it is from the first frame (after the gain), capped at 255.
      const distances: Uint8Array[] = [];
      const reach = new Uint8Array(PIXELS); // the most each pixel ever moves
      let first: Buffer | undefined;
      let gain = 1;
      let pending: Buffer = Buffer.alloc(0);
      let stderr = "";
      let lastReport = 0;

      // showinfo logs every frame's time; `area` averages pixels, so tiny details blur together.
      const args = ["-hide_banner", "-i", file, "-vf", `scale=${WIDTH}:${HEIGHT}:flags=area,format=rgb24,showinfo`, ...timing, "-f", "rawvideo", "-"];
      const proc = spawn(ffmpeg, args, { windowsHide: true });
      child = proc;
      proc.stdout.on("data", (chunk: Buffer) => {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        let offset = 0;
        for (; offset + FRAME_BYTES <= pending.length; offset += FRAME_BYTES) {
          const frame = pending.subarray(offset, offset + FRAME_BYTES);
          if (!first) {
            first = Buffer.from(frame);
            gain = gainFor(first);
          }
          const distance = new Uint8Array(PIXELS);
          for (let p = 0, i = 0; p < PIXELS; p++, i += 3) {
            const d = Math.max(Math.abs(frame[i] - first[i]), Math.abs(frame[i + 1] - first[i + 1]), Math.abs(frame[i + 2] - first[i + 2]));
            distance[p] = Math.min(255, Math.round(d * gain));
            if (distance[p] > reach[p]) reach[p] = distance[p];
          }
          distances.push(distance);
        }
        pending = Buffer.from(pending.subarray(offset));
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        const text = String(chunk);
        for (const match of text.matchAll(/pts_time:\s*(-?[\d.]+)(?:.*?duration_time:\s*([\d.]+))?/g)) {
          times.push(Number(match[1]));
          durations.push(Number(match[2] ?? 0));
        }
        if (!times.length) stderr += text; // errors come before the first frame
        const now = times[times.length - 1] ?? 0;
        if (progress && now - lastReport >= 1) {
          lastReport = now;
          progress(now);
        }
      });
      const finish = (ok: boolean) => {
        const count = Math.min(times.length, distances.length);
        if (!ok || !count) return resolve({ ok: false, stderr });
        const movingPixels: number[] = [];
        for (let p = 0; p < PIXELS; p++) if (reach[p] > TOLERANCE) movingPixels.push(p);
        const similarity = distances.slice(0, count).map((distance) => {
          if (!movingPixels.length) return 1;
          let matching = 0;
          for (const p of movingPixels) if (distance[p] <= TOLERANCE) matching++;
          return Math.round((matching / movingPixels.length) * 10000) / 10000;
        });
        const last = count - 1;
        // The last frame lasts its own delay; without one, as long as the one before it.
        const lastLength = durations[last] || (count > 1 ? times[last] - times[last - 1] : 0);
        resolve({
          ok: true,
          analysis: {
            duration: times[last] + lastLength,
            times: times.slice(0, count),
            similarity,
            moving: movingPixels.length / PIXELS,
          },
          stderr,
        });
      };
      proc.on("error", () => finish(false));
      proc.on("close", (code) => finish(code === 0));
    });

  const result = (async () => {
    // `-fps_mode passthrough` (ffmpeg 5.1+) writes each frame once, as the GIF has it; older
    // versions only know `-vsync 0`.
    let attempt = await run(["-fps_mode", "passthrough"]);
    if (!attempt.ok && !cancelled && /fps_mode/.test(attempt.stderr)) attempt = await run(["-vsync", "0"]);
    return attempt.ok && !cancelled ? attempt.analysis : undefined;
  })();
  return {
    result,
    cancel: () => {
      cancelled = true;
      child?.kill();
    },
  };
}

/** Whether the GIF moves enough for loops to mean anything. */
export const isStill = (analysis: LoopAnalysis) => analysis.moving < MIN_MOVING;
