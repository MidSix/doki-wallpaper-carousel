import * as vscode from "vscode";
import * as path from "path";
import { Carousel } from "./carousel";
import { applyWallpaper, ensureTerminalReadable, ensureTransparentSurfaces, initSwitching } from "./doki";
import { SidebarProvider } from "./sidebar";
import { Thumbnails } from "./thumbnails";
import { extractMp4 } from "./tools";

export function activate(context: vscode.ExtensionContext) {
  initSwitching(context);
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
      if (["transparentTerminal", "transparentPanels", "quickInputTint"].some((k) => e.affectsConfiguration(`dokiCarousel.${k}`))) {
        ensureTransparentSurfaces(context);
      }
      if (e.affectsConfiguration("dokiCarousel") || e.affectsConfiguration("doki.wallpaper.path") || e.affectsConfiguration("doki.background.path")) {
        carousel.refresh();
      }
    }),

    vscode.commands.registerCommand("dokiCarousel.previous", () => carousel.step(-1)),
    vscode.commands.registerCommand("dokiCarousel.next", () => carousel.step(1)),
    vscode.commands.registerCommand("dokiCarousel.random", () => carousel.random()),

    vscode.commands.registerCommand("dokiCarousel.pick", async () => {
      const files = carousel.files();
      const current = carousel.currentIndex();
      const picked = await vscode.window.showQuickPick(
        files.map((f, i) => ({ label: `${i === current ? "$(check) " : ""}${f.name}`, description: `${(f.size / 1048576).toFixed(1)} MB`, path: f.path })),
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

    // The conversion options live in the sidebar form.
    vscode.commands.registerCommand("dokiCarousel.convertMp4", () => vscode.commands.executeCommand("dokiCarousel.panel.focus"))
  );

  updateStatusBar();
  ensureTerminalReadable();
  ensureTransparentSurfaces(context);
}

export function deactivate() {}
