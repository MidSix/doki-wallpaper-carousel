import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ImageRoom, applyWallpaper, formatSize, getCurrentDokiPath, imageRoom, tooLargeReason } from "./doki";
import { WALLPAPER_EXTENSIONS } from "./formats";
import { samePath } from "./platform";

export type SortBy = "name" | "modified" | "created" | "size" | "random";

export interface WallpaperFile {
  path: string;
  name: string;
  size: number;
  modified: number;
  created: number;
}

const SHUFFLE_SEED_KEY = "dokiCarousel.shuffleSeed";

function config() {
  return vscode.workspace.getConfiguration("dokiCarousel");
}

function listFiles(dir: string, recursive: boolean, exts: Set<string>, out: WallpaperFile[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) listFiles(full, recursive, exts, out);
    } else if (entry.isFile() && exts.has(path.extname(entry.name).toLowerCase())) {
      const stat = fs.statSync(full);
      out.push({
        path: full,
        name: path.relative(config().get<string>("folder", ""), full),
        size: stat.size,
        modified: stat.mtimeMs,
        // Some Linux file systems don't record a creation time (reported as 0).
        created: stat.birthtimeMs || stat.mtimeMs,
      });
    }
  }
}

// Deterministic shuffle, so "random" order stays stable between window reloads.
function seededShuffle<T>(items: T[], seed: number): T[] {
  const result = [...items];
  let s = seed >>> 0 || 1;
  const rand = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export class Carousel {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private cache: WallpaperFile[] | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  refresh() {
    this.cache = undefined;
    this._onDidChange.fire();
  }

  reshuffle() {
    this.context.globalState.update(SHUFFLE_SEED_KEY, Math.floor(Math.random() * 2 ** 31));
    this.refresh();
  }

  files(): WallpaperFile[] {
    if (this.cache) return this.cache;
    const folder = config().get<string>("folder", "");
    if (!folder || !fs.existsSync(folder)) return (this.cache = []);

    const exts = new Set(config().get<string[]>("extensions", WALLPAPER_EXTENSIONS).map((e) => e.toLowerCase()));
    const files: WallpaperFile[] = [];
    listFiles(folder, config().get<boolean>("includeSubfolders", false), exts, files);

    const sortBy = config().get<SortBy>("sortBy", "name");
    let sorted: WallpaperFile[];
    if (sortBy === "random") {
      sorted = seededShuffle(files, this.context.globalState.get<number>(SHUFFLE_SEED_KEY, 1));
    } else {
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      const compare: Record<Exclude<SortBy, "random">, (a: WallpaperFile, b: WallpaperFile) => number> = {
        name: (a, b) => collator.compare(a.name, b.name),
        modified: (a, b) => a.modified - b.modified,
        created: (a, b) => a.created - b.created,
        size: (a, b) => a.size - b.size,
      };
      sorted = files.sort(compare[sortBy]);
      if (config().get<string>("sortOrder", "asc") === "desc") sorted.reverse();
    }
    return (this.cache = sorted);
  }

  currentIndex(): number {
    const current = getCurrentDokiPath();
    if (!current) return -1;
    return this.files().findIndex((f) => samePath(f.path, current));
  }

  async step(delta: number) {
    const files = this.files();
    if (files.length === 0) {
      const choice = await vscode.window.showInformationMessage("No wallpapers found. Set a folder first.", "Set Folder");
      if (choice) await vscode.commands.executeCommand("dokiCarousel.setFolder");
      return;
    }
    const index = this.currentIndex();
    const n = files.length;
    // Not in the list yet: "next" starts at the first file, "previous" at the last one.
    const order = files.map((_, i) => (index === -1 ? (delta > 0 ? i : n - 1 - i) : (((index + delta * (i + 1)) % n) + n) % n));
    // Files VS Code can't load are skipped; the list marks them.
    const room = imageRoom();
    const next = order.find((i) => !tooLargeReason(files[i].size, room));
    if (next === undefined) return this.reportNoneFits(room);
    await applyWallpaper(files[next].path);
  }

  async random() {
    const files = this.files();
    if (files.length === 0) return this.step(1);
    const index = this.currentIndex();
    const room = imageRoom();
    const fitting = files.map((_, i) => i).filter((i) => !tooLargeReason(files[i].size, room));
    if (!fitting.length) return this.reportNoneFits(room);
    const others = fitting.filter((i) => i !== index);
    const pool = others.length ? others : fitting;
    await applyWallpaper(files[pool[Math.floor(Math.random() * pool.length)]].path);
  }

  private reportNoneFits(room: ImageRoom) {
    const why = room.other ? `, since ${room.other} is installed too` : "";
    vscode.window.showWarningMessage(`No wallpaper in the folder is small enough: the largest VS Code can load now is ${formatSize(room.now)}${why}. Make them lighter with GIF optimization.`);
  }
}
