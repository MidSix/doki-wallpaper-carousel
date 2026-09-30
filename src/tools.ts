import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import * as crypto from "crypto";
import * as os from "os";
import { findTool, isWindows, powershellExecutable, samePath, warnFfmpegMissing } from "./platform";
import { applyWallpaper, beginTask, getCurrentDokiPath } from "./doki";

let output: vscode.OutputChannel | undefined;

// Kept by the Set opacity tool of earlier versions, replaced by the live opacity slider.
const OLD_KEYS = ["dokiCarousel.opacityRecords", "dokiCarousel.dimmedCopies", "dokiCarousel.dimOptions", "dokiCarousel.dimFiles"];

export function initTools(context: vscode.ExtensionContext) {
  for (const key of OLD_KEYS) if (context.globalState.get(key) !== undefined) context.globalState.update(key, undefined);
}

function log(line: string) {
  output ??= vscode.window.createOutputChannel("Wallpaper Carousel");
  output.appendLine(line);
}

// ---------------------------------------------------------------- extract .mp4

export interface ExtractOptions {
  source: string;
  destination: string;
  move: boolean;
}

function findMp4(dir: string, skip: string, out: string[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!samePath(full, skip)) findMp4(full, skip, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp4")) {
      out.push(full);
    }
  }
}

function uniqueTarget(dir: string, fileName: string): string {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);
  for (let i = 1; fs.existsSync(candidate); i++) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
  }
  return candidate;
}

const SAMPLE_BYTES = 1024 * 1024;

/**
 * Content fingerprint: size plus a hash of 1 MB taken from the start, the middle and the end.
 * Reading whole multi-GB videos to compare them would be far too slow, and matching size and
 * samples at three offsets doesn't happen for different videos in practice.
 */
async function fingerprint(file: string, size: number): Promise<string> {
  const hash = crypto.createHash("sha1").update(String(size));
  const handle = await fs.promises.open(file, "r");
  try {
    const offsets = size <= SAMPLE_BYTES * 3 ? [0] : [0, Math.floor(size / 2 - SAMPLE_BYTES / 2), size - SAMPLE_BYTES];
    const length = Math.min(size, offsets.length === 1 ? size : SAMPLE_BYTES);
    const buffer = Buffer.alloc(length);
    for (const offset of offsets) {
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

/** Videos already in the destination, indexed by size; fingerprints are computed only on size matches. */
class DestinationIndex {
  private readonly bySize = new Map<number, string[]>();
  private readonly fingerprints = new Map<string, string>();

  constructor(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp4")) {
        const full = path.join(dir, entry.name);
        this.add(full, fs.statSync(full).size);
      }
    }
  }

  add(file: string, size: number, knownFingerprint?: string) {
    const list = this.bySize.get(size) ?? [];
    list.push(file);
    this.bySize.set(size, list);
    if (knownFingerprint) this.fingerprints.set(file, knownFingerprint);
  }

  /** Path of an existing copy with the same content, if any. */
  async findDuplicate(size: number, sourceFingerprint: () => Promise<string>): Promise<string | undefined> {
    const candidates = this.bySize.get(size);
    if (!candidates?.length) return undefined;
    const wanted = await sourceFingerprint();
    for (const candidate of candidates) {
      let fp = this.fingerprints.get(candidate);
      if (!fp) {
        fp = await fingerprint(candidate, size);
        this.fingerprints.set(candidate, fp);
      }
      if (fp === wanted) return candidate;
    }
    return undefined;
  }
}

export async function extractMp4(opts: ExtractOptions): Promise<number> {
  const lock = beginTask(opts.move ? "Moving .mp4 files" : "Copying .mp4 files");
  if (!lock) return 0;

  const verb = opts.move ? "moved" : "copied";
  let done = 0;
  let skipped = 0;
  let failed = 0;
  // Released once the files are in place, not when the summary below is dismissed.
  try {
    fs.mkdirSync(opts.destination, { recursive: true });
    const files: string[] = [];
    // Never descend into the destination, or we'd pick up files we just copied.
    findMp4(opts.source, opts.destination, files);

    if (files.length === 0) {
      vscode.window.showInformationMessage(`No .mp4 files found in ${opts.source}`);
      return 0;
    }

    const index = new DestinationIndex(opts.destination);
    output?.clear();
    log(`Extracting ${files.length} .mp4 file(s) from ${opts.source} to ${opts.destination}`);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `${opts.move ? "Moving" : "Copying"} .mp4 files`, cancellable: true },
      async (progress, token) => {
        for (const [i, file] of files.entries()) {
          if (token.isCancellationRequested) break;
          progress.report({ message: `${i + 1}/${files.length} ${path.basename(file)}`, increment: 100 / files.length });
          try {
            const size = (await fs.promises.stat(file)).size;
            let sourceFp: string | undefined;
            const getSourceFp = async () => (sourceFp ??= await fingerprint(file, size));

            const existing = await index.findDuplicate(size, getSourceFp);
            if (existing) {
              // Duplicates are left where they are, even when moving: never delete a video
              // just because it looks like one we already have.
              log(`skipped (already in destination as ${path.basename(existing)}): ${file}`);
              skipped++;
              continue;
            }

            const target = uniqueTarget(opts.destination, path.basename(file));
            if (opts.move) {
              try {
                await fs.promises.rename(file, target);
              } catch {
                // rename fails across drives: fall back to copy + delete
                await fs.promises.copyFile(file, target);
                await fs.promises.unlink(file);
              }
            } else {
              await fs.promises.copyFile(file, target);
            }
            // Register it, so the same video found again in another source folder is skipped too.
            index.add(target, size, sourceFp);
            log(`${verb}: ${file} -> ${target}`);
            done++;
          } catch (err) {
            log(`FAILED: ${file}: ${err}`);
            failed++;
          }
        }
      }
    );
  } finally {
    lock.dispose();
  }

  const parts = [`${done} ${verb}`];
  if (skipped) parts.push(`${skipped} skipped (already in destination)`);
  if (failed) parts.push(`${failed} failed`);
  const message = `.mp4 extraction: ${parts.join(", ")}.`;
  const action = await vscode.window.showInformationMessage(message, "Show Details");
  if (action) output?.show(true);
  return done;
}

