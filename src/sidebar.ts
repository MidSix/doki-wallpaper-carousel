import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Carousel } from "./carousel";
import { applyWallpaper, currentTask, getCurrentDokiPath, imageRoom, isSwitching, isWallpaperShown, onDidChangeSwitching, onDidChangeTask, removeWallpaper, shownImages, tooLargeReason } from "./doki";
import { LoopAnalysis, analyzeLoops, isStill } from "./loops";
import { disablePaletteTheme, enablePaletteTheme } from "./paletteTheme";
import { findTool, samePath } from "./platform";
import { Thumbnails } from "./thumbnails";
import { WALLPAPER_EXTENSIONS, isAnimated } from "./formats";
import { ConvertOptions, OptimizeOptions, convertMp4, defaultConvertOptions, defaultOptimizeOptions, extractMp4, optimizeGifs } from "./tools";

const CONVERT_OPTIONS_KEY = "dokiCarousel.convertOptions";
const OPTIMIZE_OPTIONS_KEY = "dokiCarousel.optimizeOptions";
// Files picked in the panel for each tool, kept until they are picked again.
const PICKED_KEY: Record<FileTool, string> = { optimize: "dokiCarousel.optimizeFiles" };

export type FileTool = "optimize";
const TOOL_SECTION: Record<FileTool, string> = { optimize: "secOptimize" };
const EXTRACT_SOURCE_KEY = "dokiCarousel.extractSource";
const EXTRACT_DEST_KEY = "dokiCarousel.extractDestination";

type Message =
  | { type: "ready" | "refresh" | "prev" | "next" | "random" | "reshuffle" | "setFolder" | "previewPalette" | "removeWallpaper" }
  | { type: "sort"; value: string }
  | { type: "apply"; path: string }
  | { type: "setOption"; key: string; value: unknown }
  | { type: "opacity"; value: number }
  | { type: "wallpaperTheme"; enabled: boolean }
  | { type: "browseDir"; field: string; current?: string }
  | { type: "extract"; source: string; destination: string; move: boolean }
  | { type: "convert"; options: ConvertOptions }
  | { type: "pickFiles"; tool: FileTool }
  | { type: "optimize"; options: OptimizeOptions };

