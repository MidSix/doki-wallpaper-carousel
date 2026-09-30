import * as vscode from "vscode";
import * as path from "path";
import { Carousel } from "./carousel";
import { applyWallpaper, ensureCssOverrides, ensureTerminalReadable, ensureTransparentSurfaces, formatSize, imageRoom, initSwitching, removeWallpaper, reopenToApply, tooLargeReason } from "./doki";
import { checkThemeConflict, initPaletteTheme, refreshPaletteTheme } from "./paletteTheme";
import { SidebarProvider } from "./sidebar";
import { Thumbnails } from "./thumbnails";
import { extractMp4, initTools } from "./tools";
import { watchUninstall } from "./uninstallPrompt";

export function activate(context: vscode.ExtensionContext) {
  initSwitching(context);
  initTools(context);
  watchUninstall(context);
  initPaletteTheme(context);
  const carousel = new Carousel(context);
  const sidebar = new SidebarProvider(context, carousel, new Thumbnails(context));

  // ◀ n/N ▶ in the status bar
  const prevItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  const labelItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 999);
  const nextItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 998);
  prevItem.text = "$(chevron-left)";
  prevItem.tooltip = "Previous wallpaper";
  prevItem.command = "dokiCarousel.previous";
  nextItem.text = "$(chevron-right)";
  nextItem.tooltip = "Next wallpaper";
  nextItem.command = "dokiCarousel.next";
  labelItem.command = "dokiCarousel.pick";

  const updateStatusBar = () => {
    const show = vscode.workspace.getConfiguration("dokiCarousel").get<boolean>("showStatusBar", true);
    const files = carousel.files();
    if (!show) {
      [prevItem, labelItem, nextItem].forEach((i) => i.hide());
      return;
    }
    const index = carousel.currentIndex();
    labelItem.text = `$(file-media) ${files.length ? `${index >= 0 ? index + 1 : "–"}/${files.length}` : "no folder"}`;
    labelItem.tooltip = index >= 0 ? files[index].name : "Pick a wallpaper";
    [prevItem, labelItem, nextItem].forEach((i) => i.show());
  };
  carousel.onDidChange(updateStatusBar);

  context.subscriptions.push(
    prevItem,
    labelItem,
    nextItem,
    vscode.window.registerWebviewViewProvider("dokiCarousel.panel", sidebar),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("dokiCarousel.fixTerminalText") || e.affectsConfiguration("terminal.integrated.gpuAcceleration")) {
        ensureTerminalReadable();
      }
      // A new theme also means a new color for the terminal without the wallpaper; the dimming
      // follows Doki's switches.
      if (
        ["transparentTerminal", "transparentPanels", "quickInputTint", "wallpaperOpacity", "backgroundOpacity"].some((k) => e.affectsConfiguration(`dokiCarousel.${k}`)) ||
        ["wallpaper.enabled", "background.enabled"].some((k) => e.affectsConfiguration(`doki.${k}`)) ||
        e.affectsConfiguration("workbench.colorTheme")
      ) {
        ensureTransparentSurfaces(context);
      }
      // Theme from wallpaper follows the image its palette comes from.
      if (
        ["wallpaperTheme", "paletteSource"].some((k) => e.affectsConfiguration(`dokiCarousel.${k}`)) ||
        ["wallpaper.path", "background.path", "wallpaper.enabled", "background.enabled"].some((k) => e.affectsConfiguration(`doki.${k}`))
      ) {
        refreshPaletteTheme();
      }
      if (e.affectsConfiguration("workbench.colorTheme")) checkThemeConflict();
      if (e.affectsConfiguration("dokiCarousel.wallpaperInEditor") || e.affectsConfiguration("dokiCarousel.transparentTerminal")) {
        // The terminal changes right away through its color; the editor needs the new stylesheet.
        // Every open window gets this event: the first one writes the file, the focused one reopens.
        const result = ensureCssOverrides();
        if (result !== "failed" && e.affectsConfiguration("dokiCarousel.wallpaperInEditor") && vscode.window.state.focused) {
          reopenToApply("Wallpaper in editors");
        }
      }
      // The opacity slider writes its setting many times while it moves; the list stays as it is.
      const onlyOpacity = e.affectsConfiguration("dokiCarousel.wallpaperOpacity") || e.affectsConfiguration("dokiCarousel.backgroundOpacity");
      if ((e.affectsConfiguration("dokiCarousel") && !onlyOpacity) || ["wallpaper.path", "background.path", "wallpaper.enabled", "background.enabled"].some((k) => e.affectsConfiguration(`doki.${k}`))) {
        carousel.refresh();
      }
    }),

    vscode.commands.registerCommand("dokiCarousel.previous", () => carousel.step(-1)),
    vscode.commands.registerCommand("dokiCarousel.next", () => carousel.step(1)),
    vscode.commands.registerCommand("dokiCarousel.random", () => carousel.random()),
    vscode.commands.registerCommand("dokiCarousel.removeWallpaper", () => removeWallpaper()),

    vscode.commands.registerCommand("dokiCarousel.pick", async () => {
      const files = carousel.files();
      const current = carousel.currentIndex();
      const room = imageRoom();
      const picked = await vscode.window.showQuickPick(
        files.map((f, i) => {
          const tooLarge = tooLargeReason(f.size, room);
          return {
            label: `${i === current ? "$(check) " : ""}${f.name}`,
            description: `${tooLarge ? "$(warning) " : ""}${formatSize(f.size)}`,
            detail: tooLarge || undefined,
            path: f.path,
          };
        }),
        { placeHolder: "Choose a wallpaper", matchOnDescription: true }
      );
      if (picked) await applyWallpaper(picked.path);
    }),

    vscode.commands.registerCommand("dokiCarousel.setFolder", async () => {
      const cfg = vscode.workspace.getConfiguration("dokiCarousel");
      const current = cfg.get<string>("folder");
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        openLabel: "Use as wallpaper folder",
        defaultUri: current ? vscode.Uri.file(current) : undefined,
      });
      if (picked?.[0]) await cfg.update("folder", picked[0].fsPath, vscode.ConfigurationTarget.Global);
    }),

    vscode.commands.registerCommand("dokiCarousel.extractMp4", async () => {
      const source = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: "Search .mp4 here" });
      if (!source?.[0]) return;
      const destination = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        openLabel: "Put .mp4 files here",
        defaultUri: vscode.Uri.file(path.join(source[0].fsPath, "..")),
      });
      if (!destination?.[0]) return;
      const mode = await vscode.window.showQuickPick(["Copy", "Move"], { placeHolder: "Copy or move the files?" });
      if (!mode) return;
      await extractMp4({ source: source[0].fsPath, destination: destination[0].fsPath, move: mode === "Move" });
    }),

    // The conversion and optimization options live in the sidebar form.
    vscode.commands.registerCommand("dokiCarousel.convertMp4", () => vscode.commands.executeCommand("dokiCarousel.panel.focus")),
    // Called with the GIFs to pick when a wallpaper is too large (see doki.ts).
    vscode.commands.registerCommand("dokiCarousel.optimizeGifs", (files?: unknown) =>
      sidebar.openTool("optimize", Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : undefined)
    )
  );

  updateStatusBar();
  ensureTerminalReadable();
  ensureTransparentSurfaces(context);
  // A VS Code update installs a fresh stylesheet without our CSS, and a new version of the
  // extension may bring a new block. Checked a bit later, so Doki is done reinstalling its
  // wallpaper first (it rewrites the same file).
  setTimeout(async () => {
    if (ensureCssOverrides() !== "changed") return;
    const choice = await vscode.window.showInformationMessage(
      "Wallpaper Carousel updated VS Code's stylesheet, which the wallpaper opacity slider and the Appearance settings need (after an update of VS Code or of the extension). Reopen the window to use them.",
      "Reopen Window"
    );
    if (choice) reopenToApply("Appearance settings");
  }, 5000);
}

export function deactivate() {}
