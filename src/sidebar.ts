import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Carousel } from "./carousel";
import { applyWallpaper, currentTask, getCurrentDokiPath, isSwitching, isWallpaperShown, onDidChangeSwitching, onDidChangeTask, removeWallpaper } from "./doki";
import { samePath } from "./platform";
import { Thumbnails } from "./thumbnails";
import { WALLPAPER_EXTENSIONS, WALLPAPER_FILTER, isAnimated } from "./formats";
import { ConvertOptions, DimOptions, OptimizeOptions, convertMp4, defaultConvertOptions, defaultDimOptions, defaultOptimizeOptions, dimWallpapers, extractMp4, optimizeGifs } from "./tools";

const CONVERT_OPTIONS_KEY = "dokiCarousel.convertOptions";
const DIM_OPTIONS_KEY = "dokiCarousel.dimOptions";
const OPTIMIZE_OPTIONS_KEY = "dokiCarousel.optimizeOptions";
// Files picked in the panel for each tool, kept until they are picked again.
const PICKED_KEY: Record<FileTool, string> = { dim: "dokiCarousel.dimFiles", optimize: "dokiCarousel.optimizeFiles" };

type FileTool = "dim" | "optimize";
const EXTRACT_SOURCE_KEY = "dokiCarousel.extractSource";
const EXTRACT_DEST_KEY = "dokiCarousel.extractDestination";

type Message =
  | { type: "ready" | "refresh" | "prev" | "next" | "random" | "reshuffle" | "setFolder" | "previewPalette" | "resetDim" | "removeWallpaper" }
  | { type: "sort"; value: string }
  | { type: "apply"; path: string }
  | { type: "setOption"; key: string; value: unknown }
  | { type: "browseDir"; field: string; current?: string }
  | { type: "extract"; source: string; destination: string; move: boolean }
  | { type: "convert"; options: ConvertOptions }
  | { type: "pickFiles"; tool: FileTool }
  | { type: "dim"; options: DimOptions }
  | { type: "optimize"; options: OptimizeOptions };

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

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
    view.webview.options = { enableScripts: true, localResourceRoots: this.resourceRoots() };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: Message) => this.onMessage(msg));
    view.onDidChangeVisibility(() => view.visible && this.postState());
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
    webview.postMessage({
      type: "state",
      folder,
      // Hover previews use cached static thumbnails, never the (possibly huge) animated GIFs.
      files: files.map((f) => {
        const thumb = this.thumbnails.get(f.path);
        return { path: f.path, name: f.name, thumb: thumb ? webview.asWebviewUri(vscode.Uri.file(thumb)).toString() : "" };
      }),
      currentIndex: this.carousel.currentIndex(),
      current: current ?? "",
      wallpaperShown: isWallpaperShown(),
      currentUri: this.previewUri(webview, current),
      sortBy: cfg.get("sortBy"),
      sortOrder: cfg.get("sortOrder"),
      includeSubfolders: cfg.get("includeSubfolders"),
      target: cfg.get("target"),
      busy: isSwitching(),
      task: currentTask() ?? "",
      quickInputTint: cfg.get("quickInputTint"),
      thumbsAvailable: this.thumbnails.available,
      transparentPanels: cfg.get("transparentPanels"),
      transparentTerminal: cfg.get("transparentTerminal"),
      wallpaperInEditor: cfg.get("wallpaperInEditor"),
      brightenThumbnails: cfg.get("brightenThumbnails"),
      convert: { ...defaultConvertOptions, ...this.context.globalState.get<Partial<ConvertOptions>>(CONVERT_OPTIONS_KEY, {}) },
      dim: { ...defaultDimOptions, ...this.context.globalState.get<Partial<DimOptions>>(DIM_OPTIONS_KEY, {}) },
      optimize: { ...defaultOptimizeOptions, ...this.context.globalState.get<Partial<OptimizeOptions>>(OPTIMIZE_OPTIONS_KEY, {}) },
      dimFiles: this.pickedFiles("dim"),
      optimizeFiles: this.pickedFiles("optimize"),
      extractSource: this.context.globalState.get<string>(EXTRACT_SOURCE_KEY, ""),
      extractDestination: this.context.globalState.get<string>(EXTRACT_DEST_KEY, folder ? path.join(folder, "mp4") : ""),
    });
    // The current wallpaper first, so the preview at the top is ready before the hover previews.
    this.thumbnails.request([...(current ? [current] : []), ...files.map((f) => f.path)]);
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
      case "resetDim":
        await vscode.commands.executeCommand("dokiCarousel.resetOpacity");
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
          filters: msg.tool === "dim" ? { Wallpapers: WALLPAPER_FILTER } : { GIFs: ["gif"] },
          openLabel: "Select",
          defaultUri: this.pickStart(msg.tool),
        });
        if (!picked?.length) break;
        await this.context.globalState.update(PICKED_KEY[msg.tool], picked.map((f) => f.fsPath));
        this.postState();
        break;
      }
      case "dim":
        await this.context.globalState.update(DIM_OPTIONS_KEY, msg.options);
        if (this.readyToRun("dim")) await dimWallpapers(this.pickedFiles("dim"), msg.options);
        this.carousel.refresh();
        break;
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
      <button id="removeWallpaper" class="preview-remove" title="Remove the wallpaper (Doki's stickers stay)" aria-label="Remove the wallpaper">✕</button>
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
    <p class="muted hint">Most wallpapers (GIF, PNG, JPG…) are too bright to read code over. Darken them first in <a href="#" data-open="secOpacity">Set opacity</a>.</p>
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

  <details id="secOpacity">
    <summary>Set opacity</summary>
    <p class="muted">Darkens wallpapers so code stays readable over them. Format, size, animation and transparency are kept. Works with every format listed under Folder except animated WebP.</p>
    <label>Files<div class="row"><input id="dimFiles" class="picked" type="text" readonly placeholder="Choose wallpapers…"><button data-pick="dim" class="secondary" title="Choose files">…</button></div></label>
    <label>Opacity <span id="dimOpacityValue"></span>% <span class="muted">(over black, lower = darker)</span><input id="dimOpacity" type="range" min="5" max="100" step="1"></label>
    <div class="range-hints muted"><span>Dark</span><span>Unchanged</span></div>
    <label>Destination folder<div class="row"><input id="dimDestination" type="text" placeholder="Same folder (replaces the files)"><button data-browse="dimDestination" class="secondary">…</button></div></label>
    <p class="muted hint">Saving into the files' own folder replaces them (you are asked first). Pick another folder to keep the originals.</p>
    <button id="dim" class="wide">Set opacity</button>
    <button id="resetDim" class="secondary wide" title="Brighten files changed by Set opacity back to about how they were">Reset opacity…</button>
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
      <label>Video opacity <span id="opacityValue"></span>% <span class="muted">(over black, lower = darker)</span><input id="opacity" type="range" min="0" max="100"></label>
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