interface LoopJob {
  /** The file as it was analyzed: a new version (after optimizing it) is analyzed again. */
  key: string;
  status: "running" | "done" | "failed" | "noFfmpeg";
  seconds: number;
  analysis?: LoopAnalysis;
  cancel?: () => void;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  // Messages sent while the panel's page is (re)loading are lost, so a section to open waits for it.
  private pageReady = false;
  private pendingSection: string | undefined;
  /** Loops of the one GIF picked in GIF optimization (see loops.ts), kept while it stays picked. */
  private loop: LoopJob | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly carousel: Carousel,
    private readonly thumbnails: Thumbnails
  ) {
    carousel.onDidChange(() => this.postState());
    onDidChangeSwitching((busy) => this.view?.webview.postMessage({ type: "busy", busy }));
    onDidChangeTask((task) => this.view?.webview.postMessage({ type: "task", task: task ?? "" }));
    thumbnails.onDidCreate(({ file, thumb }) => {
      if (!this.view) return;
      const uri = this.view.webview.asWebviewUri(vscode.Uri.file(thumb)).toString();
      this.view.webview.postMessage({ type: "thumb", path: file, thumb: uri });
      const current = getCurrentDokiPath();
      if (current && samePath(file, current)) this.view.webview.postMessage({ type: "currentThumb", thumb: uri });
    });
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.pageReady = false;
    view.webview.options = { enableScripts: true, localResourceRoots: this.resourceRoots() };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: Message) => this.onMessage(msg));
    view.onDidChangeVisibility(() => {
      // A hidden panel loses its page and loads it again when shown.
      if (!view.visible) this.pageReady = false;
      else this.postState();
    });
  }

  /** Show a tool's section in the panel, with `files` picked for it when given. */
  async openTool(tool: FileTool, files?: string[]) {
    if (files?.length) await this.context.globalState.update(PICKED_KEY[tool], files);
    this.pendingSection = TOOL_SECTION[tool];
    await vscode.commands.executeCommand("dokiCarousel.panel.focus");
    this.postState();
  }

  private resourceRoots(): vscode.Uri[] {
    const roots = [vscode.Uri.joinPath(this.context.extensionUri, "media"), vscode.Uri.file(this.thumbnails.folder)];
    const folder = vscode.workspace.getConfiguration("dokiCarousel").get<string>("folder", "");
    if (folder) roots.push(vscode.Uri.file(folder));
    const current = getCurrentDokiPath();
    if (current) roots.push(vscode.Uri.file(path.dirname(current)));
    return roots;
  }

  postState() {
    if (!this.view) return;
    const webview = this.view.webview;
    // Roots depend on the configured folder, so refresh them before sending image URIs.
    webview.options = { enableScripts: true, localResourceRoots: this.resourceRoots() };

    const cfg = vscode.workspace.getConfiguration("dokiCarousel");
    const files = this.carousel.files();
    const current = getCurrentDokiPath();
    const folder = cfg.get<string>("folder", "");
    const room = imageRoom();
    const openSection = this.pageReady ? this.pendingSection : undefined;
    if (openSection) this.pendingSection = undefined;
    webview.postMessage({
      type: "state",
      folder,
      // Hover previews use cached static thumbnails, never the (possibly huge) animated GIFs.
      files: files.map((f) => {
        const thumb = this.thumbnails.get(f.path);
        return {
          path: f.path,
          name: f.name,
          thumb: thumb ? webview.asWebviewUri(vscode.Uri.file(thumb)).toString() : "",
          tooLarge: tooLargeReason(f.size, room),
        };
      }),
      openSection: openSection ?? "",
      currentIndex: this.carousel.currentIndex(),
      current: current ?? "",
      wallpaperShown: isWallpaperShown(),
      shown: shownImages(),
      currentUri: this.previewUri(webview, current),
      sortBy: cfg.get("sortBy"),
      sortOrder: cfg.get("sortOrder"),
      includeSubfolders: cfg.get("includeSubfolders"),
      target: cfg.get("target"),
      busy: isSwitching(),
      task: currentTask() ?? "",
      quickInputTint: cfg.get("quickInputTint"),
      wallpaperTheme: cfg.get<boolean>("wallpaperTheme", false),
      paletteSource: cfg.get<string>("paletteSource", "wallpaper") === "background" ? "background" : "wallpaper",
      opacity: { wallpaper: cfg.get<number>("wallpaperOpacity", 100), background: cfg.get<number>("backgroundOpacity", 100) },
      thumbsAvailable: this.thumbnails.available,
      transparentPanels: cfg.get("transparentPanels"),
      transparentTerminal: cfg.get("transparentTerminal"),
      wallpaperInEditor: cfg.get("wallpaperInEditor"),
      brightenThumbnails: cfg.get("brightenThumbnails"),
      convert: { ...defaultConvertOptions, ...this.context.globalState.get<Partial<ConvertOptions>>(CONVERT_OPTIONS_KEY, {}) },
      optimize: { ...defaultOptimizeOptions, ...this.context.globalState.get<Partial<OptimizeOptions>>(OPTIMIZE_OPTIONS_KEY, {}) },
      optimizeFiles: this.pickedFiles("optimize"),
      extractSource: this.context.globalState.get<string>(EXTRACT_SOURCE_KEY, ""),
      extractDestination: this.context.globalState.get<string>(EXTRACT_DEST_KEY, folder ? path.join(folder, "mp4") : ""),
    });
    // The current wallpaper first, so the preview at the top is ready before the hover previews.
    this.thumbnails.request([...(current ? [current] : []), ...files.map((f) => f.path)]);
    this.updateLoops();
  }

  /** Find the loops of the GIF picked for optimization, when it is the only one picked. */
  private updateLoops() {
    const picked = this.pickedFiles("optimize");
    const file = picked.length === 1 && path.extname(picked[0]).toLowerCase() === ".gif" ? picked[0] : undefined;
    let key = "";
    try {
      if (file) {
        const stat = fs.statSync(file);
        key = `${file}|${stat.size}|${stat.mtimeMs}`;
      }
    } catch {
      // Gone since it was picked.
    }
    if (this.loop?.key !== key) {
      this.loop?.cancel?.();
      this.loop = undefined;
      if (key && file) this.loop = this.startLoops(file, key);
    }
    this.postLoops();
  }

  private startLoops(file: string, key: string): LoopJob {
    const ffmpeg = findTool("ffmpeg");
    if (!ffmpeg) return { key, status: "noFfmpeg", seconds: 0 };
    const job: LoopJob = { key, status: "running", seconds: 0 };
    const analysis = analyzeLoops(ffmpeg, file, (seconds) => {
      job.seconds = seconds;
      if (this.loop === job) this.postLoops();
    });
    job.cancel = analysis.cancel;
    analysis.result.then((result) => {
      job.status = result ? "done" : "failed";
      job.analysis = result;
      job.cancel = undefined;
      if (this.loop === job) this.postLoops();
    });
    return job;
  }

  private postLoops() {
    const job = this.loop;
    const a = job?.analysis;
    this.view?.webview.postMessage({
      type: "loops",
      status: !job ? "off" : a && isStill(a) ? "still" : job.status,
      seconds: job?.seconds ?? 0,
      duration: a?.duration ?? 0,
      times: a?.times ?? [],
      similarity: a?.similarity ?? [],
    });
  }

  /**
   * Preview of the current wallpaper: its cached still frame, never the animated file. A large GIF
   * playing in the panel keeps decoding frames and can take hundreds of MB, which made the panel lag.
   */
  private previewUri(webview: vscode.Webview, file: string | undefined): string {
    if (!file || !fs.existsSync(file)) return "";
    const thumb = this.thumbnails.get(file);
    if (thumb) return webview.asWebviewUri(vscode.Uri.file(thumb)).toString();
    // Still images are cheap to show as they are; an animation waits for its thumbnail.
    return isAnimated(file) ? "" : webview.asWebviewUri(vscode.Uri.file(file)).toString();
  }

  private async onMessage(msg: Message) {
    const cfg = vscode.workspace.getConfiguration("dokiCarousel");
    switch (msg.type) {
      case "ready":
        this.pageReady = true;
        this.carousel.refresh();
        break;
      case "refresh":
        this.carousel.refresh();
        break;
      case "prev":
        await this.carousel.step(-1);
        break;
      case "next":
        await this.carousel.step(1);
        break;
      case "random":
        await this.carousel.random();
        break;
      case "reshuffle":
        this.carousel.reshuffle();
        break;
      case "previewPalette":
        await vscode.commands.executeCommand("workbench.action.showCommands");
        break;
      case "setFolder":
        await vscode.commands.executeCommand("dokiCarousel.setFolder");
        break;
      case "apply":
        await applyWallpaper(msg.path);
        break;
      case "removeWallpaper":
        await removeWallpaper();
        break;
      case "sort": {
        // One list in the panel: "modified:desc" = newest first, "random" = shuffled.
        const [sortBy, sortOrder] = msg.value.split(":");
        if (["name", "modified", "created", "size", "random"].includes(sortBy)) {
          await cfg.update("sortBy", sortBy, vscode.ConfigurationTarget.Global);
          if (sortOrder === "asc" || sortOrder === "desc") await cfg.update("sortOrder", sortOrder, vscode.ConfigurationTarget.Global);
        }
        break;
      }
      case "wallpaperTheme":
        // Turning it on asks first; the box shows the outcome either way.
        if (msg.enabled) await enablePaletteTheme();
        else await disablePaletteTheme();
        this.postState();
        break;
      case "opacity": {
        // The slider acts on the image(s) the carousel applies to: w, b, or both.
        const value = Math.min(100, Math.max(0, Math.round(Number(msg.value) || 0)));
        const target = cfg.get<string>("target", "wallpaper");
        if (target !== "background") await cfg.update("wallpaperOpacity", value, vscode.ConfigurationTarget.Global);
        if (target !== "wallpaper") await cfg.update("backgroundOpacity", value, vscode.ConfigurationTarget.Global);
        break;
      }
      case "setOption":
        if (["includeSubfolders", "target", "quickInputTint", "transparentPanels", "transparentTerminal", "wallpaperInEditor", "brightenThumbnails"].includes(msg.key)) {
          await cfg.update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
        }
        break;
      case "browseDir": {
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          defaultUri: msg.current ? vscode.Uri.file(msg.current) : undefined,
        });
        if (picked?.[0]) this.view?.webview.postMessage({ type: "dirPicked", field: msg.field, path: picked[0].fsPath });
        break;
      }
      case "extract":
        if (!msg.source || !msg.destination) {
          vscode.window.showWarningMessage("Choose a source and a destination folder first.");
          break;
        }
        await this.context.globalState.update(EXTRACT_SOURCE_KEY, msg.source);
        await this.context.globalState.update(EXTRACT_DEST_KEY, msg.destination);
        await extractMp4({ source: msg.source, destination: msg.destination, move: msg.move });
        break;
      case "convert": {
        await this.context.globalState.update(CONVERT_OPTIONS_KEY, msg.options);
        // Don't ask for files when the window is about to close anyway.
        if (isSwitching()) {
          vscode.window.setStatusBarMessage("$(sync~spin) A wallpaper is being applied, try again once the window has reopened.", 3000);
          break;
        }
        const startDir = this.context.globalState.get<string>(EXTRACT_DEST_KEY) || cfg.get<string>("folder");
        const files = await vscode.window.showOpenDialog({
          canSelectMany: true,
          filters: { Videos: ["mp4"] },
          openLabel: "Convert to GIF",
          defaultUri: startDir ? vscode.Uri.file(startDir) : undefined,
        });
        if (!files?.length) break;
        await convertMp4(files.map((f) => f.fsPath), msg.options);
        this.carousel.refresh();
        break;
      }
      case "pickFiles": {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: true,
          filters: { GIFs: ["gif"] },
          openLabel: "Select",
          defaultUri: this.pickStart(msg.tool),
        });
        if (!picked?.length) break;
        await this.context.globalState.update(PICKED_KEY[msg.tool], picked.map((f) => f.fsPath));
        this.postState();
        break;
      }
      case "optimize":
        await this.context.globalState.update(OPTIMIZE_OPTIONS_KEY, msg.options);
        if (this.readyToRun("optimize")) await optimizeGifs(this.pickedFiles("optimize"), msg.options);
        this.carousel.refresh();
        break;
    }
  }

  /** Files picked for a tool that still exist. */
  private pickedFiles(tool: FileTool): string[] {
    return this.context.globalState.get<string[]>(PICKED_KEY[tool], []).filter((f) => fs.existsSync(f));
  }

  /** The file dialog opens where the last pick was, else in the wallpaper folder. */
  private pickStart(tool: FileTool): vscode.Uri | undefined {
    const last = this.pickedFiles(tool)[0];
    const folder = last ? path.dirname(last) : vscode.workspace.getConfiguration("dokiCarousel").get<string>("folder");
    return folder ? vscode.Uri.file(folder) : undefined;
  }

  private readyToRun(tool: FileTool): boolean {
    // Don't start when the window is about to close anyway.
    if (isSwitching()) {
      vscode.window.setStatusBarMessage("$(sync~spin) A wallpaper is being applied, try again once the window has reopened.", 3000);
      return false;
    }
    if (!this.pickedFiles(tool).length) {
      vscode.window.showWarningMessage("Choose the files first (the … button next to Files).");
      return false;
    }
    return true;
  }

  private html(webview: vscode.Webview): string {
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", file));
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media("sidebar.css")}">
</head>
<body>
  <section>
    <div class="preview">
      <img id="preview" alt=""><span id="previewEmpty">No wallpaper set</span>
      <div class="preview-targets">
        <button data-target="wallpaper" class="preview-btn" aria-label="Apply as Wallpaper">w</button>
        <button data-target="background" class="preview-btn" aria-label="Apply as Background">b</button>
      </div>
      <button id="removeWallpaper" class="preview-btn preview-remove" title="Remove the wallpaper (Doki's stickers stay)" aria-label="Remove the wallpaper">✕</button>
    </div>
    <div class="nav">
      <button id="prev" title="Previous">◀</button>
      <span id="counter">–</span>
      <button id="random" title="Random">⤮</button>
      <button id="next" title="Next">▶</button>
    </div>
    <div id="currentName" class="muted ellipsis"></div>
    <div id="taskNote" class="task-note" hidden></div>
  </section>

  <details id="secWallpapers" open>
    <summary>Wallpapers <span id="count" class="muted"></span></summary>
    <label class="check" id="wallpaperThemeLabel"><input type="checkbox" id="wallpaperTheme"> Theme from wallpaper</label>
    <p class="muted hint indent">Colors VS Code with the palette of the wallpaper.<br><span id="paletteSourceHint">The palette comes from the wallpaper (w), not from the background (b).</span></p>
    <label><span id="opacityLabel">Wallpaper opacity</span> <span id="wallpaperOpacityValue"></span>% <span class="muted">(over black, lower = darker)</span><input id="wallpaperOpacity" type="range" min="0" max="100" step="1"></label>
    <div class="range-hints muted"><span>Dark</span><span>Unchanged</span></div>
    <p class="muted hint">The wallpaper and the background each keep their own opacity.</p>
    <input id="filter" type="search" placeholder="Filter…">
    <label>Sort by
      <select id="sort">
        <option value="name:asc">Name (A → Z)</option>
        <option value="name:desc">Name (Z → A)</option>
        <option value="modified:desc">Newest first (modified)</option>
        <option value="modified:asc">Oldest first (modified)</option>
        <option value="created:desc">Last added (created)</option>
        <option value="created:asc">First added (created)</option>
        <option value="size:desc">Largest first</option>
        <option value="size:asc">Smallest first</option>
        <option value="random">Random (shuffle)</option>
      </select>
    </label>
    <button id="reshuffle" class="secondary wide">Shuffle again</button>
    <button id="refresh" class="secondary wide" title="Look for new or deleted files in the folder">Refresh list</button>
    <ul id="list"></ul>
  </details>

  <details id="secFolder" open>
    <summary>Folder</summary>
    <div class="row"><span id="folder" class="ellipsis muted">No folder set</span></div>
    <button id="setFolder" class="wide">Set wallpaper folder…</button>
    <p class="muted hint">Formats: ${WALLPAPER_EXTENSIONS.join(" ")}</p>
    <label class="check"><input type="checkbox" id="includeSubfolders"> Include subfolders</label>
    <label>Apply as
      <select id="target">
        <option value="wallpaper">Wallpaper</option>
        <option value="background">Background (empty editor)</option>
        <option value="both">Both</option>
      </select>
    </label>
    <p class="muted hint">Doki has two images. The <b>wallpaper</b> shows through your code, the side bars, the panel and the terminal. The <b>background</b> only fills the editor area while no file is open, behind the VS Code logo: open a file and it is covered.</p>
  </details>

  <details id="secOptimize">
    <summary>GIF optimization</summary>
    <p class="muted">Makes GIFs lighter: fewer frames per second, a smaller size or only a fragment. Colors and animation are kept.</p>
    <label>Files<div class="row"><input id="optimizeFiles" class="picked" type="text" readonly placeholder="Choose GIFs…"><button data-pick="optimize" class="secondary" title="Choose files">…</button></div></label>
    <div class="grid">
      <label>FPS <span class="muted">(0 = keep)</span><input id="optFps" type="number" min="0" max="60"></label>
      <label>Width <span class="muted">(0 = keep)</span><input id="optWidth" type="number" min="0"></label>
      <label>Height <span class="muted">(-1 = auto)</span><input id="optHeight" type="number" min="-1"></label>
      <span></span>
      <label>Start (s)<input id="optStart" type="number" min="0" step="0.1"></label>
      <label>Duration (s) <span class="muted">(0 = all)</span><input id="optDuration" type="number" min="0" step="0.1"></label>
    </div>
    <div id="loops" class="loops" hidden>
      <div>Loops <span id="loopStatus" class="muted"></span></div>
      <div id="loopTrack" class="loop-track"><div id="loopRange" class="loop-range"></div></div>
      <div class="range-hints muted"><span>0 s</span><span id="loopLength"></span></div>
      <label>Match <span id="loopMatchValue"></span>% <span class="muted">(of the moving parts)</span><input id="loopMatch" type="range" min="80" max="100" step="1"></label>
      <p class="muted hint">Each yellow dot is where the GIF is back at its first frame: the loop that began at the previous dot (or at the start) ends there. Click a dot to keep just that loop.</p>
    </div>
    <label>Destination folder<div class="row"><input id="optDestination" type="text" placeholder="Same folder (replaces the files)"><button data-browse="optDestination" class="secondary">…</button></div></label>
    <p class="muted hint">Saving into the GIFs' own folder replaces them (you are asked first). Pick another folder to keep the originals.</p>
    <button id="optimize" class="wide">Optimize GIFs</button>
  </details>

  <details id="secMp4">
    <summary>.mp4 videos</summary>
    <p class="muted">Turn your videos into GIF wallpapers.</p>
    <details id="secExtract">
      <summary>Extract .mp4 files</summary>
      <p class="muted">Collects every .mp4 in a folder and all its subfolders into one folder.</p>
      <label>Source folder<div class="row"><input id="extractSource" type="text"><button data-browse="extractSource" class="secondary">…</button></div></label>
      <label>Destination folder<div class="row"><input id="extractDestination" type="text"><button data-browse="extractDestination" class="secondary">…</button></div></label>
      <label class="check"><input type="checkbox" id="extractMove"> Move instead of copy</label>
      <button id="extract" class="wide">Extract .mp4 files</button>
    </details>

    <details id="secConvert">
      <summary>Convert .mp4 → GIF</summary>
      <div class="grid">
        <label>FPS<input id="fps" type="number" min="1" max="60"></label>
        <label>Width<input id="width" type="number" min="16"></label>
        <label>Height <span class="muted">(-1 = auto)</span><input id="height" type="number" min="-1"></label>
        <span></span>
        <label>Start (s)<input id="startSeconds" type="number" min="0" step="0.1"></label>
        <label>Duration (s) <span class="muted">(0 = all)</span><input id="durationSeconds" type="number" min="0" step="0.1"></label>
      </div>
      <label>Destination folder<div class="row"><input id="convertDestination" type="text" placeholder="Next to each .mp4"><button data-browse="convertDestination" class="secondary">…</button></div></label>
      <button id="convert" class="wide">Select .mp4 files &amp; convert…</button>
    </details>
  </details>

  <details id="secAppearance" open>
    <summary>Appearance</summary>
    <label>Command palette tint <span id="quickInputTintValue"></span>%
      <input id="quickInputTint" type="range" min="0" max="100" step="1">
    </label>
    <div class="range-hints muted"><span>Transparent</span><span>Solid</span></div>
    <button id="previewPalette" class="secondary wide">Open command palette to preview</button>
    <label class="check"><input type="checkbox" id="wallpaperInEditor"> Wallpaper in editors</label>
    <p class="muted hint indent">Code, Welcome page, Settings and tabs. Changing it reopens the window.</p>
    <label class="check"><input type="checkbox" id="transparentPanels"> Wallpaper in side bars &amp; panel</label>
    <label class="check"><input type="checkbox" id="transparentTerminal"> Wallpaper in terminal</label>
    <label class="check" title="Undo the dark layer of darkened wallpapers in the hover previews only"><input type="checkbox" id="brightenThumbnails"> Brighten dimmed previews</label>
  </details>

  <script nonce="${nonce}" src="${media("sidebar.js")}"></script>
</body>
</html>`;
  }
}