// ---------------------------------------------------------------- mp4 -> gif

export interface ConvertOptions {
  fps: number;
  width: number;
  height: number;
  startSeconds: number;
  durationSeconds: number;
  /** Empty = next to each .mp4 */
  destination: string;
}

export const defaultConvertOptions: ConvertOptions = {
  fps: 12,
  width: 480,
  height: -1,
  startSeconds: 0,
  durationSeconds: 0,
  destination: "",
};

// Same ffmpeg pipeline as the original mp4_to_gif.ps1, run directly so it works on every OS.

function runFfmpeg(ffmpeg: string, args: string[], token: vscode.CancellationToken): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    const cancel = token.onCancellationRequested(() => child.kill());
    child.stderr.on("data", (d) => log("  " + String(d).trimEnd()));
    child.on("error", (err) => {
      log(`  could not start ffmpeg: ${err}`);
      cancel.dispose();
      resolve(false);
    });
    child.on("close", (code) => {
      cancel.dispose();
      resolve(code === 0);
    });
  });
}

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Validated options: the values end up inside an ffmpeg filter graph. */
function sanitize(opts: ConvertOptions) {
  return {
    fps: Math.max(1, Math.round(num(opts.fps, 12))),
    width: Math.round(num(opts.width, 480)),
    height: Math.round(num(opts.height, -1)),
    startSeconds: Math.max(0, num(opts.startSeconds, 0)),
    durationSeconds: Math.max(0, num(opts.durationSeconds, 0)),
  };
}

async function convertOne(ffmpeg: string, file: string, outPath: string, opts: ConvertOptions, token: vscode.CancellationToken): Promise<boolean> {
  const o = sanitize(opts);
  const palette = path.join(os.tmpdir(), `doki-carousel-palette-${crypto.randomUUID()}.png`);
  const trim: string[] = [];
  if (o.startSeconds > 0) trim.push("-ss", String(o.startSeconds));
  if (o.durationSeconds > 0) trim.push("-t", String(o.durationSeconds));
  // No darkening here: the wallpaper's opacity is set live in VS Code (the panel's Opacity slider).
  const filters = `fps=${o.fps},scale=${o.width}:${o.height}:flags=lanczos`;
  const quiet = ["-loglevel", "error"];

  try {
    // Two passes: an optimized palette first, then the GIF using it.
    const paletteArgs = ["-y", ...trim, "-i", file, "-vf", `${filters},palettegen=stats_mode=diff`, ...quiet, palette];
    if (!(await runFfmpeg(ffmpeg, paletteArgs, token))) return false;
    const gifArgs = ["-y", ...trim, "-i", file, "-i", palette, "-lavfi", `${filters} [x]; [x][1:v] paletteuse=dither=sierra2_4a`, ...quiet, outPath];
    return await runFfmpeg(ffmpeg, gifArgs, token);
  } finally {
    fs.promises.unlink(palette).catch(() => undefined);
  }
}

