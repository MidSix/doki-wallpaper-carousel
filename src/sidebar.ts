import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Carousel } from "./carousel";
import { applyWallpaper, currentTask, getCurrentDokiPath, isSwitching, onDidChangeSwitching, onDidChangeTask } from "./doki";
import { Thumbnails } from "./thumbnails";
import { ConvertOptions, convertMp4, defaultConvertOptions, extractMp4 } from "./tools";

const CONVERT_OPTIONS_KEY = "dokiCarousel.convertOptions";
const EXTRACT_SOURCE_KEY = "dokiCarousel.extractSource";
const EXTRACT_DEST_KEY = "dokiCarousel.extractDestination";

type Message =
  | { type: "ready" | "refresh" | "prev" | "next" | "random" | "reshuffle" | "setFolder" | "previewPalette" }
  | { type: "apply"; path: string }
  | { type: "setOption"; key: string; value: unknown }
  | { type: "browseDir"; field: string; current?: string }
  | { type: "extract"; source: string; destination: string; move: boolean }
  | { type: "convert"; options: ConvertOptions };

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
    thumbnails.onDidCreate(({ file, thumb }) =>
      this.view?.webview.postMessage({ type: "thumb", path: file, thumb: this.view.webview.asWebviewUri(vscode.Uri.file(thumb)).toString() })
    );
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
      currentUri: current && fs.existsSync(current) ? webview.asWebviewUri(vscode.Uri.file(current)).toString() : "",
      sortBy: cfg.get("sortBy"),
      sortOrder: cfg.get("sortOrder"),
      includeSubfolders: cfg.get("includeSubfolders"),
      target: cfg.get("target"),
      reloadMode: cfg.get("reloadMode"),
      busy: isSwitching(),
      task: currentTask() ?? "",
      quickInputTint: cfg.get("quickInputTint"),
      thumbsAvailable: this.thumbnails.available,
      transparentPanels: cfg.get("transparentPanels"),
      transparentTerminal: cfg.get("transparentTerminal"),
      brightenThumbnails: cfg.get("brightenThumbnails"),
      convert: { ...defaultConvertOptions, ...this.context.globalState.get<Partial<ConvertOptions>>(CONVERT_OPTIONS_KEY, {}) },
      extractSource: this.context.globalState.get<string>(EXTRACT_SOURCE_KEY, ""),
      extractDestination: this.context.globalState.get<string>(EXTRACT_DEST_KEY, folder ? path.join(folder, "mp4") : ""),
    });
    this.thumbnails.request(files.map((f) => f.path));
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
      case "apply":
        await applyWallpaper(msg.path);
        break;
      case "setOption":
        if (["sortBy", "sortOrder", "includeSubfolders", "target", "reloadMode", "quickInputTint", "transparentPanels", "transparentTerminal", "brightenThumbnails"].includes(msg.key)) {
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
    }
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
    <div class="preview"><img id="preview" alt=""><span id="previewEmpty">No wallpaper set</span></div>
    <div class="nav">
      <button id="prev" title="Previous">◀</button>
      <span id="counter">–</span>
      <button id="random" title="Random">⤮</button>
      <button id="next" title="Next">▶</button>
    </div>
    <div id="currentName" class="muted ellipsis"></div>
    <div id="taskNote" class="task-note" hidden></div>
  </section>

  <details open>
    <summary>Wallpapers <span id="count" class="muted"></span></summary>
    <input id="filter" type="search" placeholder="Filter…">
    <ul id="list"></ul>
  </details>

  <details open>
    <summary>Folder &amp; order</summary>
    <div class="row"><span id="folder" class="ellipsis muted">No folder set</span></div>
    <button id="setFolder" class="wide">Set GIF folder…</button>
    <label>Sort by
      <select id="sortBy">
        <option value="name">Name</option>
        <option value="modified">Date modified</option>
        <option value="created">Date created</option>
        <option value="size">Size</option>
        <option value="random">Random (shuffle)</option>
      </select>
    </label>
    <label>Order
      <select id="sortOrder"><option value="asc">Ascending</option><option value="desc">Descending</option></select>
    </label>
    <label>Apply to
      <select id="target">
        <option value="wallpaper">Wallpaper (doki.wallpaper.path)</option>
        <option value="background">Background (doki.background.path)</option>
        <option value="both">Both</option>
      </select>
    </label>
    <label class="check"><input type="checkbox" id="includeSubfolders"> Include subfolders</label>
    <label>After changing
      <select id="reloadMode">
        <option value="newWindow">Reopen window (recommended)</option>
        <option value="reload">Reload window</option>
        <option value="none">Nothing</option>
      </select>
    </label>
    <div class="row gap"><button id="refresh" class="secondary">Refresh</button><button id="reshuffle" class="secondary">Reshuffle</button></div>
  </details>

  <details open>
    <summary>Appearance</summary>
    <label>Command palette tint <span id="quickInputTintValue"></span>%
      <input id="quickInputTint" type="range" min="0" max="100" step="1">
    </label>
    <div class="range-hints muted"><span>Transparent</span><span>Solid</span></div>
    <button id="previewPalette" class="secondary wide">Open command palette to preview</button>
    <label class="check"><input type="checkbox" id="transparentPanels"> Wallpaper in side bars &amp; panel</label>
    <label class="check"><input type="checkbox" id="transparentTerminal"> Wallpaper in terminal</label>
    <label class="check" title="Undo the dark layer of dimmed GIFs in the hover previews only"><input type="checkbox" id="brightenThumbnails"> Brighten dimmed previews</label>
  </details>

  <details>
    <summary>Extract .mp4 files</summary>
    <p class="muted">Collects every .mp4 in a folder and all its subfolders into one folder.</p>
    <label>Source folder<div class="row"><input id="extractSource" type="text"><button data-browse="extractSource" class="secondary">…</button></div></label>
    <label>Destination folder<div class="row"><input id="extractDestination" type="text"><button data-browse="extractDestination" class="secondary">…</button></div></label>
    <label class="check"><input type="checkbox" id="extractMove"> Move instead of copy</label>
    <button id="extract" class="wide">Extract .mp4 files</button>
  </details>

  <details>
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

  <script nonce="${nonce}" src="${media("sidebar.js")}"></script>
</body>
</html>`;
  }
}
