import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execFile, spawn } from "child_process";
import { findTool } from "./platform";

const brightenThumbnails = () => vscode.workspace.getConfiguration("dokiCarousel").get<boolean>("brightenThumbnails", true);

const CONCURRENCY = 2;

interface Job {
  file: string;
  thumb: string;
  brighten: boolean;
}
const WIDTH = 360;
// Bump when the way thumbnails look changes, so old cached ones are regenerated.
const THUMB_VERSION = 2;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 60000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

function runRaw(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 60000, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
  });
}

/** Encode raw RGB pixels as a JPEG. */
function encodeJpeg(ffmpeg: string, pixels: Buffer, height: number, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${WIDTH}x${height}`, "-i", "pipe:0", "-q:v", "4", out];
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
    child.stdin.on("error", () => undefined);
    child.stdin.end(pixels);
  });
}

/**
 * Wallpapers made for Doki are usually dimmed: the video is blended with black ("video
 * opacity"), which multiplies every pixel by the same factor. Undo that for the preview so it
 * is easy to recognize: the brightest pixels (99.5th percentile, so a few stray ones don't
 * count) are stretched back to near white. Returns the gain applied.
 */
function undoDimming(pixels: Buffer): number {
  const histogram = new Uint32Array(256);
  for (let i = 0; i + 2 < pixels.length; i += 3) {
    histogram[Math.max(pixels[i], pixels[i + 1], pixels[i + 2])]++;
  }
  const total = pixels.length / 3;
  let seen = 0;
  let bright = 255;
  for (let v = 0; v < 256; v++) {
    seen += histogram[v];
    if (seen >= total * 0.995) {
      bright = v;
      break;
    }
  }
  // At most 4x (a wallpaper at 25 % opacity); below 10 % the image is left as it is.
  const gain = Math.min(4, 245 / Math.max(bright, 1));
  if (gain < 1.1) return 1;
  const lut = new Uint8Array(256).map((_, v) => Math.min(255, Math.round(v * gain)));
  for (let i = 0; i < pixels.length; i++) pixels[i] = lut[pixels[i]];
  return gain;
}

/**
 * Static JPEG previews (the frame in the middle of the GIF), generated once with ffmpeg and
 * cached on disk, so hovering the list never has to decode a heavy animated GIF.
 */
export class Thumbnails {
  private readonly dir: string;
  private readonly queue: Job[] = [];
  // Keyed by thumbnail path: the same GIF needs a new job when the preview style changes.
  private readonly queued = new Set<string>();
  private running = 0;
  /** False when ffmpeg can't be found, so the panel can say why there are no previews. */
  get available(): boolean {
    return !!findTool("ffmpeg");
  }
  private readonly _onDidCreate = new vscode.EventEmitter<{ file: string; thumb: string }>();
  readonly onDidCreate = this._onDidCreate.event;

  constructor(context: vscode.ExtensionContext) {
    this.dir = path.join(context.globalStorageUri.fsPath, "thumbs");
    fs.mkdirSync(this.dir, { recursive: true });
    this.dropOutdatedCache();
  }

  /** Thumbnails from an older version are never used again, so delete them once. */
  private dropOutdatedCache() {
    const marker = path.join(this.dir, "version");
    try {
      if (fs.readFileSync(marker, "utf-8").trim() === String(THUMB_VERSION)) return;
    } catch {
      // No marker yet.
    }
    for (const name of fs.readdirSync(this.dir)) {
      if (name.endsWith(".jpg")) fs.rmSync(path.join(this.dir, name), { force: true });
    }
    fs.writeFileSync(marker, String(THUMB_VERSION));
  }

  get folder(): string {
    return this.dir;
  }

  /** Cache path; changes whenever the file is replaced or edited. */
  private thumbPath(file: string): string | undefined {
    try {
      const stat = fs.statSync(file);
      const key = crypto
        .createHash("sha1")
        .update(`${file}|${stat.size}|${stat.mtimeMs}|v${THUMB_VERSION}|${brightenThumbnails() ? "bright" : "as-is"}`)
        .digest("hex");
      return path.join(this.dir, `${key}.jpg`);
    } catch {
      return undefined;
    }
  }

  /** Thumbnail path if it has already been generated. */
  get(file: string): string | undefined {
    const thumb = this.thumbPath(file);
    return thumb && fs.existsSync(thumb) ? thumb : undefined;
  }

  /** Queue generation for every file that has no thumbnail yet. */
  request(files: string[]) {
    if (!this.available) return;
    const brighten = brightenThumbnails();
    for (const file of files) {
      const thumb = this.thumbPath(file);
      if (thumb && !this.queued.has(thumb) && !fs.existsSync(thumb)) {
        this.queued.add(thumb);
        this.queue.push({ file, thumb, brighten });
      }
    }
    this.pump();
  }

  private pump() {
    while (this.running < CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running++;
      this.generate(job)
        .catch(() => undefined)
        .finally(() => {
          this.running--;
          this.queued.delete(job.thumb);
          this.pump();
        });
    }
  }

  private async generate({ file, thumb, brighten }: Job) {
    const ffmpeg = findTool("ffmpeg");
    const ffprobe = findTool("ffprobe");
    if (!ffmpeg) {
      this.queue.length = 0;
      return;
    }

    let middle = 0;
    try {
      if (!ffprobe) throw new Error("ffprobe not found");
      const duration = parseFloat(await run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]));
      if (Number.isFinite(duration)) middle = duration / 2;
    } catch {
      // No ffprobe or no duration: fall back to the first frame.
    }

    try {
      if (brighten) {
        // Decode the frame once as raw pixels, fix its brightness here, then encode it.
        const args = ["-v", "error", "-ss", middle.toFixed(3), "-i", file, "-frames:v", "1"];
        const pixels = await runRaw(ffmpeg, [...args, "-vf", `scale=${WIDTH}:-2,format=rgb24`, "-f", "rawvideo", "pipe:1"]);
        const height = pixels.length / (WIDTH * 3);
        if (!Number.isInteger(height) || height < 1) throw new Error("unexpected frame size");
        undoDimming(pixels);
        await encodeJpeg(ffmpeg, pixels, height, thumb);
      } else {
        await run(ffmpeg, ["-v", "error", "-y", "-ss", middle.toFixed(3), "-i", file, "-frames:v", "1", "-vf", `scale=${WIDTH}:-2`, "-q:v", "4", thumb]);
      }
    } catch (err) {
      return;
    }
    // Skip previews made in a style that was switched off meanwhile.
    if (fs.existsSync(thumb) && thumb === this.thumbPath(file)) this._onDidCreate.fire({ file, thumb });
  }
}