/** Optional user script with the parameters of the original mp4_to_gif.ps1. */
function runCustomScript(script: string, file: string, opts: ConvertOptions, token: vscode.CancellationToken): Promise<boolean> {
  const args = [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
    "-Path", file,
    "-Fps", String(opts.fps),
    "-Width", String(opts.width),
    "-Height", String(opts.height),
    // Full opacity: the panel's Opacity slider darkens wallpapers live instead.
    "-Opacity", "100",
    "-BackgroundColor", "black",
    "-StartSeconds", String(opts.startSeconds),
    "-DurationSeconds", String(opts.durationSeconds),
  ];
  if (opts.destination) args.push("-Destination", opts.destination);

  return new Promise((resolve) => {
    const shell = powershellExecutable();
    const child = spawn(shell, args, { windowsHide: true });
    const cancel = token.onCancellationRequested(() => child.kill());
    child.stdout.on("data", (d) => log(String(d).trimEnd()));
    child.stderr.on("data", (d) => log(String(d).trimEnd()));
    child.on("error", (err) => {
      log(`Could not start ${shell}: ${err}${isWindows ? "" : " (install PowerShell 7 to use a .ps1 converter)"}`);
      cancel.dispose();
      resolve(false);
    });
    child.on("close", (code) => {
      cancel.dispose();
      resolve(code === 0);
    });
  });
}

/** Move a finished file into place; rename fails across drives, so fall back to copy + delete. */
async function moveFile(from: string, to: string) {
  try {
    await fs.promises.rename(from, to);
  } catch {
    await fs.promises.copyFile(from, to);
    await fs.promises.unlink(from);
  }
}

/**
 * Render into the temp folder and move the file into place only when it's complete, so a cancelled
 * or failed run never leaves a half-written file that later runs would skip as "already done".
 */
async function renderViaTemp(outPath: string, render: (temp: string) => Promise<boolean>): Promise<boolean> {
  const temp = path.join(os.tmpdir(), `doki-carousel-${crypto.randomUUID()}${path.extname(outPath)}`);
  try {
    if ((await render(temp)) && fs.existsSync(temp)) {
      await moveFile(temp, outPath);
      return true;
    }
  } catch (err) {
    log(`  ${err}`);
  } finally {
    fs.promises.unlink(temp).catch(() => undefined);
  }
  return false;
}

export async function convertMp4(files: string[], opts: ConvertOptions): Promise<string[]> {
  const script = vscode.workspace.getConfiguration("dokiCarousel").get<string>("converterScript", "").trim();
  let ffmpeg: string | undefined;
  if (script) {
    if (!fs.existsSync(script)) {
      vscode.window.showErrorMessage(`Converter script not found: ${script}`);
      return [];
    }
  } else {
    ffmpeg = findTool("ffmpeg");
    if (!ffmpeg) {
      warnFfmpegMissing();
      return [];
    }
  }
  const lock = beginTask("Converting to GIF");
  if (!lock) return [];

  const created: string[] = [];
  let skipped = 0;
  let failed = 0;
  let cancelled = false;
  // Released once the GIFs are written, not when the summary below is dismissed.
  try {
    if (opts.destination) fs.mkdirSync(opts.destination, { recursive: true });
    output?.clear();
    output?.show(true);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Converting to GIF", cancellable: true },
      async (progress, token) => {
        for (const [i, file] of files.entries()) {
          if (token.isCancellationRequested) break;
          progress.report({ message: `${i + 1}/${files.length} ${path.basename(file)}`, increment: 100 / files.length });
          const outDir = opts.destination || path.dirname(file);
          const outPath = path.join(outDir, path.basename(file, path.extname(file)) + ".gif");
  
          log(`> ${path.basename(file)}`);
          if (fs.existsSync(outPath)) {
            log(`  skipped: ${path.basename(outPath)} already exists in ${outDir}`);
            skipped++;
            continue;
          }
  
          let ok = false;
          if (ffmpeg) {
            const tool = ffmpeg;
            ok = await renderViaTemp(outPath, (temp) => convertOne(tool, file, temp, opts, token));
          } else {
            const startedAt = Date.now();
            await runCustomScript(script, file, opts, token);
            // A script may report failures as warnings with exit code 0, so check the output file.
            ok = fs.existsSync(outPath) && fs.statSync(outPath).mtimeMs >= startedAt - 1000;
          }
  
          if (ok) {
            created.push(outPath);
            log(`  OK -> ${outPath}`);
          } else if (token.isCancellationRequested) {
            cancelled = true;
            log(`  cancelled: ${path.basename(file)}`);
          } else {
            failed++;
            log(`  no GIF produced for ${path.basename(file)}`);
          }
        }
      }
    );
  } finally {
    lock.dispose();
  }

  const parts = [`${created.length} created`];
  if (skipped) parts.push(`${skipped} skipped (GIF already exists)`);
  if (failed) parts.push(`${failed} failed`);
  if (cancelled) parts.push("cancelled");
  const action = await vscode.window.showInformationMessage(`GIF conversion: ${parts.join(", ")}.`, "Show Details");
  if (action) output?.show(true);
  return created;
}

