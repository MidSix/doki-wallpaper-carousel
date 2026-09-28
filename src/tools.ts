import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFile, spawn } from "child_process";
import * as crypto from "crypto";
import * as os from "os";
import { findTool, isWindows, powershellExecutable, samePath, warnFfmpegMissing } from "./platform";
import { applyWallpaper, beginTask, getCurrentDokiPath } from "./doki";
import { OpacityPlan, isAnimated, opacityPlan } from "./formats";

let output: vscode.OutputChannel | undefined;
let store: vscode.Memento | undefined;

/** Remembers the opacity Set opacity gave each file, so it can be reset. */
export function initTools(context: vscode.ExtensionContext) {
  store = context.globalState;
  if (store.get(OLD_DIMMED_KEY) !== undefined) store.update(OLD_DIMMED_KEY, undefined);
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
  opacity: number;
  startSeconds: number;
  durationSeconds: number;
  /** Empty = next to each .mp4 */
  destination: string;
}

export const defaultConvertOptions: ConvertOptions = {
  fps: 12,
  width: 480,
  height: -1,
  opacity: 100,
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
    opacity: Math.min(100, Math.max(0, num(opts.opacity, 100))),
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
  let filters = `fps=${o.fps},scale=${o.width}:${o.height}:flags=lanczos`;
  if (o.opacity < 100) {
    // A GIF has no real alpha: fake opacity by covering the video with black at
    // (100 - opacity)%, so opacity 25 leaves the video at 25% brightness. Always black: that is a
    // plain multiplication of every pixel, which the hover previews can undo (thumbnails.ts).
    // drawbox works on every ffmpeg version, unlike scale2ref's ref_w/ref_h (ffmpeg 7+ only).
    const cover = ((100 - o.opacity) / 100).toFixed(3);
    filters += `,drawbox=x=0:y=0:w=iw:h=ih:color=black@${cover}:t=fill`;
  }
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
    "-Opacity", String(opts.opacity),
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

// ---------------------------------------------------------------- opacity records

export interface DimOptions {
  /** 5–100: how visible the wallpaper stays over black */
  opacity: number;
  /** Empty = each file's own folder, replacing it */
  destination: string;
}

export const defaultDimOptions: DimOptions = {
  opacity: 40,
  destination: "",
};

/** At 0 % a file would turn black for good, with nothing left to brighten back. */
export function dimOpacity(opts: DimOptions): number {
  return Math.min(100, Math.max(5, Math.round(num(opts.opacity, defaultDimOptions.opacity))));
}

const OPACITY_KEY = "dokiCarousel.opacityRecords";
// Records of the copies written by earlier development versions, no longer used.
const OLD_DIMMED_KEY = "dokiCarousel.dimmedCopies";

/** What Set opacity did to a file, and the file as it left it (to notice later changes). */
interface OpacityRecord {
  /** Total opacity, 0–100: setting 50 % twice gives 25 %. */
  opacity: number;
  size: number;
  mtime: number;
}

function opacityRecords(): Record<string, OpacityRecord> {
  return store?.get<Record<string, OpacityRecord>>(OPACITY_KEY, {}) ?? {};
}

function findRecordKey(records: Record<string, OpacityRecord>, file: string): string | undefined {
  return Object.keys(records).find((key) => samePath(key, file));
}

/** The record of this file, as long as it is still the file Set opacity wrote. */
function opacityRecord(file: string): OpacityRecord | undefined {
  const records = opacityRecords();
  const key = findRecordKey(records, file);
  if (!key) return undefined;
  try {
    const stat = fs.statSync(file);
    if (stat.size === records[key].size && Math.round(stat.mtimeMs) === records[key].mtime) return records[key];
  } catch {
    // Gone.
  }
  return undefined;
}

/** Remember the total opacity of a file just written, or forget it (undefined). */
async function saveOpacityRecord(file: string, opacity: number | undefined) {
  const records = opacityRecords();
  const key = findRecordKey(records, file);
  if (key) delete records[key];
  if (opacity !== undefined && opacity < 100) {
    const stat = fs.statSync(file);
    records[path.resolve(file)] = { opacity, size: stat.size, mtime: Math.round(stat.mtimeMs) };
  }
  await store?.update(OPACITY_KEY, records);
}

function probe(ffprobe: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ffprobe, args, { windowsHide: true, timeout: 60000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** How ffmpeg rewrites this file (see formats.ts); an animated AVIF needs its stream of frames. */
async function planFor(file: string): Promise<OpacityPlan> {
  let sequence: number | undefined;
  const ffprobe = findTool("ffprobe");
  if (path.extname(file).toLowerCase() === ".avif" && isAnimated(file) && ffprobe) {
    try {
      // An animated AVIF also holds a still cover image: take the stream with the most frames.
      const streams = (await probe(ffprobe, ["-v", "error", "-show_entries", "stream=index,nb_frames", "-of", "csv=p=0", file]))
        .trim()
        .split(/\r?\n/)
        .map((line) => line.split(",").map(Number));
      sequence = streams.reduce((best, s) => ((s[1] || 0) > (best[1] || 0) ? s : best))[0];
    } catch {
      // Then ffmpeg picks the stream, which gives a still image.
    }
  }
  return opacityPlan(file, sequence);
}

/** Run a color filter over a wallpaper, keeping its format, size, frame timing and transparency. */
async function filterWallpaper(ffmpeg: string, file: string, plan: OpacityPlan, outPath: string, filter: string, token: vscode.CancellationToken): Promise<boolean> {
  const quiet = ["-loglevel", "error"];
  if (plan.kind === "single") return runFfmpeg(ffmpeg, ["-y", "-i", file, "-vf", filter, ...plan.output, ...quiet, outPath], token);
  if (plan.kind !== "gif") return false;
  // A GIF has at most 256 colors: a new palette for the new colors, then the GIF using it.
  const palette = path.join(os.tmpdir(), `doki-carousel-palette-${crypto.randomUUID()}.png`);
  try {
    const paletteArgs = ["-y", "-i", file, "-vf", `${filter},palettegen=stats_mode=diff`, ...quiet, palette];
    if (!(await runFfmpeg(ffmpeg, paletteArgs, token))) return false;
    const gifArgs = ["-y", "-i", file, "-i", palette, "-lavfi", `${filter} [x]; [x][1:v] paletteuse=dither=sierra2_4a`, ...quiet, outPath];
    return await runFfmpeg(ffmpeg, gifArgs, token);
  } finally {
    fs.promises.unlink(palette).catch(() => undefined);
  }
}

/**
 * Same "video opacity" as the .mp4 conversion, applied to an existing wallpaper: every pixel is
 * multiplied by opacity / 100, i.e. blended with black, so the hover previews can undo it too
 * (thumbnails.ts). Unlike drawbox, colorchannelmixer leaves the alpha channel alone, so
 * transparent pixels stay transparent. Without an fps filter ffmpeg keeps each frame's delay.
 */
function dimFilter(opacity: number): string {
  const f = (opacity / 100).toFixed(3);
  return `colorchannelmixer=rr=${f}:gg=${f}:bb=${f}`;
}

/**
 * Undo the darkening by dividing every pixel by the opacity. Only approximate: the darker
 * file has fewer color levels (at 25 % only a quarter are left) and was compressed again, so
 * fine gradients come back with some banding. lutrgb because colorchannelmixer can't go above
 * 2x; it leaves the alpha channel alone as well.
 */
function brightenFilter(opacity: number): string {
  const g = (100 / opacity).toFixed(3);
  return `lutrgb=r=clipval*${g}:g=clipval*${g}:b=clipval*${g}`;
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

// ---------------------------------------------------------------- set opacity

/** Write a darker version of each wallpaper; into its own folder, that replaces it (after asking). */
export async function dimWallpapers(files: string[], opts: DimOptions): Promise<string[]> {
  const ffmpeg = findTool("ffmpeg");
  if (!ffmpeg) {
    warnFfmpegMissing();
    return [];
  }
  const opacity = dimOpacity(opts);
  if (opacity >= 100) {
    vscode.window.showWarningMessage("At 100% opacity the wallpapers would stay as they are. Move the slider down to darken them.");
    return [];
  }
  const jobs = jobsFor(files, opts.destination);
  if (!(await confirmOverwrite("Set opacity", jobs, `The new version is at ${opacity}% opacity (over black). Reset opacity can brighten it back, but only approximately.`))) return [];
  if (opts.destination) fs.mkdirSync(opts.destination, { recursive: true });

  return runFileTool("Setting opacity", `Set opacity to ${opacity}%`, jobs, async ({ file, out }, token) => {
    const plan = await planFor(file);
    if (plan.kind === "unsupported") return { skipped: plan.reason };
    // Read before anything changes: a file darkened again gets darker still (50 % of 50 % = 25 %).
    const before = opacityRecord(file)?.opacity ?? 100;
    if (!(await renderViaTemp(out, (temp) => filterWallpaper(ffmpeg, file, plan, temp, dimFilter(opacity), token)))) return "failed";
    await saveOpacityRecord(out, (before * opacity) / 100);
    return "done";
  });
}

// ---------------------------------------------------------------- reset opacity

/**
 * Undo "Set opacity" by brightening each file back, in place. Only approximate: see
 * brightenFilter(). Files not written by Set opacity, or edited since, are left alone.
 */
export async function resetDimming(files: string[]): Promise<void> {
  const known = files.filter((file) => opacityRecord(file));
  const unknown = files.length - known.length;
  if (!known.length) {
    vscode.window.showInformationMessage(
      "None of these files were changed with Set opacity (or they were edited since), so there is nothing to reset. For a GIF converted from a video, convert the .mp4 again at 100% opacity."
    );
    return;
  }
  const ffmpeg = findTool("ffmpeg");
  if (!ffmpeg) {
    warnFfmpegMissing();
    return;
  }

  const what = known.length === 1 ? path.basename(known[0]) : `${known.length} wallpapers`;
  const detail = [
    "Each file is replaced by a brighter version that undoes Set opacity. The result is close to the original but not identical: some detail was lost when it was darkened.",
  ];
  if (unknown) detail.push(`${unknown} other file(s) will be left alone: not changed with Set opacity, or edited since.`);
  const confirm = await vscode.window.showWarningMessage(`Brighten ${what} back?`, { modal: true, detail: detail.join("\n\n") }, "Reset");
  if (confirm !== "Reset") return;

  await runFileTool("Resetting opacity", "Reset opacity", jobsFor(known, ""), async ({ file }, token) => {
    const record = opacityRecord(file);
    if (!record) return { skipped: "edited since it was darkened" };
    const plan = await planFor(file);
    if (plan.kind === "unsupported") return { skipped: plan.reason };
    if (!(await renderViaTemp(file, (temp) => filterWallpaper(ffmpeg, file, plan, temp, brightenFilter(record.opacity), token)))) return "failed";
    await saveOpacityRecord(file, undefined);
    return "done";
  });
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

/** The ffmpeg filters and trim options for these settings; empty when they change nothing. */
function optimization(opts: OptimizeOptions): { filters: string; trim: string[] } {
  const fps = Math.max(0, Math.round(num(opts.fps, 0)));
  const width = Math.max(0, Math.round(num(opts.width, 0)));
  const height = Math.round(num(opts.height, -1));
  const start = Math.max(0, num(opts.startSeconds, 0));
  const duration = Math.max(0, num(opts.durationSeconds, 0));
  const filters: string[] = [];
  if (fps > 0) filters.push(`fps=${fps}`);
  if (width > 0 || height > 0) filters.push(`scale=${width > 0 ? width : -1}:${height > 0 ? height : -1}:flags=lanczos`);
  // Output options, after the input: exact to the frame, unlike seeking in the GIF itself.
  const trim = [...(start > 0 ? ["-ss", String(start)] : []), ...(duration > 0 ? ["-t", String(duration)] : [])];
  return { filters: filters.join(","), trim };
}

/** Same two-pass palette as the .mp4 conversion, so the smaller GIF keeps its colors. */
async function optimizeOne(ffmpeg: string, file: string, outPath: string, filters: string, trim: string[], token: vscode.CancellationToken): Promise<boolean> {
  const palette = path.join(os.tmpdir(), `doki-carousel-palette-${crypto.randomUUID()}.png`);
  const quiet = ["-loglevel", "error"];
  try {
    const paletteArgs = ["-y", "-i", file, ...trim, "-vf", `${filters ? `${filters},` : ""}palettegen=stats_mode=diff`, ...quiet, palette];
    if (!(await runFfmpeg(ffmpeg, paletteArgs, token))) return false;
    const gifArgs = ["-y", "-i", file, "-i", palette, ...trim, "-lavfi", `${filters || "null"} [x]; [x][1:v] paletteuse=dither=sierra2_4a`, ...quiet, outPath];
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
  const { filters, trim } = optimization(opts);
  if (!filters && !trim.length) {
    vscode.window.showWarningMessage("These options keep the GIFs as they are. Set a lower FPS, a new size or a fragment to keep first.");
    return [];
  }
  const jobs = jobsFor(files, opts.destination);
  if (!(await confirmOverwrite("GIF optimization", jobs))) return [];
  if (opts.destination) fs.mkdirSync(opts.destination, { recursive: true });

  return runFileTool("Optimizing GIFs", "GIF optimization", jobs, async ({ file, out }, token) => {
    if (path.extname(file).toLowerCase() !== ".gif") return { skipped: "not a GIF" };
    const darkened = opacityRecord(file);
    if (!(await renderViaTemp(out, (temp) => optimizeOne(ffmpeg, file, temp, filters, trim, token)))) return "failed";
    // Still as dark as before: Reset opacity must keep working on the new file.
    if (darkened) await saveOpacityRecord(out, darkened.opacity);
    return "done";
  });
}