// ---------------------------------------------------------------- shared steps of the file tools

/** One file to process and where its result goes. */
interface FileJob {
  file: string;
  out: string;
}

/** Results keep their names; an empty destination means each file's own folder, i.e. replacing it. */
function jobsFor(files: string[], destination: string): FileJob[] {
  return files.map((file) => ({ file, out: path.join(destination || path.dirname(file), path.basename(file)) }));
}

/**
 * Ask before anything is overwritten: results written over their own source replace the original
 * with no copy kept, and others may land on a file of the same name in the destination.
 */
async function confirmOverwrite(tool: string, jobs: FileJob[], note?: string): Promise<boolean> {
  const replacing = jobs.filter((j) => samePath(j.file, j.out)).length;
  const overwriting = jobs.filter((j) => !samePath(j.file, j.out) && fs.existsSync(j.out)).length;
  if (!replacing && !overwriting) return true;
  const count = replacing + overwriting;
  const what = count === 1 ? path.basename(jobs.find((j) => samePath(j.file, j.out) || fs.existsSync(j.out))!.out) : `${count} files`;
  const detail: string[] = [];
  if (replacing) {
    detail.push(
      `${replacing === 1 ? "The original is" : `${replacing} originals are`} replaced by the new version, because the destination is the folder the files come from. No copy of the original is kept.`
    );
  }
  if (overwriting) detail.push(`${overwriting === 1 ? "A file" : `${overwriting} files`} with the same name in the destination folder will be overwritten.`);
  if (note) detail.push(note);
  detail.push("To keep the originals, choose another destination folder.");
  const choice = await vscode.window.showWarningMessage(`${tool}: replace ${what}?`, { modal: true, detail: detail.join("\n\n") }, "Replace");
  return choice === "Replace";
}

type Outcome = "done" | "failed" | { skipped: string };

/**
 * Run a tool over files with the task lock, a cancellable progress notification and a log line
 * per file. Each result is rendered aside first (renderViaTemp), so a failure or a cancel leaves
 * the file as it was.
 */
async function runFileTool(task: string, title: string, jobs: FileJob[], work: (job: FileJob, token: vscode.CancellationToken) => Promise<Outcome>): Promise<string[]> {
  const lock = beginTask(task);
  if (!lock) return [];
  const written: string[] = [];
  let skipped = 0;
  let failed = 0;
  let cancelled = false;
  // Released once the files are written, not when the summary is dismissed.
  try {
    output?.clear();
    output?.show(true);
    log(`${title}: ${jobs.length} file(s)`);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
      for (const [i, job] of jobs.entries()) {
        if (token.isCancellationRequested) break;
        progress.report({ message: `${i + 1}/${jobs.length} ${path.basename(job.file)}`, increment: 100 / jobs.length });
        log(`> ${path.basename(job.file)}`);
        let outcome: Outcome = "failed";
        try {
          outcome = await work(job, token);
        } catch (err) {
          log(`  ${err}`);
        }
        if (outcome === "done") {
          written.push(job.out);
          log(`  OK -> ${job.out}`);
        } else if (typeof outcome === "object") {
          skipped++;
          log(`  skipped: ${outcome.skipped}`);
        } else if (token.isCancellationRequested) {
          cancelled = true;
          log(`  cancelled, left unchanged: ${path.basename(job.file)}`);
        } else {
          failed++;
          log(`  failed, left unchanged: ${path.basename(job.file)}`);
        }
      }
    });
  } finally {
    lock.dispose();
  }

  const parts = [`${written.length} done`];
  if (skipped) parts.push(`${skipped} skipped`);
  if (failed) parts.push(`${failed} failed`);
  if (cancelled) parts.push("cancelled");
  await reportAndReload(`${title}: ${parts.join(", ")}.`, written);
  return written;
}

/**
 * Report the result. When the wallpaper in use was rewritten, Doki still shows its old content,
 * so it is applied again right away (which reopens the window) once every file is done.
 */
async function reportAndReload(message: string, written: string[]) {
  const current = getCurrentDokiPath();
  if (current && written.some((f) => samePath(f, current))) {
    vscode.window.showInformationMessage(`${message} Loading the new version of the current wallpaper…`);
    await applyWallpaper(current);
    return;
  }
  const action = await vscode.window.showInformationMessage(message, "Show Details");
  if (action) output?.show(true);
}

// ---------------------------------------------------------------- gif optimization

export interface OptimizeOptions {
  /** 0 = keep the GIF's own frame rate */
  fps: number;
  /** 0 = keep */
  width: number;
  /** -1 = keep the aspect ratio */
  height: number;
  startSeconds: number;
  /** 0 = up to the end */
  durationSeconds: number;
  /** Empty = the GIFs' own folder, replacing them */
  destination: string;
}

export const defaultOptimizeOptions: OptimizeOptions = {
  fps: 0,
  width: 0,
  height: -1,
  startSeconds: 0,
  durationSeconds: 0,
  destination: "",
};

/** The ffmpeg filters for these settings; empty when they change nothing. */
function optimization(opts: OptimizeOptions): string {
  const fps = Math.max(0, Math.round(num(opts.fps, 0)));
  const width = Math.max(0, Math.round(num(opts.width, 0)));
  const height = Math.round(num(opts.height, -1));
  const start = Math.max(0, num(opts.startSeconds, 0));
  const duration = Math.max(0, num(opts.durationSeconds, 0));
  const filters: string[] = [];
  // Trimmed in the filter graph, exact to the frame. Output -ss/-t would also drop the palette,
  // which palettegen emits as one frame at the end, and the second pass would find no palette.
  if (start > 0 || duration > 0) {
    filters.push(`trim=${[...(start > 0 ? [`start=${start}`] : []), ...(duration > 0 ? [`duration=${duration}`] : [])].join(":")}`, "setpts=PTS-STARTPTS");
  }
  if (fps > 0) filters.push(`fps=${fps}`);
  if (width > 0 || height > 0) filters.push(`scale=${width > 0 ? width : -1}:${height > 0 ? height : -1}:flags=lanczos`);
  return filters.join(",");
}

/** Same two-pass palette as the .mp4 conversion, so the smaller GIF keeps its colors. */
async function optimizeOne(ffmpeg: string, file: string, outPath: string, filters: string, token: vscode.CancellationToken): Promise<boolean> {
  const palette = path.join(os.tmpdir(), `doki-carousel-palette-${crypto.randomUUID()}.png`);
  const quiet = ["-loglevel", "error"];
  try {
    const paletteArgs = ["-y", "-i", file, "-vf", `${filters},palettegen=stats_mode=diff`, ...quiet, palette];
    if (!(await runFfmpeg(ffmpeg, paletteArgs, token))) return false;
    // A fragment with no frames (Start past the end) leaves no palette.
    if (!fs.existsSync(palette)) {
      log("  no frames to keep: is Start past the end of the GIF?");
      return false;
    }
    const gifArgs = ["-y", "-i", file, "-i", palette, "-lavfi", `${filters} [x]; [x][1:v] paletteuse=dither=sierra2_4a`, ...quiet, outPath];
    return await runFfmpeg(ffmpeg, gifArgs, token);
  } finally {
    fs.promises.unlink(palette).catch(() => undefined);
  }
}

/** Make GIFs lighter: fewer frames per second, a smaller size and/or only a fragment. */
export async function optimizeGifs(files: string[], opts: OptimizeOptions): Promise<string[]> {
  const ffmpeg = findTool("ffmpeg");
  if (!ffmpeg) {
    warnFfmpegMissing();
    return [];
  }
  const filters = optimization(opts);
  if (!filters) {
    vscode.window.showWarningMessage("These options keep the GIFs as they are. Set a lower FPS, a new size or a fragment to keep first.");
    return [];
  }
  const jobs = jobsFor(files, opts.destination);
  if (!(await confirmOverwrite("GIF optimization", jobs))) return [];
  if (opts.destination) fs.mkdirSync(opts.destination, { recursive: true });

  return runFileTool("Optimizing GIFs", "GIF optimization", jobs, async ({ file, out }, token) => {
    if (path.extname(file).toLowerCase() !== ".gif") return { skipped: "not a GIF" };
    return (await renderViaTemp(out, (temp) => optimizeOne(ffmpeg, file, temp, filters, token))) ? "done" : "failed";
  });
}
